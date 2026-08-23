import test from "node:test";
import assert from "node:assert/strict";

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

      if (
        config.idErrorAt !== undefined &&
        idIndex === config.idErrorAt
      ) {
        throw config.idError;
      }

      const value = ids[idIndex];
      idIndex += 1;

      return value;
    },

    now_iso() {
      calls.push("now_iso");

      if (
        config.timestampErrorAt !== undefined &&
        timestampIndex === config.timestampErrorAt
      ) {
        throw config.timestampError;
      }

      const value = timestamps[timestampIndex];
      timestampIndex += 1;

      return value;
    }
  };
}

function makeRuntimeFake(config = {}) {
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

      if (config.batchRejection !== undefined) {
        return Promise.reject(config.batchRejection);
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
  "runtime-report-v0.1\n"
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

function bookingRuntimeInput(overrides = {}) {
  return {
    source: "trip.com",
    report_type: "booking",
    aid: "10021103",
    source_filename: "booking-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: FILE_BYTES,
    rows: [bookingRow()],
    ...overrides
  };
}

function commissionRuntimeInput(overrides = {}) {
  return {
    source: "trip.com",
    report_type: "commission",
    aid: "10021103",
    source_filename: "commission-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: FILE_BYTES,
    rows: [commissionRow()],
    ...overrides
  };
}

const ONE_ROW_IDS = ["run-1", "fact-1"];
const ONE_ROW_TIMESTAMPS = ["t-start", "t-end"];

test(
  "malformed top-level input rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          {},
          null,
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import runtime input/
    );
  }
);

test(
  "rows must be an array",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          {},
          bookingRuntimeInput({ rows: "not-an-array" }),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import runtime input/
    );
  }
);

test(
  "malformed runtime rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          {},
          bookingRuntimeInput(),
          null
        ),
      /Invalid Trip import runtime dependency/
    );
  }
);

test(
  "missing create_id rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          {},
          bookingRuntimeInput(),
          { now_iso: () => "t" }
        ),
      /Invalid Trip import runtime dependency/
    );
  }
);

test(
  "missing now_iso rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          {},
          bookingRuntimeInput(),
          { create_id: () => "id" }
        ),
      /Invalid Trip import runtime dependency/
    );
  }
);

test(
  "booking one-row happy path",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(result.ingestion_run_id, "run-1");
    assert.equal(result.ledger_plan.rows_seen, 1);
    assert.equal(result.ledger_plan.rows_inserted, 1);
  }
);

test(
  "commission one-row happy path",
  async () => {
    const { executeTripCommissionImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripCommissionImportWithRuntime(
      database,
      commissionRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(result.ingestion_run_id, "run-1");
    assert.equal(result.ledger_plan.rows_seen, 1);
    assert.equal(result.ledger_plan.rows_inserted, 1);
  }
);

test(
  "booking generated path reaches completed through real service stack",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(database.__calls.placementReads, 1);
    assert.equal(database.__calls.ingestionRunReads, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "commission generated path reaches completed through real service stack",
  async () => {
    const { executeTripCommissionImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripCommissionImportWithRuntime(
      database,
      commissionRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(database.__calls.placementReads, 1);
    assert.equal(database.__calls.ingestionRunReads, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "exact generation call order for one-row import",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const runtime = makeRuntime({
      ids: ONE_ROW_IDS,
      timestamps: ONE_ROW_TIMESTAMPS
    });

    await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingRuntimeInput(),
      runtime
    );

    assert.deepEqual(runtime.__calls, [
      "now_iso",
      "create_id",
      "create_id",
      "now_iso"
    ]);
  }
);

test(
  "now_iso call count is exactly 2",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const runtime = makeRuntime({
      ids: ONE_ROW_IDS,
      timestamps: ONE_ROW_TIMESTAMPS
    });

    await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingRuntimeInput(),
      runtime
    );

    assert.equal(
      runtime.__calls.filter((call) => call === "now_iso").length,
      2
    );
  }
);

test(
  "create_id call count equals rows.length + 1",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const rows = [bookingRow(), bookingRow({ orderId: "BOOKING-002" })];

    const runtime = makeRuntime({
      ids: ["run-1", "fact-a", "fact-b"],
      timestamps: ONE_ROW_TIMESTAMPS
    });

    await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingRuntimeInput({ rows }),
      runtime
    );

    assert.equal(
      runtime.__calls.filter((call) => call === "create_id").length,
      3
    );
  }
);

test(
  "zero-row exact generation counts",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const runtime = makeRuntime({
      ids: ["run-1"],
      timestamps: ONE_ROW_TIMESTAMPS
    });

    await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingRuntimeInput({ rows: [] }),
      runtime
    );

    assert.deepEqual(runtime.__calls, [
      "now_iso",
      "create_id",
      "now_iso"
    ]);
    assert.equal(
      runtime.__calls.filter((call) => call === "now_iso").length,
      2
    );
    assert.equal(
      runtime.__calls.filter((call) => call === "create_id").length,
      1
    );
  }
);

test(
  "first generated ID becomes ingestion_run_id",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const result = await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingRuntimeInput(),
      makeRuntime({
        ids: ["run-first", "fact-1"],
        timestamps: ONE_ROW_TIMESTAMPS
      })
    );

    assert.equal(result.ingestion_run_id, "run-first");
  }
);

test(
  "subsequent generated IDs map exactly to row order",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const rows = [bookingRow(), bookingRow({ orderId: "BOOKING-002" })];

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput({ rows }),
      makeRuntime({
        ids: ["run-1", "fact-a", "fact-b"],
        timestamps: ONE_ROW_TIMESTAMPS
      })
    );

    const statements = database.__calls.batchStatements[0];

    assert.equal(
      getInsertBoundValue(statements[1], "booking_fact_id"),
      "fact-a"
    );
    assert.equal(
      getInsertBoundValue(statements[2], "booking_fact_id"),
      "fact-b"
    );
  }
);

test(
  "generated booking fact ID reaches actual booking INSERT",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "booking_fact_id"),
      "fact-1"
    );
  }
);

test(
  "generated commission fact ID reaches actual commission INSERT",
  async () => {
    const { executeTripCommissionImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripCommissionImportWithRuntime(
      database,
      commissionRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "commission_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "commission_fact_id"),
      "fact-1"
    );
  }
);

test(
  "generated ingestion_run_id reaches ledger INSERT",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "ingestion_run_id"),
      "run-1"
    );
  }
);

test(
  "generated started_at reaches ledger started_at",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "started_at"
    );

    assert.equal(
      getInsertBoundValue(statement, "started_at"),
      "t-start"
    );
  }
);

test(
  "generated observed_at reaches ledger completed_at",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "completed_at"
    );

    assert.equal(
      getInsertBoundValue(statement, "completed_at"),
      "t-end"
    );
  }
);

test(
  "generated ingestion_run_id reaches fact first/last ingestion run id",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "first_ingestion_run_id"),
      "run-1"
    );
    assert.equal(
      getInsertBoundValue(statement, "last_ingestion_run_id"),
      "run-1"
    );
  }
);

test(
  "generated observed_at reaches fact observation fields",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "first_seen_at"),
      "t-end"
    );
    assert.equal(
      getInsertBoundValue(statement, "last_seen_at"),
      "t-end"
    );
    assert.equal(
      getInsertBoundValue(statement, "source_ingested_at"),
      "t-end"
    );
  }
);

test(
  "caller-supplied malicious new_fact_ids are overridden",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput({ new_fact_ids: ["evil-fact"] }),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    const persisted = getInsertBoundValue(
      statement,
      "booking_fact_id"
    );

    assert.equal(persisted, "fact-1");
    assert.notEqual(persisted, "evil-fact");
  }
);

test(
  "caller-supplied malicious context is overridden",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput({
        context: {
          ingestion_run_id: "evil-run",
          started_at: "evil-start",
          observed_at: "evil-observed"
        }
      }),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(
      getInsertBoundValue(ledger, "ingestion_run_id"),
      "run-1"
    );
    assert.equal(
      getInsertBoundValue(ledger, "started_at"),
      "t-start"
    );
    assert.equal(
      getInsertBoundValue(ledger, "completed_at"),
      "t-end"
    );
  }
);

test(
  "invalid generated ingestion_run_id rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({ ids: ["", "fact-1"], timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import runtime ids/
    );
  }
);

test(
  "invalid generated fact ID rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({ ids: ["run-1", ""], timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import runtime ids/
    );
  }
);

test(
  "duplicate generated fact IDs rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const rows = [bookingRow(), bookingRow({ orderId: "BOOKING-002" })];

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput({ rows }),
          makeRuntime({
            ids: ["run-1", "dup", "dup"],
            timestamps: ONE_ROW_TIMESTAMPS
          })
        ),
      /Invalid Trip import runtime ids/
    );
  }
);

test(
  "ingestion_run_id colliding with fact ID rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({
            ids: ["same", "same"],
            timestamps: ONE_ROW_TIMESTAMPS
          })
        ),
      /Invalid Trip import runtime ids/
    );
  }
);

test(
  "invalid started_at generation rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ["", "t-end"] })
        ),
      /Invalid Trip import runtime timestamp/
    );
  }
);

test(
  "invalid observed_at generation rejected",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ["t-start", ""] })
        ),
      /Invalid Trip import runtime timestamp/
    );
  }
);

test(
  "create_id thrown sentinel propagates exactly",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const sentinel = new Error("create-id-boom");

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({
            ids: ONE_ROW_IDS,
            timestamps: ONE_ROW_TIMESTAMPS,
            idErrorAt: 0,
            idError: sentinel
          })
        ),
      (error) => error === sentinel
    );
  }
);

test(
  "first now_iso thrown sentinel propagates exactly",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const sentinel = new Error("now-iso-boom");

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({
            ids: ONE_ROW_IDS,
            timestamps: ONE_ROW_TIMESTAMPS,
            timestampErrorAt: 0,
            timestampError: sentinel
          })
        ),
      (error) => error === sentinel
    );
  }
);

test(
  "second now_iso thrown sentinel propagates exactly",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const sentinel = new Error("now-iso-boom-2");

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput(),
          makeRuntime({
            ids: ONE_ROW_IDS,
            timestamps: ONE_ROW_TIMESTAMPS,
            timestampErrorAt: 1,
            timestampError: sentinel
          })
        ),
      (error) => error === sentinel
    );
  }
);

test(
  "generator validation failure causes zero service D1 operations",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          database,
          bookingRuntimeInput(),
          makeRuntime({ ids: ["", "fact-1"], timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import runtime ids/
    );

    assert.equal(database.__calls.placementReads, 0);
    assert.equal(database.__calls.ingestionRunReads, 0);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate booking source file still consumes runtime generation",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: "trip.com",
        report_type: "booking",
        source_file_sha256: sourceFileSha256
      }
    });

    const runtime = makeRuntime({
      ids: ONE_ROW_IDS,
      timestamps: ONE_ROW_TIMESTAMPS
    });

    const result = await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      runtime
    );

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });

    assert.equal(
      runtime.__calls.filter((call) => call === "now_iso").length,
      2
    );
    assert.equal(
      runtime.__calls.filter((call) => call === "create_id").length,
      2
    );
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate commission source file still consumes runtime generation",
  async () => {
    const { executeTripCommissionImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: "trip.com",
        report_type: "commission",
        source_file_sha256: sourceFileSha256
      }
    });

    const runtime = makeRuntime({
      ids: ONE_ROW_IDS,
      timestamps: ONE_ROW_TIMESTAMPS
    });

    const result = await executeTripCommissionImportWithRuntime(
      database,
      commissionRuntimeInput(),
      runtime
    );

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });

    assert.equal(
      runtime.__calls.filter((call) => call === "now_iso").length,
      2
    );
    assert.equal(
      runtime.__calls.filter((call) => call === "create_id").length,
      2
    );
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "wrong booking report_type propagates downstream route error",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripBookingImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          bookingRuntimeInput({ report_type: "commission" }),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "wrong commission report_type propagates downstream route error",
  async () => {
    const { executeTripCommissionImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeTripCommissionImportWithRuntime(
          makeRuntimeFake({ placementResult: PLACEMENT_RESULT }),
          commissionRuntimeInput({ report_type: "booking" }),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "caller input remains unmodified",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const input = bookingRuntimeInput();

    const snapshot = JSON.stringify(input);

    await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      input,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(JSON.stringify(input), snapshot);
    assert.equal("new_fact_ids" in input, false);
    assert.equal("context" in input, false);
  }
);

test(
  "rows remain same reference and content",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const row = bookingRow();
    const rows = [row];
    const input = bookingRuntimeInput({ rows });

    await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      input,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(input.rows, rows);
    assert.equal(input.rows[0], row);
    assert.equal(row.orderId, "BOOKING-001");
  }
);

test(
  "file_bytes reaches downstream source-file hash unchanged",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const expectedSha256 = await computeSourceFileSha256(FILE_BYTES);

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
  "completed result has exactly existing 3 keys",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const result = await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
  }
);

test(
  "duplicate result has exactly existing 3 keys",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const result = await executeTripBookingImportWithRuntime(
      makeRuntimeFake({
        placementResult: PLACEMENT_RESULT,
        existingIngestionRun: {
          ingestion_run_id: "run-already-imported",
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: sourceFileSha256
        }
      }),
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
  }
);

test(
  "no run() or exec() calls occur",
  async () => {
    const { executeTripBookingImportWithRuntime } = await import(
      "../reporting-importer-runtime-v0.1.mjs"
    );

    const database = makeRuntimeFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImportWithRuntime(
      database,
      bookingRuntimeInput(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
  }
);
