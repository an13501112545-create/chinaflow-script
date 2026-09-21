import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../publisher-commercial-activation-api-worker-v0.1.mjs";

const ORIGIN = "https://activation.example.test";
const TOKEN = "activation_test_" + "a".repeat(48);
const ROUTE = "/api/internal/commercial-activation";

const hotel = {
  product: "hotel",
  placement: "p_auto_china_hotels_generic",
  affiliate_url:
    "https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic&trip_sub3=E12TEST"
};

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../collector/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter(name => /^000[1-7]_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }

  sqlite.exec(`
    INSERT INTO publisher_users (user_id,email,email_normalized)
      VALUES ('u','owner@example.test','owner@example.test');
    INSERT INTO publishers (
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id,
      install_public_key
    ) VALUES (
      'p','p','Publisher','pending_review',
      'chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,'u',
      'cfi_0123456789abcdef0123456789abcdef'
    );
    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,review_status,
      monetization_status,first_seen_at,last_seen_at,
      verified_at,reviewed_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','approved','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,
      aid,sid,sid_name,provisioning_status,provisioned_at
    ) VALUES (
      'site','p','d','trip.com',
      '10021103','330739613','chinaflow-p',
      'active',CURRENT_TIMESTAMP
    );
  `);

  let queue = Promise.resolve();
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          const prepared = () => sqlite.prepare(sql);
          return {
            async first() { return prepared().get(...values) ?? null; },
            async all() { return { results: prepared().all(...values) }; },
            async run() {
              const result = prepared().run(...values);
              return { meta: { changes: Number(result.changes) } };
            }
          };
        }
      };
    },
    async batch(statements) {
      const execute = async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      };
      const result = queue.then(execute, execute);
      queue = result.catch(() => {});
      return result;
    }
  };

  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });

  return { sqlite, database };
}

async function request({
  method = "POST",
  path = ROUTE,
  auth = `Bearer ${TOKEN}`,
  body = { publisher_id: "p", offers: [hotel] },
  env
} = {}) {
  const headers = {};
  if (auth !== null) headers.Authorization = auth;
  const init = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return worker.fetch(
    new Request(ORIGIN + path, init),
    env ?? { ACTIVATION_API_TOKEN: TOKEN }
  );
}

test("activation route is POST-only before D1", async () => {
  const env = {
    ACTIVATION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  for (const method of ["GET","HEAD","PUT","PATCH","DELETE","OPTIONS"]) {
    const response = await request({ method, body: undefined, env });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }
});

test("missing or invalid bearer rejects before D1", async () => {
  const env = {
    ACTIVATION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  for (const auth of [
    null, "", "Bearer", "Bearer wrong",
    `Basic ${TOKEN}`, `Bearer ${TOKEN}x`
  ]) {
    const response = await request({ auth, env });
    assert.equal(response.status, 401);
  }
});

test("invalid configured secret fails closed before D1", async () => {
  for (const secret of [undefined, "", "short", "a".repeat(513)]) {
    const env = {
      ...(secret === undefined ? {} : { ACTIVATION_API_TOKEN: secret }),
      get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
    };
    const response = await request({ env });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  }
});

test("query and malformed input reject before D1", async () => {
  const env = {
    ACTIVATION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  assert.equal(
    (await request({ path: ROUTE + "?publisher_id=p", env })).status,
    400
  );
  for (const body of [
    "", "{", "null", "[]", "{}",
    JSON.stringify({ publisher_id: "p", offers: [hotel], supplier: "trip.com" }),
    "x".repeat(16385)
  ]) {
    assert.equal((await request({ body, env })).status, 400);
  }
});

test("authenticated activation creates commercial graph and activates publisher", async t => {
  const f = fixture(t);
  const response = await request({
    env: {
      ACTIVATION_API_TOKEN: TOKEN,
      CHINAFLOW_EVENTS: f.database,
      APP_ENVIRONMENT: "test"
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  const body = await response.json();
  assert.equal(body.activation.activated, true);
  assert.equal(body.activation.account_status, "active");
  assert.equal(body.activation.monetization_status, "enabled");
  assert.equal(body.activation.offer_count, 1);

  const state = f.sqlite.prepare(`
    SELECT p.account_status,d.monetization_status
    FROM publishers p JOIN publisher_domains d
      ON d.publisher_id=p.publisher_id AND d.is_primary=1
    WHERE p.publisher_id='p'
  `).get();
  assert.equal(state.account_status, "active");
  assert.equal(state.monetization_status, "enabled");
  assert.equal(
    f.sqlite.prepare("SELECT count(*) AS n FROM publisher_placements").get().n,
    1
  );
  assert.equal(
    f.sqlite.prepare("SELECT count(*) AS n FROM publisher_supplier_offers").get().n,
    1
  );
});

test("authenticated exact retry is idempotent", async t => {
  const f = fixture(t);
  const env = {
    ACTIVATION_API_TOKEN: TOKEN,
    CHINAFLOW_EVENTS: f.database
  };
  assert.equal((await request({ env })).status, 200);
  const retry = await request({ env });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).activation.activated, false);
});

test("valid auth still enforces strict activation input", async t => {
  const f = fixture(t);
  const response = await request({
    body: { publisher_id: "p", offers: [], supplier: "trip.com" },
    env: {
      ACTIVATION_API_TOKEN: TOKEN,
      CHINAFLOW_EVENTS: f.database
    }
  });
  assert.equal(response.status, 400);
  assert.equal(
    f.sqlite.prepare("SELECT count(*) AS n FROM publisher_placements").get().n,
    0
  );
});

test("health is read-only and unknown routes stay closed", async () => {
  const health = await request({
    method: "GET",
    path: "/health",
    body: undefined,
    auth: null,
    env: { APP_ENVIRONMENT: "test" }
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "chinaflow-publisher-activation-api",
    environment: "test"
  });

  const missing = await request({
    path: "/api/internal/unknown",
    env: { ACTIVATION_API_TOKEN: TOKEN }
  });
  assert.equal(missing.status, 404);
});
