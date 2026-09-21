import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker, { handleAppRequest } from "../app-worker-v0.1.mjs";
import { createOnboardingDraft, normalizeOnboardingHostname } from "../onboarding-draft-v0.1.mjs";
import { createSession } from "../auth-session-store-v0.1.mjs";
import { createMagicLink } from "../auth-magic-link-store-v0.1.mjs";
import { buildPublisherConfigFromD1 } from "../config-reader-d1-v0.1.mjs";

const TEST_APP_ORIGIN = "https://app.getchinaflow.com";
const TEST_AUTH_ORIGIN = "https://auth.getchinaflow.com";

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(migrations).filter(name => /^000[1-7]_.*\.sql$/.test(name)).sort();
  assert.equal(files.length, 7);
  for (const file of files) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  sqlite.exec(`INSERT INTO publisher_users (user_id,email,email_normalized) VALUES
    ('user1','one@example.com','one@example.com'),('user2','two@example.com','two@example.com')`);
  const state = { batches: 0, beforeBatch: null };
  const db = {
    prepare(sql) {
      return { bind(...values) {
        const statement = sqlite.prepare(sql);
        return {
          async first() { return statement.get(...values) ?? null; },
          async all() { return { results: statement.all(...values) }; },
          async run() { return { meta: statement.run(...values) }; },
          execute() {
            const results = statement.all(...values);
            return { results, meta: { changes: sqlite.prepare("SELECT changes() AS n").get().n } };
          }
        };
      } };
    },
    async batch(statements) {
      state.batches++;
      state.beforeBatch?.();
      // D1 batch executes sequentially in a transaction; competing requests may
      // both validate before reaching this serialized write boundary.
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(s => s.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  };
  const sessions = [await createSession(db, "user1"), await createSession(db, "user2")];
  const counts = () => ["publishers", "publisher_memberships", "publisher_domains"].map(table =>
    sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  async function request({ method = "POST", token = sessions[0].token, origin = TEST_APP_ORIGIN, appOrigin = TEST_APP_ORIGIN,
    body = { display_name: "Example Company", hostname: "Travel.Example.COM." }, path = "/api/onboarding/draft" } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token !== null) headers.Cookie = `__Host-chinaflow_session=${token}`;
    if (origin !== null) headers.Origin = origin;
    const requestEnv = { CHINAFLOW_EVENTS: db };
    if (appOrigin !== null) requestEnv.APP_ORIGIN = appOrigin;
    const response = await handleAppRequest(new Request(`${TEST_APP_ORIGIN}${path}`, {
      method, headers, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
    }), requestEnv);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { sqlite, db, state, sessions, counts, request };
}

const input = { display_name: "Example Company", hostname: "travel.example.com" };

test("create, authorized GET/retry, exact defaults, no supplier or placement writes, empty draft config", async t => {
  const f = await fixture(t);
  const untouched = ["publisher_supplier_sites", "publisher_supplier_offers", "publisher_placements"];
  const snapshots = () => untouched.map(table => f.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshots();
  assert.equal((await f.request({ method: "GET" })).status, 404);
  const created = await f.request();
  assert.equal(created.status, 201);
  assert.deepEqual(f.counts(), [1, 1, 1]);
  const p = f.sqlite.prepare("SELECT * FROM publishers").get();
  const m = f.sqlite.prepare("SELECT * FROM publisher_memberships").get();
  const d = f.sqlite.prepare("SELECT * FROM publisher_domains").get();
  assert.equal(p.account_status, "draft");
  assert.equal(p.country_code, null);
  assert.equal(p.terms_version, null);
  assert.equal(p.terms_accepted_at, null);
  assert.equal(p.terms_accepted_by_user_id, null);
  assert.match(p.install_public_key, /^cfi_[0-9a-f]{32}$/);
  assert.equal(m.publisher_id, p.publisher_id);
  assert.equal(m.user_id, "user1");
  assert.equal(m.role, "owner");
  assert.equal(m.membership_status, "active");
  assert.equal(d.publisher_id, p.publisher_id);
  assert.equal(d.is_primary, 1);
  assert.equal(d.install_status, "pending");
  assert.equal(d.verification_status, "unverified");
  assert.equal(d.review_status, "pending");
  assert.equal(d.monetization_status, "disabled");
  for (const key of ["first_seen_at", "last_seen_at", "verified_at", "reviewed_at"]) assert.equal(d[key], null);
  assert.deepEqual(created.body, { draft: { publisher: {
    publisher_id: p.publisher_id, slug: p.slug, display_name: input.display_name,
    account_status: "draft", install_public_key: p.install_public_key
  }, primary_domain: {
    hostname: input.hostname,
    install_status: "pending",
    verification_status: "unverified",
    review_status: "pending",
    monetization_status: "disabled",
    reviewed_at: null
  } } });
  assert.deepEqual((await f.request({ method: "GET" })).body, created.body);
  const retry = await f.request({ body: input });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, created.body);
  for (const body of [{ ...input, hostname: "another.example.com" }, { ...input, display_name: "Changed" }]) {
    const conflict = await f.request({ body });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { error: "conflict" });
  }
  assert.deepEqual(f.counts(), [1, 1, 1]);
  assert.deepEqual(snapshots(), before);
  assert.deepEqual((await buildPublisherConfigFromD1(f.db, p.publisher_id, d.hostname)).offers, []);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("simultaneous same-user submissions create exactly one unit", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.request()));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  for (const result of results) assert.deepEqual(result.body, results[0].body);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("different users race for canonical hostname: generic conflict and no orphans", async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    f.request({ body: { ...input, hostname: "BÜCHER.Example." } }),
    f.request({ token: f.sessions[1].token, body: { ...input, hostname: "xn--bcher-kva.example" } })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.deepEqual(results.find(r => r.status === 409).body, { error: "conflict" });
  assert.deepEqual(f.counts(), [1, 1, 1]);
  assert.equal((await f.request({ token: f.sessions[results.findIndex(r => r.status === 409)].token, method: "GET" })).status, 404);
});

for (const table of ["publishers", "publisher_memberships", "publisher_domains"]) {
  test(`injected ${table} failure rolls back whole unit and is never retried`, async t => {
    const f = await fixture(t);
    f.sqlite.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await assert.rejects(f.request(), /injected failure/);
    assert.deepEqual(f.counts(), [0, 0, 0]);
    assert.equal(f.state.batches, 1);
  });
}

for (const mutation of [
  "UPDATE publisher_sessions SET revoked_at = CURRENT_TIMESTAMP",
  "UPDATE publisher_sessions SET expires_at = '2000-01-01T00:00:00.000Z'",
  "UPDATE publisher_users SET user_status = 'disabled'"
]) {
  test(`transaction guard rechecks eligibility: ${mutation}`, async t => {
    const f = await fixture(t);
    f.state.beforeBatch = () => f.sqlite.exec(mutation);
    assert.equal((await f.request()).status, 401);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}

test("zero-row first insert cannot attach rows even when generated IDs already exist", async t => {
  const f = await fixture(t);
  const uuid = "11111111-1111-4111-8111-111111111111";
  f.sqlite.prepare("INSERT INTO publishers (publisher_id,slug,display_name) VALUES (?, 'existing', 'Existing')").run(`pub_${uuid}`);
  f.sqlite.prepare("INSERT INTO publisher_memberships (membership_id,publisher_id,user_id,membership_status) VALUES (?,?,'user1','removed')").run(`mem_${uuid}`, `pub_${uuid}`);
  const original = crypto.randomUUID;
  crypto.randomUUID = () => uuid;
  t.after(() => { crypto.randomUUID = original; });
  assert.deepEqual(await createOnboardingDraft(f.db, f.sessions[0].token, input), { status: 409, body: { error: "conflict" } });
  assert.deepEqual(f.counts(), [1, 1, 0]);
  assert.equal(f.state.batches, 1);
});

for (const [raw, expected] of [
  ["TRAVEL.Example.COM.", "travel.example.com"], ["bücher.example", "xn--bcher-kva.example"],
  ["news.travel.example.com", "news.travel.example.com"], ["例子.中国", "xn--fsqu00a.xn--fiqs8s"],
  ...["https://example.com", "example.com/path", "example.com:443", "user@example.com", "user:pass@example.com",
    "example.com?x=1", "example.com#hash", "example.com\\path", " example.com", "example.com\n", "example.com..",
    "example..com", "-bad.example", "bad_.example", "localhost", "127.0.0.1", "[::1]", "0x7f000001",
    "%65xample.com", `${"a".repeat(64)}.com`, `${"a.".repeat(128)}com`].map(raw => [raw, null])
]) {
  test(`hostname: ${JSON.stringify(raw)}`, () => assert.equal(normalizeOnboardingHostname(raw), expected));
}

for (const body of ["{", "null", "[]", "{}", "x".repeat(4097),
  { ...input, display_name: "" }, { ...input, display_name: "a".repeat(201) },
  { ...input, display_name: "<script>" }, { ...input, display_name: 123 }, { ...input, hostname: "a".repeat(1025) },
  ...["user_id", "publisher_id", "slug", "account_status", "role", "membership_status", "terms_version",
    "terms_accepted_at", "install_public_key", "supplier_credentials", "affiliate_url",
    "external_tracking_key", "country_code",
    "domain_id", "is_primary", "__proto__"].map(key => ({ ...input, [key]: "forged" }))
]) {
  test(`invalid or forbidden input: ${JSON.stringify(body).slice(0, 100)}`, async t => {
    const f = await fixture(t);
    const result = await f.request({ body });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "invalid_input" });
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}

for (const origin of [null, "null", "https://evil.example", "http://app.getchinaflow.com", "https://app.getchinaflow.com/", "https://app.getchinaflow.com.evil.example"]) {
  test(`POST rejects origin ${origin}`, async t => {
    const f = await fixture(t);
    assert.equal((await f.request({ origin })).status, 403);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}

for (const appOrigin of [null, "", "not an origin", "http://app.getchinaflow.com", "https://app.getchinaflow.com/"]) {
  test(`POST fails closed for configured APP_ORIGIN ${appOrigin}`, async t => {
    const f = await fixture(t);
    const env = { CHINAFLOW_EVENTS: f.db };
    if (appOrigin !== null) env.APP_ORIGIN = appOrigin;
    const response = await worker.fetch(new Request(`${TEST_APP_ORIGIN}/api/onboarding/draft`, {
      method: "POST",
      headers: { Origin: TEST_APP_ORIGIN, "Content-Type": "application/json", Cookie: `__Host-chinaflow_session=${f.sessions[0].token}` },
      body: JSON.stringify(input)
    }), env);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}

for (const authOrigin of [
  null,
  "",
  "not an origin",
  "http://auth.getchinaflow.com",
  "https://auth.getchinaflow.com/"
]) {
  test(`login page fails closed for configured CHINAFLOW_AUTH_ORIGIN ${authOrigin}`, async t => {
    const f = await fixture(t);
    const env = {
      CHINAFLOW_EVENTS: f.db,
      APP_ORIGIN: TEST_APP_ORIGIN
    };
    if (authOrigin !== null) env.CHINAFLOW_AUTH_ORIGIN = authOrigin;
    const response = await worker.fetch(
      new Request(`${TEST_APP_ORIGIN}/login`),
      env
    );
    assert.equal(response.status, 500);
    assert.deepEqual(
      await response.json(),
      { error: "internal_error" }
    );
  });
}

for (const mode of ["missing", "bad", "expired", "revoked", "disabled"]) {
  test(`GET and POST reject ${mode} session`, async t => {
    const f = await fixture(t);
    let token = f.sessions[0].token;
    if (mode === "missing") token = null;
    if (mode === "bad") token = "a".repeat(64);
    if (mode === "expired") f.sqlite.exec("UPDATE publisher_sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
    if (mode === "revoked") f.sqlite.exec("UPDATE publisher_sessions SET revoked_at = CURRENT_TIMESTAMP");
    if (mode === "disabled") f.sqlite.exec("UPDATE publisher_users SET user_status = 'disabled'");
    for (const method of ["GET", "POST"]) assert.equal((await f.request({ method, token })).status, 401);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}

for (const status of ["invited", "removed"]) {
  test(`${status} membership cannot read or create another draft; cross-tenant selectors do not authorize`, async t => {
    const f = await fixture(t);
    const created = await f.request();
    const id = created.body.draft.publisher.publisher_id;
    const other = await f.request({ method: "GET", token: f.sessions[1].token,
      path: `/api/onboarding/draft?publisher_id=${id}&user_id=user1&hostname=travel.example.com` });
    assert.equal(other.status, 404);
    f.sqlite.prepare("UPDATE publisher_memberships SET membership_status = ?").run(status);
    assert.equal((await f.request({ method: "GET" })).status, 404);
    assert.equal((await f.request()).status, 409);
    assert.deepEqual(f.counts(), [1, 1, 1]);
  });
}

for (const exhausted of [false, true]) {
  test(`generated install_public_key collision: ${exhausted ? "bounded exhaustion" : "specific retry succeeds"}`, async t => {
    const f = await fixture(t);
    const collisionKey = `cfi_${"11".repeat(16)}`;

    f.sqlite.prepare(`
      INSERT INTO publishers (
        publisher_id, slug, display_name, install_public_key
      ) VALUES (
        'existing-install-key',
        'existing-install-key',
        'Existing',
        ?
      )
    `).run(collisionKey);

    const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let randomCalls = 0;

    t.mock.method(globalThis.crypto, "getRandomValues", bytes => {
      randomCalls++;

      if (exhausted || randomCalls === 1) {
        bytes.fill(0x11);
        return bytes;
      }

      return original(bytes);
    });

    const result = await f.request();

    assert.equal(result.status, exhausted ? 503 : 201);
    assert.equal(f.state.batches, exhausted ? 3 : 2);
    assert.equal(randomCalls, exhausted ? 3 : 2);
    assert.deepEqual(
      f.counts(),
      exhausted ? [1, 0, 0] : [2, 1, 1]
    );

    if (exhausted) {
      assert.deepEqual(
        result.body,
        { error: "temporarily_unavailable" }
      );
    } else {
      const issued =
        result.body.draft.publisher.install_public_key;

      assert.match(
        issued,
        /^cfi_[0-9a-f]{32}$/
      );

      assert.notEqual(
        issued,
        collisionKey
      );

      assert.equal(
        f.sqlite.prepare(`
          SELECT count(*) AS n
          FROM publishers
          WHERE install_public_key = ?
        `).get(issued).n,
        1
      );
    }

    assert.deepEqual(
      f.sqlite.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });
}

for (const field of ["publisher_id", "slug"]) {
  for (const exhausted of [false, true]) {
    test(`generated ${field} collision: ${exhausted ? "bounded exhaustion" : "specific retry succeeds"}`, async t => {
      const f = await fixture(t);
      const uuid = "11111111-1111-4111-8111-111111111111";
      f.sqlite.prepare("INSERT INTO publishers (publisher_id,slug,display_name) VALUES (?,?, 'Existing')").run(
        field === "publisher_id" ? `pub_${uuid}` : "existing", field === "slug" ? `pub-${uuid}` : "existing");
      const original = crypto.randomUUID;
      let calls = 0;
      crypto.randomUUID = () => (exhausted || calls++ < 4) ? uuid : original.call(crypto);
      t.after(() => { crypto.randomUUID = original; });
      const result = await f.request();
      assert.equal(result.status, exhausted ? 503 : 201);
      assert.equal(f.state.batches, exhausted ? 3 : 2);
      assert.deepEqual(f.counts(), exhausted ? [1, 0, 0] : [2, 1, 1]);
    });
  }
}

test("unrelated domain-ID constraint is not classified as hostname conflict or retried", async t => {
  const f = await fixture(t);
  const uuid = "11111111-1111-4111-8111-111111111111";
  f.sqlite.exec("INSERT INTO publishers (publisher_id,slug,display_name) VALUES ('existing','existing','Existing')");
  f.sqlite.prepare("INSERT INTO publisher_domains (domain_id,publisher_id,hostname) VALUES (?, 'existing','other.example')").run(`dom_${uuid}`);
  const original = crypto.randomUUID;
  crypto.randomUUID = () => uuid;
  t.after(() => { crypto.randomUUID = original; });
  await assert.rejects(f.request(), /UNIQUE constraint failed: publisher_domains.domain_id/);
  assert.equal(f.state.batches, 1);
  assert.deepEqual(f.counts(), [1, 0, 1]);
});

test("app login/consume/session/logout regressions and host-only cookie", async t => {
  const f = await fixture(t);
  const link = await createMagicLink(f.db, "user1");
  const login = await f.request({ path: "/api/auth/consume", body: { token: link.token } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie");
  assert.match(cookie, /^__Host-chinaflow_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax;/);
  assert.ok(!cookie.includes("Domain="));
  const token = cookie.split(";")[0].split("=")[1];
  assert.equal((await f.request({ path: "/api/auth/consume", body: { token: link.token } })).status, 401);
  assert.deepEqual((await f.request({ method: "GET", path: "/api/auth/session", token })).body,
    { authenticated: true, userId: "user1" });
  assert.equal((await f.request({ path: "/api/auth/logout", token, origin: null })).status, 403);
  const logout = await f.request({ path: "/api/auth/logout", token });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await f.request({ method: "GET", path: "/api/auth/session", token })).status, 401);
  assert.equal((await f.request({ token })).status, 401);
  const page = await handleAppRequest(
    new Request(`${TEST_APP_ORIGIN}/login`),
    {
      CHINAFLOW_EVENTS: f.db,
      APP_ORIGIN: TEST_APP_ORIGIN,
      CHINAFLOW_AUTH_ORIGIN: TEST_AUTH_ORIGIN
    }
  );
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Continue sign in/);
  assert.match(pageHtml, /Email me a sign-in link/);
  assert.match(pageHtml, /type="email"/);
  assert.equal(pageHtml.includes(TEST_AUTH_ORIGIN), true);
  assert.match(pageHtml, /\/v1\/auth\/magic-link/);
  assert.match(pageHtml, /location\.assign\(["']\/onboarding["']\)/);
});

test("concurrent differing same-user input creates only the winning draft", async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    f.request(), f.request({ body: { ...input, hostname: "other.example.com" } })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.deepEqual(results.find(r => r.status === 409).body, { error: "conflict" });
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("schema enforces membership pair, global hostname and one primary per publisher", async t => {
  const f = await fixture(t);
  await f.request();
  const id = f.sqlite.prepare("SELECT publisher_id FROM publishers").get().publisher_id;
  assert.throws(() => f.sqlite.prepare(`INSERT INTO publisher_memberships
    (membership_id,publisher_id,user_id) VALUES ('duplicate',?,'user1')`).run(id),
  /UNIQUE constraint failed: publisher_memberships.publisher_id, publisher_memberships.user_id/);
  assert.throws(() => f.sqlite.prepare(`INSERT INTO publisher_domains
    (domain_id,publisher_id,hostname,is_primary) VALUES ('second',?,'second.example',1)`).run(id),
  /UNIQUE constraint failed: publisher_domains.publisher_id/);
  assert.throws(() => f.sqlite.prepare(`INSERT INTO publisher_domains
    (domain_id,publisher_id,hostname) VALUES ('duplicate',?,'travel.example.com')`).run(id),
  /UNIQUE constraint failed: publisher_domains.hostname/);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("two tenants read only their own explicitly joined draft", async t => {
  const f = await fixture(t);
  const first = await f.request();
  const second = await f.request({ token: f.sessions[1].token,
    body: { display_name: "Second", hostname: "second.example" } });
  assert.equal(second.status, 201);
  for (const [token, expected, foreign] of [
    [f.sessions[0].token, first, second], [f.sessions[1].token, second, first]
  ]) {
    const response = await f.request({ method: "GET", token, origin: null,
      path: `/api/onboarding/draft?publisher_id=${foreign.body.draft.publisher.publisher_id}` });
    assert.deepEqual(response.body, expected.body);
  }
});

test("existing active membership blocks recreation but remains readable", async t => {
  const f = await fixture(t);
  await f.request();
  f.sqlite.exec("UPDATE publishers SET account_status = 'active'");
  assert.equal((await f.request()).status, 409);
  const resumed = await f.request({ method: "GET" });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.draft.publisher.account_status, "active");
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

for (const suffix of ["", ": SQLITE_CONSTRAINT", ": SQLITE_CONSTRAINT_UNIQUE",
  ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
  ": SQLITE_CONSTRAINT_PRIMARYKEY", ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"]) {
  for (const field of [
    "publishers.publisher_id",
    "publishers.slug",
    "publishers.install_public_key",
    "publisher_domains.hostname"
  ]) {
    for (const wrapped of [false, true]) {
      test(`constraint matcher ${field}${suffix} (${wrapped ? "cause" : "message"})`, async t => {
        const f = await fixture(t);
        const message = `UNIQUE constraint failed: ${field}${suffix}`;
        const error = wrapped ? new Error("D1_ERROR: batch failed", { cause: new Error(message) }) : new Error(`D1_ERROR: ${message}`);
        const batch = f.db.batch.bind(f.db);
        let attempts = 0;
        f.db.batch = async statements => { if (++attempts === 1) throw error; return batch(statements); };
        if (suffix.includes("PRIMARYKEY") && field !== "publishers.publisher_id") {
          await assert.rejects(f.request(), e => e === error);
          assert.equal(attempts, 1);
          assert.deepEqual(f.counts(), [0, 0, 0]);
        } else {
          const result = await f.request();
          assert.equal(result.status, field === "publisher_domains.hostname" ? 409 : 201);
          if (result.status === 409) assert.deepEqual(result.body, { error: "conflict" });
          assert.equal(attempts, result.status === 409 ? 1 : 2);
          assert.deepEqual(f.counts(), result.status === 409 ? [0, 0, 0] : [1, 1, 1]);
        }
      });
    }
  }
}

for (const field of [
  "publishers.publisher_id",
  "publishers.slug",
  "publishers.install_public_key"
]) {
  test(`workerd ${field} collision exhaustion remains bounded`, async t => {
    const f = await fixture(t);
    let attempts = 0;
    f.db.batch = async () => { attempts++; throw new Error(`D1_ERROR: UNIQUE constraint failed: ${field}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_${field.endsWith("publisher_id") ? "PRIMARYKEY" : "UNIQUE"})`); };
    const result = await f.request();
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "temporarily_unavailable" });
    assert.equal(attempts, 3);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}

for (const message of [
  ...["publisher_domains.domain_id", "publisher_domains.publisher_id", "publisher_memberships.membership_id",
    "publisher_memberships.publisher_id, publisher_memberships.user_id", "unrelated.hostname",
    "publishers.slug, publishers.publisher_id"].map(field => `UNIQUE constraint failed: ${field}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`),
  "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
  "CHECK constraint failed: account_status: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
  "NOT NULL constraint failed: publishers.slug: SQLITE_CONSTRAINT_NOTNULL",
  "UNIQUE constraint failed: publishers.slug: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
  "UNIQUE constraint failed: publisher_domains.hostname: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE) unexpected",
  "SQLITE_CONSTRAINT", "unknown integrity error"
]) {
  test(`unclassified constraint: ${message}`, async t => {
    const f = await fixture(t);
    const error = new Error(`D1_ERROR: ${message}`, { cause: new Error(message) });
    let attempts = 0;
    f.db.batch = async () => { attempts++; throw error; };
    await assert.rejects(f.request(), e => e === error);
    assert.equal(attempts, 1);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });
}


test("GET resumes pending review and installation state while create stays draft-only", async t => {
  const f = await fixture(t);
  await f.request();
  f.sqlite.exec("UPDATE publishers SET account_status='pending_review'; UPDATE publisher_domains SET install_status='detected', verification_status='verified'");
  const result = await f.request({ method: "GET" });
  assert.equal(result.status, 200);
  assert.equal(result.body.draft.publisher.account_status, "pending_review");
  assert.equal(result.body.draft.primary_domain.install_status, "detected");
  assert.equal(result.body.draft.primary_domain.verification_status, "verified");
  assert.equal(result.body.draft.primary_domain.review_status, "pending");
  assert.equal(result.body.draft.primary_domain.monetization_status, "disabled");
  assert.equal(result.body.draft.primary_domain.reviewed_at, null);
  assert.equal((await f.request()).status, 409);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});

test("GET resumes approved and rejected review outcomes without allowing recreation", async t => {
  const f = await fixture(t);
  await f.request();
  f.sqlite.exec(`
    UPDATE publishers SET account_status='pending_review';
    UPDATE publisher_domains
      SET install_status='detected',
          verification_status='verified',
          review_status='approved',
          reviewed_at=CURRENT_TIMESTAMP
  `);
  let result = await f.request({ method: "GET" });
  assert.equal(result.status, 200);
  assert.equal(result.body.draft.publisher.account_status, "pending_review");
  assert.equal(result.body.draft.primary_domain.review_status, "approved");
  assert.ok(result.body.draft.primary_domain.reviewed_at);
  assert.equal((await f.request()).status, 409);

  f.sqlite.exec(`
    UPDATE publishers SET account_status='rejected';
    UPDATE publisher_domains SET review_status='rejected'
  `);
  result = await f.request({ method: "GET" });
  assert.equal(result.status, 200);
  assert.equal(result.body.draft.publisher.account_status, "rejected");
  assert.equal(result.body.draft.primary_domain.review_status, "rejected");
  assert.equal((await f.request()).status, 409);
  assert.deepEqual(f.counts(), [1, 1, 1]);
});


test("GET exposes supplier provisioning lifecycle without supplier credentials", async t => {
  const f = await fixture(t);
  const created = await f.request();
  const publisherId = created.body.draft.publisher.publisher_id;
  const domain = f.sqlite.prepare(
    "SELECT domain_id FROM publisher_domains WHERE publisher_id=? AND is_primary=1"
  ).get(publisherId);

  f.sqlite.exec(`
    UPDATE publishers SET account_status='pending_review';
    UPDATE publisher_domains
      SET install_status='detected',
          verification_status='verified',
          review_status='approved',
          reviewed_at=CURRENT_TIMESTAMP;
  `);

  f.sqlite.prepare(`
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,provisioning_status
    ) VALUES ('site-test',?,?,'trip.com','pending')
  `).run(publisherId, domain.domain_id);

  let result = await f.request({ method: "GET" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.draft.supplier_site, {
    supplier_site_id: "site-test",
    supplier: "trip.com",
    provisioning_status: "pending",
    provisioned_at: null
  });
  for (const secretField of ["aid", "sid", "sid_name"]) {
    assert.equal(
      Object.hasOwn(result.body.draft.supplier_site, secretField),
      false
    );
  }

  f.sqlite.exec(`
    UPDATE publisher_supplier_sites
    SET aid='10021103',
        sid='330739613',
        sid_name='internal-only',
        provisioning_status='active',
        provisioned_at=CURRENT_TIMESTAMP
    WHERE supplier_site_id='site-test'
  `);

  result = await f.request({ method: "GET" });
  assert.equal(result.status, 200);
  assert.equal(
    result.body.draft.supplier_site.provisioning_status,
    "active"
  );
  assert.ok(result.body.draft.supplier_site.provisioned_at);
  for (const secretField of ["aid", "sid", "sid_name"]) {
    assert.equal(
      Object.hasOwn(result.body.draft.supplier_site, secretField),
      false
    );
  }
});


test("GET resumes final active state without exposing commercial URLs", async t => {
  const f = await fixture(t);
  const created = await f.request();
  const publisherId = created.body.draft.publisher.publisher_id;
  const domain = f.sqlite.prepare(
    "SELECT domain_id FROM publisher_domains WHERE publisher_id=? AND is_primary=1"
  ).get(publisherId);

  f.sqlite.exec(`
    UPDATE publishers SET account_status='active';
    UPDATE publisher_domains
      SET install_status='detected',
          verification_status='verified',
          review_status='approved',
          monetization_status='enabled',
          reviewed_at=CURRENT_TIMESTAMP;
  `);

  f.sqlite.prepare(`
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,
      aid,sid,sid_name,provisioning_status,provisioned_at
    ) VALUES (
      'site-active',?,?,'trip.com',
      '10021103','330739613','internal-only','active',CURRENT_TIMESTAMP
    )
  `).run(publisherId, domain.domain_id);

  const result = await f.request({ method: "GET" });
  assert.equal(result.status, 200);
  assert.equal(result.body.draft.publisher.account_status, "active");
  assert.equal(
    result.body.draft.primary_domain.monetization_status,
    "enabled"
  );
  assert.equal(
    result.body.draft.supplier_site.provisioning_status,
    "active"
  );

  const serialized = JSON.stringify(result.body);
  for (const forbidden of [
    "10021103",
    "330739613",
    "internal-only",
    "affiliate_url",
    "trip_sub1"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  assert.equal((await f.request()).status, 409);
});
