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
