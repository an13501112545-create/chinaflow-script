import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSession } from "../auth-session-store-v0.1.mjs";
import { handleAppRequest } from "../app-worker-v0.1.mjs";
import {
  publisherReportingQueryEnabled,
  parsePublisherReportingQuery,
  getPublisherReportingSummary
} from "../publisher-reporting-query-v0.1.mjs";

const ORIGIN = "https://publisher.example.test";
const ROUTE = "/api/reporting/summary";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  sqlite.exec(`
    INSERT INTO publisher_users(user_id,email,email_normalized) VALUES
      ('u','owner@example.test','owner@example.test'),('u2','other@example.test','other@example.test');
    INSERT INTO publishers(publisher_id,slug,display_name,account_status) VALUES
      ('p','p','Publisher','active'),('q','q','Other','active');
    INSERT INTO publisher_memberships(membership_id,publisher_id,user_id,role,membership_status) VALUES
      ('m','p','u','owner','active'),('m2','q','u2','owner','active');
    INSERT INTO trip_bookings(
      booking_fact_id,source_record_key,source,source_order_id,source_row_hash,
      attributed_publisher_id,attributed_placement,attribution_status,
      booking_amount_micros,currency,order_date,
      first_seen_at,last_seen_at,first_ingestion_run_id,last_ingestion_run_id,
      source_ingested_at,raw_payload_json
    ) VALUES
      ('b1','bk1','trip.com','o1','h1','p','pl-a','matched',1000000,'USD','2026-08-02','t','t','r','r','t','{}'),
      ('b2','bk2','trip.com','o2','h2','p','pl-b','matched',2000000,'USD','2026-08-03','t','t','r','r','t','{}'),
      ('b3','bk3','trip.com','o3','h3','p','pl-a','matched',3000000,'CNY','2026-09-03','t','t','r','r','t','{}'),
      ('b4','bk4','trip.com','o4','h4','q','pl-a','matched',9000000,'USD','2026-08-02','t','t','r','r','t','{}'),
      ('b5','bk5','trip.com','o5','h5',NULL,NULL,'unmatched',7000000,'USD','2026-08-02','t','t','r','r','t','{}');
    INSERT INTO trip_commissions(
      commission_fact_id,commission_record_key,source,source_order_id,source_row_hash,
      attributed_publisher_id,attributed_placement,attribution_status,
      booking_amount_micros,commission_amount_micros,currency,commission_month,
      first_seen_at,last_seen_at,first_ingestion_run_id,last_ingestion_run_id,
      source_ingested_at,raw_payload_json
    ) VALUES
      ('c1','ck1','trip.com','o1','ch1','p','pl-a','matched',1000000,100000,'USD','2026-08','t','t','r','r','t','{}'),
      ('c2','ck2','trip.com','o2','ch2','p','pl-b','matched',2000000,-50000,'USD','2026-08','t','t','r','r','t','{}'),
      ('c3','ck3','trip.com','o3','ch3','p','pl-a','matched',3000000,300000,'CNY','2026-09','t','t','r','r','t','{}'),
      ('c4','ck4','trip.com','o4','ch4','q','pl-a','matched',9000000,900000,'USD','2026-08','t','t','r','r','t','{}');
  `);
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return sqlite.prepare(sql).get(...values) ?? null; },
            async all() { return { results: sqlite.prepare(sql).all(...values) }; },
            async run() { const x=sqlite.prepare(sql).run(...values); return { meta:{changes:Number(x.changes)} }; }
          };
        }
      };
    }
  };
  t.after(() => sqlite.close());
  return { sqlite, database };
}

test("query parser requires bounded month range and rejects tenant selection", () => {
  assert.deepEqual(parsePublisherReportingQuery(new URLSearchParams("from=2026-08&to=2026-09")),
    { from:"2026-08", to:"2026-09", placement:null });
  assert.deepEqual(parsePublisherReportingQuery(new URLSearchParams("from=2026-08&to=2026-09&placement=pl-a")),
    { from:"2026-08", to:"2026-09", placement:"pl-a" });
  for (const value of [
    "", "from=2026-08", "from=2026-13&to=2026-14", "from=2026-09&to=2026-08",
    "from=2025-01&to=2027-01", "from=2026-08&to=2026-09&publisher_id=p",
    "from=2026-08&from=2026-09&to=2026-10", "from=2026-08&to=2026-09&placement=%20pl-a"
  ]) assert.equal(parsePublisherReportingQuery(new URLSearchParams(value)), null);
});

test("summary enforces session-derived publisher isolation and preserves currency/sign", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");
  const result = await getPublisherReportingSummary(f.database, session.token,
    { from:"2026-08", to:"2026-09", placement:null });
  assert.equal(result.status, 200);
  const r = result.body.reporting;
  assert.equal(r.publisher_id, "p");
  assert.equal(r.bookings.rows, 3);
  assert.deepEqual(r.bookings.by_currency, [
    { currency:"CNY", rows:1, booking_amount_micros:3000000 },
    { currency:"USD", rows:2, booking_amount_micros:3000000 }
  ]);
  assert.equal(r.commissions.rows, 3);
  assert.deepEqual(r.commissions.by_currency, [
    { currency:"CNY", rows:1, booking_amount_micros:3000000, commission_amount_micros:300000 },
    { currency:"USD", rows:2, booking_amount_micros:3000000, commission_amount_micros:50000 }
  ]);
  assert.ok(r.bookings.by_placement.every(row => ["pl-a","pl-b"].includes(row.placement)));
});

test("placement filter is exact and cannot expose another publisher", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");
  const result = await getPublisherReportingSummary(f.database, session.token,
    { from:"2026-08", to:"2026-09", placement:"pl-a" });
  assert.equal(result.status, 200);
  assert.equal(result.body.reporting.bookings.rows, 2);
  assert.equal(result.body.reporting.commissions.rows, 2);
  assert.ok(result.body.reporting.bookings.by_placement.every(row => row.placement === "pl-a"));
  assert.ok(result.body.reporting.commissions.by_placement.every(row => row.placement === "pl-a"));
});

test("invalid session and ambiguous active memberships fail closed", async t => {
  const f = fixture(t);
  assert.equal((await getPublisherReportingSummary(f.database, "bad", {from:"2026-08",to:"2026-09",placement:null})).status, 401);
  const session = await createSession(f.database, "u");
  f.sqlite.exec("INSERT INTO publisher_memberships(membership_id,publisher_id,user_id,role,membership_status) VALUES ('m3','q','u','owner','active')");
  const result = await getPublisherReportingSummary(f.database, session.token,
    {from:"2026-08",to:"2026-09",placement:null});
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {error:"conflict"});
});

test("reporting SQL always authorizes by attributed_publisher_id before period or placement", () => {
  const source = readFileSync(new URL("../publisher-reporting-query-v0.1.mjs", import.meta.url), "utf8");
  assert.match(source, /WHERE attributed_publisher_id = \?1/);
  assert.doesNotMatch(source, /WHERE\s+trip_sub1\s*=/i);
});

test("reporting summary route enforces GET, same-origin reads, session auth and strict query", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");
  const env = { APP_ORIGIN: ORIGIN, PUBLISHER_REPORTING_QUERY_ENABLED: "true", CHINAFLOW_EVENTS: f.database };

  for (const method of ["POST","PUT","PATCH","DELETE","OPTIONS"]) {
    const response = await handleAppRequest(
      new Request(ORIGIN + ROUTE + "?from=2026-08&to=2026-09", { method }), env
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET");
  }

  const foreign = await handleAppRequest(
    new Request(ORIGIN + ROUTE + "?from=2026-08&to=2026-09", {
      headers: { Origin: "https://foreign.test" }
    }), env
  );
  assert.equal(foreign.status, 403);

  const unauthenticated = await handleAppRequest(
    new Request(ORIGIN + ROUTE + "?from=2026-08&to=2026-09"), env
  );
  assert.equal(unauthenticated.status, 401);

  const cookie = `__Host-chinaflow_session=${session.token}`;
  const injectedTenant = await handleAppRequest(
    new Request(ORIGIN + ROUTE + "?from=2026-08&to=2026-09&publisher_id=q", {
      headers: { Cookie: cookie }
    }), env
  );
  assert.equal(injectedTenant.status, 400);

  const ok = await handleAppRequest(
    new Request(ORIGIN + ROUTE + "?from=2026-08&to=2026-09", {
      headers: { Cookie: cookie }
    }), env
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), null);
  const body = await ok.json();
  assert.equal(body.reporting.publisher_id, "p");
  assert.equal(body.reporting.bookings.rows, 3);
  assert.ok(!JSON.stringify(body).includes("9000000"));
});

test("service rejects reversed or oversized ranges even when called without router", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");
  for (const query of [
    {from:"2026-09",to:"2026-08",placement:null},
    {from:"2025-01",to:"2027-01",placement:null}
  ]) {
    const result = await getPublisherReportingSummary(f.database, session.token, query);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {error:"invalid_input"});
  }
});

test("reporting query rollout gate is exact and enabled only in TEST", async () => {
  assert.equal(publisherReportingQueryEnabled({PUBLISHER_REPORTING_QUERY_ENABLED:"true"}), true);
  for (const value of [undefined,null,"","false","TRUE",true,1]) {
    assert.equal(publisherReportingQueryEnabled({PUBLISHER_REPORTING_QUERY_ENABLED:value}), false);
  }
  const testConfig = JSON.parse(readFileSync(new URL("../../wrangler.publisher-app.test.jsonc", import.meta.url), "utf8"));
  const prodConfig = JSON.parse(readFileSync(new URL("../../wrangler.publisher-app.production.jsonc", import.meta.url), "utf8"));
  assert.equal(testConfig.vars.PUBLISHER_REPORTING_QUERY_ENABLED, "true");
  assert.equal(prodConfig.vars.PUBLISHER_REPORTING_QUERY_ENABLED, "false");
});

test("dark reporting route returns 404 before D1 access", async () => {
  const env = {
    APP_ORIGIN: ORIGIN,
    PUBLISHER_REPORTING_QUERY_ENABLED: "false",
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed while reporting route dark"); }
  };
  const response = await handleAppRequest(
    new Request(ORIGIN + ROUTE + "?from=2026-08&to=2026-09"), env
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {error:"not_found"});
});
