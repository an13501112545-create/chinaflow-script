function assertDatabaseBinding(database) {
  if (
    database === null ||
    database === undefined ||
    typeof database !== "object" ||
    typeof database.prepare !== "function"
  ) {
    throw new Error(
      "D1 binding unavailable"
    );
  }
}

export async function loadActiveTripPublisherPlacements(database) {
  assertDatabaseBinding(database);

  const result =
    await database
      .prepare(
        `
SELECT
  supplier,
  is_active,
  external_tracking_key,
  publisher_id,
  placement
FROM publisher_placements
WHERE supplier = ?1
  AND is_active = ?2
`
      )
      .bind("trip.com", 1)
      .all();

  if (!Array.isArray(result?.results)) {
    throw new Error(
      "Invalid D1 result: publisher_placements"
    );
  }

  return result.results;
}

export async function findExistingIngestionRun(database, preflight) {
  assertDatabaseBinding(database);

  const row =
    await database
      .prepare(
        `
SELECT
  ingestion_run_id,
  source,
  report_type,
  source_file_sha256
FROM report_ingestion_runs
WHERE source = ?1
  AND report_type = ?2
  AND source_file_sha256 = ?3
LIMIT 1
`
      )
      .bind(
        preflight.source,
        preflight.report_type,
        preflight.source_file_sha256
      )
      .first();

  if (row === null) {
    return null;
  }

  if (
    typeof row !== "object" ||
    Array.isArray(row)
  ) {
    throw new Error(
      "Invalid D1 result: report_ingestion_runs"
    );
  }

  return row;
}

export async function findExistingBookingFact(database, normalizedRow) {
  assertDatabaseBinding(database);

  const row =
    await database
      .prepare(
        `
SELECT
  booking_fact_id,
  source_record_key,
  source_row_hash,
  attributed_publisher_id,
  attributed_placement,
  attribution_status
FROM trip_bookings
WHERE source_record_key = ?1
LIMIT 1
`
      )
      .bind(normalizedRow.source_record_key)
      .first();

  if (row === null) {
    return null;
  }

  if (
    typeof row !== "object" ||
    Array.isArray(row)
  ) {
    throw new Error(
      "Invalid D1 result: trip_bookings"
    );
  }

  return row;
}

export async function findExistingCommissionFact(database, normalizedRow) {
  assertDatabaseBinding(database);

  const row =
    await database
      .prepare(
        `
SELECT
  commission_fact_id,
  commission_record_key,
  source_row_hash,
  attributed_publisher_id,
  attributed_placement,
  attribution_status
FROM trip_commissions
WHERE commission_record_key = ?1
LIMIT 1
`
      )
      .bind(normalizedRow.commission_record_key)
      .first();

  if (row === null) {
    return null;
  }

  if (
    typeof row !== "object" ||
    Array.isArray(row)
  ) {
    throw new Error(
      "Invalid D1 result: trip_commissions"
    );
  }

  return row;
}

const BOOKING_INSERT_COLUMNS = [
  "booking_fact_id",
  "source_record_key",
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "raw_order_status",
  "normalized_order_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "currency",
  "order_date",
  "product_start_date",
  "product_end_date",
  "booking_window",
  "departure_city",
  "departure_country",
  "arrival_city",
  "arrival_country",
  "order_platform",
  "booker_region",
  "ouid",
  "first_seen_at",
  "last_seen_at",
  "first_ingestion_run_id",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

const BOOKING_UPDATE_MATERIAL_COLUMNS = [
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "raw_order_status",
  "normalized_order_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "currency",
  "order_date",
  "product_start_date",
  "product_end_date",
  "booking_window",
  "departure_city",
  "departure_country",
  "arrival_city",
  "arrival_country",
  "order_platform",
  "booker_region",
  "ouid",
  "last_seen_at",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

const COMMISSION_INSERT_COLUMNS = [
  "commission_fact_id",
  "commission_record_key",
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "sub_order_type",
  "raw_order_status",
  "normalized_order_status",
  "raw_commission_status",
  "normalized_commission_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "commission_amount_raw",
  "commission_amount_micros",
  "currency",
  "commission_month",
  "order_date",
  "check_out_or_issue_date",
  "ratio_raw",
  "plan_type",
  "region",
  "ouid",
  "first_seen_at",
  "last_seen_at",
  "first_ingestion_run_id",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

const COMMISSION_UPDATE_MATERIAL_COLUMNS = [
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "sub_order_type",
  "raw_order_status",
  "normalized_order_status",
  "raw_commission_status",
  "normalized_commission_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "commission_amount_raw",
  "commission_amount_micros",
  "currency",
  "commission_month",
  "order_date",
  "check_out_or_issue_date",
  "ratio_raw",
  "plan_type",
  "region",
  "ouid",
  "last_seen_at",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

function buildInsertSql(table, columns) {
  const placeholders = columns
    .map((_, index) => `?${index + 1}`)
    .join(", ");

  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
}

function buildUpdateMaterialSql(table, setColumns, whereColumn) {
  const assignments = setColumns
    .map((column, index) => `${column} = ?${index + 1}`)
    .join(",\n  ");

  const whereParam = setColumns.length + 1;

  return `UPDATE ${table}\nSET\n  ${assignments}\nWHERE ${whereColumn} = ?${whereParam}`;
}

const BOOKING_INSERT_SQL =
  buildInsertSql("trip_bookings", BOOKING_INSERT_COLUMNS);

const BOOKING_UPDATE_MATERIAL_SQL =
  buildUpdateMaterialSql(
    "trip_bookings",
    BOOKING_UPDATE_MATERIAL_COLUMNS,
    "booking_fact_id"
  );

const BOOKING_UPDATE_OBSERVATION_SQL = `UPDATE trip_bookings
SET
  last_seen_at = ?1,
  last_ingestion_run_id = ?2,
  source_ingested_at = ?3
WHERE booking_fact_id = ?4`;

const COMMISSION_INSERT_SQL =
  buildInsertSql("trip_commissions", COMMISSION_INSERT_COLUMNS);

const COMMISSION_UPDATE_MATERIAL_SQL =
  buildUpdateMaterialSql(
    "trip_commissions",
    COMMISSION_UPDATE_MATERIAL_COLUMNS,
    "commission_fact_id"
  );

const COMMISSION_UPDATE_OBSERVATION_SQL = `UPDATE trip_commissions
SET
  last_seen_at = ?1,
  last_ingestion_run_id = ?2,
  source_ingested_at = ?3
WHERE commission_fact_id = ?4`;

const BOOKING_INSERT_BIND_COLUMNS =
  BOOKING_INSERT_COLUMNS.slice(1);

const COMMISSION_INSERT_BIND_COLUMNS =
  COMMISSION_INSERT_COLUMNS.slice(1);

function collectValues(values, fields) {
  return fields.map((field) => values[field]);
}

function assertWritePlan(plan, factIdField, errorMessage) {
  if (
    plan === null ||
    typeof plan !== "object" ||
    Array.isArray(plan)
  ) {
    throw new Error(errorMessage);
  }

  if (
    plan.persistence_action !== "insert" &&
    plan.persistence_action !== "update_material" &&
    plan.persistence_action !== "update_observation"
  ) {
    throw new Error(errorMessage);
  }

  const factId = plan[factIdField];

  if (
    typeof factId !== "string" ||
    factId.trim().length === 0
  ) {
    throw new Error(errorMessage);
  }

  if (
    plan.values === null ||
    typeof plan.values !== "object" ||
    Array.isArray(plan.values)
  ) {
    throw new Error(errorMessage);
  }
}

export function prepareBookingFactWriteStatement(database, persistencePlan) {
  assertDatabaseBinding(database);
  assertWritePlan(
    persistencePlan,
    "booking_fact_id",
    "Invalid booking D1 persistence plan"
  );

  const values = persistencePlan.values;

  if (persistencePlan.persistence_action === "insert") {
    return database
      .prepare(BOOKING_INSERT_SQL)
      .bind(
        persistencePlan.booking_fact_id,
        ...collectValues(values, BOOKING_INSERT_BIND_COLUMNS)
      );
  }

  if (persistencePlan.persistence_action === "update_material") {
    return database
      .prepare(BOOKING_UPDATE_MATERIAL_SQL)
      .bind(
        ...collectValues(values, BOOKING_UPDATE_MATERIAL_COLUMNS),
        persistencePlan.booking_fact_id
      );
  }

  return database
    .prepare(BOOKING_UPDATE_OBSERVATION_SQL)
    .bind(
      values.last_seen_at,
      values.last_ingestion_run_id,
      values.source_ingested_at,
      persistencePlan.booking_fact_id
    );
}

export function prepareCommissionFactWriteStatement(database, persistencePlan) {
  assertDatabaseBinding(database);
  assertWritePlan(
    persistencePlan,
    "commission_fact_id",
    "Invalid commission D1 persistence plan"
  );

  const values = persistencePlan.values;

  if (persistencePlan.persistence_action === "insert") {
    return database
      .prepare(COMMISSION_INSERT_SQL)
      .bind(
        persistencePlan.commission_fact_id,
        ...collectValues(values, COMMISSION_INSERT_BIND_COLUMNS)
      );
  }

  if (persistencePlan.persistence_action === "update_material") {
    return database
      .prepare(COMMISSION_UPDATE_MATERIAL_SQL)
      .bind(
        ...collectValues(values, COMMISSION_UPDATE_MATERIAL_COLUMNS),
        persistencePlan.commission_fact_id
      );
  }

  return database
    .prepare(COMMISSION_UPDATE_OBSERVATION_SQL)
    .bind(
      values.last_seen_at,
      values.last_ingestion_run_id,
      values.source_ingested_at,
      persistencePlan.commission_fact_id
    );
}
