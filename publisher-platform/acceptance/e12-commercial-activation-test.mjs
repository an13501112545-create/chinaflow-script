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
const ACTIVATION_CONFIG = "wrangler.publisher-activation-api.test.jsonc";
const CONFIG_API_CONFIG = "wrangler.publisher-config-api.test.jsonc";
const DB = "chinaflow-events-v0-1-test";
const DB_ID = "f8c07a5f-f9e7-4595-9f25-ce3d525241d9";

const APP_WORKER = "chinaflow-publisher-app-v0-1-test";
const ACTIVATION_WORKER = "chinaflow-publisher-activation-api-v0-1-test";
const CONFIG_WORKER = "chinaflow-config-api-v0-1-test";

const APP =
  "https://chinaflow-publisher-app-v0-1-test.an13501112545.workers.dev";
const ACTIVATION =
  "https://chinaflow-publisher-activation-api-v0-1-test.an13501112545.workers.dev";
const CONFIG_API =
  "https://chinaflow-config-api-v0-1-test.an13501112545.workers.dev";

const TERMS = "chinaflow-publisher-terms-v1";
const SECRET_PATH = join(
  homedir(), ".config", "chinaflow", "activation-api-token-test"
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

for (const [configPath, required, forbiddenSecret] of [
  [APP_CONFIG, [
    `"name": "${APP_WORKER}"`,
    `"database_name": "${DB}"`,
    `"database_id": "${DB_ID}"`,
    '"APP_ENVIRONMENT": "test"'
  ], null],
  [ACTIVATION_CONFIG, [
    `"name": "${ACTIVATION_WORKER}"`,
    `"database_name": "${DB}"`,
    `"database_id": "${DB_ID}"`,
    '"APP_ENVIRONMENT": "test"'
  ], "ACTIVATION_API_TOKEN"],
  [CONFIG_API_CONFIG, [
    `"name": "${CONFIG_WORKER}"`,
    `"database_name": "${DB}"`,
    `"database_id": "${DB_ID}"`
  ], null]
]) {
  const config = readFileSync(configPath, "utf8");
  for (const needle of required) {
    assert.ok(config.includes(needle), "TEST config mismatch: " + needle);
  }
  assert.ok(
    !config.includes('"database_name": "chinaflow-events-v0-1"'),
    "Production D1 reference detected"
  );
  if (forbiddenSecret) {
    assert.ok(
      !config.includes(forbiddenSecret),
      "Activation secret must never be stored in config"
    );
  }
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

const activationDeploy = wrangler(["deploy", "--config", ACTIVATION_CONFIG]);
const activationDeployVersion =
  activationDeploy.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ?? "unknown";

const configDeploy = wrangler(["deploy", "--config", CONFIG_API_CONFIG]);
const configVersion =
  configDeploy.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ?? "unknown";

const activationToken =
  "activation_test_" + randomBytes(32).toString("hex");

wranglerInput([
  "secret", "put", "ACTIVATION_API_TOKEN", "--config", ACTIVATION_CONFIG
], activationToken + "\n");

mkdirSync(dirname(SECRET_PATH), { recursive: true });
writeFileSync(SECRET_PATH, activationToken + "\n", {
  encoding: "utf8", mode: 0o600
});
chmodSync(SECRET_PATH, 0o600);
if (process.platform !== "win32") {
  assert.equal(statSync(SECRET_PATH).mode & 0o777, 0o600);
}

async function call(base, route, init = {}) {
  return fetch(base + route, { redirect: "manual", ...init });
}
async function waitForActivationApi() {
  let healthStatus = null;
  let patchStatus = null;
  let patchAllow = null;
  let authenticatedInvalidStatus = null;

  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const health = await call(ACTIVATION, "/health", { method: "GET" });
    healthStatus = health.status;
    await health.arrayBuffer();

    const patch = await call(
      ACTIVATION,
      "/api/internal/commercial-activation",
      { method: "PATCH" }
    );
    patchStatus = patch.status;
    patchAllow = patch.headers.get("allow");
    await patch.arrayBuffer();

    const invalid = await call(
      ACTIVATION,
      "/api/internal/commercial-activation",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + activationToken,
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
    "TEST activation Worker did not become ready after secret propagation: " +
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

async function waitForConfigApi() {
  let lastStatus = null;
  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const response = await call(CONFIG_API, "/v1/config", { method: "GET" });
    lastStatus = response.status;
    await response.arrayBuffer();
    if (lastStatus === 400) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Config API not ready: status=" + lastStatus);
}

await Promise.all([
  waitForActivationApi(),
  waitForPublisherApp(),
  waitForConfigApi()
]);

for (const method of ["GET","HEAD","PUT","PATCH","DELETE","OPTIONS"]) {
  const response = await call(
    ACTIVATION,
    "/api/internal/commercial-activation",
    { method }
  );
  assert.equal(response.status, 405, method + " activation must be 405");
}

{
  const missing = await call(
    ACTIVATION,
    "/api/internal/commercial-activation",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }
  );
  assert.equal(missing.status, 401, "Missing activation auth must be 401");

  const wrong = await call(
    ACTIVATION,
    "/api/internal/commercial-activation",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong_wrong_wrong_wrong_wrong_wrong_wrong",
        "Content-Type": "application/json"
      },
      body: "{}"
    }
  );
  assert.equal(wrong.status, 401, "Wrong activation auth must be 401");

  const query = await call(
    ACTIVATION,
    "/api/internal/commercial-activation?publisher_id=forged",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + activationToken,
        "Content-Type": "application/json"
      },
      body: "{}"
    }
  );
  assert.equal(query.status, 400, "Activation query selectors must be 400");
}

const suffix = Date.now().toString(36) + randomBytes(5).toString("hex");
const userId = "e12u_" + suffix;
const publisherId = "e12p_" + suffix;
const membershipId = "e12m_" + suffix;
const domainId = "e12d_" + suffix;
const siteId = "e12site_" + suffix;
const sessionId = "e12s_" + suffix;
const slug = "e12-" + suffix;
const email = "e12-" + suffix + "@example.test";
const hostname = "e12-" + suffix + ".example.test";
const origin = "https://" + hostname;
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const installKey = "cfi_" + randomBytes(16).toString("hex");
const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const aid = "aid" + randomBytes(6).toString("hex");
const sid = "sid" + randomBytes(6).toString("hex");
const hotelPlacement = "e12_hotels_" + suffix;
const flightPlacement = "e12_flights_" + suffix;

const hotelUrl =
  "https://www.trip.com/hotels" +
  "?Allianceid=" + encodeURIComponent(aid) +
  "&SID=" + encodeURIComponent(sid) +
  "&trip_sub1=" + encodeURIComponent(hotelPlacement) +
  "&trip_sub3=E12REMOTE";

const flightUrl =
  "https://www.trip.com/flights" +
  "?Allianceid=" + encodeURIComponent(aid) +
  "&SID=" + encodeURIComponent(sid) +
  "&trip_sub1=" + encodeURIComponent(flightPlacement) +
  "&trip_sub3=E12REMOTE";

const activationInput = {
  publisher_id: publisherId,
  offers: [
    {
      product: "hotel",
      placement: hotelPlacement,
      affiliate_url: hotelUrl
    },
    {
      product: "flight",
      placement: flightPlacement,
      affiliate_url: flightUrl
    }
  ]
};

let fixtureCreated = false;

function cleanup() {
  if (!fixtureCreated) return;
  d1(`
    DELETE FROM publisher_supplier_offers WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_placements WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_supplier_sites WHERE supplier_site_id=${q(siteId)};
    DELETE FROM publisher_sessions WHERE session_id=${q(sessionId)};
    DELETE FROM publisher_memberships WHERE membership_id=${q(membershipId)};
    DELETE FROM publisher_domains WHERE domain_id=${q(domainId)};
    DELETE FROM publishers WHERE publisher_id=${q(publisherId)};
    DELETE FROM publisher_users WHERE user_id=${q(userId)};
  `);
  fixtureCreated = false;
}

async function publisherState() {
  const response = await call(APP, "/api/onboarding/draft", {
    method: "GET",
    headers: { Cookie: "__Host-chinaflow_session=" + token }
  });
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function runtimeConfig() {
  const response = await call(
    CONFIG_API,
    "/v1/config?install_key=" + encodeURIComponent(installKey),
    {
      method: "GET",
      headers: { Origin: origin }
    }
  );
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function activate(body = activationInput) {
  const response = await call(
    ACTIVATION,
    "/api/internal/commercial-activation",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + activationToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
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
      ${q(publisherId)},${q(slug)},'E12 Synthetic','pending_review',
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

    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,
      aid,sid,sid_name,provisioning_status,provisioned_at
    ) VALUES (
      ${q(siteId)},${q(publisherId)},${q(domainId)},'trip.com',
      ${q(aid)},${q(sid)},${q("chinaflow-" + suffix)},
      'active',CURRENT_TIMESTAMP
    );

    INSERT INTO publisher_sessions (
      session_id,user_id,token_hash,expires_at,created_at
    ) VALUES (
      ${q(sessionId)},${q(userId)},${q(tokenHash)},
      ${q(expires)},CURRENT_TIMESTAMP
    );
  `);

  const beforePublic = await publisherState();
  assert.equal(beforePublic.response.status, 200);
  assert.equal(
    beforePublic.body?.draft?.publisher?.account_status,
    "pending_review"
  );
  assert.equal(
    beforePublic.body?.draft?.primary_domain?.monetization_status,
    "disabled"
  );
  assert.equal(
    beforePublic.body?.draft?.supplier_site?.provisioning_status,
    "active"
  );

  const beforeRuntime = await runtimeConfig();
  assert.equal(
    beforeRuntime.response.status,
    200,
    "Pre-activation runtime config must be readable"
  );
  assert.equal(
    beforeRuntime.response.headers.get("access-control-allow-origin"),
    origin
  );
  assert.equal(beforeRuntime.body?.runtime_enabled, false);
  assert.deepEqual(beforeRuntime.body?.offers, []);

  const activated = await activate();
  assert.equal(
    activated.response.status,
    200,
    "Remote activation failed: " + JSON.stringify(activated.body)
  );
  assert.equal(activated.body?.activation?.activated, true);
  assert.equal(activated.body?.activation?.account_status, "active");
  assert.equal(activated.body?.activation?.monetization_status, "enabled");
  assert.equal(activated.body?.activation?.supplier, "trip.com");
  assert.equal(activated.body?.activation?.offer_count, 2);

  const lifecycle = one(`
    SELECT
      p.account_status,
      d.install_status,
      d.verification_status,
      d.review_status,
      d.monetization_status,
      s.provisioning_status
    FROM publishers p
    JOIN publisher_domains d
      ON d.publisher_id=p.publisher_id AND d.is_primary=1
    JOIN publisher_supplier_sites s
      ON s.publisher_id=p.publisher_id
     AND s.domain_id=d.domain_id
     AND s.supplier='trip.com'
    WHERE p.publisher_id=${q(publisherId)}
  `);
  assert.equal(lifecycle.account_status, "active");
  assert.equal(lifecycle.install_status, "detected");
  assert.equal(lifecycle.verification_status, "verified");
  assert.equal(lifecycle.review_status, "approved");
  assert.equal(lifecycle.monetization_status, "enabled");
  assert.equal(lifecycle.provisioning_status, "active");

  const commercial = d1(`
    SELECT
      o.product,
      o.offer_key,
      o.affiliate_url,
      o.is_active AS offer_active,
      pp.placement,
      pp.external_tracking_key,
      pp.supplier,
      pp.is_active AS placement_active
    FROM publisher_supplier_offers o
    JOIN publisher_placements pp
      ON pp.placement_id=o.placement_id
     AND pp.publisher_id=o.publisher_id
    WHERE o.publisher_id=${q(publisherId)}
    ORDER BY o.product
  `);
  assert.equal(commercial.length, 2);

  const flightRow = commercial.find(row => row.product === "flight");
  const hotelRow = commercial.find(row => row.product === "hotel");
  assert.ok(flightRow);
  assert.ok(hotelRow);

  for (const [row, expectedPlacement, expectedUrl] of [
    [hotelRow, hotelPlacement, hotelUrl],
    [flightRow, flightPlacement, flightUrl]
  ]) {
    assert.equal(row.offer_key, row.product);
    assert.equal(row.affiliate_url, expectedUrl);
    assert.equal(Number(row.offer_active), 1);
    assert.equal(row.placement, expectedPlacement);
    assert.equal(row.external_tracking_key, expectedPlacement);
    assert.equal(row.supplier, "trip.com");
    assert.equal(Number(row.placement_active), 1);
  }

  const afterPublic = await publisherState();
  assert.equal(afterPublic.response.status, 200);
  assert.equal(
    afterPublic.body?.draft?.publisher?.account_status,
    "active"
  );
  assert.equal(
    afterPublic.body?.draft?.primary_domain?.monetization_status,
    "enabled"
  );
  assert.equal(
    afterPublic.body?.draft?.supplier_site?.provisioning_status,
    "active"
  );

  const publicSerialized = JSON.stringify(afterPublic.body);
  for (const forbidden of [
    aid,
    sid,
    hotelUrl,
    flightUrl,
    "affiliate_url",
    "trip_sub1"
  ]) {
    assert.equal(
      publicSerialized.includes(forbidden),
      false,
      "Publisher onboarding state leaked commercial credential data"
    );
  }

  const afterRuntime = await runtimeConfig();
  assert.equal(
    afterRuntime.response.status,
    200,
    "Activated runtime config must be readable"
  );
  assert.equal(
    afterRuntime.response.headers.get("access-control-allow-origin"),
    origin
  );
  assert.equal(afterRuntime.body?.runtime_enabled, true);
  assert.equal(afterRuntime.body?.bound_origin, origin);
  assert.equal(afterRuntime.body?.offers?.length, 2);

  const runtimeHotel = afterRuntime.body.offers.find(
    offer => offer.product === "hotel"
  );
  const runtimeFlight = afterRuntime.body.offers.find(
    offer => offer.product === "flight"
  );
  assert.ok(runtimeHotel);
  assert.ok(runtimeFlight);
  assert.equal(runtimeHotel.placement, hotelPlacement);
  assert.equal(runtimeHotel.url, hotelUrl);
  assert.equal(runtimeFlight.placement, flightPlacement);
  assert.equal(runtimeFlight.url, flightUrl);

  d1(`
    UPDATE publishers
      SET updated_at='2001-01-01 00:00:00'
      WHERE publisher_id=${q(publisherId)};
    UPDATE publisher_domains
      SET updated_at='2001-01-01 00:00:00'
      WHERE domain_id=${q(domainId)};
    UPDATE publisher_placements
      SET updated_at='2001-01-01 00:00:00'
      WHERE publisher_id=${q(publisherId)};
    UPDATE publisher_supplier_offers
      SET updated_at='2001-01-01 00:00:00'
      WHERE publisher_id=${q(publisherId)};
  `);

  const retry = await activate();
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body?.activation?.activated, false);

  const retryTimestamps = one(`
    SELECT
      (SELECT updated_at FROM publishers
       WHERE publisher_id=${q(publisherId)}) publisher_updated_at,
      (SELECT updated_at FROM publisher_domains
       WHERE domain_id=${q(domainId)}) domain_updated_at,
      (SELECT count(*) FROM publisher_placements
       WHERE publisher_id=${q(publisherId)}
         AND updated_at='2001-01-01 00:00:00') placement_old_count,
      (SELECT count(*) FROM publisher_supplier_offers
       WHERE publisher_id=${q(publisherId)}
         AND updated_at='2001-01-01 00:00:00') offer_old_count
  `);
  assert.equal(retryTimestamps.publisher_updated_at, "2001-01-01 00:00:00");
  assert.equal(retryTimestamps.domain_updated_at, "2001-01-01 00:00:00");
  assert.equal(Number(retryTimestamps.placement_old_count), 2);
  assert.equal(Number(retryTimestamps.offer_old_count), 2);

  const driftInput = structuredClone(activationInput);
  driftInput.offers[0].affiliate_url += "&drift=1";
  const drift = await activate(driftInput);
  assert.equal(
    drift.response.status,
    409,
    "Active commercial graph drift must conflict"
  );

  const countCheck = one(`
    SELECT
      (SELECT count(*) FROM publisher_placements
       WHERE publisher_id=${q(publisherId)}) placements,
      (SELECT count(*) FROM publisher_supplier_offers
       WHERE publisher_id=${q(publisherId)}) offers
  `);
  assert.equal(Number(countCheck.placements), 2);
  assert.equal(Number(countCheck.offers), 2);

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
      "E12 cleanup also failed for synthetic suffix " +
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
  "deployments", "list", "--config", ACTIVATION_CONFIG
]);
const versionMatches = [
  ...deployments.matchAll(
    /Version\(s\):\s+\(100%\)\s+([0-9a-f-]+)/gi
  )
];
const activationVersion =
  versionMatches.at(-1)?.[1] ?? activationDeployVersion;

console.log("===== REPORT =====");
console.log("STEP=E12_REMOTE_TEST_ACCEPTANCE");
console.log("E12_ROUTE_SECURITY=PASS");
console.log("PRE_ACTIVATION_RUNTIME_INERT=PASS");
console.log("E12_ACTIVATION_REMOTE=PASS");
console.log("COMMERCIAL_GRAPH_ATOMIC=PASS");
console.log("ACTIVE_STATE_RECOVERY=PASS");
console.log("RUNTIME_CONFIG_ACTIVE=PASS");
console.log("RUNTIME_TWO_OFFERS=PASS");
console.log("RUNTIME_URLS_EXACT=PASS");
console.log("RUNTIME_CORS_BOUND_ORIGIN=PASS");
console.log("COMMERCIAL_CREDENTIAL_PRIVACY=PASS");
console.log("IDEMPOTENT_ACTIVATION=PASS");
console.log("GRAPH_DRIFT_CONFLICT=PASS");
console.log("PUBLISHER_ACTIVE=PASS");
console.log("MONETIZATION_ENABLED=PASS");
console.log("SUPPLIER_REMAINS_ACTIVE=PASS");
console.log("BASELINE_RESTORED=PASS");
console.log("HISTORICAL_PARTIAL_TERMS=" + historicalAfter);
console.log("FK=0");
console.log("TEST_DEPLOYMENT=PASS");
console.log("ACTIVATION_SECRET_STORED=YES");
console.log("ACTIVATION_SECRET_MODE=0600");
console.log("ACTIVATION_SECRET_PATH=" + SECRET_PATH);
console.log("PRODUCTION_ACCESS=NO");
console.log("HEAD=" + head);
console.log("PUBLISHER_APP_VERSION=" + appVersion);
console.log("ACTIVATION_API_VERSION=" + activationVersion);
console.log("CONFIG_API_VERSION=" + configVersion);

