import {
  planSourceFileDedupe,
  planSuccessfulBookingIngestion,
  planSuccessfulCommissionIngestion
} from "./reporting-importer-core-v0.1.mjs";

import {
  findExistingIngestionRun,
  findExistingBookingFact,
  findExistingCommissionFact,
  executeSuccessfulBookingIngestionBatch,
  executeSuccessfulCommissionIngestionBatch
} from "./reporting-importer-d1-v0.1.mjs";

function assertPreparedImportInput(
  preflight,
  normalizedRows,
  rowContexts
) {
  if (
    !Array.isArray(normalizedRows) ||
    !Array.isArray(rowContexts)
  ) {
    throw new Error(
      "Invalid prepared import input"
    );
  }

  if (
    normalizedRows.length !== preflight?.rows_seen ||
    rowContexts.length !== preflight?.rows_seen
  ) {
    throw new Error(
      "Prepared import row count mismatch"
    );
  }
}

async function executePreparedImport(
  database,
  preflight,
  normalizedRows,
  rowContexts,
  context,
  findExistingFact,
  planSuccessfulIngestion,
  executeSuccessfulIngestionBatch
) {
  assertPreparedImportInput(
    preflight,
    normalizedRows,
    rowContexts
  );

  const existingRun = await findExistingIngestionRun(
    database,
    preflight
  );

  const dedupePlan = planSourceFileDedupe(
    preflight,
    existingRun
  );

  if (dedupePlan.should_import === false) {
    return {
      import_status: "duplicate",
      ingestion_run_id:
        dedupePlan.existing_ingestion_run_id,
      ledger_plan: null
    };
  }

  const existingFacts = [];

  for (
    let index = 0;
    index < normalizedRows.length;
    index += 1
  ) {
    const existingFact = await findExistingFact(
      database,
      normalizedRows[index]
    );

    existingFacts.push(existingFact);
  }

  const planResult = planSuccessfulIngestion(
    preflight,
    normalizedRows,
    existingFacts,
    rowContexts,
    context
  );

  await executeSuccessfulIngestionBatch(
    database,
    planResult.ledger_plan,
    planResult.persistence_plans
  );

  return {
    import_status: "completed",
    ingestion_run_id:
      planResult.ledger_plan.ingestion_run_id,
    ledger_plan: planResult.ledger_plan
  };
}

export function executePreparedBookingImport(
  database,
  preflight,
  normalizedRows,
  rowContexts,
  context
) {
  return executePreparedImport(
    database,
    preflight,
    normalizedRows,
    rowContexts,
    context,
    findExistingBookingFact,
    planSuccessfulBookingIngestion,
    executeSuccessfulBookingIngestionBatch
  );
}

export function executePreparedCommissionImport(
  database,
  preflight,
  normalizedRows,
  rowContexts,
  context
) {
  return executePreparedImport(
    database,
    preflight,
    normalizedRows,
    rowContexts,
    context,
    findExistingCommissionFact,
    planSuccessfulCommissionIngestion,
    executeSuccessfulCommissionIngestionBatch
  );
}
