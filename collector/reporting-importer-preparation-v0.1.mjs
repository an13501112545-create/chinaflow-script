import {
  buildTripSub1PlacementMap,
  createIngestionRunPreflight,
  preflightTripBookingRows,
  preflightTripCommissionRows
} from "./reporting-importer-core-v0.1.mjs";

function isNonNullObject(value) {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isNonBlankString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function assertPreparationStructure(input) {
  if (!isNonNullObject(input)) {
    throw new Error(
      "Invalid Trip import preparation input"
    );
  }

  if (!isNonBlankString(input.aid)) {
    throw new Error(
      "Invalid Trip import preparation input"
    );
  }

  if (
    !Array.isArray(input.rows) ||
    !Array.isArray(input.placement_rows) ||
    !Array.isArray(input.new_fact_ids)
  ) {
    throw new Error(
      "Invalid Trip import preparation input"
    );
  }

  if (input.new_fact_ids.length !== input.rows.length) {
    throw new Error(
      "Invalid Trip import preparation input"
    );
  }
}

function assertPreparationRoute(input, reportType) {
  if (
    input.source !== "trip.com" ||
    input.report_type !== reportType
  ) {
    throw new Error(
      "Invalid Trip import preparation route"
    );
  }
}

function assertPreparationFactIds(newFactIds) {
  const seen =
    new Set();

  for (const factId of newFactIds) {
    if (!isNonBlankString(factId)) {
      throw new Error(
        "Invalid Trip import preparation fact ids"
      );
    }

    if (seen.has(factId)) {
      throw new Error(
        "Invalid Trip import preparation fact ids"
      );
    }

    seen.add(factId);
  }
}

function assertPreparationContext(context) {
  if (!isNonNullObject(context)) {
    throw new Error(
      "Invalid Trip import preparation context"
    );
  }

  if (
    !isNonBlankString(context.ingestion_run_id) ||
    !isNonBlankString(context.started_at) ||
    !isNonBlankString(context.observed_at)
  ) {
    throw new Error(
      "Invalid Trip import preparation context"
    );
  }
}

function buildRowContexts(rows, newFactIds) {
  const rowContexts =
    [];

  for (let index = 0; index < rows.length; index += 1) {
    const rawPayload =
      JSON.stringify(rows[index]);

    if (typeof rawPayload !== "string") {
      throw new Error(
        "Invalid Trip import preparation raw payload"
      );
    }

    rowContexts.push({
      new_fact_id: newFactIds[index],
      raw_payload_json: rawPayload
    });
  }

  return rowContexts;
}

async function prepareTripImport(
  input,
  reportType,
  preflightRows
) {
  assertPreparationStructure(input);
  assertPreparationRoute(input, reportType);
  assertPreparationFactIds(input.new_fact_ids);
  assertPreparationContext(input.context);

  const placementsByTripSub1 =
    buildTripSub1PlacementMap(
      input.placement_rows
    );

  const preflight =
    await createIngestionRunPreflight({
      source: input.source,
      report_type: input.report_type,
      source_filename: input.source_filename,
      report_period_from: input.report_period_from,
      report_period_to: input.report_period_to,
      file_bytes: input.file_bytes,
      rows_seen: input.rows.length
    });

  const normalizedRows =
    await preflightRows(
      input.rows,
      {
        source: input.source,
        aid: input.aid,
        placementsByTripSub1
      }
    );

  const rowContexts =
    buildRowContexts(
      input.rows,
      input.new_fact_ids
    );

  return {
    preflight,
    normalized_rows: normalizedRows,
    row_contexts: rowContexts,
    context: input.context
  };
}

export function prepareTripBookingImport(input) {
  return prepareTripImport(
    input,
    "booking",
    preflightTripBookingRows
  );
}

export function prepareTripCommissionImport(input) {
  return prepareTripImport(
    input,
    "commission",
    preflightTripCommissionRows
  );
}
