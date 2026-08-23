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

function makeCommandFake(config = {}) {
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
  "command-report-v0.1\n"
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

function bookingPayload(overrides = {}) {
  return {
    aid: "10021103",
    source_filename: "booking-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: FILE_BYTES,
    rows: [bookingRow()],
    ...overrides
  };
}

function commissionPayload(overrides = {}) {
  return {
    aid: "10021103",
    source_filename: "commission-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: FILE_BYTES,
    rows: [commissionRow()],
    ...overrides
  };
}

function bookingCommand(payloadOverrides = {}) {
  return {
    command_type: "trip.booking.import",
    payload: bookingPayload(payloadOverrides)
  };
}

function commissionCommand(payloadOverrides = {}) {
  return {
    command_type: "trip.commission.import",
    payload: commissionPayload(payloadOverrides)
  };
}

const ONE_ROW_IDS = ["run-1", "fact-1"];
const ONE_ROW_TIMESTAMPS = ["t-start", "t-end"];

test(
  "null command rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          null,
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command/
    );
  }
);

test(
  "array command rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          [],
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command/
    );
  }
);

test(
  "missing payload rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          { command_type: "trip.booking.import" },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command/
    );
  }
);

test(
  "null payload rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          { command_type: "trip.booking.import", payload: null },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command/
    );
  }
);

test(
  "array payload rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          { command_type: "trip.booking.import", payload: [] },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command/
    );
  }
);

test(
  "rows must be array",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          {
            command_type: "trip.booking.import",
            payload: bookingPayload({ rows: "not-an-array" })
          },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command/
    );
  }
);

test(
  "unsupported command_type rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          { command_type: "trip.hotel.import", payload: bookingPayload() },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command type/
    );
  }
);

test(
  "almost-matching booking command rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          { command_type: "trip.booking.import ", payload: bookingPayload() },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command type/
    );
  }
);

test(
  "almost-matching commission command rejected",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          {},
          { command_type: "trip.commission.importx", payload: commissionPayload() },
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      /Invalid internal Trip import command type/
    );
  }
);

test(
  "booking command full happy path",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(result.ingestion_run_id, "run-1");
    assert.equal(result.ledger_plan.rows_seen, 1);
    assert.equal(result.ledger_plan.rows_inserted, 1);
  }
);

test(
  "commission command full happy path",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeInternalTripImportCommand(
      database,
      commissionCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(result.ingestion_run_id, "run-1");
    assert.equal(result.ledger_plan.rows_seen, 1);
    assert.equal(result.ledger_plan.rows_inserted, 1);
  }
);

test(
  "booking command reaches real downstream stack",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(database.__calls.placementReads, 1);
    assert.equal(database.__calls.ingestionRunReads, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.factReads[0].kind, "booking");
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "commission command reaches real downstream stack",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const result = await executeInternalTripImportCommand(
      database,
      commissionCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");
    assert.equal(database.__calls.placementReads, 1);
    assert.equal(database.__calls.ingestionRunReads, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.factReads[0].kind, "commission");
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "booking command produces authoritative source and report_type",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(getInsertBoundValue(ledger, "source"), "trip.com");
    assert.equal(getInsertBoundValue(ledger, "report_type"), "booking");
  }
);

test(
  "commission command produces authoritative source and report_type",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      commissionCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(getInsertBoundValue(ledger, "source"), "trip.com");
    assert.equal(getInsertBoundValue(ledger, "report_type"), "commission");
  }
);

test(
  "malicious command-level source and report_type are ignored",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand();
    command.source = "evil-command-source";
    command.report_type = "commission";

    await executeInternalTripImportCommand(
      database,
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(getInsertBoundValue(ledger, "source"), "trip.com");
    assert.equal(getInsertBoundValue(ledger, "report_type"), "booking");
  }
);

test(
  "malicious payload-level source and report_type are ignored",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand({
      source: "evil-payload-source",
      report_type: "commission"
    });

    await executeInternalTripImportCommand(
      database,
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(getInsertBoundValue(ledger, "source"), "trip.com");
    assert.equal(getInsertBoundValue(ledger, "report_type"), "booking");
  }
);

test(
  "malicious payload new_fact_ids are stripped",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand({
      new_fact_ids: ["evil-fact-id"]
    });

    await executeInternalTripImportCommand(
      database,
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    const persisted = getInsertBoundValue(fact, "booking_fact_id");

    assert.equal(persisted, "fact-1");
    assert.notEqual(persisted, "evil-fact-id");
  }
);

test(
  "malicious payload context is stripped",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand({
      context: {
        ingestion_run_id: "evil-run",
        started_at: "evil-start",
        observed_at: "evil-observed"
      }
    });

    await executeInternalTripImportCommand(
      database,
      command,
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
    assert.equal(getInsertBoundValue(ledger, "started_at"), "t-start");
    assert.equal(getInsertBoundValue(ledger, "completed_at"), "t-end");
  }
);

test(
  "malicious payload ingestion_run_id is stripped",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand({
      ingestion_run_id: "evil-run-2"
    });

    await executeInternalTripImportCommand(
      database,
      command,
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
  }
);

test(
  "malicious payload started_at is stripped",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand({
      started_at: "evil-start-2"
    });

    await executeInternalTripImportCommand(
      database,
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "started_at"
    );

    assert.equal(getInsertBoundValue(ledger, "started_at"), "t-start");
  }
);

test(
  "malicious payload observed_at is stripped",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = bookingCommand({
      observed_at: "evil-observed-2"
    });

    await executeInternalTripImportCommand(
      database,
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "completed_at"
    );

    assert.equal(getInsertBoundValue(ledger, "completed_at"), "t-end");
  }
);

test(
  "generated runtime booking fact ID reaches actual booking INSERT",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(getInsertBoundValue(fact, "booking_fact_id"), "fact-1");
  }
);

test(
  "generated runtime commission fact ID reaches actual commission INSERT",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      commissionCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "commission_fact_id"
    );

    assert.equal(
      getInsertBoundValue(fact, "commission_fact_id"),
      "fact-1"
    );
  }
);

test(
  "generated runtime ingestion_run_id reaches actual ledger INSERT",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
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
  }
);

test(
  "generated runtime timestamps reach actual ledger and fact persistence",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "started_at"
    );

    assert.equal(getInsertBoundValue(ledger, "started_at"), "t-start");
    assert.equal(getInsertBoundValue(ledger, "completed_at"), "t-end");

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(getInsertBoundValue(fact, "first_seen_at"), "t-end");
    assert.equal(getInsertBoundValue(fact, "last_seen_at"), "t-end");
  }
);

test(
  "payload.rows exact reference reaches downstream unchanged",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const row = bookingRow();
    const rows = [row];

    const command = bookingCommand({ rows });

    await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(command.payload.rows, rows);
    assert.equal(command.payload.rows[0], row);
  }
);

test(
  "payload.file_bytes exact reference reaches downstream unchanged",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const command = bookingCommand();

    await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(command.payload.file_bytes, FILE_BYTES);
  }
);

test(
  "file_bytes produces expected source_file_sha256",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
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
  "caller command remains unmodified",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const command = bookingCommand();

    const snapshot = JSON.stringify(command);

    await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(JSON.stringify(command), snapshot);
  }
);

test(
  "caller payload remains unmodified",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const command = bookingCommand();

    const snapshot = JSON.stringify(command.payload);

    await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(JSON.stringify(command.payload), snapshot);
  }
);

test(
  "row objects remain unmodified",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const row = bookingRow();

    const snapshot = JSON.stringify(row);

    const command = bookingCommand({ rows: [row] });

    await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(JSON.stringify(row), snapshot);
  }
);

test(
  "booking runtime downstream error propagates exact sentinel",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sentinel = new Error("booking-downstream-boom");

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          makeCommandFake({
            placementResult: PLACEMENT_RESULT,
            batchError: sentinel
          }),
          bookingCommand(),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      (error) => error === sentinel
    );
  }
);

test(
  "commission runtime downstream error propagates exact sentinel",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sentinel = new Error("commission-downstream-boom");

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          makeCommandFake({
            placementResult: PLACEMENT_RESULT,
            batchError: sentinel
          }),
          commissionCommand(),
          makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
        ),
      (error) => error === sentinel
    );
  }
);

test(
  "booking duplicate source file returns exact duplicate result",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: "trip.com",
        report_type: "booking",
        source_file_sha256: sourceFileSha256
      }
    });

    const result = await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });
  }
);

test(
  "commission duplicate source file returns exact duplicate result",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: "trip.com",
        report_type: "commission",
        source_file_sha256: sourceFileSha256
      }
    });

    const result = await executeInternalTripImportCommand(
      database,
      commissionCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });
  }
);

test(
  "duplicate booking still follows existing runtime generation semantics",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeCommandFake({
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

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      runtime
    );

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
  "duplicate commission still follows existing runtime generation semantics",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const database = makeCommandFake({
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

    await executeInternalTripImportCommand(
      database,
      commissionCommand(),
      runtime
    );

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
  "completed result exact three keys",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const result = await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        batchResult: { success: true }
      }),
      bookingCommand(),
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
  "duplicate result exact three keys",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const sourceFileSha256 = await computeSourceFileSha256(FILE_BYTES);

    const result = await executeInternalTripImportCommand(
      makeCommandFake({
        placementResult: PLACEMENT_RESULT,
        existingIngestionRun: {
          ingestion_run_id: "run-already-imported",
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: sourceFileSha256
        }
      }),
      bookingCommand(),
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
  "invalid command type causes zero runtime generator calls and zero D1 operations",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const runtime = makeRuntime({
      ids: ONE_ROW_IDS,
      timestamps: ONE_ROW_TIMESTAMPS
    });

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(
          database,
          { command_type: "trip.hotel.import", payload: bookingPayload() },
          runtime
        ),
      /Invalid internal Trip import command type/
    );

    assert.equal(runtime.__calls.length, 0);
    assert.equal(database.__calls.placementReads, 0);
    assert.equal(database.__calls.ingestionRunReads, 0);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "malformed command causes zero runtime generator calls and zero D1 operations",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const runtime = makeRuntime({
      ids: ONE_ROW_IDS,
      timestamps: ONE_ROW_TIMESTAMPS
    });

    await assert.rejects(
      () =>
        executeInternalTripImportCommand(database, null, runtime),
      /Invalid internal Trip import command/
    );

    assert.equal(runtime.__calls.length, 0);
    assert.equal(database.__calls.placementReads, 0);
    assert.equal(database.__calls.ingestionRunReads, 0);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "no direct run() or exec() calls",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    await executeInternalTripImportCommand(
      database,
      bookingCommand(),
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
  }
);

test(
  "malicious command and payload metadata cannot reach persistence",
  async () => {
    const { executeInternalTripImportCommand } = await import(
      "../reporting-importer-command-v0.1.mjs"
    );

    const database = makeCommandFake({
      placementResult: PLACEMENT_RESULT,
      batchResult: { success: true }
    });

    const command = {
      command_type: "trip.booking.import",
      source: "evil-command-source",
      report_type: "commission",
      context: { ingestion_run_id: "evil-command-run" },
      payload: {
        aid: "10021103",
        source_filename: "booking-report.csv",
        report_period_from: "2026-08-01",
        report_period_to: "2026-08-20",
        file_bytes: FILE_BYTES,
        rows: [bookingRow()],
        source: "evil-payload-source",
        report_type: "commission",
        new_fact_ids: ["evil-fact-id"],
        context: {
          ingestion_run_id: "evil-run",
          started_at: "evil-start",
          observed_at: "evil-observed"
        },
        ingestion_run_id: "evil-run-2",
        started_at: "evil-start-2",
        observed_at: "evil-observed-2"
      }
    };

    const result = await executeInternalTripImportCommand(
      database,
      command,
      makeRuntime({ ids: ONE_ROW_IDS, timestamps: ONE_ROW_TIMESTAMPS })
    );

    assert.equal(result.import_status, "completed");

    const ledger = findInsertStatement(
      database.__calls.batchStatements,
      "ingestion_run_id"
    );

    assert.equal(getInsertBoundValue(ledger, "source"), "trip.com");
    assert.equal(getInsertBoundValue(ledger, "report_type"), "booking");
    assert.equal(
      getInsertBoundValue(ledger, "ingestion_run_id"),
      "run-1"
    );
    assert.equal(getInsertBoundValue(ledger, "started_at"), "t-start");
    assert.equal(getInsertBoundValue(ledger, "completed_at"), "t-end");

    const fact = findInsertStatement(
      database.__calls.batchStatements,
      "booking_fact_id"
    );

    assert.equal(getInsertBoundValue(fact, "booking_fact_id"), "fact-1");
    assert.equal(
      getInsertBoundValue(fact, "first_ingestion_run_id"),
      "run-1"
    );

    const allValues = database.__calls.batchStatements[0].flatMap(
      (statement) => statement.__boundValues
    );

    const evilValues = [
      "evil-command-source",
      "evil-payload-source",
      "evil-fact-id",
      "evil-run",
      "evil-run-2",
      "evil-start",
      "evil-start-2",
      "evil-observed",
      "evil-observed-2",
      "evil-command-run"
    ];

    for (const evil of evilValues) {
      assert.ok(
        !allValues.includes(evil),
        `evil value must not reach persistence: ${evil}`
      );
    }
  }
);
