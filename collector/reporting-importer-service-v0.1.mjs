import {
  loadActiveTripPublisherPlacements
} from "./reporting-importer-d1-v0.1.mjs";

import {
  prepareTripBookingImport,
  prepareTripCommissionImport
} from "./reporting-importer-preparation-v0.1.mjs";

import {
  executePreparedBookingImport,
  executePreparedCommissionImport
} from "./reporting-importer-orchestrator-v0.1.mjs";

async function executeTripImport(
  database,
  input,
  prepareImport,
  executePreparedImport
) {
  const placementRows =
    await loadActiveTripPublisherPlacements(
      database
    );

  const prepared =
    await prepareImport({
      ...input,
      placement_rows: placementRows
    });

  return executePreparedImport(
    database,
    prepared.preflight,
    prepared.normalized_rows,
    prepared.row_contexts,
    prepared.context
  );
}

export function executeTripBookingImport(database, input) {
  return executeTripImport(
    database,
    input,
    prepareTripBookingImport,
    executePreparedBookingImport
  );
}

export function executeTripCommissionImport(database, input) {
  return executeTripImport(
    database,
    input,
    prepareTripCommissionImport,
    executePreparedCommissionImport
  );
}
