import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  randomBytes
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const PROD_CONFIG = "collector/wrangler.production.jsonc";
const PROD_DB = "chinaflow-events-v0-1";
const PROD_DB_ID = "838917da-3fb8-437e-bc00-caff178798e8";
const AUDITED_BASELINE_HEAD = "fa962b4a7eadfd0355647fd6d1912f1a1d987eaa";
const EXPECTED_PENDING = [
  "0003_publisher_platform_v1.sql",
  "0004_publisher_supplier_offers_v1.sql",
  "0005_publisher_accounts_v1.sql",
  "0006_publisher_terms_acceptance_v1.sql",
  "0007_publisher_install_identity_v1.sql"
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
}

const npx = () => process.platform === "win32" ? "npx.cmd" : "npx";

const config = readFileSync(PROD_CONFIG, "utf8");
assert.ok(config.includes(`"database_name": "${PROD_DB}"`));
assert.ok(config.includes(`"database_id": "${PROD_DB_ID}"`));
assert.ok(!config.includes("chinaflow-events-v0-1-test"));

const status = run("git", ["status", "-sb"]).trim();
assert.equal(status, "## main...origin/main", "Git must be clean and synced");

const head = run("git", ["rev-parse", "HEAD"]).trim();
const originHead = run("git", ["rev-parse", "origin/main"]).trim();
assert.equal(head, originHead, "HEAD must equal origin/main");
run("git", [
  "merge-base",
  "--is-ancestor",
  AUDITED_BASELINE_HEAD,
  head
]);

function assertReadOnlySql(sql) {
  const trimmed = sql.trim();
  const body = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;

  assert.ok(
    /^SELECT\b/i.test(body) ||
      /^PRAGMA\s+foreign_key_check\b/i.test(body),
    "Non-read-only SQL rejected"
  );
  assert.ok(!body.includes(";"), "Multiple SQL statements rejected");
}

function d1(sql) {
  assertReadOnlySql(sql);
  const raw = run(npx(), [
    "wrangler", "d1", "execute", PROD_DB,
    "--remote",
    "--config", PROD_CONFIG,
    "--yes",
    "--json",
    "--command", sql
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

const migrationsRaw = run(npx(), [
  "wrangler", "d1", "migrations", "list", PROD_DB,
  "--remote",
  "--config", PROD_CONFIG
]);

for (const name of EXPECTED_PENDING) {
  assert.ok(
    migrationsRaw.includes(name),
    "Expected pending migration missing: " + name
  );
}

for (const name of [
  "0001_events.sql",
  "0002_publisher_reporting_v0_1.sql"
]) {
  assert.equal(
    migrationsRaw.includes(name),
    false,
    "Already-applied migration unexpectedly listed: " + name
  );
}

const tables = new Set(
  d1(`
    SELECT name
    FROM sqlite_master
    WHERE type='table'
    ORDER BY name
  `).map(row => row.name)
);

for (const required of [
  "events",
  "publisher_placements",
  "report_ingestion_runs",
  "trip_bookings",
  "trip_commissions"
]) {
  assert.ok(tables.has(required), "Missing legacy table: " + required);
}

for (const absent of [
  "publishers",
  "publisher_domains",
  "publisher_supplier_sites",
  "publisher_supplier_offers",
  "publisher_users",
  "publisher_memberships",
  "publisher_magic_links",
  "publisher_sessions"
]) {
  assert.equal(
    tables.has(absent),
    false,
    "New platform table already exists: " + absent
  );
}

const counts = {
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

assert.ok(
  counts.events >= 145,
  "Production event count regressed below audited baseline"
);
assert.equal(counts.publisher_placements, 4);
assert.equal(counts.report_ingestion_runs, 0);
assert.equal(counts.trip_bookings, 0);
assert.equal(counts.trip_commissions, 0);

const placements = d1(`
  SELECT
    placement_id,
    publisher_id,
    placement,
    supplier,
    external_tracking_key,
    is_active,
    effective_from,
    effective_to,
    created_at,
    updated_at
  FROM publisher_placements
  ORDER BY placement_id
`);

assert.equal(placements.length, 4);
for (const row of placements) {
  assert.equal(row.publisher_id, "flightflex");
  assert.equal(row.supplier, "trip.com");
  assert.equal(Number(row.is_active), 1);
  assert.ok(
    String(row.external_tracking_key).endsWith("_test"),
    "Legacy production attribution key changed"
  );
}

const fk = d1("PRAGMA foreign_key_check");
assert.deepEqual(fk, [], "Production FK violations exist");

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "")
  .replaceAll(".", "")
  .replace("Z", "Z");

const baseHome =
  process.env.HOME ||
  process.env.USERPROFILE ||
  ROOT;

const backupDir = join(
  baseHome,
  ".config",
  "chinaflow",
  "e13-production-schema-preflight",
  stamp + "-" + randomBytes(3).toString("hex")
);

mkdirSync(backupDir, { recursive: true });
chmodSync(backupDir, 0o700);

const checkpointTime = new Date().toISOString();

const d1InfoRaw = run(npx(), [
  "wrangler", "d1", "info", PROD_DB,
  "--config", PROD_CONFIG,
  "--json"
]);

JSON.parse(d1InfoRaw);

const d1InfoPath = join(backupDir, "d1-info.json");
writeFileSync(
  d1InfoPath,
  d1InfoRaw,
  { encoding: "utf8", mode: 0o600 }
);

const timeTravelRaw = run(npx(), [
  "wrangler", "d1", "time-travel", "info", PROD_DB,
  "--config", PROD_CONFIG,
  "--json"
]);

const timeTravelPath = join(backupDir, "time-travel-info.json");
writeFileSync(timeTravelPath, timeTravelRaw, {
  encoding: "utf8",
  mode: 0o600
});

function findBookmark(value) {
  if (!value || typeof value !== "object") return null;

  if (
    typeof value.bookmark === "string" &&
    value.bookmark.length > 0
  ) {
    return value.bookmark;
  }

  for (const child of Object.values(value)) {
    const found = findBookmark(child);
    if (found) return found;
  }

  return null;
}

const timeTravelJson = JSON.parse(timeTravelRaw);
const bookmark = findBookmark(timeTravelJson);
assert.ok(bookmark, "Time Travel bookmark not found");

const exportPath = join(backupDir, "production-before.sql");

run(npx(), [
  "wrangler", "d1", "export", PROD_DB,
  "--remote",
  "--config", PROD_CONFIG,
  "--skip-confirmation",
  "--output", exportPath
]);

chmodSync(exportPath, 0o600);

const exportBytes = readFileSync(exportPath);
assert.ok(exportBytes.length > 0, "Production export is empty");

const exportSha256 = createHash("sha256")
  .update(exportBytes)
  .digest("hex");

const placementSha256 = createHash("sha256")
  .update(JSON.stringify(placements))
  .digest("hex");

const bookmarkSha256 = createHash("sha256")
  .update(bookmark)
  .digest("hex");

const manifest = {
  step: "E13_PRODUCTION_SCHEMA_PREFLIGHT",
  checkpoint_time: checkpointTime,
  head,
  production_db: PROD_DB,
  production_db_id: PROD_DB_ID,
  counts,
  placement_count: placements.length,
  placement_sha256: placementSha256,
  export_file: exportPath,
  export_size_bytes: exportBytes.length,
  export_sha256: exportSha256,
  d1_info_file: d1InfoPath,
  time_travel_supported: true,
  time_travel_file: timeTravelPath,
  bookmark_sha256: bookmarkSha256,
  pending_migrations: EXPECTED_PENDING
};

const manifestPath = join(backupDir, "manifest.json");
writeFileSync(
  manifestPath,
  JSON.stringify(manifest, null, 2) + "\n",
  { encoding: "utf8", mode: 0o600 }
);

const restoreCommandPath = join(
  backupDir,
  "EMERGENCY_RESTORE_COMMAND.txt"
);

writeFileSync(
  restoreCommandPath,
  [
    "cd " + ROOT,
    "npx wrangler d1 time-travel restore " + PROD_DB +
      " --config " + PROD_CONFIG +
      " --bookmark " + bookmark +
      " --json"
  ].join(" && ") + "\n",
  { encoding: "utf8", mode: 0o600 }
);

console.log("===== REPORT =====");
console.log("STEP=E13_PRODUCTION_SCHEMA_PREFLIGHT");
console.log("READ_ONLY_PRODUCTION_ACCESS=YES");
console.log("PRODUCTION_D1_WRITE=NO");
console.log("MIGRATION_APPLY=NO");
console.log("WORKER_DEPLOYMENT=NO");
console.log("SECRET_WRITE=NO");
console.log("HEAD=" + head);
console.log("BASELINE_COUNTS=" + JSON.stringify(counts));
console.log("LEGACY_PLACEMENTS=4");
console.log("LEGACY_PLACEMENTS_SHA256=" + placementSha256);
console.log("FK=0");
console.log("TIME_TRAVEL_SUPPORTED=YES");
console.log("PENDING_MIGRATIONS=" + EXPECTED_PENDING.join(","));
console.log("TIME_TRAVEL_BOOKMARK_STORED=YES");
console.log("TIME_TRAVEL_BOOKMARK_SHA256=" + bookmarkSha256);
console.log("SQL_EXPORT_STORED=YES");
console.log("SQL_EXPORT_SIZE_BYTES=" + exportBytes.length);
console.log("SQL_EXPORT_SHA256=" + exportSha256);
console.log("BACKUP_DIR=" + backupDir);
console.log("MANIFEST_PATH=" + manifestPath);
console.log("RESTORE_COMMAND_STORED=YES");
console.log("RESTORE_COMMAND_PATH=" + restoreCommandPath);
console.log("PRODUCTION_SCHEMA_PROMOTION_READY=YES");
