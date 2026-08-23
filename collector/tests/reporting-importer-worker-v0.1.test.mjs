import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKER_URL =
  "https://internal.test/v1/internal/reporting/trip/import";

const TOKEN = "test-internal-import-token";

async function computeSourceFileSha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array
    .from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeRuntime(config = {}) {
  const calls = [];

  const ids = config.ids ?? [];
  const timestamps = config.timestamps ?? [];

  let idIndex = 0;
  let timestampIndex = 0;

  return {
    __calls: calls,

    create_id() {
      calls.push("create_id");

      const value = ids[idIndex];
      idIndex += 1;

      return value;
    },

    now_iso() {
      calls.push("now_iso");

      const value = timestamps[timestampIndex];
      timestampIndex += 1;

      return value;
    }
  };
}

function makeFakeD1(config = {}) {
  const calls = {
    placementReads: 0,
    ingestionRunReads: 0,
    factReads: [],
    batchCalls: 0,
    batchStatements: [],
    runCalls: 0,
    execCalls: 0
  };

  const database = {
    __calls: calls,

    prepare(sql) {
      const sqlUpper = sql.toUpperCase();

      const statement = {
        __sql: sql,

        bind(...values) {
          const bound = {
            __sql: sql,
            __boundValues: values,

            first() {
              if (sqlUpper.includes("REPORT_INGESTION_RUNS")) {
                calls.ingestionRunReads += 1;

                if (config.ingestionRunError !== undefined) {
                  throw config.ingestionRunError;
                }

                return config.existingIngestionRun === undefined
                  ? null
                  : config.existingIngestionRun;
              }

              if (sqlUpper.includes("TRIP_BOOKINGS")) {
                const key = values[0];
                calls.factReads.push({ kind: "booking", key });

                if (config.factReadError !== undefined) {
                  throw config.factReadError;
                }

                const map = config.bookingFactsByKey ?? {};

                return Object.prototype.hasOwnProperty.call(map, key)
                  ? map[key]
                  : null;
              }

              if (sqlUpper.includes("TRIP_COMMISSIONS")) {
                const key = values[0];
                calls.factReads.push({ kind: "commission", key });

                if (config.factReadError !== undefined) {
                  throw config.factReadError;
                }

                const map = config.commissionFactsByKey ?? {};

                return Object.prototype.hasOwnProperty.call(map, key)
                  ? map[key]
                  : null;
              }

              throw new Error("Unexpected D1 first() read");
            },

            all() {
              if (sqlUpper.includes("PUBLISHER_PLACEMENTS")) {
                calls.placementReads += 1;

                if (config.placementReadError !== undefined) {
                  throw config.placementReadError;
                }

                return config.placementResult;
              }

              throw new Error("Unexpected D1 all() read");
            }
          };

          return bound;
        }
      };

      return statement;
    },

    batch(statements) {
      calls.batchCalls += 1;
      calls.batchStatements.push(statements);

      if (config.batchError !== undefined) {
        throw config.batchError;
      }

      return config.batchResult;
    },

    run() {
      calls.runCalls += 1;
      return config.runResult;
    },

    exec() {
      calls.execCalls += 1;
      return config.execResult;
    }
  };

  return database;
}

function getInsertBoundValue(statement, columnName) {
  const sql = statement.__sql;
  const values = statement.__boundValues;

  assert.ok(
    typeof sql === "string",
    "statement must expose __sql"
  );
  assert.ok(
    Array.isArray(values),
    "statement must expose __boundValues"
  );

  const match = sql.match(
    /INSERT\s+INTO\s+[^(]+\(([^)]*)\)/i
  );

  assert.ok(
    match !== null,
    `statement is not an INSERT: ${sql.slice(0, 80)}`
  );

  const columns = match[1]
    .split(",")
    .map((column) => column.trim());

  const index = columns.indexOf(columnName);

  assert.ok(
    index !== -1,
    `INSERT columns do not include ${columnName}`
  );

  return values[index];
}

function findInsertStatement(batchStatements, columnName) {
  const statements = batchStatements[0];

  assert.ok(
    Array.isArray(statements),
    "batch must contain statements"
  );

  const statement = statements.find(
    (candidate) => {
      const sql = candidate.__sql;

      if (
        typeof sql !== "string" ||
        !sql.toUpperCase().includes("INSERT")
      ) {
        return false;
      }

      const match = sql.match(
        /INSERT\s+INTO\s+[^(]+\(([^)]*)\)/i
      );

      if (match === null) {
        return false;
      }

      const columns = match[1]
        .split(",")
        .map((column) => column.trim());

      return columns.includes(columnName);
    }
  );

  assert.ok(
    statement !== undefined,
    `batch must contain an INSERT statement with column ${columnName}`
  );

  return statement;
}

function placementRow(key, publisherId, placement) {
  return {
    supplier: "trip.com",
    is_active: 1,
    external_tracking_key: key,
    publisher_id: publisherId,
    placement
  };
}

const PLACEMENT_RESULT = {
  results: [
    placementRow(
      "flightflex_flights_yyz_bjs_test",
      "flightflex",
      "placement-a"
    )
  ]
};

const FILE_BYTES = new TextEncoder().encode(
  "worker-report-v0.1\n"
);

function bookingRow(overrides = {}) {
  return {
    orderId: "BOOKING-001",
    sid: "123456",
    sidName: "sid-name",
    tripSub1: "flightflex_flights_yyz_bjs_test",
    tripSub3: "sub3",
    productLine: "htl",
    orderStatus: "S",
    amount: "100.00",
    currency: "CNY",
    orderDate: "2026-08-01",
    productStartDate: "2026-08-05",
    productEndDate: "2026-08-08",
    bookingWindow: 3,
    departureCity: "YYZ",
    departureCountry: "CA",
    arrivalCity: "BJS",
    arrivalCountry: "CN",
    orderPlatform: "web",
    region: "CA",
    ouid: "ouid-1",
    ...overrides
  };
}

function commissionRow(overrides = {}) {
  return {
    orderId: "BOOKING-001",
    sid: "123456",
    sidName: "sid-name",
    tripSub1: "flightflex_flights_yyz_bjs_test",
    tripSub3: "sub3",
    productLine: "htl",
    orderStatus: "S",
    commissionStatus: "SETTLED",
    bookingAmount: "200.00",
    commissionAmount: "5.00",
    currency: "CNY",
    commissionMonth: "2026-08",
    orderDate: "2026-08-01",
    checkOutOrIssueDate: "2026-08-08",
    ratio: "0.05",
    subOrderType: "sub-order-type",
    planType: "standard",
    region: "CA",
    ouid: "ouid-1",
    ...overrides
  };
}

function makeFile(name = "upload.csv") {
  return new File(
    [FILE_BYTES],
    name,
    { type: "text/csv" }
  );
}

function bookingFields(overrides = {}) {
  const fields = [
    ["command_type", "trip.booking.import"],
    ["aid", "10021103"],
    ["source_filename", "booking-report.csv"],
    ["rows_json", JSON.stringify([bookingRow()])],
    ["file", makeFile()]
  ];

  if (overrides.reportPeriods === true) {
    fields.splice(
      4,
      0,
      ["report_period_from", "2026-08-01"],
      ["report_period_to", "2026-08-20"]
    );
  }

  if (overrides.rows !== undefined) {
    fields[3] = ["rows_json", overrides.rows];
  }

  if (overrides.commandType !== undefined) {
    fields[0] = ["command_type", overrides.commandType];
  }

  if (overrides.file !== undefined) {
    fields[4] = ["file", overrides.file];
  }

  if (overrides.sourceFilename !== undefined) {
    fields[2] = ["source_filename", overrides.sourceFilename];
  }

  if (overrides.remove !== undefined) {
    return fields.filter(
      ([name]) => name !== overrides.remove
    );
  }

  return fields;
}

function commissionFields(overrides = {}) {
  const fields = bookingFields({
    ...overrides,
    commandType: "trip.commission.import"
  });

  fields[2] = ["source_filename", "commission-report.csv"];

  if (overrides.rows === undefined) {
    fields[3] = ["rows_json", JSON.stringify([commissionRow()])];
  }

  return fields;
}

function makeEnv(database, token = TOKEN) {
  return {
    CHINAFLOW_REPORTING_IMPORT_TOKEN: token,
    CHINAFLOW_EVENTS: database
  };
}

function makeRequest(fields, options = {}) {
  const headers = {};

  if (options.auth !== null) {
    headers.authorization =
      options.auth ?? `Bearer ${TOKEN}`;
  }

  if (options.rawBody !== undefined) {
    headers["content-type"] = options.contentType;

    return new Request(options.url ?? WORKER_URL, {
      method: options.method ?? "POST",
      headers,
      body: options.rawBody
    });
  }

  const form = new FormData();

  for (const [name, value] of fields) {
    form.append(name, value);
  }

  return new Request(options.url ?? WORKER_URL, {
    method: options.method ?? "POST",
    headers,
    body: form
  });
}

function defaultRuntime() {
  return makeRuntime({
    ids: ["run-1", "fact-1"],
    timestamps: ["t-start", "t-end"]
  });
}

async function readWorkerSource() {
  return readFileSync(
    new URL(
      "../reporting-importer-worker-v0.1.mjs",
      import.meta.url
    ),
    "utf8"
  );
}

test(
  "wrong pathname returns 404",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields(), {
        url: "https://internal.test/v1/events"
      }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }
);

test(
  "correct pathname with GET returns 405",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      new Request(WORKER_URL, { method: "GET" }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 405);
    assert.equal(await response.text(), "");
  }
);

test(
  "405 response includes Allow POST header",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      new Request(WORKER_URL, { method: "PUT" }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
);

test(
  "invalid or missing secret env returns 500",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    for (const token of [undefined, "", "   ", 42]) {
      const response = await handleReportingImporterRequest(
        makeRequest(bookingFields()),
        makeEnv(makeFakeD1(), token),
        defaultRuntime()
      );

      assert.equal(response.status, 500);
      assert.equal(await response.text(), "");
    }
  }
);

test(
  "missing Authorization returns 401",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields(), { auth: null }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  }
);

test(
  "wrong bearer token returns 401",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields(), {
        auth: "Bearer wrong-token"
      }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  }
);

test(
  "lowercase bearer scheme rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields(), {
        auth: `bearer ${TOKEN}`
      }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 401);
  }
);

test(
  "whitespace-modified bearer rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    for (const auth of [
      `Bearer  ${TOKEN}`,
      `Bearer\t${TOKEN}`
    ]) {
      const response = await handleReportingImporterRequest(
        makeRequest(bookingFields(), { auth }),
        makeEnv(makeFakeD1()),
        defaultRuntime()
      );

      assert.equal(response.status, 401);
    }
  }
);

test(
  "unauthorized request causes zero runtime calls and zero D1 operations",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1();
    const runtime = defaultRuntime();

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields(), { auth: null }),
      makeEnv(database),
      runtime
    );

    assert.equal(response.status, 401);
    assert.deepEqual(runtime.__calls, []);
    assert.equal(database.__calls.placementReads, 0);
    assert.equal(database.__calls.ingestionRunReads, 0);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "missing or invalid D1 binding after valid auth returns 500",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    for (const database of [
      undefined,
      null,
      {},
      { prepare() {} },
      { batch() {} }
    ]) {
      const response = await handleReportingImporterRequest(
        makeRequest(bookingFields()),
        makeEnv(database),
        defaultRuntime()
      );

      assert.equal(response.status, 500);
      assert.equal(await response.text(), "");
    }
  }
);

test(
  "wrong Content-Type returns 415",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(undefined, {
        rawBody: JSON.stringify({}),
        contentType: "application/json"
      }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 415);
    assert.equal(await response.text(), "");
  }
);

test(
  "lookalike Content-Types containing multipart substring return 415",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    for (const contentType of [
      "application/json; note=multipart/form-data",
      "application/x-multipart/form-data",
      "multipart/form-dataevil"
    ]) {
      const response = await handleReportingImporterRequest(
        makeRequest(undefined, {
          rawBody: "anything",
          contentType
        }),
        makeEnv(makeFakeD1()),
        defaultRuntime()
      );

      assert.equal(
        response.status,
        415,
        `expected 415 for ${contentType}`
      );
      assert.equal(await response.text(), "");
    }
  }
);

test(
  "malformed multipart returns 400",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(undefined, {
        rawBody: "not-a-multipart-body",
        contentType: "multipart/form-data"
      }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
  }
);

test(
  "unknown multipart field rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["evil_field", "evil"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
  }
);

test(
  "duplicate command_type rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["command_type", "trip.booking.import"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "duplicate aid rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["aid", "10021103"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "duplicate source_filename rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["source_filename", "other.csv"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "duplicate rows_json rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["rows_json", "[]"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "duplicate file rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["file", makeFile("second.csv")]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "duplicate report_period_from rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["report_period_from", "2026-08-01"]);
    fields.push(["report_period_from", "2026-08-02"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "duplicate report_period_to rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const fields = bookingFields();
    fields.push(["report_period_to", "2026-08-20"]);
    fields.push(["report_period_to", "2026-08-21"]);

    const response = await handleReportingImporterRequest(
      makeRequest(fields),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "missing command_type rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields({ remove: "command_type" })),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "missing aid rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields({ remove: "aid" })),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "missing source_filename rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(
        bookingFields({ remove: "source_filename" })
      ),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "missing rows_json rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields({ remove: "rows_json" })),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "missing file rejected",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields({ remove: "file" })),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "rows_json invalid JSON returns 400",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields({ rows: "{not-json" })),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
  }
);

test(
  "rows_json parsing to object returns 400",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(
        bookingFields({ rows: JSON.stringify({ a: 1 }) })
      ),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "file field supplied as string returns 400",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      makeRequest(
        bookingFields({ file: "not-a-file" })
      ),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
  }
);

test(
  "booking one-row full HTTP happy path",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.deepEqual(body, {
      import_status: "completed",
      ingestion_run_id: "run-1",
      ledger_plan: body.ledger_plan
    });
    assert.equal(
      body.ledger_plan.report_type,
      "booking"
    );
  }
);

test(
  "commission one-row full HTTP happy path",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(commissionFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.import_status, "completed");
    assert.equal(body.ingestion_run_id, "run-1");
    assert.equal(
      body.ledger_plan.report_type,
      "commission"
    );
  }
);

test(
  "booking HTTP path executes real downstream chain",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);
    assert.equal(database.__calls.placementReads, 1);
    assert.equal(database.__calls.ingestionRunReads, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(
      database.__calls.factReads[0].kind,
      "booking"
    );
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "commission HTTP path executes real downstream chain",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(commissionFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);
    assert.equal(database.__calls.placementReads, 1);
    assert.equal(database.__calls.ingestionRunReads, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(
      database.__calls.factReads[0].kind,
      "commission"
    );
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "deterministic fake runtime reaches actual booking persistence",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      makeRuntime({
        ids: ["run-det-1", "fact-det-1"],
        timestamps: [
          "2026-08-22T10:00:00.000Z",
          "2026-08-22T10:05:00.000Z"
        ]
      })
    );

    assert.equal(response.status, 200);

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(fact, "booking_fact_id"),
      "fact-det-1"
    );
    assert.equal(
      getInsertBoundValue(fact, "first_ingestion_run_id"),
      "run-det-1"
    );
    assert.equal(
      getInsertBoundValue(fact, "last_ingestion_run_id"),
      "run-det-1"
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "source_file_sha256"
    );

    assert.equal(
      getInsertBoundValue(ledger, "ingestion_run_id"),
      "run-det-1"
    );
    assert.equal(
      getInsertBoundValue(ledger, "started_at"),
      "2026-08-22T10:00:00.000Z"
    );
    assert.equal(
      getInsertBoundValue(ledger, "completed_at"),
      "2026-08-22T10:05:00.000Z"
    );
  }
);

test(
  "deterministic fake runtime reaches actual commission persistence",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(commissionFields()),
      makeEnv(database),
      makeRuntime({
        ids: ["run-det-2", "fact-det-2"],
        timestamps: [
          "2026-08-22T11:00:00.000Z",
          "2026-08-22T11:05:00.000Z"
        ]
      })
    );

    assert.equal(response.status, 200);

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "commission_fact_id"
    );

    assert.equal(
      getInsertBoundValue(fact, "commission_fact_id"),
      "fact-det-2"
    );
    assert.equal(
      getInsertBoundValue(fact, "first_ingestion_run_id"),
      "run-det-2"
    );
    assert.equal(
      getInsertBoundValue(fact, "last_ingestion_run_id"),
      "run-det-2"
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "source_file_sha256"
    );

    assert.equal(
      getInsertBoundValue(ledger, "ingestion_run_id"),
      "run-det-2"
    );
    assert.equal(
      getInsertBoundValue(ledger, "started_at"),
      "2026-08-22T11:00:00.000Z"
    );
    assert.equal(
      getInsertBoundValue(ledger, "completed_at"),
      "2026-08-22T11:05:00.000Z"
    );
  }
);

test(
  "raw uploaded file bytes produce expected source_file_sha256 in ledger INSERT",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const expectedSha256 =
      await computeSourceFileSha256(FILE_BYTES);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "source_file_sha256"
    );

    assert.equal(
      getInsertBoundValue(ledger, "source_file_sha256"),
      expectedSha256
    );
  }
);

test(
  "source_filename comes from explicit multipart field not file.name",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(
        bookingFields({
          file: makeFile("totally-different-name.csv")
        })
      ),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "source_filename"
    );

    assert.equal(
      getInsertBoundValue(ledger, "source_filename"),
      "booking-report.csv"
    );
  }
);

test(
  "absent report_period_from becomes null in ledger persistence",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "report_period_from"
    );

    assert.equal(
      getInsertBoundValue(ledger, "report_period_from"),
      null
    );
  }
);

test(
  "absent report_period_to becomes null in ledger persistence",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "report_period_to"
    );

    assert.equal(
      getInsertBoundValue(ledger, "report_period_to"),
      null
    );
  }
);

test(
  "explicit report periods reach actual ledger persistence",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields({ reportPeriods: true })),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "report_period_from"
    );

    assert.equal(
      getInsertBoundValue(ledger, "report_period_from"),
      "2026-08-01"
    );
    assert.equal(
      getInsertBoundValue(ledger, "report_period_to"),
      "2026-08-20"
    );
  }
);

test(
  "malicious file name cannot override source_filename",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(
        bookingFields({
          file: makeFile("../../evil-override.csv"),
          sourceFilename: "authoritative-report.csv"
        })
      ),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "source_filename"
    );

    const persisted =
      getInsertBoundValue(ledger, "source_filename");

    assert.equal(persisted, "authoritative-report.csv");
    assert.notEqual(persisted, "../../evil-override.csv");
  }
);

test(
  "booking command_type reaches booking table only",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    assert.ok(
      database.__calls.factReads.every(
        (read) => read.kind === "booking"
      )
    );

    const statements =
      database.__calls.batchStatements[0];

    assert.ok(
      statements.some((statement) =>
        statement.__sql
          .toUpperCase()
          .includes("TRIP_BOOKINGS")
      )
    );
    assert.ok(
      !statements.some((statement) =>
        statement.__sql
          .toUpperCase()
          .includes("TRIP_COMMISSIONS")
      )
    );
  }
);

test(
  "commission command_type reaches commission table only",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(commissionFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    assert.ok(
      database.__calls.factReads.every(
        (read) => read.kind === "commission"
      )
    );

    const statements =
      database.__calls.batchStatements[0];

    assert.ok(
      statements.some((statement) =>
        statement.__sql
          .toUpperCase()
          .includes("TRIP_COMMISSIONS")
      )
    );
    assert.ok(
      !statements.some((statement) =>
        statement.__sql
          .toUpperCase()
          .includes("TRIP_BOOKINGS")
      )
    );
  }
);

test(
  "unsupported command_type returns 400 with zero fact reads and zero batch writes",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(
        bookingFields({ commandType: "trip.hotel.import" })
      ),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "completed response has exact contract headers and three keys",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=UTF-8"
    );
    assert.equal(
      response.headers.get("cache-control"),
      "no-store"
    );

    const body = await response.json();

    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "import_status",
        "ingestion_run_id",
        "ledger_plan"
      ].sort()
    );
    assert.equal(body.import_status, "completed");
  }
);

test(
  "duplicate booking response returns exact duplicate result",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const sourceFileSha256 =
      await computeSourceFileSha256(FILE_BYTES);

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: "trip.com",
        report_type: "booking",
        source_file_sha256: sourceFileSha256
      }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store"
    );

    const body = await response.json();

    assert.deepEqual(body, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate commission response returns exact duplicate result",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const sourceFileSha256 =
      await computeSourceFileSha256(FILE_BYTES);

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported-c",
        source: "trip.com",
        report_type: "commission",
        source_file_sha256: sourceFileSha256
      }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(commissionFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.deepEqual(body, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported-c",
      ledger_plan: null
    });
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate path preserves runtime generation semantics",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const sourceFileSha256 =
      await computeSourceFileSha256(FILE_BYTES);

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: "trip.com",
        report_type: "booking",
        source_file_sha256: sourceFileSha256
      }
    });

    const runtime = defaultRuntime();

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      runtime
    );

    assert.equal(response.status, 200);

    assert.deepEqual(runtime.__calls, [
      "now_iso",
      "create_id",
      "create_id",
      "now_iso"
    ]);
  }
);

test(
  "unexpected downstream D1 error returns 500 empty body",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementReadError: new Error("d1-read-boom")
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
  }
);

test(
  "batch error returns 500 empty body",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchError: new Error("d1-batch-boom")
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
  }
);

test(
  "no retry after downstream error",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchError: new Error("d1-batch-boom")
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 500);
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "Worker source imports only the command module",
  async () => {
    const source = await readWorkerSource();

    assert.ok(
      source.includes(
        "./reporting-importer-command-v0.1.mjs"
      )
    );

    for (const forbidden of [
      "reporting-importer-runtime-v0.1.mjs",
      "reporting-importer-service-v0.1.mjs",
      "reporting-importer-preparation-v0.1.mjs",
      "reporting-importer-orchestrator-v0.1.mjs",
      "reporting-importer-core-v0.1.mjs",
      "reporting-importer-d1-v0.1.mjs",
      "worker-v0.1.js"
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `Worker source must not reference ${forbidden}`
      );
    }
  }
);

test(
  "Worker source performs no direct D1 calls",
  async () => {
    const source = await readWorkerSource();

    for (const forbidden of [
      ".prepare(",
      ".batch(",
      ".run(",
      ".exec("
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `Worker source must not contain ${forbidden}`
      );
    }
  }
);

test(
  "no direct run or exec calls through full HTTP path",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    assert.equal(response.status, 200);
    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
  }
);

test(
  "no CORS headers on responses",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const success = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    const rejected = await handleReportingImporterRequest(
      new Request(WORKER_URL, { method: "GET" }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    for (const response of [success, rejected]) {
      for (const [name] of response.headers) {
        assert.ok(
          !name.toLowerCase().startsWith(
            "access-control-"
          ),
          `unexpected CORS header ${name}`
        );
      }
    }
  }
);

test(
  "OPTIONS returns 405 not CORS preflight",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const response = await handleReportingImporterRequest(
      new Request(WORKER_URL, { method: "OPTIONS" }),
      makeEnv(makeFakeD1()),
      defaultRuntime()
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      null
    );
  }
);

test(
  "default fetch produces UUID-style ingestion_run_id",
  async () => {
    const { default: worker } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await worker.fetch(
      makeRequest(bookingFields()),
      makeEnv(database)
    );

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.match(
      body.ingestion_run_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.match(
      getInsertBoundValue(fact, "booking_fact_id"),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  }
);

test(
  "default fetch produces valid ISO timestamps",
  async () => {
    const { default: worker } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const response = await worker.fetch(
      makeRequest(bookingFields()),
      makeEnv(database)
    );

    assert.equal(response.status, 200);

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "started_at"
    );

    const startedAt =
      getInsertBoundValue(ledger, "started_at");
    const completedAt =
      getInsertBoundValue(ledger, "completed_at");

    for (const value of [startedAt, completedAt]) {
      assert.equal(
        typeof value,
        "string"
      );
      assert.equal(
        new Date(value).toISOString(),
        value
      );
    }
  }
);

test(
  "Authorization token never appears in responses",
  async () => {
    const { handleReportingImporterRequest } = await import(
      "../reporting-importer-worker-v0.1.mjs"
    );

    const database = makeFakeD1({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const success = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(database),
      defaultRuntime()
    );

    const failure = await handleReportingImporterRequest(
      makeRequest(bookingFields()),
      makeEnv(
        makeFakeD1({
          placementReadError: new Error("boom")
        })
      ),
      defaultRuntime()
    );

    for (const response of [success, failure]) {
      const body = await response.text();

      assert.ok(
        !body.includes(TOKEN),
        "response body must not contain the token"
      );
    }
  }
);
