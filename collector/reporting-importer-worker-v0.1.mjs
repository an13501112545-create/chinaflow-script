import { executeInternalTripImportCommand } from "./reporting-importer-command-v0.1.mjs";
import { executePublisherReconciliationCommand } from "./publisher-reconciliation-writer-v0.1.mjs";

const ROUTE_PATHNAME =
  "/v1/internal/reporting/trip/import";
const RECONCILIATION_ROUTE_PATHNAME =
  "/v1/internal/reporting/reconciliation";

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

function reconciliationWriterEnabled(env) {
  return env?.PUBLISHER_RECONCILIATION_WRITER_ENABLED === "true";
}

function readReconciliationSecretToken(env) {
  if (!env || typeof env !== "object") return undefined;
  return env.CHINAFLOW_RECONCILIATION_API_TOKEN;
}

async function readBoundedJson(request, maxBytes = 16384) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function handleReconciliationRequest(request, env, runtime) {
  if (!reconciliationWriterEnabled(env)) return emptyResponse(404);
  if (request.method !== "POST") return emptyResponse(405, { Allow: "POST" });

  const token = readReconciliationSecretToken(env);
  if (!isNonBlankString(token)) return emptyResponse(500);
  if (request.headers.get("authorization") !== `Bearer ${token}`) return emptyResponse(401);

  const url = new URL(request.url);
  if (url.search) return emptyResponse(400);

  const database = readDatabaseBinding(env);
  if (!database || typeof database.prepare !== "function") return emptyResponse(500);

  const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return emptyResponse(415);

  const idempotencyKey = request.headers.get("idempotency-key");
  const input = await readBoundedJson(request);
  if (input === null) return emptyResponse(400);

  let result;
  try {
    result = await executePublisherReconciliationCommand(database, input, idempotencyKey, runtime);
  } catch (error) {
    console.error("reporting-importer-worker-v0.1 reconciliation failed", error);
    return emptyResponse(500);
  }

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function handleReportingImporterRequest(
  request,
  env,
  runtime
) {
  const pathname = new URL(request.url).pathname;

  if (pathname === RECONCILIATION_ROUTE_PATHNAME) {
    return handleReconciliationRequest(request, env, runtime);
  }

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
