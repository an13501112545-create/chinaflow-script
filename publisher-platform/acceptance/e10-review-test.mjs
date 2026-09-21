import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const APP_CONFIG = "wrangler.publisher-app.test.jsonc";
const REVIEW_CONFIG = "wrangler.publisher-review-api.test.jsonc";
const DB = "chinaflow-events-v0-1-test";
const DB_ID = "f8c07a5f-f9e7-4595-9f25-ce3d525241d9";
const APP_WORKER = "chinaflow-publisher-app-v0-1-test";
const REVIEW_WORKER = "chinaflow-publisher-review-api-v0-1-test";
const APP =
  "https://chinaflow-publisher-app-v0-1-test.an13501112545.workers.dev";
const REVIEW =
  "https://chinaflow-publisher-review-api-v0-1-test.an13501112545.workers.dev";
const TERMS = "chinaflow-publisher-terms-v1";
const SECRET_PATH = join(
  homedir(),
  ".config",
  "chinaflow",
  "review-api-token-test"
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function wrangler(args) {
  return run(npxCommand(), ["wrangler", ...args]);
}

function wranglerInput(args, input) {
  return run(npxCommand(), ["wrangler", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    input
  });
}

function isTransientD1AuthError(error) {
  const output = [
    error?.message,
    error?.stdout,
    error?.stderr
  ].filter(Boolean).join("\n");
  return (
    output.includes("Authentication error") &&
    output.includes("10000")
  );
}

function sleepSync(ms) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    ms
  );
}

function d1(sql) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const raw = wrangler([
        "d1", "execute", DB,
        "--remote",
        "--config", APP_CONFIG,
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
    } catch (error) {
      lastError = error;
      if (!isTransientD1AuthError(error) || attempt === 5) throw error;
      sleepSync(attempt * 1000);
    }
  }
  throw lastError;
}

function one(sql) {
  const rows = d1(sql);
  assert.equal(rows.length, 1, "Expected exactly one D1 result row");
  return rows[0];
}

function q(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

for (const [configPath, required] of [
  [APP_CONFIG, [
    '"name": "' + APP_WORKER + '"',
    '"database_name": "' + DB + '"',
    '"database_id": "' + DB_ID + '"',
    '"APP_ENVIRONMENT": "test"'
  ]],
  [REVIEW_CONFIG, [
    '"name": "' + REVIEW_WORKER + '"',
    '"database_name": "' + DB + '"',
    '"database_id": "' + DB_ID + '"',
    '"APP_ENVIRONMENT": "test"'
  ]]
]) {
  const config = readFileSync(configPath, "utf8");
  for (const needle of required) {
    assert.ok(
      config.includes(needle),
      "TEST config mismatch in " + configPath + ": " + needle
    );
  }
  assert.ok(
    !config.includes('"database_name": "chinaflow-events-v0-1"'),
    "Production D1 reference detected in " + configPath
  );
  assert.ok(
    !config.includes("REVIEW_API_TOKEN"),
    "Review secret must never be stored in config"
  );
}

const branch = run("git", ["status", "-sb"]).trim();
assert.equal(
  branch,
  "## main...origin/main",
  "Git must be clean and synchronized with origin/main"
);
const head = run("git", ["rev-parse", "HEAD"]).trim();
const remote = run("git", ["rev-parse", "origin/main"]).trim();
assert.equal(head, remote, "HEAD must equal origin/main");

const historicalBefore = Number(one([
  "SELECT count(*) AS n FROM publishers",
  "WHERE terms_version IS NOT NULL",
  "  AND terms_accepted_at IS NOT NULL",
  "  AND terms_accepted_by_user_id IS NULL"
].join("\n")).n);
assert.equal(
  historicalBefore,
  1,
  "Historical partial Terms baseline changed"
);

const BASELINE_SQL = [
  "SELECT",
  "  (SELECT count(*) FROM publishers) publishers,",
  "  (SELECT count(*) FROM publisher_domains) publisher_domains,",
  "  (SELECT count(*) FROM publisher_memberships) publisher_memberships,",
  "  (SELECT count(*) FROM publisher_supplier_sites) publisher_supplier_sites,",
  "  (SELECT count(*) FROM publisher_supplier_offers) publisher_supplier_offers,",
  "  (SELECT count(*) FROM publisher_placements) publisher_placements,",
  "  (SELECT count(*) FROM publisher_users) publisher_users,",
  "  (SELECT count(*) FROM publisher_sessions) publisher_sessions,",
  "  (SELECT count(*) FROM publisher_magic_links) publisher_magic_links,",
  "  (SELECT count(*) FROM events) events,",
  "  (SELECT count(*) FROM report_ingestion_runs) report_ingestion_runs,",
  "  (SELECT count(*) FROM trip_bookings) trip_bookings,",
  "  (SELECT count(*) FROM trip_commissions) trip_commissions,",
  "  (SELECT count(*) FROM publishers",
  "    WHERE install_public_key IS NOT NULL) install_keys_nonnull,",
  "  (SELECT count(*) FROM publishers",
  "    WHERE terms_version IS NOT NULL",
  "      AND terms_accepted_at IS NOT NULL",
  "      AND terms_accepted_by_user_id IS NOT NULL",
  "  ) complete_terms_acceptance;"
].join("\n");

const baseline = one(BASELINE_SQL);

const appDeployOutput = wrangler([
  "deploy",
  "--config", APP_CONFIG
]);
const appDeployVersion =
  appDeployOutput.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ??
  "unknown";

const reviewDeployOutput = wrangler([
  "deploy",
  "--config", REVIEW_CONFIG
]);
const reviewDeployVersion =
  reviewDeployOutput.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ??
  "unknown";

const reviewToken =
  "review_test_" + randomBytes(32).toString("hex");

wranglerInput([
  "secret", "put", "REVIEW_API_TOKEN",
  "--config", REVIEW_CONFIG
], reviewToken + "\n");

mkdirSync(dirname(SECRET_PATH), { recursive: true });
writeFileSync(SECRET_PATH, reviewToken + "\n", {
  encoding: "utf8",
  mode: 0o600
});
chmodSync(SECRET_PATH, 0o600);

const secretMode =
  process.platform === "win32"
    ? null
    : (await import("node:fs")).statSync(SECRET_PATH).mode & 0o777;
if (secretMode !== null) {
  assert.equal(secretMode, 0o600, "Stored TEST review token must be mode 0600");
}

async function call(base, path, init = {}) {
  return fetch(base + path, {
    redirect: "manual",
    ...init
  });
}

async function waitForReviewApi() {
  let healthStatus = null;
  let patchStatus = null;
  let patchAllow = null;
  let authenticatedInvalidStatus = null;

  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const health = await call(REVIEW, "/health", { method: "GET" });
    healthStatus = health.status;
    await health.arrayBuffer();

    const patch = await call(
      REVIEW,
      "/api/internal/publisher-review",
      { method: "PATCH" }
    );
    patchStatus = patch.status;
    patchAllow = patch.headers.get("allow");
    await patch.arrayBuffer();

    const authenticatedInvalid = await call(
      REVIEW,
      "/api/internal/publisher-review",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + reviewToken,
          "Content-Type": "application/json"
        },
        body: "{}"
      }
    );
    authenticatedInvalidStatus = authenticatedInvalid.status;
    await authenticatedInvalid.arrayBuffer();

    if (
      healthStatus === 200 &&
      patchStatus === 405 &&
      patchAllow === "POST" &&
      authenticatedInvalidStatus === 400
    ) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(
    "TEST review Worker did not become ready after secret propagation: " +
      "health=" + healthStatus +
      ", patch=" + patchStatus +
      ", allow=" + patchAllow +
      ", authenticated_invalid=" + authenticatedInvalidStatus
  );
}

async function waitForPublisherApp() {
  let lastStatus = null;
  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const response = await call(APP, "/health", { method: "GET" });
    lastStatus = response.status;
    await response.arrayBuffer();
    if (lastStatus === 200) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    "TEST publisher Worker did not become ready: status=" + lastStatus
  );
}

await Promise.all([
  waitForReviewApi(),
  waitForPublisherApp()
]);

const authHeaders = {
  Authorization: "Bearer " + reviewToken,
  "Content-Type": "application/json"
};

for (const method of [
  "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"
]) {
  const response = await call(
    REVIEW,
    "/api/internal/publisher-review",
    { method }
  );
  assert.equal(
    response.status,
    405,
    method + " review must be 405"
  );
}

{
  const response = await call(
    REVIEW,
    "/api/internal/publisher-review",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publisher_id: "never-read",
        decision: "approve"
      })
    }
  );
  assert.equal(response.status, 401, "Missing review auth must be 401");
}

{
  const response = await call(
    REVIEW,
    "/api/internal/publisher-review",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong_wrong_wrong_wrong_wrong_wrong_wrong",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        publisher_id: "never-read",
        decision: "approve"
      })
    }
  );
  assert.equal(response.status, 401, "Wrong review auth must be 401");
}

{
  const response = await call(
    REVIEW,
    "/api/internal/publisher-review?publisher_id=forged",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        publisher_id: "never-read",
        decision: "approve"
      })
    }
  );
  assert.equal(response.status, 400, "Review query selectors must be 400");
}

{
  const response = await call(
    REVIEW,
    "/api/internal/publisher-review",
    {
      method: "POST",
      headers: authHeaders,
      body: "{}"
    }
  );
  assert.equal(response.status, 400, "Malformed review input must be 400");
}

function makeFixture(label) {
  const suffix =
    label + "_" +
    Date.now().toString(36) +
    randomBytes(5).toString("hex");
  const token = randomBytes(32).toString("hex");
  return {
    label,
    suffix,
    userId: "e10u_" + suffix,
    publisherId: "e10p_" + suffix,
    membershipId: "e10m_" + suffix,
    domainId: "e10d_" + suffix,
    sessionId: "e10s_" + suffix,
    slug: "e10-" + suffix,
    email: "e10-" + suffix + "@example.test",
    hostname: "e10-" + suffix + ".example.test",
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    installKey: "cfi_" + randomBytes(16).toString("hex"),
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created: false
  };
}

const fixtures = [
  makeFixture("approve"),
  makeFixture("reject")
];

function insertFixture(fixture) {
  fixture.created = true;
  d1([
    "INSERT INTO publisher_users (",
    "  user_id,email,email_normalized,user_status",
    ") VALUES (",
    "  " + q(fixture.userId) + ",",
    "  " + q(fixture.email) + ",",
    "  " + q(fixture.email) + ",",
    "  'active'",
    ");",
    "INSERT INTO publishers (",
    "  publisher_id,slug,display_name,account_status,",
    "  terms_version,terms_accepted_at,",
    "  terms_accepted_by_user_id,install_public_key",
    ") VALUES (",
    "  " + q(fixture.publisherId) + ",",
    "  " + q(fixture.slug) + ",",
    "  'E10 Synthetic',",
    "  'pending_review',",
    "  " + q(TERMS) + ",",
    "  CURRENT_TIMESTAMP,",
    "  " + q(fixture.userId) + ",",
    "  " + q(fixture.installKey),
    ");",
    "INSERT INTO publisher_memberships (",
    "  membership_id,publisher_id,user_id,",
    "  role,membership_status",
    ") VALUES (",
    "  " + q(fixture.membershipId) + ",",
    "  " + q(fixture.publisherId) + ",",
    "  " + q(fixture.userId) + ",",
    "  'owner','active'",
    ");",
    "INSERT INTO publisher_domains (",
    "  domain_id,publisher_id,hostname,is_primary,",
    "  install_status,verification_status,review_status,",
    "  monetization_status,first_seen_at,last_seen_at,verified_at",
    ") VALUES (",
    "  " + q(fixture.domainId) + ",",
    "  " + q(fixture.publisherId) + ",",
    "  " + q(fixture.hostname) + ",1,",
    "  'detected','verified','pending','disabled',",
    "  CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP",
    ");",
    "INSERT INTO publisher_sessions (",
    "  session_id,user_id,token_hash,expires_at,created_at",
    ") VALUES (",
    "  " + q(fixture.sessionId) + ",",
    "  " + q(fixture.userId) + ",",
    "  " + q(fixture.tokenHash) + ",",
    "  " + q(fixture.expires) + ",",
    "  CURRENT_TIMESTAMP",
    ");"
  ].join("\n"));
}

function cleanupFixture(fixture) {
  if (!fixture.created) return;
  d1([
    "DELETE FROM publisher_sessions",
    "  WHERE session_id=" + q(fixture.sessionId) + ";",
    "DELETE FROM publisher_memberships",
    "  WHERE membership_id=" + q(fixture.membershipId) + ";",
    "DELETE FROM publisher_domains",
    "  WHERE domain_id=" + q(fixture.domainId) + ";",
    "DELETE FROM publishers",
    "  WHERE publisher_id=" + q(fixture.publisherId) + ";",
    "DELETE FROM publisher_users",
    "  WHERE user_id=" + q(fixture.userId) + ";"
  ].join("\n"));
  fixture.created = false;
}

async function review(fixture, decision) {
  const response = await call(
    REVIEW,
    "/api/internal/publisher-review",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        publisher_id: fixture.publisherId,
        decision
      })
    }
  );
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { response, body };
}

async function readPublisherState(fixture) {
  const response = await call(
    APP,
    "/api/onboarding/draft",
    {
      method: "GET",
      headers: {
        Cookie:
          "__Host-chinaflow_session=" + fixture.token
      }
    }
  );
  let body = {};
  try {
    body = await response.json();

  } catch {
    body = {};
  }
  return { response, body };
}

function assertNoCommercialRows(fixture) {
  const row = one([
    "SELECT",
    "  (SELECT count(*) FROM publisher_supplier_sites",
    "    WHERE publisher_id=" + q(fixture.publisherId) + ") sites,",
    "  (SELECT count(*) FROM publisher_supplier_offers",
    "    WHERE publisher_id=" + q(fixture.publisherId) + ") offers,",
    "  (SELECT count(*) FROM publisher_placements",
    "    WHERE publisher_id=" + q(fixture.publisherId) + ") placements;"
  ].join("\n"));
  assert.deepEqual(
    {
      sites: Number(row.sites),
      offers: Number(row.offers),
      placements: Number(row.placements)
    },
    { sites: 0, offers: 0, placements: 0 },

    "E10 must not provision or monetize"
  );
}

let primaryError = null;

try {
  const approve = fixtures[0];
  insertFixture(approve);

  const approved = await review(approve, "approve");
  assert.equal(
    approved.response.status,
    200,
    "Remote approve failed: " + JSON.stringify(approved.body)
  );
  assert.equal(
    approved.body?.review?.decision,
    "approve"
  );
  assert.equal(
    approved.body?.review?.account_status,
    "pending_review"
  );
  assert.equal(
    approved.body?.review?.review_status,
    "approved"

  );

  let approvedDb = one([
    "SELECT",
    "  p.account_status,",
    "  d.review_status,",
    "  d.reviewed_at,",
    "  d.monetization_status",
    "FROM publishers p",
    "JOIN publisher_domains d",
    "  ON d.publisher_id=p.publisher_id",
    " AND d.is_primary=1",
    "WHERE p.publisher_id=" + q(approve.publisherId) + ";"
  ].join("\n"));
  assert.equal(approvedDb.account_status, "pending_review");
  assert.equal(approvedDb.review_status, "approved");
  assert.ok(approvedDb.reviewed_at);
  assert.equal(approvedDb.monetization_status, "disabled");
  assertNoCommercialRows(approve);

  const approvedPublic = await readPublisherState(approve);
  assert.equal(
    approvedPublic.response.status,
    200,

    "Approved state must be recoverable by publisher app"
  );
  assert.equal(
    approvedPublic.body?.draft?.publisher?.account_status,
    "pending_review"
  );
  assert.equal(
    approvedPublic.body?.draft?.primary_domain?.review_status,
    "approved"
  );
  assert.equal(
    approvedPublic.body?.draft?.primary_domain?.monetization_status,
    "disabled"
  );

  d1([
    "UPDATE publisher_domains",
    "SET reviewed_at='2001-01-01 00:00:00',",
    "    updated_at='2001-01-01 00:00:00'",
    "WHERE domain_id=" + q(approve.domainId) + ";"
  ].join("\n"));

  const approveRetry = await review(approve, "approve");
  assert.equal(approveRetry.response.status, 200);

  approvedDb = one([
    "SELECT reviewed_at,updated_at",
    "FROM publisher_domains",
    "WHERE domain_id=" + q(approve.domainId) + ";"
  ].join("\n"));
  assert.equal(
    approvedDb.reviewed_at,
    "2001-01-01 00:00:00",
    "Approve retry must not mutate reviewed_at"
  );
  assert.equal(
    approvedDb.updated_at,
    "2001-01-01 00:00:00",
    "Approve retry must not mutate updated_at"
  );

  const oppositeAfterApprove = await review(approve, "reject");
  assert.equal(
    oppositeAfterApprove.response.status,
    409,
    "Opposite reject after approve must conflict"
  );

  cleanupFixture(approve);

  const reject = fixtures[1];
  insertFixture(reject);

  const rejected = await review(reject, "reject");
  assert.equal(
    rejected.response.status,
    200,
    "Remote reject failed: " + JSON.stringify(rejected.body)
  );
  assert.equal(
    rejected.body?.review?.decision,
    "reject"
  );
  assert.equal(
    rejected.body?.review?.account_status,
    "rejected"
  );
  assert.equal(
    rejected.body?.review?.review_status,
    "rejected"
  );

  let rejectedDb = one([
    "SELECT",
    "  p.account_status,",

    "  d.review_status,",
    "  d.reviewed_at,",
    "  d.monetization_status",
    "FROM publishers p",
    "JOIN publisher_domains d",
    "  ON d.publisher_id=p.publisher_id",
    " AND d.is_primary=1",
    "WHERE p.publisher_id=" + q(reject.publisherId) + ";"
  ].join("\n"));
  assert.equal(rejectedDb.account_status, "rejected");
  assert.equal(rejectedDb.review_status, "rejected");
  assert.ok(rejectedDb.reviewed_at);
  assert.equal(rejectedDb.monetization_status, "disabled");
  assertNoCommercialRows(reject);

  const rejectedPublic = await readPublisherState(reject);
  assert.equal(
    rejectedPublic.response.status,
    200,
    "Rejected state must be recoverable by publisher app"
  );
  assert.equal(
    rejectedPublic.body?.draft?.publisher?.account_status,
    "rejected"
  );

  assert.equal(
    rejectedPublic.body?.draft?.primary_domain?.review_status,
    "rejected"
  );

  d1([
    "UPDATE publishers",
    "SET updated_at='2001-01-01 00:00:00'",
    "WHERE publisher_id=" + q(reject.publisherId) + ";",
    "UPDATE publisher_domains",
    "SET reviewed_at='2001-01-01 00:00:00',",
    "    updated_at='2001-01-01 00:00:00'",
    "WHERE domain_id=" + q(reject.domainId) + ";"
  ].join("\n"));

  const rejectRetry = await review(reject, "reject");
  assert.equal(rejectRetry.response.status, 200);
  rejectedDb = one([
    "SELECT",
    "  p.updated_at AS publisher_updated_at,",
    "  d.reviewed_at,",
    "  d.updated_at AS domain_updated_at",
    "FROM publishers p",

    "JOIN publisher_domains d",
    "  ON d.publisher_id=p.publisher_id",
    "WHERE p.publisher_id=" + q(reject.publisherId) + "",
    "  AND d.domain_id=" + q(reject.domainId) + ";"
  ].join("\n"));
  assert.equal(
    rejectedDb.publisher_updated_at,
    "2001-01-01 00:00:00",
    "Reject retry must not mutate publisher"
  );
  assert.equal(
    rejectedDb.reviewed_at,
    "2001-01-01 00:00:00",
    "Reject retry must not mutate reviewed_at"
  );
  assert.equal(
    rejectedDb.domain_updated_at,
    "2001-01-01 00:00:00",
    "Reject retry must not mutate domain"
  );

  const oppositeAfterReject = await review(reject, "approve");
  assert.equal(
    oppositeAfterReject.response.status,

    409,
    "Opposite approve after reject must conflict"
  );

  cleanupFixture(reject);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  for (const fixture of fixtures) {
    try {
      cleanupFixture(fixture);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      console.error(
        "E10 cleanup also failed for " +
          fixture.suffix +
          ": " +
          cleanupError.message
      );
    }
  }
}

assert.deepEqual(
  one(BASELINE_SQL),
  baseline,

  "TEST D1 baseline was not restored"
);

const historicalAfter = Number(one([
  "SELECT count(*) AS n FROM publishers",
  "WHERE terms_version IS NOT NULL",
  "  AND terms_accepted_at IS NOT NULL",
  "  AND terms_accepted_by_user_id IS NULL"
].join("\n")).n);
assert.equal(
  historicalAfter,
  historicalBefore,
  "Historical partial Terms changed"
);

const fk = d1("PRAGMA foreign_key_check");
assert.deepEqual(
  fk,
  [],
  "Foreign-key violations detected"
);

const deployments = wrangler([
  "deployments", "list",
  "--config", REVIEW_CONFIG
]);
const versionMatches = [

  ...deployments.matchAll(
    /Version\(s\):\s+\(100%\)\s+([0-9a-f-]+)/gi
  )
];
const reviewCurrentVersion =
  versionMatches.at(-1)?.[1] ?? reviewDeployVersion;

console.log("===== REPORT =====");
console.log("STEP=E10_REMOTE_TEST_ACCEPTANCE");
console.log("E10_ROUTE_SECURITY=PASS");
console.log("E10_APPROVE_REMOTE=PASS");
console.log("E10_REJECT_REMOTE=PASS");
console.log("APPROVED_STATE_RECOVERY=PASS");
console.log("REJECTED_STATE_RECOVERY=PASS");
console.log("IDEMPOTENT_REVIEW=PASS");
console.log("OPPOSITE_DECISION_CONFLICT=PASS");
console.log("NO_EARLY_PROVISIONING=PASS");
console.log("BASELINE_RESTORED=PASS");
console.log(
  "HISTORICAL_PARTIAL_TERMS=" + historicalAfter
);
console.log("FK=0");
console.log("TEST_DEPLOYMENT=PASS");

console.log("REVIEW_SECRET_STORED=YES");
console.log("REVIEW_SECRET_MODE=0600");
console.log("REVIEW_SECRET_PATH=" + SECRET_PATH);
console.log("PRODUCTION_ACCESS=NO");
console.log("HEAD=" + head);
console.log("PUBLISHER_APP_VERSION=" + appDeployVersion);
console.log("REVIEW_API_VERSION=" + reviewCurrentVersion);

