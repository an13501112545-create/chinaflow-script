import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const CONFIG = "wrangler.publisher-auth-api.production.jsonc";
const PROD_DB = "chinaflow-events-v0-1";
const PROD_DB_ID = "838917da-3fb8-437e-bc00-caff178798e8";
const WORKER = "chinaflow-auth-api-v0-1";
const URL =
  "https://chinaflow-auth-api-v0-1.an13501112545.workers.dev";
const APP_ORIGIN =
  "https://chinaflow-publisher-app-v0-1.an13501112545.workers.dev";
const AUDITED_BASELINE_HEAD =
  "2bd7e070b8282b171ed266980dc9fcdcd61229ed";
const ONE_TIME_ENV = "CHINAFLOW_RESEND_API_KEY_ONCE";

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

const configText = readFileSync(CONFIG, "utf8");

assert.ok(configText.includes(`"name": "${WORKER}"`));
assert.ok(configText.includes(`"database_name": "${PROD_DB}"`));
assert.ok(configText.includes(`"database_id": "${PROD_DB_ID}"`));
assert.ok(configText.includes('"AUTH_ENVIRONMENT": "production"'));
assert.ok(configText.includes(`"APP_ORIGIN": "${APP_ORIGIN}"`));
assert.ok(configText.includes('"required": ["RESEND_API_KEY"]'));
assert.ok(!configText.includes("AUTH_TEST_EMAIL"));
assert.ok(!configText.includes("chinaflow-events-v0-1-test"));
assert.ok(!configText.includes("-test.an13501112545.workers.dev"));

const resendKey = process.env[ONE_TIME_ENV];

assert.ok(
  typeof resendKey === "string" &&
  resendKey.length >= 20 &&
  resendKey.length <= 512 &&
  !/[\r\n\0]/.test(resendKey),
  "One-time Resend API key is missing or invalid"
);

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
    table + " must remain empty before Auth API rollout"
  );
}

const home =
  process.env.HOME ||
  process.env.USERPROFILE ||
  ROOT;

const secretDir = join(home, ".config", "chinaflow");
mkdirSync(secretDir, { recursive: true });
chmodSync(secretDir, 0o700);

const secretPath = join(
  secretDir,
  "e13-auth-secret-" + process.pid + "-" +
    randomBytes(4).toString("hex") + ".json"
);

writeFileSync(
  secretPath,
  JSON.stringify({ RESEND_API_KEY: resendKey }),
  { encoding: "utf8", mode: 0o600 }
);

delete process.env[ONE_TIME_ENV];

let deployOutput = "";

try {
  deployOutput = run(
    npx(),
    [
      "wrangler",
      "deploy",
      "--config",
      CONFIG,
      "--secrets-file",
      secretPath
    ],
    {
      env: {
        CI: "1",
        [ONE_TIME_ENV]: ""
      }
    }
  );
} finally {
  if (existsSync(secretPath)) {
    rmSync(secretPath, { force: true });
  }
}

assert.equal(
  existsSync(secretPath),
  false,
  "Temporary secret file was not removed"
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
      const response = await request("/unknown");
      status = response.status;
      await response.arrayBuffer();

      if (status === 404) return;
    } catch {
      // Worker propagation or transient network error.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(
    "Production Auth API readiness failed: status=" + status
  );
}

await waitReady();

{
  const response = await request("/unknown");
  assert.equal(response.status, 404);
}

{
  const response = await request("/v1/auth/magic-link", {
    method: "GET",
    headers: {
      Origin: APP_ORIGIN
    }
  });
  assert.equal(response.status, 405);
}

{
  const response = await request("/v1/auth/magic-link", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: "nobody@example.com"
    })
  });

  assert.equal(response.status, 403);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    null
  );
}

{
  const response = await request("/v1/auth/magic-link", {
    method: "OPTIONS",
    headers: {
      Origin: APP_ORIGIN,
      "Access-Control-Request-Method": "POST"
    }
  });

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    APP_ORIGIN
  );
}

const after = snapshot();

assert.deepEqual(
  after,
  before,
  "Auth API deployment or route checks mutated Production D1"
);

const secrets = run(npx(), [
  "wrangler",
  "secret",
  "list",
  "--config",
  CONFIG
]);

assert.ok(
  secrets.includes("RESEND_API_KEY"),
  "Production Auth API secret is not present"
);

assert.equal(
  secrets.includes(resendKey),
  false,
  "Secret value unexpectedly exposed by Wrangler"
);

console.log("===== DEPLOY OUTPUT =====");
console.log(deployOutput.trim());
console.log("===== REPORT =====");
console.log("STEP=E13_PRODUCTION_AUTH_API_DEPLOY");
console.log("RESULT=PASS");
console.log("WORKER=" + WORKER);
console.log("WORKER_URL=" + URL);
console.log("WORKER_DEPLOYMENT=YES");
console.log("OTHER_WORKER_DEPLOYMENT=NO");
console.log("SECRET_WRITE=RESEND_API_KEY_ONLY");
console.log("SECRET_VALUE_EXPOSED=NO");
console.log("TEMP_SECRET_FILE_REMOVED=YES");
console.log("PRODUCTION_D1_WRITE=NO");
console.log("MIGRATION_APPLY=NO");
console.log("AUTH_UNKNOWN_ROUTE_404=PASS");
console.log("AUTH_POST_ONLY=PASS");
console.log("AUTH_BAD_ORIGIN_403=PASS");
console.log("AUTH_BAD_ORIGIN_CORS_NONE=PASS");
console.log("AUTH_VALID_PREFLIGHT_204=PASS");
console.log("RESEND_SECRET_PRESENT=PASS");
console.log("PRODUCTION_D1_UNCHANGED=PASS");
console.log("PLATFORM_TABLES_EMPTY=PASS");
console.log("BEFORE_COUNTS=" + JSON.stringify(before));
console.log("AFTER_COUNTS=" + JSON.stringify(after));
console.log("HEAD=" + head);
console.log("AUTH_API_VERSION=" + version);
