import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const PROD_CONFIG = "collector/wrangler.production.jsonc";
const PROD_DB = "chinaflow-events-v0-1";
const STATIC_CONFIGS = [
  "config.json",
  "config-anjia.json",
  "config-mubus.json",
  "config-omacar.json",
  "config-yobus.json"
];

function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024
  });
}

const npx = () => process.platform === "win32" ? "npx.cmd" : "npx";

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

function sqlQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

const workerSource = readFileSync("collector/worker-v0.1.js", "utf8");
const allowedOriginsMatch = workerSource.match(
  /const ALLOWED_ORIGINS = new Set\(\[([\s\S]*?)\]\);/
);
assert.ok(allowedOriginsMatch, "Collector allowlist not found");
const allowedOrigins = [
  ...allowedOriginsMatch[1].matchAll(/"([^"]+)"/g)
].map(match => match[1]);

const staticPublishers = [];
for (const file of STATIC_CONFIGS) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const items = [
    ...(Array.isArray(config.rules) ? config.rules : []),
    ...(Array.isArray(config.offers) ? config.offers : [])
  ];

  staticPublishers.push({
    file,
    publisher: config.publisher,
    analytics_enabled: config.analytics?.enabled === true,
    collector_url: config.analytics?.collector_url ?? null,
    placements: items
      .filter(item => item?.enabled !== false && typeof item?.placement === "string")
      .map(item => ({
        placement: item.placement,
        product: item.product ?? null,
        trip_sub1: (() => {
          try {
            return new URL(item.url).searchParams.get("trip_sub1");
          } catch {
            return null;
          }
        })()
      }))
  });
}

const eventByPublisher = d1(`
  SELECT
    publisher_id,
    count(*) AS event_count,
    sum(CASE WHEN event_type='cta_impression' THEN 1 ELSE 0 END) AS impressions,
    sum(CASE WHEN event_type='cta_click' THEN 1 ELSE 0 END) AS clicks,
    count(DISTINCT placement) AS distinct_placements,
    min(occurred_at) AS first_event_at,
    max(occurred_at) AS last_event_at
  FROM events
  GROUP BY publisher_id
  ORDER BY publisher_id
`);

const eventByPlacement = d1(`
  SELECT
    publisher_id,
    placement,
    trip_sub1,
    supplier,
    count(*) AS event_count,
    sum(CASE WHEN event_type='cta_click' THEN 1 ELSE 0 END) AS clicks
  FROM events
  GROUP BY publisher_id, placement, trip_sub1, supplier
  ORDER BY publisher_id, placement, trip_sub1
`);

const eventOwnership = d1(`
  SELECT
    e.publisher_id,
    e.placement,
    e.trip_sub1,
    count(*) AS event_count,
    sum(CASE
      WHEN p.publisher_id IS NOT NULL THEN 1 ELSE 0
    END) AS trip_sub1_owned_count,
    sum(CASE
      WHEN p2.publisher_id IS NOT NULL THEN 1 ELSE 0
    END) AS publisher_placement_owned_count
  FROM events e
  LEFT JOIN publisher_placements p
    ON p.supplier='trip.com'
   AND p.is_active=1
   AND e.trip_sub1 IS NOT NULL
   AND p.external_tracking_key=e.trip_sub1
  LEFT JOIN publisher_placements p2
    ON p2.publisher_id=e.publisher_id
   AND p2.placement=e.placement
   AND p2.is_active=1
  GROUP BY e.publisher_id,e.placement,e.trip_sub1
  ORDER BY e.publisher_id,e.placement,e.trip_sub1
`);

const eventTotals = one(`
  SELECT
    count(*) AS total_events,
    sum(CASE WHEN trip_sub1 IS NULL OR trim(trip_sub1)='' THEN 1 ELSE 0 END)
      AS missing_trip_sub1,
    sum(CASE WHEN supplier='trip.com' THEN 1 ELSE 0 END)
      AS trip_supplier_events
  FROM events
`);

const unownedByTripSub1 = one(`
  SELECT count(*) AS n
  FROM events e
  LEFT JOIN publisher_placements p
    ON p.supplier='trip.com'
   AND p.is_active=1
   AND e.trip_sub1=p.external_tracking_key
  WHERE e.trip_sub1 IS NOT NULL
    AND trim(e.trip_sub1)<>''
    AND p.placement_id IS NULL
`);

const unownedByPublisherPlacement = one(`
  SELECT count(*) AS n
  FROM events e
  LEFT JOIN publisher_placements p
    ON p.publisher_id=e.publisher_id
   AND p.placement=e.placement
   AND p.is_active=1
  WHERE p.placement_id IS NULL
`);

const staticCoverage = [];
for (const publisher of staticPublishers) {
  for (const item of publisher.placements) {
    const trackingKey = item.trip_sub1 ?? item.placement;
    const placementRows = d1(`
      SELECT placement_id,publisher_id,placement,supplier,
             external_tracking_key,is_active
      FROM publisher_placements
      WHERE external_tracking_key=${sqlQuote(trackingKey)}
         OR (publisher_id=${sqlQuote(publisher.publisher)}
             AND placement=${sqlQuote(item.placement)})
      ORDER BY placement_id
    `);

    const eventCount = Number(one(`
      SELECT count(*) AS n
      FROM events
      WHERE publisher_id=${sqlQuote(publisher.publisher)}
        AND placement=${sqlQuote(item.placement)}
    `).n);

    staticCoverage.push({
      config: publisher.file,
      publisher: publisher.publisher,
      analytics_enabled: publisher.analytics_enabled,
      product: item.product,
      placement: item.placement,
      trip_sub1: item.trip_sub1,
      d1_placement_rows: placementRows,
      event_count: eventCount
    });
  }
}

const pageHosts = d1(`
  SELECT
    publisher_id,
    lower(
      replace(
        replace(
          substr(page_url, 1,
            CASE
              WHEN instr(substr(page_url, 9), '/') > 0
              THEN instr(substr(page_url, 9), '/') + 7
              ELSE length(page_url)
            END
          ),
          'https://',''
        ),
        'http://',''
      )
    ) AS page_host_prefix,
    count(*) AS event_count
  FROM events
  GROUP BY publisher_id,page_host_prefix
  ORDER BY publisher_id,page_host_prefix
`);

console.log("===== REPORT =====");
console.log("STEP=E13_PRODUCTION_ATTRIBUTION_READONLY");
console.log("READ_ONLY=YES");
console.log("DEPLOYMENT=NO");
console.log("MIGRATION_APPLY=NO");
console.log("PRODUCTION_D1_WRITE=NO");
console.log("HEAD=" + head);
console.log("COLLECTOR_ALLOWED_ORIGINS=" + JSON.stringify(allowedOrigins));
console.log("STATIC_PUBLISHERS=" + JSON.stringify(staticPublishers));
console.log("EVENT_TOTALS=" + JSON.stringify(eventTotals));
console.log(
  "EVENTS_UNOWNED_BY_TRIP_SUB1=" + Number(unownedByTripSub1.n)
);
console.log(
  "EVENTS_UNOWNED_BY_PUBLISHER_PLACEMENT=" +
  Number(unownedByPublisherPlacement.n)
);
console.log("EVENT_BY_PUBLISHER=" + JSON.stringify(eventByPublisher));
console.log("EVENT_BY_PLACEMENT=" + JSON.stringify(eventByPlacement));
console.log("EVENT_OWNERSHIP=" + JSON.stringify(eventOwnership));
console.log("STATIC_CONFIG_COVERAGE=" + JSON.stringify(staticCoverage));
console.log("EVENT_PAGE_HOSTS=" + JSON.stringify(pageHosts));
