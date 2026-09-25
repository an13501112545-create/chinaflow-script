import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSession } from "../auth-session-store-v0.1.mjs";
import { handleAppRequest } from "../app-worker-v0.1.mjs";
import {
  agentBookingEnabled,
  getAgentBookingLaunch
} from "../publisher-agent-booking-v0.1.mjs";

const ORIGIN = "https://publisher.example.test";
const API_ROUTE = "/api/agent-booking/launch";
const PAGE_ROUTE = "/agent-booking";
const ROUTING_ENV = {
  AGENT_BOOKING_TRIP_AID: "10021103",
  AGENT_BOOKING_TRIP_SID: "330739613"
};

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));

  sqlite.exec(`
    INSERT INTO publisher_users(user_id,email,email_normalized,email_verified_at)
    VALUES ('u','owner@example.test','owner@example.test','2026-09-01');

    INSERT INTO publishers(
      publisher_id,slug,display_name,account_status,terms_version,
      terms_accepted_at,terms_accepted_by_user_id,install_public_key
    ) VALUES (
      'p','p','Publisher','active','chinaflow-publisher-terms-v1',
      '2026-09-01','u','pub_install_0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    );

    INSERT INTO publisher_memberships(
      membership_id,publisher_id,user_id,role,membership_status
    ) VALUES ('m','p','u','owner','active');

    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,is_primary,install_status,
      verification_status,claim_status,claim_acquired_at,review_status,
      monetization_status,first_seen_at,last_seen_at,verified_at,reviewed_at
    ) VALUES (
      'd','p','publisher.example.test',1,'detected','verified','claimed',
      '2026-09-01','approved','enabled','2026-09-01','2026-09-01',
      '2026-09-01','2026-09-01'
    );

    INSERT INTO publisher_supplier_sites(
      supplier_site_id,publisher_id,domain_id,supplier,aid,sid,sid_name,
      provisioning_status,provisioned_at
    ) VALUES (
      's','p','d','trip.com','10021103','330739613','Pilot',
      'active','2026-09-01'
    );

    INSERT INTO publisher_channel_capabilities(
      capability_id,publisher_id,channel,capability_status,enabled_at
    ) VALUES (
      'cap','p','agent_booking','enabled','2026-09-24'
    );

    INSERT INTO publisher_placements(
      placement_id,publisher_id,placement,supplier,external_tracking_key,
      is_active,effective_from,channel
    ) VALUES (
      'pl','p','agent_booking_p','trip.com','agent_booking_p',
      1,'2026-09-24','agent_booking'
    );
  `);

  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return sqlite.prepare(sql).get(...values) ?? null; },
            async all() { return { results: sqlite.prepare(sql).all(...values) }; },
            async run() {
              const x = sqlite.prepare(sql).run(...values);
              return { meta: { changes: Number(x.changes) } };
            }
          };
        }
      };
    }
  };

  t.after(() => sqlite.close());
  return { sqlite, database };
}

test("agent booking launch uses authenticated publisher Trip credentials and agent placement", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");
  const result = await getAgentBookingLaunch(
    f.database, session.token, "hotel", ROUTING_ENV
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.agent_booking, {
    publisher_id: "p",
    channel: "agent_booking",
    supplier: "trip.com",
    product: "hotel",
    placement: "agent_booking_p",
    destination_url:
      "https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=agent_booking_p"
  });
});

test("agent booking fails closed for invalid session and unsupported product", async t => {
  const f = fixture(t);
  assert.equal(
    (await getAgentBookingLaunch(f.database, "bad", "hotel", ROUTING_ENV)).status,
    401
  );

  const session = await createSession(f.database, "u");
  assert.deepEqual(
    await getAgentBookingLaunch(f.database, session.token, "flight", ROUTING_ENV),
    { status: 400, body: { error: "invalid_input" } }
  );
});

test("agent booking is publisher-channel authorized, not website-install authorized", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");

  f.sqlite.exec(
    "UPDATE publisher_domains SET install_status='not_detected', verification_status='unverified', claim_status='unclaimed', claim_acquired_at=NULL, claim_ended_at=NULL, claim_end_reason=NULL, review_status='pending', monetization_status='disabled', first_seen_at=NULL, last_seen_at=NULL, verified_at=NULL, reviewed_at=NULL WHERE domain_id='d'"
  );
  f.sqlite.exec(
    "UPDATE publisher_supplier_sites SET provisioning_status='disabled', provisioned_at=NULL WHERE supplier_site_id='s'"
  );

  assert.equal(
    (await getAgentBookingLaunch(
      f.database, session.token, "hotel", ROUTING_ENV
    )).status,
    200
  );

  f.sqlite.exec(
    "UPDATE publisher_channel_capabilities SET capability_status='disabled', disabled_at='2026-09-25' WHERE capability_id='cap'"
  );
  assert.equal(
    (await getAgentBookingLaunch(
      f.database, session.token, "hotel", ROUTING_ENV
    )).status,
    404
  );
});

test("agent booking requires accepted terms, verified email, allowed account state and routing credentials", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");

  f.sqlite.exec("UPDATE publishers SET terms_version=NULL, terms_accepted_at=NULL, terms_accepted_by_user_id=NULL WHERE publisher_id='p'");
  assert.equal(
    (await getAgentBookingLaunch(f.database, session.token, "hotel", ROUTING_ENV)).status,
    404
  );

  f.sqlite.exec("UPDATE publishers SET terms_version='chinaflow-publisher-terms-v1', terms_accepted_at='2026-09-01', terms_accepted_by_user_id='u' WHERE publisher_id='p'");
  f.sqlite.exec("UPDATE publisher_users SET email_verified_at=NULL WHERE user_id='u'");
  assert.equal(
    (await getAgentBookingLaunch(f.database, session.token, "hotel", ROUTING_ENV)).status,
    404
  );

  f.sqlite.exec("UPDATE publisher_users SET email_verified_at='2026-09-01' WHERE user_id='u'");
  f.sqlite.exec("UPDATE publishers SET account_status='rejected' WHERE publisher_id='p'");
  assert.equal(
    (await getAgentBookingLaunch(f.database, session.token, "hotel", ROUTING_ENV)).status,
    404
  );

  f.sqlite.exec("UPDATE publishers SET account_status='draft' WHERE publisher_id='p'");
  assert.deepEqual(
    await getAgentBookingLaunch(f.database, session.token, "hotel", {}),
    { status: 503, body: { error: "temporarily_unavailable" } }
  );
});

test("agent booking rejects ambiguous active agent placements", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");

  f.sqlite.exec(`
    INSERT INTO publisher_placements(
      placement_id,publisher_id,placement,supplier,external_tracking_key,
      is_active,effective_from,channel
    ) VALUES (
      'pl2','p','agent_booking_p_2','trip.com','agent_booking_p_2',
      1,'2026-09-24','agent_booking'
    )
  `);

  const result = await getAgentBookingLaunch(
    f.database, session.token, "hotel", ROUTING_ENV
  );
  assert.deepEqual(result, { status: 409, body: { error: "conflict" } });
});

test("agent booking rollout gate is exact and enabled in TEST and Production configs", () => {
  assert.equal(agentBookingEnabled({ AGENT_BOOKING_ENABLED: "true" }), true);
  for (const value of [undefined, null, "", "false", "TRUE", true, 1]) {
    assert.equal(agentBookingEnabled({ AGENT_BOOKING_ENABLED: value }), false);
  }

  const testConfig = JSON.parse(readFileSync(
    new URL("../../wrangler.publisher-app.test.jsonc", import.meta.url), "utf8"
  ));
  const prodConfig = JSON.parse(readFileSync(
    new URL("../../wrangler.publisher-app.production.jsonc", import.meta.url), "utf8"
  ));

  assert.equal(testConfig.vars.AGENT_BOOKING_ENABLED, "true");
  assert.equal(prodConfig.vars.AGENT_BOOKING_ENABLED, "true");
  assert.equal(testConfig.vars.AGENT_BOOKING_TRIP_AID, "10021103");
  assert.equal(testConfig.vars.AGENT_BOOKING_TRIP_SID, "CHINAFLOW_TEST_ONLY");
  assert.equal(prodConfig.vars.AGENT_BOOKING_TRIP_AID, "10021103");
  assert.equal(prodConfig.vars.AGENT_BOOKING_TRIP_SID, "330739613");
});

test("agent booking API route is gated, same-origin and session-derived", async t => {
  const f = fixture(t);
  const session = await createSession(f.database, "u");
  const env = {
    APP_ORIGIN: ORIGIN,
    AGENT_BOOKING_ENABLED: "true",
    AGENT_BOOKING_TRIP_AID: ROUTING_ENV.AGENT_BOOKING_TRIP_AID,
    AGENT_BOOKING_TRIP_SID: ROUTING_ENV.AGENT_BOOKING_TRIP_SID,
    CHINAFLOW_EVENTS: f.database
  };
  const cookie = `__Host-chinaflow_session=${session.token}`;

  const foreign = await handleAppRequest(
    new Request(ORIGIN + API_ROUTE + "?product=hotel", {
      headers: { Origin: "https://foreign.test", Cookie: cookie }
    }), env
  );
  assert.equal(foreign.status, 403);

  const unauthenticated = await handleAppRequest(
    new Request(ORIGIN + API_ROUTE + "?product=hotel"), env
  );
  assert.equal(unauthenticated.status, 401);

  const ok = await handleAppRequest(
    new Request(ORIGIN + API_ROUTE + "?product=hotel", {
      headers: { Origin: ORIGIN, Cookie: cookie }
    }), env
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.agent_booking.publisher_id, "p");
  assert.equal(body.agent_booking.placement, "agent_booking_p");

  const extra = await handleAppRequest(
    new Request(ORIGIN + API_ROUTE + "?product=hotel&publisher_id=q", {
      headers: { Cookie: cookie }
    }), env
  );
  assert.equal(extra.status, 400);

  for (const method of ["POST","PUT","PATCH","DELETE","OPTIONS"]) {
    const rejected = await handleAppRequest(
      new Request(ORIGIN + API_ROUTE + "?product=hotel", { method }), env
    );
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("Allow"), "GET");
  }
});

test("publisher root redirects to branded login", async () => {
  const env = { APP_ORIGIN: ORIGIN };

  for (const method of ["GET", "HEAD"]) {
    const response = await handleAppRequest(
      new Request(ORIGIN + "/", { method }),
      env
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/login");
  }

  const rejected = await handleAppRequest(
    new Request(ORIGIN + "/", { method: "POST" }),
    env
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("Allow"), "GET, HEAD");
});

test("agent booking page is gated and keeps supplier credentials out of static HTML", async () => {
  const darkEnv = {
    APP_ORIGIN: ORIGIN,
    AGENT_BOOKING_ENABLED: "false",
    get CHINAFLOW_EVENTS() {
      assert.fail("D1 accessed while agent booking is dark");
    }
  };
  const darkApi = await handleAppRequest(
    new Request(ORIGIN + API_ROUTE + "?product=hotel"), darkEnv
  );
  assert.equal(darkApi.status, 404);

  const darkPage = await handleAppRequest(
    new Request(ORIGIN + PAGE_ROUTE), darkEnv
  );
  assert.equal(darkPage.status, 404);

  const page = await handleAppRequest(
    new Request(ORIGIN + PAGE_ROUTE),
    { APP_ORIGIN: ORIGIN, AGENT_BOOKING_ENABLED: "true" }
  );
  assert.equal(page.status, 200);

  assert.match(page.headers.get("Content-Type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /Agent Booking/);
  assert.match(html, /Book hotels for your clients/);
  assert.match(html, /\/api\/agent-booking\/launch\?product=hotel/);
  assert.match(html, /Open Trip\.com/);
  assert.doesNotMatch(html, /10021103|330739613|Allianceid|trip_sub1/);

  for (const method of ["POST","PUT","PATCH","DELETE","OPTIONS"]) {
    const rejected = await handleAppRequest(
      new Request(ORIGIN + PAGE_ROUTE, { method }),
      { APP_ORIGIN: ORIGIN, AGENT_BOOKING_ENABLED: "true" }
    );
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("Allow"), "GET");
  }
});
