import test from "node:test";
import assert from "node:assert/strict";

async function computeSourceFileSha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array
    .from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeServiceFake(config = {}) {
  const calls = {
    placementReads: [],
    ingestionRunReads: [],
    factReads: [],
    batchCalls: 0,
    batchStatements: [],
    runCalls: 0,
    execCalls: 0,
    callOrder: []
  };

  const database = {
    __calls: calls,

    prepare(sql) {
      const sqlUpper = sql.toUpperCase();

      const statement = {
        __sql: sql,

        bind(...values) {
          let boundValues = values;

          const bound = {
            __sql: sql,
            __boundValues: values,

            first() {
              if (sqlUpper.includes("REPORT_INGESTION_RUNS")) {
                calls.ingestionRunReads.push(boundValues);
                calls.callOrder.push("ingestion_run_read");

                if (config.ingestionRunError !== undefined) {
                  throw config.ingestionRunError;
                }

                return config.existingIngestionRun === undefined
                  ? null
                  : config.existingIngestionRun;
              }

              if (sqlUpper.includes("TRIP_BOOKINGS")) {
                const key = boundValues[0];
                calls.factReads.push({ kind: "booking", key });
                calls.callOrder.push(`booking_fact_read:${key}`);

                if (calls.factReads.length - 1 === config.factReadErrorAt) {
                  throw config.factReadError;
                }

                const map = config.bookingFactsByKey ?? {};

                return Object.prototype.hasOwnProperty.call(map, key)
                  ? map[key]
                  : null;
              }

              if (sqlUpper.includes("TRIP_COMMISSIONS")) {
                const key = boundValues[0];
                calls.factReads.push({ kind: "commission", key });
                calls.callOrder.push(`commission_fact_read:${key}`);

                if (calls.factReads.length - 1 === config.factReadErrorAt) {
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
                calls.placementReads.push(boundValues);
                calls.callOrder.push("placement_read");

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
      calls.callOrder.push("batch");

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

const SERVICE_CONTEXT = {
  ingestion_run_id: "run-service-001",
  started_at: "2026-08-22T00:00:00.000Z",
  observed_at: "2026-08-22T00:05:00.000Z"
};

const FILE_BYTES = new TextEncoder().encode(
  "service-report-v0.1\n"
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

function bookingInput(overrides = {}) {
  return {
    source: "trip.com",
    report_type: "booking",
    aid: "10021103",
    source_filename: "booking-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: FILE_BYTES,
    rows: [bookingRow()],
    new_fact_ids: ["fact-booking-1"],
    context: SERVICE_CONTEXT,
    ...overrides
  };
}

function commissionInput(overrides = {}) {
  return {
    source: "trip.com",
    report_type: "commission",
    aid: "10021103",
    source_filename: "commission-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: FILE_BYTES,
    rows: [commissionRow()],
    new_fact_ids: ["fact-commission-1"],
    context: SERVICE_CONTEXT,
    ...overrides
  };
}

test(
  "booking full new-import happy path",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput()
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.batchCalls, 1);

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
    assert.equal(result.import_status, "completed");
    assert.equal(
      result.ingestion_run_id,
      SERVICE_CONTEXT.ingestion_run_id
    );
    assert.equal(result.ledger_plan.rows_seen, 1);
    assert.equal(result.ledger_plan.rows_inserted, 1);
  }
);

test(
  "commission full new-import happy path",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripCommissionImport(
      database,
      commissionInput()
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.batchCalls, 1);

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 1);
    assert.equal(result.ledger_plan.rows_inserted, 1);
  }
);

test(
  "booking placement load occurs exactly once",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImport(
      database,
      bookingInput()
    );

    assert.equal(database.__calls.placementReads.length, 1);
  }
);

test(
  "commission placement load occurs exactly once",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripCommissionImport(
      database,
      commissionInput()
    );

    assert.equal(database.__calls.placementReads.length, 1);
  }
);

test(
  "placement loader binds supplier=trip.com and is_active=1 for booking",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImport(
      database,
      bookingInput()
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.deepEqual(
      database.__calls.placementReads[0],
      ["trip.com", 1]
    );
  }
);

test(
  "placement loader binds supplier=trip.com and is_active=1 for commission",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripCommissionImport(
      database,
      commissionInput()
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.deepEqual(
      database.__calls.placementReads[0],
      ["trip.com", 1]
    );
  }
);

test(
  "booking uses D1 placement rows for matched attribution",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput()
    );

    assert.equal(result.import_status, "completed");

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "attributed_publisher_id"),
      "flightflex"
    );
    assert.equal(
      getInsertBoundValue(statement, "attributed_placement"),
      "placement-a"
    );
    assert.equal(
      getInsertBoundValue(statement, "attribution_status"),
      "matched"
    );
    assert.equal(
      getInsertBoundValue(statement, "trip_sub1"),
      "flightflex_flights_yyz_bjs_test"
    );
  }
);

test(
  "commission uses D1 placement rows for matched attribution",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripCommissionImport(
      database,
      commissionInput()
    );

    assert.equal(result.import_status, "completed");

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "commission_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "attributed_publisher_id"),
      "flightflex"
    );
    assert.equal(
      getInsertBoundValue(statement, "attributed_placement"),
      "placement-a"
    );
    assert.equal(
      getInsertBoundValue(statement, "attribution_status"),
      "matched"
    );
    assert.equal(
      getInsertBoundValue(statement, "trip_sub1"),
      "flightflex_flights_yyz_bjs_test"
    );
  }
);

test(
  "caller-supplied placement_rows cannot override D1 mappings",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({
        placement_rows: [
          placementRow(
            "flightflex_flights_yyz_bjs_test",
            "evil-publisher",
            "evil-placement"
          )
        ]
      })
    );

    assert.equal(result.import_status, "completed");

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    const persistedPublisher = getInsertBoundValue(
      statement,
      "attributed_publisher_id"
    );
    const persistedPlacement = getInsertBoundValue(
      statement,
      "attributed_placement"
    );
    const persistedStatus = getInsertBoundValue(
      statement,
      "attribution_status"
    );

    assert.equal(persistedPublisher, "flightflex");
    assert.equal(persistedPlacement, "placement-a");
    assert.equal(persistedStatus, "matched");

    assert.notEqual(persistedPublisher, "evil-publisher");
    assert.notEqual(persistedPlacement, "evil-placement");
  }
);

test(
  "caller-supplied fake placement_rows are ignored",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({
        placement_rows: "malicious"
      })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(database.__calls.placementReads.length, 1);

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "attributed_publisher_id"),
      "flightflex"
    );
    assert.equal(
      getInsertBoundValue(statement, "attributed_placement"),
      "placement-a"
    );
    assert.equal(
      getInsertBoundValue(statement, "attribution_status"),
      "matched"
    );
  }
);

test(
  "unmatched trip_sub1 remains unmatched through full service path",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({
        rows: [bookingRow({ tripSub1: "unknown_key" })]
      })
    );

    assert.equal(result.import_status, "completed");

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "trip_sub1"),
      "unknown_key"
    );
    assert.equal(
      getInsertBoundValue(statement, "attributed_publisher_id"),
      null
    );
    assert.equal(
      getInsertBoundValue(statement, "attributed_placement"),
      null
    );
    assert.equal(
      getInsertBoundValue(statement, "attribution_status"),
      "unmatched"
    );
  }
);

test(
  "missing trip_sub1 remains missing through full service path",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({
        rows: [bookingRow({ tripSub1: null })]
      })
    );

    assert.equal(result.import_status, "completed");

    const statement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(statement, "attributed_publisher_id"),
      null
    );
    assert.equal(
      getInsertBoundValue(statement, "attributed_placement"),
      null
    );
    assert.equal(
      getInsertBoundValue(statement, "attribution_status"),
      "missing_trip_sub1"
    );
    assert.equal(
      getInsertBoundValue(statement, "trip_sub1"),
      null
    );
  }
);

test(
  "wrong booking report_type propagates route error",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripBookingImport(
          database,
          bookingInput({ report_type: "commission" })
        ),
      /Invalid Trip import preparation route/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "wrong commission report_type propagates route error",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripCommissionImport(
          database,
          commissionInput({ report_type: "booking" })
        ),
      /Invalid Trip import preparation route/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "wrong source propagates route error",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripBookingImport(
          database,
          bookingInput({ source: "booking.com" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "placement read error propagates exact sentinel",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const sentinel = new Error("placement read failed");

    const database = makeServiceFake({
      placementReadError: sentinel
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.ingestionRunReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "invalid D1 result shape from placement loader propagates exact error",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: {}
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      /Invalid D1 result: publisher_placements/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "malformed D1 placement row propagates existing validation error",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: {
        results: [
          placementRow(
            "flightflex_flights_yyz_bjs_test",
            "flightflex",
            "placement-a"
          ),
          { ...placementRow("key2", "pub", "p2"), supplier: "other" }
        ]
      }
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      /Invalid publisher placement candidate: supplier/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate D1 placement key propagates existing error",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: {
        results: [
          placementRow("dup-key", "p1", "placement-1"),
          placementRow("dup-key", "p2", "placement-2")
        ]
      }
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      /Duplicate publisher placement tracking key: dup-key/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate booking source record key fails before prepared orchestrator writes",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripBookingImport(
          database,
          bookingInput({
            rows: [bookingRow(), bookingRow()],
            new_fact_ids: ["f1", "f2"]
          })
        ),
      /Duplicate booking record key/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "duplicate commission source record key fails before prepared orchestrator writes",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripCommissionImport(
          database,
          commissionInput({
            rows: [commissionRow(), commissionRow()],
            new_fact_ids: ["f1", "f2"]
          })
        ),
      /Duplicate commission record key/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "invalid fact IDs fail before prepared orchestrator writes",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripBookingImport(
          database,
          bookingInput({ new_fact_ids: ["fact-dup", "fact-dup"], rows: [
            bookingRow(),
            bookingRow({ orderId: "BOOKING-002" })
          ] })
        ),
      /Invalid Trip import preparation fact ids/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "invalid context fails before prepared orchestrator writes",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT
    });

    await assert.rejects(
      () =>
        executeTripBookingImport(
          database,
          bookingInput({
            context: { ...SERVICE_CONTEXT, ingestion_run_id: "  " }
          })
        ),
      /Invalid Trip import preparation context/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "exact duplicate booking source file performs placement read but zero fact reads/writes",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const input = bookingInput();
    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: input.source,
        report_type: input.report_type,
        source_file_sha256: sourceFileSha256
      }
    });

    const result = await executeTripBookingImport(database, input);

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "exact duplicate commission source file performs placement read but zero fact reads/writes",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const input = commissionInput();
    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: input.source,
        report_type: input.report_type,
        source_file_sha256: sourceFileSha256
      }
    });

    const result = await executeTripCommissionImport(database, input);

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "full 3-row booking import: insert, update, unchanged",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const rows = [
      bookingRow({ tripSub1: "flightflex_flights_yyz_bjs_test" }),
      bookingRow({ orderId: "BOOKING-002", tripSub1: "unknown_key" }),
      bookingRow({ orderId: "BOOKING-003", tripSub1: null })
    ];

    const prepared = await prepareTripBookingImport({
      ...bookingInput({ rows, new_fact_ids: ["f1", "f2", "f3"] }),
      placement_rows: PLACEMENT_RESULT.results
    });

    const row2 = prepared.normalized_rows[1];
    const row3 = prepared.normalized_rows[2];

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      bookingFactsByKey: {
        [row2.source_record_key]: {
          booking_fact_id: "fact-bk-2",
          source_record_key: row2.source_record_key,
          source_row_hash: "different-hash-2",
          attributed_publisher_id: null,
          attributed_placement: null,
          attribution_status: "unmatched"
        },
        [row3.source_record_key]: {
          booking_fact_id: "fact-bk-3",
          source_record_key: row3.source_record_key,
          source_row_hash: row3.source_row_hash,
          attributed_publisher_id: row3.attributed_publisher_id,
          attributed_placement: row3.attributed_placement,
          attribution_status: row3.attribution_status
        }
      },
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({
        rows,
        new_fact_ids: ["f1", "f2", "f3"]
      })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 3);
    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");

    assert.equal(database.__calls.batchCalls, 1);
    assert.equal(database.__calls.factReads.length, 3);
  }
);

test(
  "full 3-row commission import: insert, update, unchanged",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const rows = [
      commissionRow({ tripSub1: "flightflex_flights_yyz_bjs_test" }),
      commissionRow({ orderId: "BOOKING-002", tripSub1: "unknown_key" }),
      commissionRow({ orderId: "BOOKING-003", tripSub1: null })
    ];

    const prepared = await prepareTripCommissionImport({
      ...commissionInput({ rows, new_fact_ids: ["f1", "f2", "f3"] }),
      placement_rows: PLACEMENT_RESULT.results
    });

    const row2 = prepared.normalized_rows[1];
    const row3 = prepared.normalized_rows[2];

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      commissionFactsByKey: {
        [row2.commission_record_key]: {
          commission_fact_id: "fact-ck-2",
          commission_record_key: row2.commission_record_key,
          source_row_hash: "different-hash-2",
          attributed_publisher_id: null,
          attributed_placement: null,
          attribution_status: "unmatched"
        },
        [row3.commission_record_key]: {
          commission_fact_id: "fact-ck-3",
          commission_record_key: row3.commission_record_key,
          source_row_hash: row3.source_row_hash,
          attributed_publisher_id: row3.attributed_publisher_id,
          attributed_placement: row3.attributed_placement,
          attribution_status: row3.attribution_status
        }
      },
      batchResult: { success: true }
    });

    const result = await executeTripCommissionImport(
      database,
      commissionInput({
        rows,
        new_fact_ids: ["f1", "f2", "f3"]
      })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 3);
    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");

    assert.equal(database.__calls.batchCalls, 1);
    assert.equal(database.__calls.factReads.length, 3);
  }
);

test(
  "all reads occur before the one atomic batch",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const rows = [
      bookingRow(),
      bookingRow({ orderId: "BOOKING-002", tripSub1: "unknown_key" })
    ];

    const prepared = await prepareTripBookingImport({
      ...bookingInput({ rows, new_fact_ids: ["f1", "f2"] }),
      placement_rows: PLACEMENT_RESULT.results
    });

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImport(
      database,
      bookingInput({
        rows,
        new_fact_ids: ["f1", "f2"]
      })
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 2);
    assert.equal(database.__calls.batchCalls, 1);

    const callOrder = database.__calls.callOrder;

    assert.deepEqual(callOrder, [
      "placement_read",
      "ingestion_run_read",
      `booking_fact_read:${prepared.normalized_rows[0].source_record_key}`,
      `booking_fact_read:${prepared.normalized_rows[1].source_record_key}`,
      "batch"
    ]);

    assert.equal(callOrder[0], "placement_read");
    assert.equal(callOrder[callOrder.length - 1], "batch");
    assert.equal(
      callOrder.filter((event) => event === "batch").length,
      1
    );
  }
);

test(
  "zero-row booking import: placement read, ledger-only batch, completed",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({ rows: [], new_fact_ids: [] })
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 1);
    assert.equal(database.__calls.batchStatements[0].length, 1);

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 0);
  }
);

test(
  "zero-row commission import: placement read, ledger-only batch, completed",
  async () => {
    const { executeTripCommissionImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripCommissionImport(
      database,
      commissionInput({ rows: [], new_fact_ids: [] })
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 1);
    assert.equal(database.__calls.batchStatements[0].length, 1);

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 0);
  }
);

test(
  "current-fact read error propagates unchanged",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const sentinel = new Error("fact read failed");

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      factReadErrorAt: 0,
      factReadError: sentinel
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "batch error propagates unchanged",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const sentinel = new Error("batch failed");

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchError: sentinel
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "concurrency unique-constraint sentinel propagates unchanged with no retry",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const sentinel = new Error(
      "UNIQUE constraint failed: report_ingestion_runs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: null,
      batchError: sentinel
    });

    await assert.rejects(
      () => executeTripBookingImport(database, bookingInput()),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.placementReads.length, 1);
    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "completed result has exactly import_status/ingestion_run_id/ledger_plan",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({ rows: [], new_fact_ids: [] })
    );

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
    assert.equal(result.import_status, "completed");
  }
);

test(
  "duplicate result has exactly import_status/ingestion_run_id/ledger_plan",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const input = bookingInput();
    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-dup",
        source: input.source,
        report_type: input.report_type,
        source_file_sha256: sourceFileSha256
      }
    });

    const result = await executeTripBookingImport(database, input);

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
    assert.equal(result.import_status, "duplicate");
    assert.equal(result.ledger_plan, null);
  }
);

test(
  "caller input remains unmodified",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const input = bookingInput({
      rows: [bookingRow(), bookingRow({ orderId: "BOOKING-002", tripSub1: "unknown_key" })],
      new_fact_ids: ["f1", "f2"],
      placement_rows: [
        placementRow(
          "flightflex_flights_yyz_bjs_test",
          "evil-publisher",
          "evil-placement"
        )
      ]
    });

    const snapshot = JSON.stringify(input);

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImport(database, input);

    assert.equal(JSON.stringify(input), snapshot);
  }
);

test(
  "no run() or exec() calls occur",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeTripBookingImport(database, bookingInput());

    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
  }
);

test(
  "caller-supplied fact ID and ingestion context are preserved in batch statements",
  async () => {
    const { executeTripBookingImport } = await import(
      "../reporting-importer-service-v0.1.mjs"
    );

    const newFactId = "fact-service-preserved-001";

    const context = {
      ingestion_run_id: "run-service-preserved-001",
      started_at: "2026-08-22T10:00:00.000Z",
      observed_at: "2026-08-22T10:05:00.000Z"
    };

    const database = makeServiceFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeTripBookingImport(
      database,
      bookingInput({
        new_fact_ids: [newFactId],
        context
      })
    );

    assert.equal(result.import_status, "completed");

    const factStatement = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(
      getInsertBoundValue(factStatement, "booking_fact_id"),
      newFactId
    );
    assert.equal(
      getInsertBoundValue(factStatement, "first_ingestion_run_id"),
      context.ingestion_run_id
    );
    assert.equal(
      getInsertBoundValue(factStatement, "last_ingestion_run_id"),
      context.ingestion_run_id
    );

    const ledgerStatement = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(
      getInsertBoundValue(ledgerStatement, "ingestion_run_id"),
      context.ingestion_run_id
    );
    assert.equal(
      getInsertBoundValue(ledgerStatement, "started_at"),
      context.started_at
    );
    assert.equal(
      getInsertBoundValue(ledgerStatement, "completed_at"),
      context.observed_at
    );
  }
);
