import {
  executeTripBookingImportWithRuntime,
  executeTripCommissionImportWithRuntime
} from "./reporting-importer-runtime-v0.1.mjs";

const COMMAND_TYPE_BOOKING = "trip.booking.import";
const COMMAND_TYPE_COMMISSION = "trip.commission.import";

function isNonNullObject(value) {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function assertCommand(command) {
  if (!isNonNullObject(command)) {
    throw new Error(
      "Invalid internal Trip import command"
    );
  }

  const payload = command.payload;

  if (!isNonNullObject(payload)) {
    throw new Error(
      "Invalid internal Trip import command"
    );
  }

  if (!Array.isArray(payload.rows)) {
    throw new Error(
      "Invalid internal Trip import command"
    );
  }
}

function assertCommandType(commandType) {
  if (
    commandType !== COMMAND_TYPE_BOOKING &&
    commandType !== COMMAND_TYPE_COMMISSION
  ) {
    throw new Error(
      "Invalid internal Trip import command type"
    );
  }
}

function buildBookingRuntimeInput(payload) {
  return {
    source: "trip.com",
    report_type: "booking",
    aid: payload.aid,
    source_filename: payload.source_filename,
    report_period_from: payload.report_period_from,
    report_period_to: payload.report_period_to,
    file_bytes: payload.file_bytes,
    rows: payload.rows
  };
}

function buildCommissionRuntimeInput(payload) {
  return {
    source: "trip.com",
    report_type: "commission",
    aid: payload.aid,
    source_filename: payload.source_filename,
    report_period_from: payload.report_period_from,
    report_period_to: payload.report_period_to,
    file_bytes: payload.file_bytes,
    rows: payload.rows
  };
}

export async function executeInternalTripImportCommand(
  database,
  command,
  runtime
) {
  assertCommand(command);

  const commandType = command.command_type;

  assertCommandType(commandType);

  const payload = command.payload;

  if (commandType === COMMAND_TYPE_BOOKING) {
    return executeTripBookingImportWithRuntime(
      database,
      buildBookingRuntimeInput(payload),
      runtime
    );
  }

  return executeTripCommissionImportWithRuntime(
    database,
    buildCommissionRuntimeInput(payload),
    runtime
  );
}
