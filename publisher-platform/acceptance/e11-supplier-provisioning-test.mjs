import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, readFileSync, statSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const APP_CONFIG = "wrangler.publisher-app.test.jsonc";
const PROVISION_CONFIG = "wrangler.publisher-provisioning-api.test.jsonc";
const DB = "chinaflow-events-v0-1-test";
const DB_ID = "f8c07a5f-f9e7-4595-9f25-ce3d525241d9";
const APP_WORKER = "chinaflow-publisher-app-v0-1-test";
const PROVISION_WORKER = "chinaflow-publisher-provisioning-api-v0-1-test";
const APP =
  "https://chinaflow-publisher-app-v0-1-test.an13501112545.workers.dev";
const PROVISION =
  "https://chinaflow-publisher-provisioning-api-v0-1-test.an13501112545.workers.dev";
const TERMS = "chinaflow-publisher-terms-v1";
const SECRET_PATH = join(
  homedir(), ".config", "chinaflow", "provision-api-token-test"
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
const npx = () => process.platform === "win32" ? "npx.cmd" : "npx";
const wrangler = args => run(npx(), ["wrangler", ...args]);
const wranglerInput = (args, input) =>
  run(npx(), ["wrangler", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    input
  });

function isTransientD1AuthError(error) {
  const output = [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean).join("\n");
  return output.includes("Authentication error") && output.includes("10000");
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function d1(sql) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const raw = wrangler([
        "d1", "execute", DB,
        "--remote", "--config", APP_CONFIG,
        "--yes", "--json", "--command", sql
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
  assert.equal(rows.length, 1, "Expected exactly one D1 row");
  return rows[0];
}
function q(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

for (const [configPath, required] of [
  [APP_CONFIG, [
    `"name": "${APP_WORKER}"`,
    `"database_name": "${DB}"`,
    `"database_id": "${DB_ID}"`,
    '"APP_ENVIRONMENT": "test"'
  ]],
  [PROVISION_CONFIG, [
    `"name": "${PROVISION_WORKER}"`,
    `"database_name": "${DB}"`,
    `"database_id": "${DB_ID}"`,
    '"APP_ENVIRONMENT": "test"'
  ]]
]) {
  const config = readFileSync(configPath, "utf8");
  for (const needle of required) {
    assert.ok(config.includes(needle), "TEST config mismatch: " + needle);
  }
  assert.ok(
    !config.includes('"database_name": "chinaflow-events-v0-1"'),
    "Production D1 reference detected"
  );
  assert.ok(
    !config.includes("PROVISION_API_TOKEN"),
    "Provision secret must never be stored in config"
  );
}

assert.equal(
  run("git", ["status", "-sb"]).trim(),
  "## main...origin/main",
  "Git must be clean and synchronized"
);
const head = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(
  head,
  run("git", ["rev-parse", "origin/main"]).trim(),
  "HEAD must equal origin/main"
);

const historicalBefore = Number(one(`
  SELECT count(*) AS n FROM publishers
  WHERE terms_version IS NOT NULL
    AND terms_accepted_at IS NOT NULL
    AND terms_accepted_by_user_id IS NULL
`).n);
assert.equal(historicalBefore, 1, "Historical partial Terms baseline changed");

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
  (SELECT count(*) FROM trip_commissions) trip_commissions;
`;
const baseline = one(BASELINE_SQL);

const appDeploy = wrangler(["deploy", "--config", APP_CONFIG]);
const appVersion =
  appDeploy.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ?? "unknown";
const provisionDeploy = wrangler(["deploy", "--config", PROVISION_CONFIG]);
const provisionDeployVersion =
  provisionDeploy.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ?? "unknown";

const provisionToken =
  "provision_test_" + randomBytes(32).toString("hex");
wranglerInput([
  "secret", "put", "PROVISION_API_TOKEN", "--config", PROVISION_CONFIG
], provisionToken + "\n");

mkdirSync(dirname(SECRET_PATH), { recursive: true });
writeFileSync(SECRET_PATH, provisionToken + "\n", {
  encoding: "utf8", mode: 0o600
});
chmodSync(SECRET_PATH, 0o600);
if (process.platform !== "win32") {
  assert.equal(statSync(SECRET_PATH).mode & 0o777, 0o600);
}

async function call(base, path, init = {}) {
  return fetch(base + path, { redirect: "manual", ...init });
}
async function waitForProvisionApi() {
  let healthStatus = null;
  let patchStatus = null;
  let patchAllow = null;
  let authenticatedInvalidStatus = null;

  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const health = await call(PROVISION, "/health", { method: "GET" });
    healthStatus = health.status;
    await health.arrayBuffer();

    const patch = await call(
      PROVISION,
      "/api/internal/supplier-provisioning/start",
      { method: "PATCH" }
    );
    patchStatus = patch.status;
    patchAllow = patch.headers.get("allow");
    await patch.arrayBuffer();

    const invalid = await call(
      PROVISION,
      "/api/internal/supplier-provisioning/start",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + provisionToken,
          "Content-Type": "application/json"
        },
        body: "{}"
      }
    );
    authenticatedInvalidStatus = invalid.status;
    await invalid.arrayBuffer();

    if (
      healthStatus === 200 &&
      patchStatus === 405 &&
      patchAllow === "POST" &&
      authenticatedInvalidStatus === 400
    ) return;

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(
    "TEST provisioning Worker did not become ready after secret propagation: " +
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
  throw new Error("Publisher app not ready: status=" + lastStatus);
}

await Promise.all([waitForProvisionApi(), waitForPublisherApp()]);

const authHeaders = {
  Authorization: "Bearer " + provisionToken,
  "Content-Type": "application/json"
};

for (const route of [
  "/api/internal/supplier-provisioning/start",
  "/api/internal/supplier-provisioning/complete"
]) {
  for (const method of ["GET","HEAD","PUT","PATCH","DELETE","OPTIONS"]) {
    const response = await call(PROVISION, route, { method });
    assert.equal(response.status, 405, method + " must be 405 for " + route);
  }
}

for (const route of [
  "/api/internal/supplier-provisioning/start",
  "/api/internal/supplier-provisioning/complete"
]) {
  const missing = await call(PROVISION, route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(missing.status, 401, "Missing auth must be 401");

  const wrong = await call(PROVISION, route, {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong_wrong_wrong_wrong_wrong_wrong_wrong",
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  assert.equal(wrong.status, 401, "Wrong auth must be 401");
}

const suffix = Date.now().toString(36) + randomBytes(5).toString("hex");
const userId = "e11u_" + suffix;
const publisherId = "e11p_" + suffix;
const membershipId = "e11m_" + suffix;
const domainId = "e11d_" + suffix;
const sessionId = "e11s_" + suffix;
const slug = "e11-" + suffix;
const email = "e11-" + suffix + "@example.test";
const hostname = "e11-" + suffix + ".example.test";
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const installKey = "cfi_" + randomBytes(16).toString("hex");
const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const aid = "aid_" + suffix;
const sid = "sid_" + suffix;
const sidName = "chinaflow-e11-" + suffix;

let fixtureCreated = false;

function cleanup() {
  if (!fixtureCreated) return;
  d1(`
    DELETE FROM publisher_supplier_offers WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_placements WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_supplier_sites WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_sessions WHERE session_id=${q(sessionId)};
    DELETE FROM publisher_memberships WHERE membership_id=${q(membershipId)};
    DELETE FROM publisher_domains WHERE domain_id=${q(domainId)};
    DELETE FROM publishers WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_users WHERE user_id=${q(userId)};
  `);
  fixtureCreated = false;
}

function commercialCounts() {
  const row = one(`
    SELECT
      (SELECT count(*) FROM publisher_supplier_offers
       WHERE publisher_id=${q(publisherId)}) offers,
      (SELECT count(*) FROM publisher_placements
       WHERE publisher_id=${q(publisherId)}) placements;
  `);
  return { offers: Number(row.offers), placements: Number(row.placements) };
}

async function publisherState() {
  const response = await call(APP, "/api/onboarding/draft", {
    method: "GET",
    headers: { Cookie: "__Host-chinaflow_session=" + token }
  });
  const body = await response.json();
  return { response, body };
}

async function provision(path, body) {
  const response = await call(PROVISION, path, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = await response.json(); } catch {}
  return { response, body: parsed };
}

let primaryError = null;

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
      ${q(publisherId)},${q(slug)},'E11 Synthetic','pending_review',
      ${q(TERMS)},CURRENT_TIMESTAMP,${q(userId)},${q(installKey)}
    );

    INSERT INTO publisher_memberships (
      membership_id,publisher_id,user_id,role,membership_status
    ) VALUES (
      ${q(membershipId)},${q(publisherId)},${q(userId)},'owner','active'
    );

    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,review_status,
      monetization_status,first_seen_at,last_seen_at,
      verified_at,reviewed_at
    ) VALUES (
      ${q(domainId)},${q(publisherId)},${q(hostname)},1,
      'detected','verified','approved','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );

    INSERT INTO publisher_sessions (
      session_id,user_id,token_hash,expires_at,created_at
    ) VALUES (
      ${q(sessionId)},${q(userId)},${q(tokenHash)},${q(expires)},CURRENT_TIMESTAMP
    );
  `);

  const beforeStart = await publisherState();
  assert.equal(beforeStart.response.status, 200);
  assert.equal(
    beforeStart.body?.draft?.primary_domain?.review_status,
    "approved"
  );
  assert.equal(
    Object.hasOwn(beforeStart.body?.draft ?? {}, "supplier_site"),
    false,
    "Supplier site must not exist before E11 start"
  );

  const started = await provision(
    "/api/internal/supplier-provisioning/start",
    { publisher_id: publisherId }
  );
  assert.equal(
    started.response.status,
    201,
    "Remote start failed: " + JSON.stringify(started.body)
  );
  assert.equal(started.body?.provisioning?.supplier, "trip.com");
  assert.equal(started.body?.provisioning?.provisioning_status, "pending");
  assert.equal(started.body?.provisioning?.created, true);

  let stored = one(`
    SELECT
      supplier_site_id,supplier,aid,sid,sid_name,
      provisioning_status,provisioned_at,created_at,updated_at
    FROM publisher_supplier_sites
    WHERE publisher_id=${q(publisherId)}
      AND domain_id=${q(domainId)}
      AND supplier='trip.com'
  `);
  assert.equal(stored.provisioning_status, "pending");
  assert.equal(stored.aid, null);
  assert.equal(stored.sid, null);
  assert.equal(stored.sid_name, null);
  assert.equal(stored.provisioned_at, null);
  assert.deepEqual(commercialCounts(), { offers: 0, placements: 0 });

  let publicState = await publisherState();
  assert.equal(publicState.response.status, 200);
  assert.equal(
    publicState.body?.draft?.supplier_site?.provisioning_status,
    "pending"
  );
  for (const key of ["aid", "sid", "sid_name"]) {
    assert.equal(
      Object.hasOwn(publicState.body?.draft?.supplier_site ?? {}, key),
      false
    );
  }

  d1(`
    UPDATE publisher_supplier_sites
    SET created_at='2001-01-01 00:00:00',
        updated_at='2001-01-01 00:00:00'
    WHERE publisher_id=${q(publisherId)}
  `);

  const startRetry = await provision(
    "/api/internal/supplier-provisioning/start",
    { publisher_id: publisherId }
  );
  assert.equal(startRetry.response.status, 200);
  assert.equal(startRetry.body?.provisioning?.created, false);

  stored = one(`
    SELECT created_at,updated_at
    FROM publisher_supplier_sites
    WHERE publisher_id=${q(publisherId)}
  `);
  assert.equal(stored.created_at, "2001-01-01 00:00:00");
  assert.equal(stored.updated_at, "2001-01-01 00:00:00");

  const completed = await provision(
    "/api/internal/supplier-provisioning/complete",
    {
      publisher_id: publisherId,
      aid,
      sid,
      sid_name: sidName
    }
  );
  assert.equal(
    completed.response.status,
    200,
    "Remote complete failed: " + JSON.stringify(completed.body)
  );
  assert.equal(completed.body?.provisioning?.provisioning_status, "active");
  assert.equal(completed.body?.provisioning?.completed, true);
  assert.equal(completed.body?.provisioning?.aid, aid);
  assert.equal(completed.body?.provisioning?.sid, sid);
  assert.equal(completed.body?.provisioning?.sid_name, sidName);

  stored = one(`
    SELECT
      aid,sid,sid_name,provisioning_status,
      provisioned_at,updated_at
    FROM publisher_supplier_sites
    WHERE publisher_id=${q(publisherId)}
  `);
  assert.equal(stored.aid, aid);
  assert.equal(stored.sid, sid);
  assert.equal(stored.sid_name, sidName);
  assert.equal(stored.provisioning_status, "active");
  assert.ok(stored.provisioned_at);
  assert.deepEqual(commercialCounts(), { offers: 0, placements: 0 });

  const lifecycle = one(`
    SELECT
      p.account_status,
      d.review_status,
      d.monetization_status
    FROM publishers p
    JOIN publisher_domains d
      ON d.publisher_id=p.publisher_id
     AND d.is_primary=1
    WHERE p.publisher_id=${q(publisherId)}
  `);
  assert.equal(lifecycle.account_status, "pending_review");
  assert.equal(lifecycle.review_status, "approved");
  assert.equal(lifecycle.monetization_status, "disabled");

  publicState = await publisherState();
  assert.equal(publicState.response.status, 200);
  assert.equal(
    publicState.body?.draft?.supplier_site?.provisioning_status,
    "active"
  );
  assert.ok(publicState.body?.draft?.supplier_site?.provisioned_at);
  for (const key of ["aid", "sid", "sid_name"]) {
    assert.equal(
      Object.hasOwn(publicState.body?.draft?.supplier_site ?? {}, key),
      false,
      "Publisher state must not expose supplier credential " + key
    );
  }

  d1(`
    UPDATE publisher_supplier_sites
    SET provisioned_at='2001-01-01 00:00:00',
        updated_at='2001-01-01 00:00:00'
    WHERE publisher_id=${q(publisherId)}
  `);

  const completeRetry = await provision(
    "/api/internal/supplier-provisioning/complete",
    {
      publisher_id: publisherId,
      aid,
      sid,
      sid_name: sidName
    }
  );
  assert.equal(completeRetry.response.status, 200);
  assert.equal(completeRetry.body?.provisioning?.completed, false);

  stored = one(`
    SELECT provisioned_at,updated_at
    FROM publisher_supplier_sites
    WHERE publisher_id=${q(publisherId)}
  `);
  assert.equal(stored.provisioned_at, "2001-01-01 00:00:00");
  assert.equal(stored.updated_at, "2001-01-01 00:00:00");

  const drift = await provision(
    "/api/internal/supplier-provisioning/complete",
    {
      publisher_id: publisherId,
      aid: aid + "_different",
      sid,
      sid_name: sidName
    }
  );
  assert.equal(
    drift.response.status,
    409,
    "Credential drift after activation must conflict"
  );

  assert.deepEqual(commercialCounts(), { offers: 0, placements: 0 });
  cleanup();
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    cleanup();
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    console.error(
      "E11 cleanup also failed for synthetic suffix " +
      suffix + ": " + cleanupError.message
    );
  }
}

assert.deepEqual(
  one(BASELINE_SQL),
  baseline,
  "TEST D1 baseline was not restored"
);

const historicalAfter = Number(one(`
  SELECT count(*) AS n FROM publishers
  WHERE terms_version IS NOT NULL
    AND terms_accepted_at IS NOT NULL
    AND terms_accepted_by_user_id IS NULL
`).n);
assert.equal(
  historicalAfter,
  historicalBefore,
  "Historical partial Terms changed"
);

const fk = d1("PRAGMA foreign_key_check");
assert.deepEqual(fk, [], "Foreign-key violations detected");

const deployments = wrangler([
  "deployments", "list", "--config", PROVISION_CONFIG
]);
const versionMatches = [
  ...deployments.matchAll(
    /Version\(s\):\s+\(100%\)\s+([0-9a-f-]+)/gi
  )
];
const provisionVersion =
  versionMatches.at(-1)?.[1] ?? provisionDeployVersion;

console.log("===== REPORT =====");
console.log("STEP=E11_REMOTE_TEST_ACCEPTANCE");
console.log("E11_ROUTE_SECURITY=PASS");
console.log("E11_START_REMOTE=PASS");
console.log("E11_COMPLETE_REMOTE=PASS");
console.log("PENDING_PROVISIONING_RECOVERY=PASS");
console.log("ACTIVE_PROVISIONING_RECOVERY=PASS");
console.log("SUPPLIER_CREDENTIAL_PRIVACY=PASS");
console.log("IDEMPOTENT_START=PASS");
console.log("IDEMPOTENT_COMPLETE=PASS");
console.log("CREDENTIAL_DRIFT_CONFLICT=PASS");
console.log("NO_EARLY_OFFERS=PASS");
console.log("NO_EARLY_PLACEMENTS=PASS");
console.log("NO_EARLY_MONETIZATION=PASS");
console.log("PUBLISHER_REMAINS_PENDING_REVIEW=PASS");
console.log("BASELINE_RESTORED=PASS");
console.log("HISTORICAL_PARTIAL_TERMS=" + historicalAfter);
console.log("FK=0");
console.log("TEST_DEPLOYMENT=PASS");
console.log("PROVISION_SECRET_STORED=YES");
console.log("PROVISION_SECRET_MODE=0600");
console.log("PROVISION_SECRET_PATH=" + SECRET_PATH);
console.log("PRODUCTION_ACCESS=NO");
console.log("HEAD=" + head);
console.log("PUBLISHER_APP_VERSION=" + appVersion);
console.log("PROVISION_API_VERSION=" + provisionVersion);

