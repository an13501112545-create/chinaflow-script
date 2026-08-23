import { executeInternalTripImportCommand } from "./reporting-importer-command-v0.1.mjs";

const ROUTE_PATHNAME =
  "/v1/internal/reporting/trip/import";

const ALLOWED_FIELD_NAMES = new Set([
  "command_type",
  "aid",
  "source_filename",
  "report_period_from",
  "report_period_to",
  "rows_json",
  "file"
]);

const REQUIRED_FIELD_NAMES = [
  "command_type",
  "aid",
  "source_filename",
  "rows_json",
  "file"
];

const COMMAND_BOUNDARY_ERRORS = new Set([
  "Invalid internal Trip import command",
  "Invalid internal Trip import command type"
]);

function emptyResponse(status, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function isNonBlankString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function readSecretToken(env) {
  if (
    env === null ||
    env === undefined ||
    typeof env !== "object"
  ) {
    return undefined;
  }

  return env.CHINAFLOW_REPORTING_IMPORT_TOKEN;
}

function readDatabaseBinding(env) {
  if (
    env === null ||
    env === undefined ||
    typeof env !== "object"
  ) {
    return undefined;
  }

  return env.CHINAFLOW_EVENTS;
}

function collectFormFields(form) {
  const fields = new Map();

  for (const [name, value] of form.entries()) {
    if (!ALLOWED_FIELD_NAMES.has(name)) {
      return null;
    }

    if (fields.has(name)) {
      return null;
    }

    fields.set(name, value);
  }

  for (const required of REQUIRED_FIELD_NAMES) {
    if (!fields.has(required)) {
      return null;
    }
  }

  return fields;
}

function readOptionalTextField(fields, name) {
  if (!fields.has(name)) {
    return null;
  }

  return fields.get(name);
}

export async function handleReportingImporterRequest(
  request,
  env,
  runtime
) {
  const pathname = new URL(request.url).pathname;

  if (pathname !== ROUTE_PATHNAME) {
    return emptyResponse(404);
  }

  if (request.method !== "POST") {
    return emptyResponse(405, { Allow: "POST" });
  }

  const token = readSecretToken(env);

  if (!isNonBlankString(token)) {
    return emptyResponse(500);
  }

  const authorization =
    request.headers.get("authorization");

  if (authorization !== `Bearer ${token}`) {
    return emptyResponse(401);
  }

  const database = readDatabaseBinding(env);

  if (
    database === null ||
    database === undefined ||
    typeof database.prepare !== "function" ||
    typeof database.batch !== "function"
  ) {
    return emptyResponse(500);
  }

  const contentType =
    request.headers.get("content-type") ?? "";

  const mediaType = contentType
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (mediaType !== "multipart/form-data") {
    return emptyResponse(415);
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return emptyResponse(400);
  }

  const fields = collectFormFields(form);

  if (fields === null) {
    return emptyResponse(400);
  }

  const commandType = fields.get("command_type");
  const aid = fields.get("aid");
  const sourceFilename = fields.get("source_filename");
  const rowsJson = fields.get("rows_json");

  const reportPeriodFrom = readOptionalTextField(
    fields,
    "report_period_from"
  );

  const reportPeriodTo = readOptionalTextField(
    fields,
    "report_period_to"
  );

  if (
    typeof commandType !== "string" ||
    typeof aid !== "string" ||
    typeof sourceFilename !== "string" ||
    typeof rowsJson !== "string" ||
    (
      reportPeriodFrom !== null &&
      typeof reportPeriodFrom !== "string"
    ) ||
    (
      reportPeriodTo !== null &&
      typeof reportPeriodTo !== "string"
    )
  ) {
    return emptyResponse(400);
  }

  const fileValue = fields.get("file");

  if (
    fileValue === null ||
    fileValue === undefined ||
    typeof fileValue === "string" ||
    typeof fileValue.arrayBuffer !== "function"
  ) {
    return emptyResponse(400);
  }

  let rows;

  try {
    rows = JSON.parse(rowsJson);
  } catch {
    return emptyResponse(400);
  }

  if (!Array.isArray(rows)) {
    return emptyResponse(400);
  }

  let fileBytes;

  try {
    fileBytes = await fileValue.arrayBuffer();
  } catch {
    return emptyResponse(400);
  }

  const command = {
    command_type: commandType,
    payload: {
      aid,
      source_filename: sourceFilename,
      report_period_from: reportPeriodFrom,
      report_period_to: reportPeriodTo,
      file_bytes: fileBytes,
      rows
    }
  };

  let result;

  try {
    result = await executeInternalTripImportCommand(
      database,
      command,
      runtime
    );
  } catch (error) {
    if (
      error instanceof Error &&
      COMMAND_BOUNDARY_ERRORS.has(error.message)
    ) {
      return emptyResponse(400);
    }

    console.error(
      "reporting-importer-worker-v0.1 import failed",
      error
    );

    return emptyResponse(500);
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async fetch(request, env) {
    const runtime = {
      create_id: () => globalThis.crypto.randomUUID(),
      now_iso: () => new Date().toISOString()
    };

    return handleReportingImporterRequest(
      request,
      env,
      runtime
    );
  }
};
