import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAppRequest } from "../app-worker-v0.1.mjs";
import { createSession } from "../auth-session-store-v0.1.mjs";

const ORIGIN = "https://publisher.example.test";
const ROUTE = "/api/onboarding/release-hostname";
const HOSTNAME = "example.test";

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|0010)_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 10);
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));

  sqlite.exec(`
    INSERT INTO publisher_users(user_id,email,email_normalized)
      VALUES ('u','owner@example.test','owner@example.test');
    INSERT INTO publishers(
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id,
      install_public_key
    ) VALUES (
      'p','p','Publisher','active',
      'chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,'u',
      'cfi_0123456789abcdef0123456789abcdef'
    );
    INSERT INTO publisher_memberships(
      membership_id,publisher_id,user_id,role,membership_status
    ) VALUES ('m','p','u','owner','active');
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
  const session = await createSession(database, "u");

  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });

  return { sqlite, database, token: session.token };
}

async function request({
  method = "POST",
  origin = ORIGIN,
  cookie,
  body = JSON.stringify({ hostname: HOSTNAME }),
  suffix = "",
  env = {}
} = {}) {
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (cookie !== undefined) headers.Cookie = cookie;
  const init = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
  return handleAppRequest(new Request(ORIGIN + ROUTE + suffix, init), env);
}

test("owner release route is dark before cutover and does not inspect D1", async () => {
  const env = {
    APP_ORIGIN: ORIGIN,
    CLAIM_LIFECYCLE_MUTATIONS_ENABLED: "false",
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  const response = await request({ env });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("enabled owner release route enforces POST, exact Origin, session and strict input", async t => {
  const f = await fixture(t);
  const baseEnv = {
    APP_ORIGIN: ORIGIN,
    CLAIM_LIFECYCLE_MUTATIONS_ENABLED: "true",
    CHINAFLOW_EVENTS: f.database
  };

  for (const method of ["GET","HEAD","PUT","PATCH","DELETE","OPTIONS"]) {
    const response = await request({ method, body: undefined, env: baseEnv });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }

  for (const badOrigin of [null,"https://foreign.test",ORIGIN+"/",ORIGIN+".evil",ORIGIN.replace("https:","http:")]) {
    assert.equal((await request({ origin: badOrigin, env: baseEnv })).status, 403);
  }

  assert.equal((await request({ env: baseEnv })).status, 401);

  const cookie = `__Host-chinaflow_session=${f.token}`;
  assert.equal((await request({ cookie, suffix: "?hostname=forged", env: baseEnv })).status, 400);
  for (const body of [
    "", "{", "null", "[]", "{}",
    JSON.stringify({ hostname: HOSTNAME, publisher_id: "p" }),
    JSON.stringify({ hostname: "https://example.test" }),
    "x".repeat(4097)
  ]) {
    assert.equal((await request({ cookie, body, env: baseEnv })).status, 400);
  }
});

test("enabled owner release route releases only the session-owned hostname and retry is idempotent", async t => {
  const f = await fixture(t);
  const env = {
    APP_ORIGIN: ORIGIN,
    CLAIM_LIFECYCLE_MUTATIONS_ENABLED: "true",
    CHINAFLOW_EVENTS: f.database
  };
  const cookie = `__Host-chinaflow_session=${f.token}`;

  const response = await request({ cookie, env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    claim: {
      hostname: HOSTNAME,
      claim_status: "released",
      monetization_status: "paused",
      released: true
    }
  });

  const stored = f.sqlite.prepare(`
    SELECT verification_status,claim_status,claim_end_reason,monetization_status
    FROM publisher_domains WHERE domain_id='d'
  `).get();
  assert.equal(stored.verification_status, "verified");
  assert.equal(stored.claim_status, "released");
  assert.equal(stored.claim_end_reason, "owner_release");
  assert.equal(stored.monetization_status, "paused");

  const retry = await request({ cookie, env });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).claim.released, false);
});

test("publisher app TEST and Production configs keep claim mutations disabled before cutover", () => {
  for (const file of [
    "../../wrangler.publisher-app.test.jsonc",
    "../../wrangler.publisher-app.production.jsonc"
  ]) {
    const config = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    assert.equal(config.vars.CLAIM_LIFECYCLE_MUTATIONS_ENABLED, "false");
  }
});
