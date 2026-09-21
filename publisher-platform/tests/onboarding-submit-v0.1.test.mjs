import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAppRequest } from "../app-worker-v0.1.mjs";
import { createSession } from "../auth-session-store-v0.1.mjs";

const origin = "https://publisher.example.test";
const path = "/api/onboarding/submit";

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../collector/migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(n => /^000[1-7]_.*\.sql$/.test(n)).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO publisher_users (user_id,email,email_normalized) VALUES ('u','u@example.test','u@example.test');
    INSERT INTO publishers (publisher_id,slug,display_name,terms_version,terms_accepted_at,
      terms_accepted_by_user_id,install_public_key) VALUES
      ('p','p','Publisher','chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,'u','cfi_0123456789abcdef0123456789abcdef');
    INSERT INTO publisher_memberships (membership_id,publisher_id,user_id) VALUES ('m','p','u');
    INSERT INTO publisher_domains (domain_id,publisher_id,hostname,is_primary,install_status,
      verification_status,first_seen_at,last_seen_at,verified_at) VALUES
      ('d','p','example.test',1,'detected','verified',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
  `);
  const state = { beforeUpdate: null, updates: 0 };
  const db = { prepare(sql) { return { bind(...values) {
    const execute = () => {
      if (/^\s*UPDATE publishers\b/i.test(sql)) {
        state.updates++;
        state.beforeUpdate?.();
      }
      return sqlite.prepare(sql);
    };
    return {
      async first() { return execute().get(...values) ?? null; },
      async all() { return { results: execute().all(...values) }; },
      async run() { return { meta: execute().run(...values) }; }
    };
  } }; } };
  const session = await createSession(db, "u");
  async function request({ token = session.token, suffix = "", body } = {}) {
    const response = await handleAppRequest(new Request(origin + path + suffix, {
      method: "POST", headers: { Origin: origin,
        ...(token === null ? {} : { Cookie: `__Host-chinaflow_session=${token}` }) },
      ...(body === undefined ? {} : { body })
    }), { APP_ORIGIN: origin, CHINAFLOW_EVENTS: db });
    return { status: response.status, body: await response.json() };
  }
  return { sqlite, state, request };
}

test("submit method, exact Origin, and missing cookie reject before D1/session processing", async () => {
  const env = { APP_ORIGIN: origin, get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); } };
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await handleAppRequest(new Request(origin + path, { method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }
  for (const bad of [null, "null", "https://foreign.test", origin + "/", origin + ".evil", origin.replace("https:", "http:")]) {
    const response = await handleAppRequest(new Request(origin + path, {
      method: "POST", headers: bad === null ? {} : { Origin: bad }
    }), env);
    assert.equal(response.status, 403);
  }
  assert.equal((await handleAppRequest(new Request(origin + path, {
    method: "POST", headers: { Origin: origin }
  }), env)).status, 401);
});

test("empty non-null request body is accepted but actual payload is rejected", async t => {
  const f = await fixture(t);
  const empty = new Uint8Array(0);
  const probe = new Request(origin + path, {
    method: "POST",
    body: empty
  });
  assert.notEqual(probe.body, null);

  assert.equal(
    (await f.request({ body: empty })).status,
    200
  );
  assert.equal(
    (await f.request({ body: "{}" })).status,
    400
  );
});

test("verified draft submits without review approval or suppliers; retry does not mutate", async t => {
  const f = await fixture(t);
  const tables = ["publisher_domains", "publisher_supplier_sites", "publisher_supplier_offers", "publisher_placements"];
  const snapshot = () => tables.map(table => f.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  assert.deepEqual(await f.request(), { status: 200, body: {
    submission: { account_status: "pending_review", submitted: true }
  } });
  assert.equal(f.state.updates, 1);
  f.sqlite.exec("UPDATE publishers SET updated_at='2001-01-01'");
  const publisher = f.sqlite.prepare("SELECT * FROM publishers").get();
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM publishers").get(), publisher);
  assert.deepEqual(snapshot(), before);
});

const invalid = [
  ["DELETE FROM publisher_memberships", 403],
  ["UPDATE publisher_memberships SET role='member'", 403],
  ["UPDATE publisher_memberships SET membership_status='removed'", 403],
  ["UPDATE publishers SET terms_version=NULL", 409],
  ["UPDATE publishers SET terms_version='old'", 409],
  ["UPDATE publishers SET terms_accepted_at=NULL", 409],
  ["UPDATE publishers SET terms_accepted_by_user_id=NULL", 409],
  ["UPDATE publishers SET install_public_key=NULL", 409],
  ["UPDATE publishers SET install_public_key='cfi_INVALID'", 409],
  ["UPDATE publisher_domains SET is_primary=0", 409],
  ...["first_seen_at", "last_seen_at", "verified_at"].map(field => [`UPDATE publisher_domains SET ${field}=NULL`, 409]),
  ...["active", "suspended", "rejected", "closed"].map(value => [`UPDATE publishers SET account_status='${value}'`, 409]),
  ["UPDATE publisher_sessions SET revoked_at=CURRENT_TIMESTAMP", 401],
  ["UPDATE publisher_sessions SET expires_at='2000-01-01'", 401],
  ["UPDATE publisher_users SET user_status='disabled'", 401],
  [`INSERT INTO publishers (publisher_id,slug,display_name) VALUES ('p2','p2','Other');
    INSERT INTO publisher_memberships (membership_id,publisher_id,user_id) VALUES ('m2','p2','u')`, 409],
  [`DROP INDEX ux_publisher_domains_one_primary;
    INSERT INTO publisher_domains (domain_id,publisher_id,hostname,is_primary) VALUES ('d2','p','other.test',1)`, 409]
];
for (const install of ["pending", "not_detected", "detected"]) {
  for (const verification of ["unverified", "failed", "verified"]) {
    if (install !== "detected" || verification !== "verified") {
      invalid.push([`UPDATE publisher_domains SET install_status='${install}', verification_status='${verification}'`, 409]);
    }
  }
}
for (const [mutation, status] of invalid) {
  test(`submit eligibility: ${mutation}`, async t => {
    const f = await fixture(t);
    f.sqlite.exec(mutation);
    const before = f.sqlite.prepare("SELECT * FROM publishers").all();
    assert.equal((await f.request()).status, status);
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM publishers").all(), before);
  });
  test(`submit write boundary rechecks: ${mutation}`, async t => {
    const f = await fixture(t);
    f.state.beforeUpdate = () => f.sqlite.exec(mutation);
    const result = await f.request();
    assert.ok([401, 403, 409].includes(result.status), JSON.stringify(result));
    assert.equal(f.state.updates, 1);
    assert.notEqual(f.sqlite.prepare("SELECT account_status FROM publishers WHERE publisher_id='p'").get().account_status, "pending_review");
  });
}

test("invalid session and client tenant selectors cannot submit", async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ token: "0".repeat(64) })).status, 401);
  for (const name of ["publisher_id", "domain_id", "hostname", "install_public_key"]) {
    assert.equal((await f.request({ suffix: `?${name}=forged` })).status, 400);
    assert.equal((await f.request({ body: JSON.stringify({ [name]: "forged" }) })).status, 400);
  }
  assert.equal(f.state.updates, 0);
});


test("populated supplier tables and all domain fields remain unchanged", async t => {
  const f = await fixture(t);
  f.sqlite.exec(`
    UPDATE publisher_domains SET review_status='rejected', monetization_status='paused';
    INSERT INTO publisher_placements (placement_id,publisher_id,placement,supplier,external_tracking_key)
      VALUES ('place','p','existing','trip','existing_key');
    INSERT INTO publisher_supplier_sites (supplier_site_id,publisher_id,domain_id,supplier,provisioning_status)
      VALUES ('site','p','d','trip','failed');
    INSERT INTO publisher_supplier_offers (supplier_offer_id,supplier_site_id,publisher_id,domain_id,
      offer_key,product,placement_id,affiliate_url,is_active)
      VALUES ('offer','site','p','d','hotel','hotel','place','https://example.test/existing',0);
  `);
  const tables = ["publisher_domains", "publisher_supplier_sites", "publisher_supplier_offers", "publisher_placements"];
  const snapshot = () => tables.map(table => f.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  for (const table of tables) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    f.sqlite.exec(`CREATE TRIGGER protect_${table}_${operation} BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'protected table write'); END`);
  }
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(snapshot(), before);
});

for (const mutation of [
  "DELETE FROM publisher_memberships",
  "UPDATE publisher_memberships SET role='admin'",
  "UPDATE publisher_sessions SET revoked_at=CURRENT_TIMESTAMP",
  "UPDATE publisher_users SET user_status='disabled'"
]) test(`pending review retry still requires authorization: ${mutation}`, async t => {
  const f = await fixture(t);
  f.sqlite.exec("UPDATE publishers SET account_status='pending_review'");
  f.sqlite.exec(mutation);
  assert.ok([401, 403].includes((await f.request()).status));
  assert.equal(f.state.updates, 0);
});

test("concurrent submission is acknowledged without a second state mutation", async t => {
  const f = await fixture(t);
  f.state.beforeUpdate = () => f.sqlite.exec("UPDATE publishers SET account_status='pending_review', updated_at='2001-01-01'");
  assert.equal((await f.request()).status, 200);
  assert.equal(f.sqlite.prepare("SELECT updated_at FROM publishers").get().updated_at, "2001-01-01");
});
