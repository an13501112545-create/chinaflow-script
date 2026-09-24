import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../publisher-claim-admin-api-worker-v0.1.mjs";

const ORIGIN = "https://claim-admin.example.test";
const TOKEN = "claim_admin_test_" + "a".repeat(48);
const ROUTE = "/api/internal/hostname-claim/revoke";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|0010)_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 10);
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));

  sqlite.exec(`
    INSERT INTO publishers(publisher_id,slug,display_name,account_status)
      VALUES ('p','p','Publisher','active');
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,claim_status,claim_acquired_at,
      review_status,monetization_status,
      first_seen_at,last_seen_at,verified_at,reviewed_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','claimed','2026-01-01',
      'approved','enabled',
      '2026-01-01','2026-01-01','2026-01-01','2026-01-01'
    );
  `);

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
  body = { publisher_id: "p", hostname: "example.test" },
  env = {}
} = {}) {
  const headers = {};
  if (auth !== null) headers.Authorization = auth;
  const init = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return worker.fetch(new Request(ORIGIN + path, init), env);
}

test("claim admin mutation route is dark before cutover and rejects before secret or D1", async () => {
  const env = {
    CLAIM_ADMIN_REVOKE_ENABLED: "false",
    get CLAIM_ADMIN_API_TOKEN() { assert.fail("secret accessed"); },
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  const response = await request({ env });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("health remains available while mutation route is dark", async () => {
  const response = await request({
    method: "GET",
    path: "/health",
    body: undefined,
    auth: null,
    env: {
      APP_ENVIRONMENT: "test",
      CLAIM_ADMIN_REVOKE_ENABLED: "false"
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "chinaflow-publisher-claim-admin-api",
    environment: "test"
  });
});

test("enabled claim admin route enforces POST and bearer auth before D1", async () => {
  const env = {
    CLAIM_ADMIN_REVOKE_ENABLED: "true",
    CLAIM_ADMIN_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  for (const method of ["GET","HEAD","PUT","PATCH","DELETE","OPTIONS"]) {
    const response = await request({ method, body: undefined, env });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }
  for (const auth of [null,"","Bearer","Bearer wrong",`Basic ${TOKEN}`,`Bearer ${TOKEN}x`]) {
    const response = await request({ auth, env });
    assert.equal(response.status, 401);
  }
});

test("invalid configured admin secret fails closed before D1", async () => {
  for (const secret of [undefined,"","short","a".repeat(513)]) {
    const env = {
      CLAIM_ADMIN_REVOKE_ENABLED: "true",
      ...(secret === undefined ? {} : { CLAIM_ADMIN_API_TOKEN: secret }),
      get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
    };
    const response = await request({ env });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  }
});

test("query and malformed admin input reject before D1", async () => {
  const env = {
    CLAIM_ADMIN_REVOKE_ENABLED: "true",
    CLAIM_ADMIN_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  assert.equal((await request({ path: ROUTE + "?publisher_id=p", env })).status, 400);
  for (const body of [
    "", "{", "null", "[]", "{}",
    JSON.stringify({ publisher_id: "p" }),
    JSON.stringify({ hostname: "example.test" }),
    JSON.stringify({ publisher_id: "p", hostname: "example.test", reason: "forged" }),
    "x".repeat(4097)
  ]) {
    assert.equal((await request({ body, env })).status, 400);
  }
});

test("authenticated admin revoke preserves verification and pauses monetization", async t => {
  const f = fixture(t);
  const env = {
    APP_ENVIRONMENT: "test",
    CLAIM_ADMIN_REVOKE_ENABLED: "true",
    CLAIM_ADMIN_API_TOKEN: TOKEN,
    CHINAFLOW_EVENTS: f.database
  };
  const response = await request({ env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    claim: {
      publisher_id: "p",
      hostname: "example.test",
      claim_status: "revoked",
      monetization_status: "paused",
      revoked: true
    }
  });
  const stored = f.sqlite.prepare(`
    SELECT verification_status,claim_status,claim_end_reason,monetization_status
    FROM publisher_domains WHERE domain_id='d'
  `).get();
  assert.equal(stored.verification_status, "verified");
  assert.equal(stored.claim_status, "revoked");
  assert.equal(stored.claim_end_reason, "admin_revoke");
  assert.equal(stored.monetization_status, "paused");

  const retry = await request({ env });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).claim.revoked, false);
});

test("claim admin revoke gate is enabled in TEST and Production requires isolated secret", () => {
  const testConfig = JSON.parse(readFileSync(
    new URL("../../wrangler.publisher-claim-admin-api.test.jsonc", import.meta.url),
    "utf8"
  ));
  const productionConfig = JSON.parse(readFileSync(
    new URL("../../wrangler.publisher-claim-admin-api.production.jsonc", import.meta.url),
    "utf8"
  ));
  assert.equal(testConfig.vars.CLAIM_ADMIN_REVOKE_ENABLED, "true");
  assert.equal(productionConfig.vars.CLAIM_ADMIN_REVOKE_ENABLED, "true");
  assert.deepEqual(productionConfig.secrets.required, ["CLAIM_ADMIN_API_TOKEN"]);
  assert.equal(productionConfig.secrets.required.includes("REVIEW_API_TOKEN"), false);
  assert.equal(productionConfig.secrets.required.includes("PROVISION_API_TOKEN"), false);
  assert.equal(productionConfig.secrets.required.includes("ACTIVATION_API_TOKEN"), false);
});
