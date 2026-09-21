import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

function sql(path) {
  return readFileSync(new URL("../../" + path, import.meta.url), "utf8");
}

db.exec(sql("collector/migrations/0001_events.sql"));
db.exec(sql("collector/migrations/0002_publisher_reporting_v0_1.sql"));
db.exec(sql("collector/seeds/0001_flightflex_publisher_placements.sql"));

const legacyEvents = [
  {
    event_id: "e13_evt_1",
    event_type: "cta_impression",
    occurred_at: "2026-09-21T00:00:00.000Z",
    publisher_id: "flightflex",
    session_id: "e13_s1",
    page_url: "https://www.flightflex.ca/flights",
    page_path: "/flights",
    placement: "flightflex_flights_yyz_bjs_test",
    trip_sub1: "flightflex_flights_yyz_bjs_test",
    destination_url: "https://www.trip.com/flights?trip_sub1=flightflex_flights_yyz_bjs_test"
  },
  {
    event_id: "e13_evt_2",
    event_type: "cta_click",
    occurred_at: "2026-09-21T00:01:00.000Z",
    publisher_id: "flightflex",
    session_id: "e13_s2",
    page_url: "https://www.flightflex.ca/post/x",
    page_path: "/post/x",
    placement: "flightflex_blog_china_inbound_hotels_generic_test",
    trip_sub1: "flightflex_blog_china_inbound_hotels_generic_test",
    destination_url: "https://www.trip.com/hotels?trip_sub1=flightflex_blog_china_inbound_hotels_generic_test"
  }
];

const insertEvent = db.prepare(`
  INSERT INTO events (
    event_id,event_schema_version,event_type,occurred_at,publisher_id,
    session_id,page_url,page_path,routing_mode,placement,trip_sub1,
    supplier,destination_url,engine_version,config_version
  ) VALUES (?, '0.1', ?, ?, ?, ?, ?, ?, 'legacy', ?, ?, 'trip.com', ?, '0.4', '0.5')
`);

for (const event of legacyEvents) {
  insertEvent.run(
    event.event_id,
    event.event_type,
    event.occurred_at,
    event.publisher_id,
    event.session_id,
    event.page_url,
    event.page_path,
    event.placement,
    event.trip_sub1,
    event.destination_url
  );
}

function rows(query) {
  return db.prepare(query).all().map(row => ({ ...row }));
}

function count(table) {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
}

const legacyPlacementBefore = rows(`
  SELECT placement_id,publisher_id,placement,supplier,
         external_tracking_key,is_active,effective_from,effective_to,
         created_at,updated_at
  FROM publisher_placements
  ORDER BY placement_id
`);

const legacyEventsBefore = rows(`
  SELECT *
  FROM events
  ORDER BY event_id
`);

const baseCountsBefore = {
  events: count("events"),
  publisher_placements: count("publisher_placements"),
  report_ingestion_runs: count("report_ingestion_runs"),
  trip_bookings: count("trip_bookings"),
  trip_commissions: count("trip_commissions")
};

const migrationOrder = [
  "collector/migrations/0003_publisher_platform_v1.sql",
  "collector/migrations/0004_publisher_supplier_offers_v1.sql",
  "collector/migrations/0005_publisher_accounts_v1.sql",
  "collector/migrations/0006_publisher_terms_acceptance_v1.sql",
  "collector/migrations/0007_publisher_install_identity_v1.sql"
];

for (const migration of migrationOrder) {
  db.exec(sql(migration));
  assert.deepEqual(
    rows("PRAGMA foreign_key_check"),
    [],
    "FK violation after " + migration
  );
}

const legacyPlacementAfter = rows(`
  SELECT placement_id,publisher_id,placement,supplier,
         external_tracking_key,is_active,effective_from,effective_to,
         created_at,updated_at
  FROM publisher_placements
  ORDER BY placement_id
`);

const legacyEventsAfter = rows(`
  SELECT *
  FROM events
  ORDER BY event_id
`);

const baseCountsAfter = {
  events: count("events"),
  publisher_placements: count("publisher_placements"),
  report_ingestion_runs: count("report_ingestion_runs"),
  trip_bookings: count("trip_bookings"),
  trip_commissions: count("trip_commissions")
};

assert.deepEqual(
  legacyPlacementAfter,
  legacyPlacementBefore,
  "Legacy publisher_placements changed"
);
assert.deepEqual(
  legacyEventsAfter,
  legacyEventsBefore,
  "Legacy events changed"
);
assert.deepEqual(
  baseCountsAfter,
  baseCountsBefore,
  "Legacy base table counts changed"
);

const newTables = [
  "publishers",
  "publisher_domains",
  "publisher_supplier_sites",
  "publisher_supplier_offers",
  "publisher_users",
  "publisher_memberships",
  "publisher_magic_links",
  "publisher_sessions"
];

const newCounts = Object.fromEntries(
  newTables.map(table => [table, count(table)])
);

for (const [table, value] of Object.entries(newCounts)) {
  assert.equal(value, 0, table + " must remain empty after schema migration");
}

assert.equal(
  Number(db.prepare(
    "SELECT count(*) AS n FROM publishers WHERE publisher_id='flightflex'"
  ).get().n),
  0,
  "Legacy FlightFlex must not be silently backfilled"
);

const placementIndexes = rows("PRAGMA index_list('publisher_placements')")
  .map(row => row.name)
  .sort();

assert.ok(
  placementIndexes.includes("ux_publisher_placements_id_publisher"),
  "0004 placement composite index missing"
);

const publisherColumns = rows("PRAGMA table_info('publishers')")
  .map(row => row.name);

assert.ok(publisherColumns.includes("terms_accepted_by_user_id"));
assert.ok(publisherColumns.includes("install_public_key"));

assert.deepEqual(rows("PRAGMA foreign_key_check"), []);

console.log("===== REPORT =====");
console.log("STEP=E13_LOCAL_PRODUCTION_SHAPE_MIGRATION_REHEARSAL");
console.log("REMOTE_ACCESS=NO");
console.log("PRODUCTION_ACCESS=NO");
console.log("PRODUCTION_WRITE=NO");
console.log("MIGRATIONS_REHEARSED=0003,0004,0005,0006,0007");
console.log("LEGACY_PLACEMENTS_PRESERVED=PASS");
console.log("LEGACY_EVENTS_PRESERVED=PASS");
console.log("LEGACY_BASE_COUNTS_PRESERVED=PASS");
console.log("LEGACY_FLIGHTFLEX_NOT_BACKFILLED=PASS");
console.log("NEW_PLATFORM_TABLES_EMPTY=PASS");
console.log("FK=0");
console.log("BASE_COUNTS_BEFORE=" + JSON.stringify(baseCountsBefore));
console.log("BASE_COUNTS_AFTER=" + JSON.stringify(baseCountsAfter));
console.log("NEW_PLATFORM_COUNTS=" + JSON.stringify(newCounts));
console.log("PLACEMENT_INDEXES=" + JSON.stringify(placementIndexes));
