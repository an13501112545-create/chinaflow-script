import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker, {
  handleReviewApiRequest
} from "../publisher-review-api-worker-v0.1.mjs";

const ORIGIN = "https://review.example.test";
const TOKEN = "review_test_" + "a".repeat(52);
const ROUTE = "/api/internal/publisher-review";

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
      monetization_status,first_seen_at,last_seen_at,verified_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','claimed',CURRENT_TIMESTAMP,'pending','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
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
  body = { publisher_id: "p", decision: "approve" },
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
    env ?? { REVIEW_API_TOKEN: TOKEN }
  );
}

test("review route is POST-only and rejects before D1", async () => {
  const env = {
    REVIEW_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await request({ method, body: undefined, env });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }
});

test("missing or invalid bearer token rejects before D1", async () => {
  const env = {
    REVIEW_API_TOKEN: TOKEN,
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

test("missing or invalid configured review secret fails closed before D1", async () => {
  for (const secret of [undefined, "", "short", "a".repeat(513)]) {
    const env = {
      ...(secret === undefined ? {} : { REVIEW_API_TOKEN: secret }),
      get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
    };
    const response = await request({ env });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  }
});

test("query selectors and malformed bodies reject before D1", async () => {
  const env = {
    REVIEW_API_TOKEN: TOKEN,
    get CHINAFLOW_EVENTS() { assert.fail("D1 accessed"); }
  };
  const query = await request({ path: ROUTE + "?publisher_id=p", env });
  assert.equal(query.status, 400);

  const missingBody = await worker.fetch(
    new Request(ORIGIN + ROUTE, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` }
    }),
    env
  );
  assert.equal(missingBody.status, 400);

  for (const body of [
    "",
    "{",
    "null",
    "[]",
    "{}",
    "x".repeat(4097)
  ]) {
    const response = await request({ body, env });
    assert.equal(
      response.status,
      400,
      "unexpected status for body " + JSON.stringify(body)
    );
    assert.deepEqual(await response.json(), { error: "invalid_input" });
  }
});

test("authenticated approve executes internal review service", async t => {
  const f = fixture(t);
  const response = await request({
    env: {
      REVIEW_API_TOKEN: TOKEN,
      CHINAFLOW_EVENTS: f.database,
      APP_ENVIRONMENT: "test"
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.deepEqual(await response.json(), {
    review: {
      publisher_id: "p",
      decision: "approve",
      account_status: "pending_review",
      review_status: "approved",
      reviewed: true
    }
  });
  const publisher = f.sqlite.prepare(
    "SELECT account_status FROM publishers WHERE publisher_id='p'"
  ).get();
  const domain = f.sqlite.prepare(
    "SELECT review_status,monetization_status FROM publisher_domains WHERE domain_id='d'"
  ).get();
  assert.equal(publisher.account_status, "pending_review");
  assert.equal(domain.review_status, "approved");
  assert.equal(domain.monetization_status, "disabled");
});

test("authenticated reject executes atomic rejection", async t => {
  const f = fixture(t);
  const response = await request({
    body: { publisher_id: "p", decision: "reject" },
    env: {
      REVIEW_API_TOKEN: TOKEN,
      CHINAFLOW_EVENTS: f.database,
      APP_ENVIRONMENT: "test"
    }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.review.account_status, "rejected");
  assert.equal(body.review.review_status, "rejected");
  assert.equal(f.sqlite.prepare(
    "SELECT account_status FROM publishers WHERE publisher_id='p'"
  ).get().account_status, "rejected");
  assert.equal(f.sqlite.prepare(
    "SELECT review_status FROM publisher_domains WHERE domain_id='d'"
  ).get().review_status, "rejected");
});

test("valid auth still enforces strict review service input", async t => {
  const f = fixture(t);
  for (const body of [
    { publisher_id: "p", decision: "approved" },
    { publisher_id: "p", decision: "approve", user_id: "forged" },
    { publisher_id: "", decision: "reject" }
  ]) {
    const response = await request({
      body,
      env: {
        REVIEW_API_TOKEN: TOKEN,
        CHINAFLOW_EVENTS: f.database
      }
    });
    assert.equal(response.status, 400);
  }
  assert.equal(f.sqlite.prepare(
    "SELECT review_status FROM publisher_domains WHERE domain_id='d'"
  ).get().review_status, "pending");
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
    service: "chinaflow-publisher-review-api",
    environment: "test"
  });

  const missing = await request({
    path: "/api/internal/unknown",
    env: { REVIEW_API_TOKEN: TOKEN }
  });
  assert.equal(missing.status, 404);
});
