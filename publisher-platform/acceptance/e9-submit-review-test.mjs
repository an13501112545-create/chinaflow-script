import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const CONFIG = "wrangler.publisher-app.test.jsonc";
const DB = "chinaflow-events-v0-1-test";
const DB_ID = "f8c07a5f-f9e7-4595-9f25-ce3d525241d9";
const WORKER = "chinaflow-publisher-app-v0-1-test";
const APP = "https://chinaflow-publisher-app-v0-1-test.an13501112545.workers.dev";
const TERMS = "chinaflow-publisher-terms-v1";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function wrangler(args) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return run(npx, ["wrangler", ...args]);
}

function d1(sql) {
  const raw = wrangler([
    "d1", "execute", DB,
    "--remote",
    "--config", CONFIG,
    "--yes",
    "--json",
    "--command", sql
  ]);
  const parsed = JSON.parse(raw);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success !== true) {
    throw new Error("TEST D1 command failed");
  }
  return first.results ?? [];
}

function one(sql) {
  const rows = d1(sql);
  assert.equal(rows.length, 1, "Expected exactly one D1 result row");
  return rows[0];
}

function q(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

const config = readFileSync(CONFIG, "utf8");
for (const required of [
  `"name": "${WORKER}"`,
  `"database_name": "${DB}"`,
  `"database_id": "${DB_ID}"`,
  `"APP_ENVIRONMENT": "test"`
]) {
  assert.ok(config.includes(required), `TEST config mismatch: ${required}`);
}
assert.ok(
  !config.includes('"database_name": "chinaflow-events-v0-1"'),
  "Production D1 reference detected"
);

const branch = run("git", ["status", "-sb"]).trim();
assert.equal(
  branch,
  "## main...origin/main",
  "Git must be clean and synchronized with origin/main"
);
const head = run("git", ["rev-parse", "HEAD"]).trim();
const remote = run("git", ["rev-parse", "origin/main"]).trim();
assert.equal(head, remote, "HEAD must equal origin/main");

const historicalBefore = Number(one(`
  SELECT count(*) AS n FROM publishers
  WHERE terms_version IS NOT NULL
    AND terms_accepted_at IS NOT NULL
    AND terms_accepted_by_user_id IS NULL
`).n);
assert.equal(
  historicalBefore,
  1,
  "Historical partial Terms baseline changed"
);

const BASELINE_SQL = `
SELECT
  (SELECT count(*) FROM publishers) publishers,
  (SELECT count(*) FROM publisher_domains) publisher_domains,
  (SELECT count(*) FROM publisher_memberships) publisher_memberships,
  (SELECT count(*) FROM publisher_supplier_sites) publisher_supplier_sites,
  (SELECT count(*) FROM publisher_supplier_offers) publisher_supplier_offers,
  (SELECT count(*) FROM publisher_placements) publisher_placements,
  (SELECT count(*) FROM publisher_users) publisher_users,
  (SELECT count(*) FROM publisher_sessions) publisher_sessions,
  (SELECT count(*) FROM publisher_magic_links) publisher_magic_links,
  (SELECT count(*) FROM events) events,
  (SELECT count(*) FROM report_ingestion_runs) report_ingestion_runs,
  (SELECT count(*) FROM trip_bookings) trip_bookings,
  (SELECT count(*) FROM trip_commissions) trip_commissions,
  (SELECT count(*) FROM publishers
    WHERE install_public_key IS NOT NULL) install_keys_nonnull,
  (SELECT count(*) FROM publishers
    WHERE terms_version IS NOT NULL
      AND terms_accepted_at IS NOT NULL
      AND terms_accepted_by_user_id IS NOT NULL
  ) complete_terms_acceptance;
`;

const baseline = one(BASELINE_SQL);

const deployOutput = wrangler([
  "deploy",
  "--config", CONFIG
]);
const version =
  deployOutput.match(
    /Current Version ID:\s*([^\s]+)/i
  )?.[1] ?? "unknown";

async function call(path, init = {}) {
  return fetch(APP + path, {
    redirect: "manual",
    ...init
  });
}

async function waitForLiveSubmitRoute() {
  let lastStatus = null;
  let lastAllow = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await call(
      "/api/onboarding/submit",
      { method: "PATCH" }
    );
    lastStatus = response.status;
    lastAllow = response.headers.get("allow");
    await response.arrayBuffer();
    if (lastStatus === 405 && lastAllow === "POST") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "TEST Worker route did not become ready after deploy: " +
      "status=" + lastStatus + ", allow=" + lastAllow
  );
}

await waitForLiveSubmitRoute();

for (const method of [
  "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"
]) {
  const response = await call(
    "/api/onboarding/submit",
    { method }
  );
  assert.equal(
    response.status,
    405,
    `${method} submit must be 405`
  );
}

{
  const response = await call(
    "/api/onboarding/submit",
    { method: "POST" }
  );
  assert.equal(
    response.status,
    403,
    "Missing Origin must be 403"
  );
}

{
  const response = await call(
    "/api/onboarding/submit",
    {
      method: "POST",
      headers: { Origin: APP }
    }
  );
  assert.equal(
    response.status,
    401,
    "Missing session must be 401"
  );
}

const suffix =
  Date.now().toString(36) +
  randomBytes(5).toString("hex");
const userId = `e9u_${suffix}`;
const publisherId = `e9p_${suffix}`;
const membershipId = `e9m_${suffix}`;
const domainId = `e9d_${suffix}`;
const sessionId = `e9s_${suffix}`;
const slug = `e9-${suffix}`;
const email = `e9-${suffix}@example.test`;
const hostname = `e9-${suffix}.example.test`;

const token =
  randomBytes(32).toString("hex");
const tokenHash =
  createHash("sha256")
    .update(token)
    .digest("hex");
const installKey =
  "cfi_" + randomBytes(16).toString("hex");
const expires =
  new Date(
    Date.now() + 60 * 60 * 1000
  ).toISOString();

let fixtureCreated = false;

function cleanup() {
  if (!fixtureCreated) return;

  d1(`
    DELETE FROM publisher_sessions
      WHERE session_id=${q(sessionId)};
    DELETE FROM publisher_memberships
      WHERE membership_id=${q(membershipId)};
    DELETE FROM publisher_domains
      WHERE domain_id=${q(domainId)};
    DELETE FROM publishers
      WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_users
      WHERE user_id=${q(userId)};
  `);

  fixtureCreated = false;
}

try {
  fixtureCreated = true;
  d1(`
    INSERT INTO publisher_users (
      user_id,email,email_normalized,user_status
    ) VALUES (
      ${q(userId)},${q(email)},${q(email)},'active'
    );

    INSERT INTO publishers (
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,
      terms_accepted_by_user_id,install_public_key
    ) VALUES (
      ${q(publisherId)},${q(slug)},'E9 Synthetic','draft',
      ${q(TERMS)},CURRENT_TIMESTAMP,
      ${q(userId)},${q(installKey)}
    );

    INSERT INTO publisher_memberships (
      membership_id,publisher_id,user_id,
      role,membership_status
    ) VALUES (
      ${q(membershipId)},${q(publisherId)},${q(userId)},
      'owner','active'
    );

    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,
      first_seen_at,last_seen_at,verified_at
    ) VALUES (
      ${q(domainId)},${q(publisherId)},${q(hostname)},1,
      'detected','verified',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );

    INSERT INTO publisher_sessions (
      session_id,user_id,token_hash,
      expires_at,created_at
    ) VALUES (
      ${q(sessionId)},${q(userId)},${q(tokenHash)},
      ${q(expires)},CURRENT_TIMESTAMP
    );
  `);

  const headers = {
    Origin: APP,
    Cookie:
      `__Host-chinaflow_session=${token}`
  };

  const first = await call(
    "/api/onboarding/submit",
    {
      method: "POST",
      headers
    }
  );
  assert.equal(
    first.status,
    200,
    "First submit must succeed"
  );
  assert.deepEqual(
    await first.json(),
    {
      submission: {
        account_status: "pending_review",
        submitted: true
      }
    }
  );

  assert.equal(
    one(
      `SELECT account_status
       FROM publishers
       WHERE publisher_id=${q(publisherId)}`
    ).account_status,
    "pending_review"
  );

  const resumed = await call(
    "/api/onboarding/draft",
    {
      method: "GET",
      headers: {
        Cookie: headers.Cookie
      }
    }
  );
  assert.equal(
    resumed.status,
    200,
    "pending_review onboarding state must be recoverable"
  );

  const resumedBody =
    await resumed.json();
  assert.equal(
    resumedBody?.draft?.publisher?.account_status,
    "pending_review"
  );
  assert.equal(
    resumedBody?.draft?.primary_domain?.install_status,
    "detected"
  );
  assert.equal(
    resumedBody?.draft?.primary_domain?.verification_status,
    "verified"
  );

  d1(`
    UPDATE publishers
    SET updated_at='2001-01-01 00:00:00'
    WHERE publisher_id=${q(publisherId)}
  `);

  const retry = await call(
    "/api/onboarding/submit",
    {
      method: "POST",
      headers
    }
  );
  assert.equal(
    retry.status,
    200,
    "Retry must be acknowledged"
  );

  assert.deepEqual(
    await retry.json(),
    {
      submission: {
        account_status: "pending_review",
        submitted: true
      }
    }
  );

  assert.equal(
    one(
      `SELECT updated_at
       FROM publishers
       WHERE publisher_id=${q(publisherId)}`
    ).updated_at,
    "2001-01-01 00:00:00",
    "Retry must not mutate publisher"
  );
} finally {
  cleanup();
}

assert.deepEqual(
  one(BASELINE_SQL),
  baseline,
  "TEST D1 baseline was not restored"
);

const historicalAfter = Number(
  one(`
    SELECT count(*) AS n FROM publishers
    WHERE terms_version IS NOT NULL
      AND terms_accepted_at IS NOT NULL
      AND terms_accepted_by_user_id IS NULL
  `).n
);
assert.equal(
  historicalAfter,
  historicalBefore,
  "Historical partial Terms changed"
);

const fk = d1(
  "PRAGMA foreign_key_check"
);
assert.deepEqual(
  fk,
  [],
  "Foreign-key violations detected"
);

console.log("===== REPORT =====");
console.log("STEP=E9_REMOTE_TEST_ACCEPTANCE");
console.log("E9_ROUTE_SECURITY=PASS");
console.log("E9_SUBMIT_REMOTE=PASS");
console.log("PENDING_REVIEW_RECOVERY=PASS");
console.log("IDEMPOTENT_RETRY=PASS");
console.log("BASELINE_RESTORED=PASS");
console.log(
  `HISTORICAL_PARTIAL_TERMS=${historicalAfter}`
);
console.log("FK=0");
console.log("TEST_DEPLOYMENT=PASS");
console.log("PRODUCTION_ACCESS=NO");
console.log(`HEAD=${head}`);
console.log(
  `TEST_WORKER_VERSION=${version}`
);
