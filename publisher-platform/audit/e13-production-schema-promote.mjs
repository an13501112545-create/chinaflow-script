import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
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
const AUDITED_BASELINE_HEAD =
  "b5f8a42f15f6e869a27c0f55acc560487605b56c";

const EXPECTED_PENDING = [
  "0003_publisher_platform_v1.sql",
  "0004_publisher_supplier_offers_v1.sql",
  "0005_publisher_accounts_v1.sql",
  "0006_publisher_terms_acceptance_v1.sql",
  "0007_publisher_install_identity_v1.sql"
];

const NEW_TABLES = [
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

const config = readFileSync(PROD_CONFIG, "utf8");
assert.ok(config.includes(`"database_name": "${PROD_DB}"`));
assert.ok(config.includes(`"database_id": "${PROD_DB_ID}"`));
assert.ok(!config.includes("chinaflow-events-v0-1-test"));

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

const allowedPragma =
  /^\s*PRAGMA\s+(?:foreign_key_check|index_list)\s*(?:\(|;|$)/i;

function assertReadOnlySql(sql) {
  const trimmed = sql.trim();
  const body = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;

  assert.ok(
    /^SELECT\b/i.test(body) || allowedPragma.test(body),
    "Non-read-only SQL rejected"
  );
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
    PROD_CONFIG,
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

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const home =
  process.env.HOME ||
  process.env.USERPROFILE ||
  ROOT;

const preflightRoot = join(
  home,
  ".config",
  "chinaflow",
  "e13-production-schema-preflight"
);

assert.ok(
  existsSync(preflightRoot),
  "Production schema preflight directory not found"
);

const checkpointDirs = readdirSync(preflightRoot)
  .map(name => join(preflightRoot, name))
  .filter(path => statSync(path).isDirectory())
  .sort()
  .reverse();

assert.ok(
  checkpointDirs.length > 0,
  "No production schema preflight checkpoint found"
);

let checkpoint = null;

for (const dir of checkpointDirs) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8")
  );

  if (
    manifest?.step === "E13_PRODUCTION_SCHEMA_PREFLIGHT" &&
    manifest?.production_db === PROD_DB &&
    manifest?.production_db_id === PROD_DB_ID &&
    manifest?.time_travel_supported === true &&
    Array.isArray(manifest?.pending_migrations) &&
    JSON.stringify(manifest.pending_migrations) ===
      JSON.stringify(EXPECTED_PENDING)
  ) {
    checkpoint = {
      dir,
      manifestPath,
      manifest
    };
    break;
  }
}

assert.ok(checkpoint, "No valid E13 production preflight found");

const exportPath = checkpoint.manifest.export_file;
const restoreCommandPath = join(
  checkpoint.dir,
  "EMERGENCY_RESTORE_COMMAND.txt"
);
const timeTravelPath = checkpoint.manifest.time_travel_file;

for (const requiredPath of [
  exportPath,
  restoreCommandPath,
  timeTravelPath,
  checkpoint.manifestPath
]) {
  assert.ok(
    typeof requiredPath === "string" &&
      requiredPath.length > 0 &&
      existsSync(requiredPath),
    "Required rollback artifact missing: " + requiredPath
  );
}

const exportBytes = readFileSync(exportPath);
assert.equal(
  sha256(exportBytes),
  checkpoint.manifest.export_sha256,
  "Preflight SQL export hash mismatch"
);

const timeTravelRaw = readFileSync(timeTravelPath, "utf8");
const timeTravelJson = JSON.parse(timeTravelRaw);

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

const bookmark = findBookmark(timeTravelJson);
assert.ok(bookmark, "Stored Time Travel bookmark not found");
assert.equal(
  sha256(Buffer.from(bookmark)),
  checkpoint.manifest.bookmark_sha256,
  "Stored Time Travel bookmark hash mismatch"
);

const restoreCommand = readFileSync(
  restoreCommandPath,
  "utf8"
).trim();

assert.ok(
  restoreCommand.includes("d1 time-travel restore"),
  "Emergency restore command is invalid"
);

function migrationsList() {
  return run(npx(), [
    "wrangler",
    "d1",
    "migrations",
    "list",
    PROD_DB,
    "--remote",
    "--config",
    PROD_CONFIG
  ]);
}

const beforeMigrations = migrationsList();

for (const name of EXPECTED_PENDING) {
  assert.ok(
    beforeMigrations.includes(name),
    "Expected pending migration missing before promotion: " + name
  );
}

const preTables = new Set(
  d1(`
    SELECT name
    FROM sqlite_master
    WHERE type='table'
    ORDER BY name
  `).map(row => row.name)
);

for (const table of NEW_TABLES) {
  assert.equal(
    preTables.has(table),
    false,
    "New platform table exists before promotion: " + table
  );
}

const preCounts = {
  events: Number(one(
    "SELECT count(*) AS n FROM events"
  ).n),
  publisher_placements: Number(one(
    "SELECT count(*) AS n FROM publisher_placements"
  ).n),
  report_ingestion_runs: Number(one(
    "SELECT count(*) AS n FROM report_ingestion_runs"
  ).n),
  trip_bookings: Number(one(
    "SELECT count(*) AS n FROM trip_bookings"
  ).n),
  trip_commissions: Number(one(
    "SELECT count(*) AS n FROM trip_commissions"
  ).n)
};

assert.ok(
  preCounts.events >= checkpoint.manifest.counts.events,
  "Production events regressed since preflight"
);
assert.equal(preCounts.publisher_placements, 4);
assert.equal(
  preCounts.report_ingestion_runs,
  checkpoint.manifest.counts.report_ingestion_runs
);
assert.equal(
  preCounts.trip_bookings,
  checkpoint.manifest.counts.trip_bookings
);
assert.equal(
  preCounts.trip_commissions,
  checkpoint.manifest.counts.trip_commissions
);

function readLegacyPlacements() {
  return d1(`
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
}

const legacyBefore = readLegacyPlacements();

assert.equal(legacyBefore.length, 4);
assert.equal(
  sha256(Buffer.from(JSON.stringify(legacyBefore))),
  checkpoint.manifest.placement_sha256,
  "Legacy placement baseline changed since preflight"
);

assert.deepEqual(
  d1("PRAGMA foreign_key_check"),
  [],
  "Production FK violations exist before promotion"
);

let migrationOutput = "";
let promotionError = null;

try {
  migrationOutput = run(
    npx(),
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      PROD_DB,
      "--remote",
      "--config",
      PROD_CONFIG
    ],
    {
      env: {
        CI: "1"
      }
    }
  );
} catch (error) {
  promotionError = error;
}

if (promotionError) {
  console.error("===== REPORT =====");
  console.error("STEP=E13_PRODUCTION_SCHEMA_PROMOTION");
  console.error("RESULT=FAIL");
  console.error("MIGRATION_APPLY=ATTEMPTED");
  console.error("WORKER_DEPLOYMENT=NO");
  console.error("SECRET_WRITE=NO");
  console.error("AUTO_RESTORE=NO");
  console.error("CHECKPOINT_DIR=" + checkpoint.dir);
  console.error(
    "RESTORE_COMMAND_PATH=" + restoreCommandPath
  );
  console.error(
    "ERROR=" +
    String(
      promotionError?.stderr ||
      promotionError?.message ||
      promotionError
    ).replaceAll("\n", " | ")
  );
  process.exitCode = 1;
} else {
  const afterMigrations = migrationsList();

  for (const name of EXPECTED_PENDING) {
    assert.equal(
      afterMigrations.includes(name),
      false,
      "Migration still pending after promotion: " + name
    );
  }

  const postTables = new Set(
    d1(`
      SELECT name
      FROM sqlite_master
      WHERE type='table'
      ORDER BY name
    `).map(row => row.name)
  );

  for (const table of NEW_TABLES) {
    assert.equal(
      postTables.has(table),
      true,
      "Expected platform table missing after promotion: " + table
    );
  }

  const postCounts = {
    events: Number(one(
      "SELECT count(*) AS n FROM events"
    ).n),
    publisher_placements: Number(one(
      "SELECT count(*) AS n FROM publisher_placements"
    ).n),
    report_ingestion_runs: Number(one(
      "SELECT count(*) AS n FROM report_ingestion_runs"
    ).n),
    trip_bookings: Number(one(
      "SELECT count(*) AS n FROM trip_bookings"
    ).n),
    trip_commissions: Number(one(
      "SELECT count(*) AS n FROM trip_commissions"
    ).n)
  };

  assert.ok(
    postCounts.events >= preCounts.events,
    "Production events decreased during schema promotion"
  );
  assert.equal(
    postCounts.publisher_placements,
    preCounts.publisher_placements
  );
  assert.equal(
    postCounts.report_ingestion_runs,
    preCounts.report_ingestion_runs
  );
  assert.equal(
    postCounts.trip_bookings,
    preCounts.trip_bookings
  );
  assert.equal(
    postCounts.trip_commissions,
    preCounts.trip_commissions
  );

  const legacyAfter = readLegacyPlacements();

  assert.deepEqual(
    legacyAfter,
    legacyBefore,
    "Legacy publisher placements changed during promotion"
  );

  const platformCounts = Object.fromEntries(
    NEW_TABLES.map(table => [
      table,
      Number(one(
        `SELECT count(*) AS n FROM ${table}`
      ).n)
    ])
  );

  for (const [table, count] of Object.entries(platformCounts)) {
    assert.equal(
      count,
      0,
      table + " must be empty immediately after schema promotion"
    );
  }

  const placementIndexes = d1(
    "PRAGMA index_list('publisher_placements')"
  ).map(row => row.name);

  assert.ok(
    placementIndexes.includes(
      "ux_publisher_placements_id_publisher"
    ),
    "0004 placement composite index missing"
  );

  assert.deepEqual(
    d1("PRAGMA foreign_key_check"),
    [],
    "Production FK violations exist after promotion"
  );

  console.log("===== MIGRATION OUTPUT =====");
  console.log(migrationOutput.trim());
  console.log("===== REPORT =====");
  console.log("STEP=E13_PRODUCTION_SCHEMA_PROMOTION");
  console.log("RESULT=PASS");
  console.log("MIGRATION_APPLY=YES");
  console.log("MIGRATIONS_APPLIED=" + EXPECTED_PENDING.join(","));
  console.log("WORKER_DEPLOYMENT=NO");
  console.log("SECRET_WRITE=NO");
  console.log("AUTO_RESTORE=NO");
  console.log("LEGACY_PLACEMENTS_PRESERVED=PASS");
  console.log("LEGACY_EVENTS_NONDECREASING=PASS");
  console.log("LEGACY_REPORTING_COUNTS_PRESERVED=PASS");
  console.log("NEW_PLATFORM_TABLES_CREATED=PASS");
  console.log("NEW_PLATFORM_TABLES_EMPTY=PASS");
  console.log("FK=0");
  console.log("PRE_COUNTS=" + JSON.stringify(preCounts));
  console.log("POST_COUNTS=" + JSON.stringify(postCounts));
  console.log(
    "PLATFORM_COUNTS=" + JSON.stringify(platformCounts)
  );
  console.log("CHECKPOINT_DIR=" + checkpoint.dir);
  console.log(
    "RESTORE_COMMAND_PATH=" + restoreCommandPath
  );
  console.log("ROLLBACK_CHECKPOINT_VERIFIED=YES");
  console.log("PRODUCTION_SCHEMA_PROMOTION=PASS");
}
