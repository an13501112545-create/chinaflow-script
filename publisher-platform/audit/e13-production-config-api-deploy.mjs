import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const CONFIG = "wrangler.publisher-config-api.production.jsonc";
const PROD_DB = "chinaflow-events-v0-1";
const PROD_DB_ID = "838917da-3fb8-437e-bc00-caff178798e8";
const WORKER = "chinaflow-config-api-v0-1";
const URL =
  "https://chinaflow-config-api-v0-1.an13501112545.workers.dev";
const AUDITED_BASELINE_HEAD =
  "6563cc4b2f5fd52ee393f1262ea7d21ed4d70e05";

const PLATFORM_TABLES = [
  "publishers",
  "publisher_domains",
  "publisher_supplier_sites",
  "publisher_supplier_offers",
  "publisher_users",
  "publisher_memberships",
  "publisher_magic_links",
  "publisher_sessions"
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      ...(options.env ?? {})
    }
  });
}

const npx = () =>
  process.platform === "win32" ? "npx.cmd" : "npx";

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

run("git", [
  "merge-base",
  "--is-ancestor",
  AUDITED_BASELINE_HEAD,
  head
]);

const configText = run(
  process.platform === "win32" ? "cmd.exe" : "cat",
  process.platform === "win32"
    ? ["/c", "type", CONFIG]
    : [CONFIG]
);

assert.ok(configText.includes(`"name": "${WORKER}"`));
assert.ok(configText.includes(`"database_name": "${PROD_DB}"`));
assert.ok(configText.includes(`"database_id": "${PROD_DB_ID}"`));
assert.ok(!configText.includes("chinaflow-events-v0-1-test"));
assert.ok(!configText.includes("-test.an13501112545.workers.dev"));

function assertReadOnlySql(sql) {
  const trimmed = sql.trim();
  const body = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  assert.ok(/^SELECT\b/i.test(body), "Only SELECT is allowed");
  assert.ok(!body.includes(";"), "Multiple SQL statements rejected");
}

function d1(sql) {
  assertReadOnlySql(sql);

  const raw = run(npx(), [
    "wrangler",
    "d1",
    "execute",
    PROD_DB,
    "--remote",
    "--config",
    CONFIG,
    "--yes",
    "--json",
    "--command",
    sql
  ]);

  const parsed = JSON.parse(raw);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.ok(first?.success === true, "Production D1 read failed");
  return first.results ?? [];
}

function one(sql) {
  const rows = d1(sql);
  assert.equal(rows.length, 1, "Expected exactly one row");
  return rows[0];
}

function snapshot() {
  const result = {
    events: Number(one("SELECT count(*) AS n FROM events").n),
    publisher_placements: Number(
      one("SELECT count(*) AS n FROM publisher_placements").n
    ),
    report_ingestion_runs: Number(
      one("SELECT count(*) AS n FROM report_ingestion_runs").n
    ),
    trip_bookings: Number(
      one("SELECT count(*) AS n FROM trip_bookings").n
    ),
    trip_commissions: Number(
      one("SELECT count(*) AS n FROM trip_commissions").n
    )
  };

  for (const table of PLATFORM_TABLES) {
    result[table] = Number(
      one(`SELECT count(*) AS n FROM ${table}`).n
    );
  }

  return result;
}

const migrations = run(npx(), [
  "wrangler",
  "d1",
  "migrations",
  "list",
  PROD_DB,
  "--remote",
  "--config",
  CONFIG
]);

for (const name of [
  "0003_publisher_platform_v1.sql",
  "0004_publisher_supplier_offers_v1.sql",
  "0005_publisher_accounts_v1.sql",
  "0006_publisher_terms_acceptance_v1.sql",
  "0007_publisher_install_identity_v1.sql"
]) {
  assert.equal(
    migrations.includes(name),
    false,
    "Schema migration still pending: " + name
  );
}

const before = snapshot();

assert.ok(before.events >= 145);
assert.equal(before.publisher_placements, 4);
assert.equal(before.report_ingestion_runs, 0);
assert.equal(before.trip_bookings, 0);
assert.equal(before.trip_commissions, 0);

for (const table of PLATFORM_TABLES) {
  assert.equal(
    before[table],
    0,
    table + " must be empty before first Worker rollout"
  );
}

const deployOutput = run(
  npx(),
  ["wrangler", "deploy", "--config", CONFIG],
  { env: { CI: "1" } }
);

const version =
  deployOutput.match(/Current Version ID:\s*([^\s]+)/i)?.[1] ??
  "unknown";

async function request(path, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(URL + path, {
        redirect: "manual",
        ...init
      });
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      await new Promise(resolve =>
        setTimeout(resolve, attempt * 500)
      );
    }
  }
  throw lastError;
}

async function waitReady() {
  let status = null;

  for (let attempt = 1; attempt <= 80; attempt += 1) {
    try {
      const response = await request("/v1/config");
      status = response.status;
      await response.arrayBuffer();

      if (status === 400) return;
    } catch {
      // Transient Worker propagation/network error.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(
    "Production Config API readiness failed: status=" + status
  );
}

await waitReady();

{
  const response = await request("/v1/config");
  assert.equal(response.status, 400);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    null
  );
}

{
  const response = await request(
    "/v1/config?install_key=invalid",
    {
      headers: {
        Origin: "https://example.com"
      }
    }
  );
  assert.equal(response.status, 400);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    null
  );
}

{
  const installKey =
    "cfi_0123456789abcdef0123456789abcdef";

  const response = await request(
    "/v1/config?install_key=" +
      encodeURIComponent(installKey),
    {
      headers: {
        Origin: "https://example.com"
      }
    }
  );

  assert.equal(response.status, 403);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    null
  );
}

for (const asset of [
  "/runtime/loader.js",
  "/runtime/chinaflow-v0.6.js"
]) {
  const response = await request(asset);
  assert.equal(response.status, 200, asset + " must be 200");
  const text = await response.text();
  assert.ok(text.length > 100, asset + " must not be empty");
}

{
  const response = await request("/unknown");
  assert.equal(response.status, 404);
}

const after = snapshot();

assert.deepEqual(
  after,
  before,
  "Config API deployment must not mutate Production D1"
);

const deployments = run(npx(), [
  "wrangler",
  "deployments",
  "list",
  "--config",
  CONFIG
]);

console.log("===== DEPLOY OUTPUT =====");
console.log(deployOutput.trim());
console.log("===== REPORT =====");
console.log("STEP=E13_PRODUCTION_CONFIG_API_DEPLOY");
console.log("RESULT=PASS");
console.log("WORKER=" + WORKER);
console.log("WORKER_URL=" + URL);
console.log("WORKER_DEPLOYMENT=YES");
console.log("OTHER_WORKER_DEPLOYMENT=NO");
console.log("SECRET_WRITE=NO");
console.log("PRODUCTION_D1_WRITE=NO");
console.log("MIGRATION_APPLY=NO");
console.log("CONFIG_API_FAIL_CLOSED=PASS");
console.log("UNKNOWN_INSTALL_KEY_403=PASS");
console.log("UNKNOWN_INSTALL_KEY_CORS_NONE=PASS");
console.log("RUNTIME_LOADER=PASS");
console.log("RUNTIME_ENGINE_V06=PASS");
console.log("PRODUCTION_D1_UNCHANGED=PASS");
console.log("PLATFORM_TABLES_EMPTY=PASS");
console.log("BEFORE_COUNTS=" + JSON.stringify(before));
console.log("AFTER_COUNTS=" + JSON.stringify(after));
console.log("HEAD=" + head);
console.log("CONFIG_API_VERSION=" + version);
console.log(
  "DEPLOYMENTS_LIST_READABLE=" +
  (deployments.length > 0 ? "YES" : "NO")
);
