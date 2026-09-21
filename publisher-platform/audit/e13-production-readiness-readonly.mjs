import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const PROD_CONFIG = "collector/wrangler.production.jsonc";
const PROD_DB = "chinaflow-events-v0-1";
const PROD_DB_ID = "838917da-3fb8-437e-bc00-caff178798e8";

function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024
  });
}

const npx = () => process.platform === "win32" ? "npx.cmd" : "npx";

const config = readFileSync(PROD_CONFIG, "utf8");
assert.ok(config.includes(`"database_name": "${PROD_DB}"`));
assert.ok(config.includes(`"database_id": "${PROD_DB_ID}"`));
assert.ok(!config.includes("chinaflow-events-v0-1-test"));

assert.equal(
  run("git", ["status", "-sb"]).trim(),
  "## main...origin/main",
  "Git must be clean and synced"
);
const head = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(head, run("git", ["rev-parse", "origin/main"]).trim());

const allowedPragma =
  /^\s*PRAGMA\s+(?:table_info|index_list|foreign_key_list|foreign_key_check)\s*(?:\(|;|$)/i;

function assertReadOnlySql(sql) {
  const trimmed = sql.trim();
  assert.ok(
    /^SELECT\b/i.test(trimmed) || allowedPragma.test(trimmed),
    "Non-read-only SQL rejected"
  );
  assert.ok(
    !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ATTACH|DETACH)\b/i.test(trimmed),
    "Mutation or DDL token rejected"
  );
}

function d1(sql) {
  assertReadOnlySql(sql);
  const raw = run(npx(), [
    "wrangler", "d1", "execute", PROD_DB,
    "--remote", "--config", PROD_CONFIG,
    "--yes", "--json", "--command", sql
  ]);
  const parsed = JSON.parse(raw);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.ok(first?.success === true, "Production read-only query failed");
  return first.results ?? [];
}

function one(sql) {
  const rows = d1(sql);
  assert.equal(rows.length, 1, "Expected exactly one row");
  return rows[0];
}

const migrationsRaw = run(npx(), [
  "wrangler", "d1", "migrations", "list", PROD_DB,
  "--remote", "--config", PROD_CONFIG
]);

const migrationNames = [
  "0001_events.sql",
  "0002_publisher_reporting_v0_1.sql",
  "0003_publisher_platform_v1.sql",
  "0004_publisher_supplier_offers_v1.sql",
  "0005_publisher_accounts_v1.sql",
  "0006_publisher_terms_acceptance_v1.sql",
  "0007_publisher_install_identity_v1.sql"
];

const migrationNamesShown = migrationNames.filter(
  name => migrationsRaw.includes(name)
);

const expectedTables = [
  "events",
  "publisher_placements",
  "report_ingestion_runs",
  "trip_bookings",
  "trip_commissions",
  "publishers",
  "publisher_domains",
  "publisher_supplier_sites",
  "publisher_supplier_offers",
  "publisher_users",
  "publisher_memberships",
  "publisher_magic_links",
  "publisher_sessions"
];

const tableRows = d1(`
  SELECT name
  FROM sqlite_master
  WHERE type='table'
    AND name IN (
      'events','publisher_placements','report_ingestion_runs',
      'trip_bookings','trip_commissions','publishers',
      'publisher_domains','publisher_supplier_sites',
      'publisher_supplier_offers','publisher_users',
      'publisher_memberships','publisher_magic_links',
      'publisher_sessions'
    )
  ORDER BY name
`);
const existingTables = new Set(tableRows.map(row => row.name));

const baseCounts = {};
for (const table of [
  "events","publisher_placements","report_ingestion_runs",
  "trip_bookings","trip_commissions"
]) {
  baseCounts[table] = existingTables.has(table)
    ? Number(one(`SELECT count(*) AS n FROM ${table}`).n)
    : null;
}

const platformCounts = {};
for (const table of [
  "publishers","publisher_domains","publisher_supplier_sites",
  "publisher_supplier_offers","publisher_users",
  "publisher_memberships","publisher_magic_links","publisher_sessions"
]) {
  platformCounts[table] = existingTables.has(table)
    ? Number(one(`SELECT count(*) AS n FROM ${table}`).n)
    : null;
}

let legacyPlacements = [];
let testSuffixCount = null;
let placementIndexes = [];

if (existingTables.has("publisher_placements")) {
  legacyPlacements = d1(`
    SELECT publisher_id,
           count(*) AS placement_count,
           sum(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active_count
    FROM publisher_placements
    GROUP BY publisher_id
    ORDER BY publisher_id
  `);

  testSuffixCount = Number(one(`
    SELECT count(*) AS n
    FROM publisher_placements
    WHERE substr(external_tracking_key, -5) = '_test'
  `).n);

  placementIndexes = d1("PRAGMA index_list('publisher_placements')");
}

const e3e7Objects = d1(`
  SELECT type,name,tbl_name
  FROM sqlite_master
  WHERE name IN (
    'ux_publishers_slug',
    'ux_publisher_domains_hostname',
    'ux_publisher_domains_one_primary',
    'ux_publisher_supplier_sites_supplier_sid',
    'ux_publisher_supplier_sites_domain_supplier',
    'ux_publisher_supplier_sites_site_tenant',
    'ux_publisher_placements_id_publisher',
    'ux_publisher_supplier_offers_site_key',
    'ux_publisher_users_email_normalized',
    'ux_publisher_memberships_publisher_user',
    'ux_publisher_magic_links_token_hash',
    'ux_publisher_sessions_token_hash',
    'ux_publishers_install_public_key'
  )
  ORDER BY name
`);

const fkViolations = d1("PRAGMA foreign_key_check");

const prodPublisherConfigs = [
  "wrangler.publisher-app.production.jsonc",
  "wrangler.publisher-auth-api.production.jsonc",
  "wrangler.publisher-config-api.production.jsonc",
  "wrangler.publisher-review-api.production.jsonc",
  "wrangler.publisher-provisioning-api.production.jsonc",
  "wrangler.publisher-activation-api.production.jsonc"
].filter(existsSync);

const newPlatformTablesPresent = expectedTables
  .filter(name => ![
    "events","publisher_placements","report_ingestion_runs",
    "trip_bookings","trip_commissions"
  ].includes(name))
  .filter(name => existingTables.has(name));

console.log("===== REPORT =====");
console.log("STEP=E13_PRODUCTION_READINESS_READONLY");
console.log("READ_ONLY=YES");
console.log("DEPLOYMENT=NO");
console.log("SECRET_WRITE=NO");
console.log("MIGRATION_APPLY=NO");
console.log("PRODUCTION_D1_WRITE=NO");
console.log("PRODUCTION_DB=" + PROD_DB);
console.log("PRODUCTION_DB_ID=" + PROD_DB_ID);
console.log("HEAD=" + head);
console.log("MIGRATION_NAMES_SHOWN=" + migrationNamesShown.join(","));
console.log("TABLES_PRESENT=" + [...existingTables].sort().join(","));
console.log(
  "NEW_PLATFORM_TABLES_PRESENT=" +
  (newPlatformTablesPresent.join(",") || "NONE")
);
console.log(
  "PROD_PUBLISHER_WRANGLER_CONFIGS=" +
  (prodPublisherConfigs.join(",") || "NONE")
);
console.log("FK_VIOLATIONS=" + fkViolations.length);
console.log(
  "LEGACY_PLACEMENT_TEST_SUFFIX_COUNT=" +
  (testSuffixCount === null ? "N/A" : testSuffixCount)
);
console.log("BASE_COUNTS=" + JSON.stringify(baseCounts));
console.log("NEW_PLATFORM_COUNTS=" + JSON.stringify(platformCounts));
console.log("LEGACY_PLACEMENTS=" + JSON.stringify(legacyPlacements));
console.log(
  "PLACEMENT_INDEXES=" +
  JSON.stringify(placementIndexes.map(row => row.name).sort())
);
console.log(
  "E3_E7_SCHEMA_OBJECTS=" +
  JSON.stringify(e3e7Objects.map(row => row.name).sort())
);
console.log("MIGRATIONS_RAW_BEGIN");
console.log(migrationsRaw.trim());
console.log("MIGRATIONS_RAW_END");
