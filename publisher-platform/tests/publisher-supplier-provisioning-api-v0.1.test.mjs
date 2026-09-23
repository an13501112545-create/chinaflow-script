import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../publisher-supplier-provisioning-api-worker-v0.1.mjs";

const ORIGIN = "https://provision.example.test";
const TOKEN = "provision_test_" + "a".repeat(48);
const START = "/api/internal/supplier-provisioning/start";
const COMPLETE = "/api/internal/supplier-provisioning/complete";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../collector/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter(name => /^000[1-9]_.*\.sql$/.test(name)).sort()) {
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
      install_status,verification_status,claim_status,claim_acquired_at,review_status,
      monetization_status,first_seen_at,last_seen_at,
      verified_at,reviewed_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','claimed',CURRENT_TIMESTAMP,'approved','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
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
    try {
      assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      sqlite.close();
    }
  });

  return { sqlite, database };
}

async function request({
  method = "POST",
  path = START,
  auth = `Bearer ${TOKEN}`,
  body = { publisher_id: "p" },
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
    env ?? { PROVISION_API_TOKEN: TOKEN }
  );
}

test("provisioning routes are POST-only before D1", async () => {
  const env = {
    PROVISION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  for (const path of [START, COMPLETE]) {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await request({
        path,
        method,
        body: undefined,
        env
      });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "POST");
    }
  }
});

test("missing or invalid bearer token rejects before D1", async () => {
  const env = {
    PROVISION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  for (const auth of [
    null,
    "",
    "Bearer",
    "Bearer wrong",
    `Basic ${TOKEN}`,
    `Bearer ${TOKEN}x`
  ]) {
    const response = await request({ auth, env });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
});

test("missing or invalid configured secret fails closed before D1", async () => {
  for (const secret of [undefined, "", "short", "a".repeat(513)]) {
    const env = {
      ...(secret === undefined ? {} : { PROVISION_API_TOKEN: secret }),
      get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
    };
    const response = await request({ env });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  }
});

test("query and malformed start input reject before D1", async () => {
  const env = {
    PROVISION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };

  assert.equal(
    (await request({
      path: START + "?publisher_id=p",
      env
    })).status,
    400
  );

  for (const body of [
    "",
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ publisher_id: "p", supplier: "trip.com" }),
    "x".repeat(4097)
  ]) {
    const response = await request({ body, env });
    assert.equal(response.status, 400);
  }
});

test("query and malformed complete input reject before D1", async () => {
  const env = {
    PROVISION_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };

  assert.equal(
    (await request({
      path: COMPLETE + "?publisher_id=p",
      body: {
        publisher_id: "p",
        aid: "10021103",
        sid: "330739613"
      },
      env
    })).status,
    400
  );

  for (const body of [
    "",
    "{",
    "{}",
    JSON.stringify({ publisher_id: "p" }),
    JSON.stringify({
      publisher_id: "p",
      aid: "10021103",
      sid: "330739613",
      supplier: "trip.com"
    }),
    "x".repeat(4097)
  ]) {
    const response = await request({
      path: COMPLETE,
      body,
      env
    });
    assert.equal(response.status, 400);
  }
});

test("authenticated start creates real pending supplier site", async t => {
  const f = fixture(t);
  const response = await request({
    env: {
      PROVISION_API_TOKEN: TOKEN,
      CHINAFLOW_EVENTS: f.database,
      APP_ENVIRONMENT: "test"
    }
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);

  const body = await response.json();
  assert.equal(body.provisioning.supplier, "trip.com");
  assert.equal(body.provisioning.provisioning_status, "pending");
  assert.equal(body.provisioning.created, true);

  const stored = f.sqlite.prepare(
    "SELECT * FROM publisher_supplier_sites"
  ).get();
  assert.equal(stored.publisher_id, "p");
  assert.equal(stored.domain_id, "d");
  assert.equal(stored.provisioning_status, "pending");
});

test("authenticated complete activates supplier site without offers", async t => {
  const f = fixture(t);
  const env = {
    PROVISION_API_TOKEN: TOKEN,
    CHINAFLOW_EVENTS: f.database,
    APP_ENVIRONMENT: "test"
  };

  assert.equal((await request({ env })).status, 201);

  const response = await request({
    path: COMPLETE,
    body: {
      publisher_id: "p",
      aid: "10021103",
      sid: "330739613",
      sid_name: "chinaflow-e11"
    },
    env
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provisioning.provisioning_status, "active");
  assert.equal(body.provisioning.aid, "10021103");
  assert.equal(body.provisioning.sid, "330739613");
  assert.equal(body.provisioning.sid_name, "chinaflow-e11");

  assert.equal(
    f.sqlite.prepare(
      "SELECT count(*) AS n FROM publisher_supplier_offers"
    ).get().n,
    0
  );
  assert.equal(
    f.sqlite.prepare(
      "SELECT count(*) AS n FROM publisher_placements"
    ).get().n,
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
    service: "chinaflow-publisher-provisioning-api",
    environment: "test"
  });

  const missing = await request({
    path: "/api/internal/unknown",
    env: { PROVISION_API_TOKEN: TOKEN }
  });
  assert.equal(missing.status, 404);
});
