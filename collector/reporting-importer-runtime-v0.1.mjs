import {
  executeTripBookingImport,
  executeTripCommissionImport
} from "./reporting-importer-service-v0.1.mjs";

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

function assertRuntimeInput(input) {
  if (!isNonNullObject(input)) {
    throw new Error(
      "Invalid Trip import runtime input"
    );
  }

  if (!Array.isArray(input.rows)) {
    throw new Error(
      "Invalid Trip import runtime input"
    );
  }
}

function assertRuntimeDependency(runtime) {
  if (!isNonNullObject(runtime)) {
    throw new Error(
      "Invalid Trip import runtime dependency"
    );
  }

  if (
    typeof runtime.create_id !== "function" ||
    typeof runtime.now_iso !== "function"
  ) {
    throw new Error(
      "Invalid Trip import runtime dependency"
    );
  }
}

function assertGeneratedIds(ingestionRunId, newFactIds) {
  const seen = new Set();

  const allIds = [ingestionRunId, ...newFactIds];

  for (const id of allIds) {
    if (!isNonBlankString(id)) {
      throw new Error(
        "Invalid Trip import runtime ids"
      );
    }

    if (seen.has(id)) {
      throw new Error(
        "Invalid Trip import runtime ids"
      );
    }

    seen.add(id);
  }
}

function assertGeneratedTimestamp(value) {
  if (!isNonBlankString(value)) {
    throw new Error(
      "Invalid Trip import runtime timestamp"
    );
  }
}

async function executeTripImportWithRuntime(
  database,
  input,
  runtime,
  executeService
) {
  assertRuntimeInput(input);
  assertRuntimeDependency(runtime);

  const startedAt = runtime.now_iso();

  assertGeneratedTimestamp(startedAt);

  const ingestionRunId = runtime.create_id();

  const newFactIds = [];

  for (let index = 0; index < input.rows.length; index += 1) {
    newFactIds.push(runtime.create_id());
  }

  const observedAt = runtime.now_iso();

  assertGeneratedTimestamp(observedAt);

  assertGeneratedIds(ingestionRunId, newFactIds);

  const authoritativeServiceInput = {
    ...input,
    new_fact_ids: newFactIds,
    context: {
      ingestion_run_id: ingestionRunId,
      started_at: startedAt,
      observed_at: observedAt
    }
  };

  return executeService(
    database,
    authoritativeServiceInput
  );
}

export function executeTripBookingImportWithRuntime(
  database,
  input,
  runtime
) {
  return executeTripImportWithRuntime(
    database,
    input,
    runtime,
    executeTripBookingImport
  );
}

export function executeTripCommissionImportWithRuntime(
  database,
  input,
  runtime
) {
  return executeTripImportWithRuntime(
    database,
    input,
    runtime,
    executeTripCommissionImport
  );
}
