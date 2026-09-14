import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createMagicLink } from "../auth-magic-link-store-v0.1.mjs";
import { hashToken } from "../auth-token-v0.1.mjs";
import { handleAuthRequest } from "../auth-api-worker-v0.1.mjs";
import { completeMagicLinkLogin } from "../auth-login-service-v0.1.mjs";
import { validateSession } from "../auth-session-validate-v0.1.mjs";

function fixture(t, clock = null) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../../collector/migrations/0005_publisher_accounts_v1.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO publisher_users (user_id, email, email_normalized) VALUES ('user1', 'test@example.com', 'test@example.com'), ('user2', 'other@example.com', 'other@example.com')");
  const calls = [];
  const db = {
    prepare(sql) {
      return { bind(...values) {
        calls.push({ sql, values });
        // Only deterministic boundary tests replace the SQL clock. Real-clock
        // tests execute the original statement without any transformation.
        const statement = sqlite.prepare(clock ? sql.replaceAll("'now'", `'${clock}'`) : sql);
        return {
          async all() { return { results: statement.all(...values) }; },
          async first() { return statement.get(...values) ?? null; },
          async run() { return { meta: statement.run(...values) }; },
          execute() {
            const results = statement.all(...values);
            return { results, meta: { changes: sqlite.prepare("SELECT changes() AS n").get().n } };
          }
        };
      } };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return { sqlite, db, calls };
}

test("execution-time insert, 15-minute TTL, hash-only bindings, and blocked repeat", async t => {
  const { sqlite, db, calls } = fixture(t);
  const before = Date.now();
  const link = await createMagicLink(db, "user1", new Date("2000-01-01"));
  const row = sqlite.prepare("SELECT * FROM publisher_magic_links").get();
  assert.ok(Date.parse(row.created_at) >= before);
  assert.ok(Date.parse(row.created_at) <= Date.now());
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 900000);
  assert.equal(link.expiresAt, row.expires_at);
  assert.equal(row.token_hash, await hashToken(link.token));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [link.magicLinkId, "user1", row.token_hash, "user1"]);
  assert.ok(!JSON.stringify(calls).includes(link.token));
  assert.equal(await createMagicLink(db, "user1"), null);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM publisher_magic_links").get().n, 1);
  assert.ok(await createMagicLink(db, "user2"));
});

for (const [label, timestamp, allowed] of [
  ["ISO 59.999 seconds", "2026-09-14T11:59:00.001Z", false],
  ["ISO exactly 60 seconds", "2026-09-14T11:59:00.000Z", true],
  ["ISO 60.001 seconds", "2026-09-14T11:58:59.999Z", true],
  ["SQLite 59 seconds", "2026-09-14 11:59:01", false],
  ["SQLite exactly 60 seconds", "2026-09-14 11:59:00", true],
  ["SQLite 61 seconds", "2026-09-14 11:58:59", true],
  ["future timestamp", "2026-09-14T12:00:01.000Z", false]
]) {
  test(label, async t => {
    const { sqlite, db } = fixture(t, "2026-09-14T12:00:00.000Z");
    sqlite.prepare("INSERT INTO publisher_magic_links (magic_link_id, user_id, purpose, token_hash, expires_at, created_at, consumed_at) VALUES ('old', 'user1', 'login', 'oldhash', '2026-09-14T12:14:00.000Z', ?, '2026-09-14T11:59:30.000Z')").run(timestamp);
    // Consuming a link must not bypass its cooldown.
    assert.equal(Boolean(await createMagicLink(db, "user1")), allowed);
  });
}

test("mixed timestamp history and login-purpose scope", async t => {
  const { sqlite, db } = fixture(t, "2026-09-14T12:00:00.000Z");
  sqlite.exec(`INSERT INTO publisher_magic_links (magic_link_id, user_id, purpose, token_hash, expires_at, created_at) VALUES
    ('old', 'user1', 'login', 'oldhash', '2026-09-14T12:15:00.000Z', '2026-09-14T11:00:00.000Z'),
    ('recent', 'user1', 'login', 'recenthash', '2026-09-14T12:15:00.000Z', '2026-09-14 11:59:30'),
    ('verify', 'user2', 'verify_email', 'verifyhash', '2026-09-14T12:15:00.000Z', '2026-09-14 12:00:00')`);
  assert.equal(await createMagicLink(db, "user1"), null);
  assert.ok(await createMagicLink(db, "user2"));
});

test("Worker keeps coarse shields and returns 202 without Resend on cooldown", async t => {
  const { db } = fixture(t);
  let emails = 0;
  let ipChecks = 0;
  let emailChecks = 0;
  let ipAllowed = true;
  let emailAllowed = true;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    emails++;
    return Response.json({ id: "mock-email" });
  };
  const env = {
    CHINAFLOW_EVENTS: db, AUTH_ENVIRONMENT: "test",
    AUTH_TEST_EMAIL: "test@example.com", RESEND_API_KEY: "mock-key",
    MAGIC_LINK_IP_RATE_LIMITER: { async limit() { ipChecks++; return { success: ipAllowed }; } },
    MAGIC_LINK_EMAIL_RATE_LIMITER: { async limit() { emailChecks++; return { success: emailAllowed }; } }
  };
  async function request() {
    const result = await handleAuthRequest(new Request("https://auth.example/v1/auth/magic-link", {
      method: "POST", headers: { Origin: "https://app.getchinaflow.com", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com" })
    }), env);
    assert.equal(result.status, 202);
    assert.deepEqual(await result.json(), { ok: true });
  }
  await request();
  await request();
  assert.equal(emails, 1);
  assert.equal(ipChecks, 2);
  assert.equal(emailChecks, 2);
  ipAllowed = false;
  await request();
  assert.equal(emailChecks, 2);
  ipAllowed = true;
  emailAllowed = false;
  await request();
  assert.equal(emails, 1);
});

test("new links retain single-use login and session security", async t => {
  const { sqlite, db } = fixture(t);
  const link = await createMagicLink(db, "user1");
  const login = await completeMagicLinkLogin(db, link.token);
  assert.equal(login.userId, "user1");
  assert.equal(await completeMagicLinkLogin(db, link.token), null);
  assert.equal((await validateSession(db, login.token)).userId, "user1");
  sqlite.exec("UPDATE publisher_users SET user_status = 'disabled' WHERE user_id = 'user1'");
  assert.equal(await validateSession(db, login.token), null);
  const other = await createMagicLink(db, "user2");
  assert.equal(await completeMagicLinkLogin(db, other.token, new Date(other.expiresAt)), null);
  assert.equal(await completeMagicLinkLogin(db, "invalid"), null);
});
