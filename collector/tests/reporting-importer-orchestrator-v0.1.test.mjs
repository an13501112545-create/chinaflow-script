import test from "node:test";
import assert from "node:assert/strict";

function makeOrchestratorFake(config = {}) {
  const calls = {
    ingestionRunReads: [],
    factReads: [],
    batchCalls: 0,
    batchStatements: [],
    runCalls: 0,
    execCalls: 0,
    preparedSql: [],
    bindValues: []
  };

  const database = {
    __calls: calls,

    prepare(sql) {
      calls.preparedSql.push(sql);

      let boundValues = [];

      const statement = {
        bind(...values) {
          boundValues = values;
          calls.bindValues.push(values);
          return statement;
        },

        first() {
          const sqlUpper = sql.toUpperCase();

          if (sqlUpper.includes("REPORT_INGESTION_RUNS")) {
            calls.ingestionRunReads.push(boundValues);

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

            if (calls.factReads.length - 1 === config.factReadErrorAt) {
              throw config.factReadError;
            }

            const map = config.commissionFactsByKey ?? {};

            return Object.prototype.hasOwnProperty.call(map, key)
              ? map[key]
              : null;
          }

          throw new Error("Unexpected D1 read SQL");
        },

        all() {
          return config.allResult;
        }
      };

      return statement;
    },

    run() {
      calls.runCalls += 1;
      return config.runResult;
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

    exec() {
      calls.execCalls += 1;
      return config.execResult;
    }
  };

  return database;
}

const ORCHESTRATOR_CONTEXT = {
  ingestion_run_id: "run-orchestrator-001",
  started_at: "2026-08-22T00:00:00.000Z",
  observed_at: "2026-08-22T00:05:00.000Z"
};

function bookingRow(index) {
  return {
    source_record_key: `bk-${index}`,
    source_row_hash: `hash-${index}`,
    source: "trip.com",
    source_order_id: `BOOKING-00${index}`,
    aid: "10021103",
    sid: "123456",
    sid_name: "sid-name",
    trip_sub1: "flightflex_flights_yyz_bjs_test",
    trip_sub3: "sub3",
    attributed_publisher_id: "flightflex",
    attributed_placement: "placement-a",
    attribution_status: "matched",
    raw_product_line: "htl",
    normalized_product: "hotel",
    raw_order_status: "S",
    normalized_order_status: "successful",
    booking_amount_raw: "100.00",
    booking_amount_micros: 100000000,
    currency: null,
    order_date: "2026-08-01",
    product_start_date: "2026-08-05",
    product_end_date: "2026-08-08",
    booking_window: 3,
    departure_city: "YYZ",
    departure_country: "CA",
    arrival_city: "BJS",
    arrival_country: "CN",
    order_platform: "web",
    booker_region: "CA",
    ouid: "ouid-1"
  };
}

function commissionRow(index) {
  return {
    commission_record_key: `ck-${index}`,
    source_row_hash: `hash-${index}`,
    source: "trip.com",
    source_order_id: `BOOKING-00${index}`,
    aid: "10021103",
    sid: "123456",
    sid_name: "sid-name",
    trip_sub1: "flightflex_flights_yyz_bjs_test",
    trip_sub3: "sub3",
    attributed_publisher_id: "flightflex",
    attributed_placement: "placement-a",
    attribution_status: "matched",
    raw_product_line: "htl",
    normalized_product: "hotel",
    sub_order_type: "sub-order-type",
    raw_order_status: "S",
    normalized_order_status: "successful",
    raw_commission_status: "SETTLED",
    normalized_commission_status: "settled",
    booking_amount_raw: "200.00",
    booking_amount_micros: 200000000,
    commission_amount_raw: "-5.00",
    commission_amount_micros: -5000000,
    currency: null,
    commission_month: "2026-08",
    order_date: "2026-08-01",
    check_out_or_issue_date: "2026-08-08",
    ratio_raw: "0.05",
    plan_type: "standard",
    region: "CA",
    ouid: "ouid-1"
  };
}

function bookingExistingFact(index, row, overrides = {}) {
  return {
    booking_fact_id: `fact-bk-${index}`,
    source_record_key: row.source_record_key,
    source_row_hash: row.source_row_hash,
    attributed_publisher_id: row.attributed_publisher_id,
    attributed_placement: row.attributed_placement,
    attribution_status: row.attribution_status,
    ...overrides
  };
}

function commissionExistingFact(index, row, overrides = {}) {
  return {
    commission_fact_id: `fact-ck-${index}`,
    commission_record_key: row.commission_record_key,
    source_row_hash: row.source_row_hash,
    attributed_publisher_id: row.attributed_publisher_id,
    attributed_placement: row.attributed_placement,
    attribution_status: row.attribution_status,
    ...overrides
  };
}

function bookingRowContexts(actions) {
  return actions.map((action, index) => {
    if (action === "insert") {
      return {
        new_fact_id: `nf-${index}`,
        raw_payload_json: `{"raw":${index}}`
      };
    }

    if (action === "update") {
      return { raw_payload_json: `{"raw":${index}}` };
    }

    return {};
  });
}

function commissionRowContexts(actions) {
  return actions.map((action, index) => {
    if (action === "insert") {
      return {
        new_fact_id: `nf-${index}`,
        raw_payload_json: `{"raw":${index}}`
      };
    }

    if (action === "update") {
      return { raw_payload_json: `{"raw":${index}}` };
    }

    return {};
  });
}

async function makePreflight(overrides = {}) {
  const { createIngestionRunPreflight } = await import(
    "../reporting-importer-core-v0.1.mjs"
  );

  return createIngestionRunPreflight({
    source: "trip.com",
    report_type: "booking",
    source_filename: "booking-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: new TextEncoder().encode(
      "orchestrator-report-v0.1\n"
    ),
    rows_seen: 3,
    ...overrides
  });
}

test(
  "booking import rejects non-array normalizedRows before reads",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({});
    const preflight = await makePreflight({ rows_seen: 0 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          "not-an-array",
          [],
          ORCHESTRATOR_CONTEXT
        ),
      /Invalid prepared import input/
    );

    assert.equal(database.__calls.ingestionRunReads.length, 0);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "booking import rejects non-array rowContexts before reads",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({});
    const preflight = await makePreflight({ rows_seen: 0 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [],
          "not-an-array",
          ORCHESTRATOR_CONTEXT
        ),
      /Invalid prepared import input/
    );

    assert.equal(database.__calls.ingestionRunReads.length, 0);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "commission import rejects malformed inputs",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({});
    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 0
    });

    await assert.rejects(
      () =>
        executePreparedCommissionImport(
          database,
          preflight,
          null,
          [],
          ORCHESTRATOR_CONTEXT
        ),
      /Invalid prepared import input/
    );

    await assert.rejects(
      () =>
        executePreparedCommissionImport(
          database,
          preflight,
          [],
          null,
          ORCHESTRATOR_CONTEXT
        ),
      /Invalid prepared import input/
    );
  }
);

test(
  "booking import rejects row count mismatches",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({});
    const row = bookingRow(1);
    const preflight = await makePreflight({ rows_seen: 1 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [],
          [{}],
          ORCHESTRATOR_CONTEXT
        ),
      /Prepared import row count mismatch/
    );

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [row],
          [],
          ORCHESTRATOR_CONTEXT
        ),
      /Prepared import row count mismatch/
    );

    assert.equal(database.__calls.ingestionRunReads.length, 0);
  }
);

test(
  "commission import rejects row count mismatches",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({});
    const row = commissionRow(1);
    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 2
    });

    await assert.rejects(
      () =>
        executePreparedCommissionImport(
          database,
          preflight,
          [row],
          [{}],
          ORCHESTRATOR_CONTEXT
        ),
      /Prepared import row count mismatch/
    );

    assert.equal(database.__calls.ingestionRunReads.length, 0);
  }
);

test(
  "booking duplicate source file short-circuits with no fact reads or writes",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 3 });

    const database = makeOrchestratorFake({
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: preflight.source,
        report_type: preflight.report_type,
        source_file_sha256: preflight.source_file_sha256
      }
    });

    const result = await executePreparedBookingImport(
      database,
      preflight,
      [bookingRow(1), bookingRow(2), bookingRow(3)],
      bookingRowContexts(["insert", "insert", "insert"]),
      ORCHESTRATOR_CONTEXT
    );

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "commission duplicate source file short-circuits with no fact reads or writes",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 3
    });

    const database = makeOrchestratorFake({
      existingIngestionRun: {
        ingestion_run_id: "run-already-imported",
        source: preflight.source,
        report_type: preflight.report_type,
        source_file_sha256: preflight.source_file_sha256
      }
    });

    const result = await executePreparedCommissionImport(
      database,
      preflight,
      [commissionRow(1), commissionRow(2), commissionRow(3)],
      commissionRowContexts(["insert", "insert", "insert"]),
      ORCHESTRATOR_CONTEXT
    );

    assert.deepEqual(result, {
      import_status: "duplicate",
      ingestion_run_id: "run-already-imported",
      ledger_plan: null
    });

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "booking new import reads facts in order, plans, and batches once",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const rows = [bookingRow(1), bookingRow(2), bookingRow(3)];
    const actions = ["insert", "update", "unchanged"];

    const database = makeOrchestratorFake({
      bookingFactsByKey: {
        "bk-2": bookingExistingFact(2, rows[1], {
          source_row_hash: "hash-old-2"
        }),
        "bk-3": bookingExistingFact(3, rows[2])
      },
      batchResult: { success: true }
    });

    const preflight = await makePreflight({ rows_seen: 3 });

    const result = await executePreparedBookingImport(
      database,
      preflight,
      rows,
      bookingRowContexts(actions),
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 3);
    assert.deepEqual(
      database.__calls.factReads.map((r) => r.key),
      ["bk-1", "bk-2", "bk-3"]
    );
    assert.equal(database.__calls.batchCalls, 1);

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
    assert.equal(result.import_status, "completed");
    assert.equal(
      result.ingestion_run_id,
      ORCHESTRATOR_CONTEXT.ingestion_run_id
    );
    assert.equal(
      result.ledger_plan.ingestion_run_id,
      ORCHESTRATOR_CONTEXT.ingestion_run_id
    );
    assert.equal(result.ledger_plan.rows_seen, 3);
    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");
  }
);

test(
  "commission new import reads facts in order, plans, and batches once",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const rows = [commissionRow(1), commissionRow(2), commissionRow(3)];
    const actions = ["insert", "update", "unchanged"];

    const database = makeOrchestratorFake({
      commissionFactsByKey: {
        "ck-2": commissionExistingFact(2, rows[1], {
          source_row_hash: "hash-old-2"
        }),
        "ck-3": commissionExistingFact(3, rows[2])
      },
      batchResult: { success: true }
    });

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 3
    });

    const result = await executePreparedCommissionImport(
      database,
      preflight,
      rows,
      commissionRowContexts(actions),
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 3);
    assert.deepEqual(
      database.__calls.factReads.map((r) => r.key),
      ["ck-1", "ck-2", "ck-3"]
    );
    assert.equal(database.__calls.batchCalls, 1);

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 3);
    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");
  }
);

test(
  "booking 3-row existing-fact alignment stays index-aligned",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const rows = [bookingRow(1), bookingRow(2), bookingRow(3)];

    const database = makeOrchestratorFake({
      bookingFactsByKey: {
        "bk-2": bookingExistingFact(2, rows[1], {
          source_row_hash: "hash-old-2"
        }),
        "bk-3": bookingExistingFact(3, rows[2])
      },
      batchResult: { success: true }
    });

    const preflight = await makePreflight({ rows_seen: 3 });

    const result = await executePreparedBookingImport(
      database,
      preflight,
      rows,
      bookingRowContexts(["insert", "update", "unchanged"]),
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);

    const statements = database.__calls.batchStatements[0];
    assert.equal(statements.length, 4);
  }
);

test(
  "commission 3-row existing-fact alignment stays index-aligned",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const rows = [commissionRow(1), commissionRow(2), commissionRow(3)];

    const database = makeOrchestratorFake({
      commissionFactsByKey: {
        "ck-2": commissionExistingFact(2, rows[1], {
          source_row_hash: "hash-old-2"
        }),
        "ck-3": commissionExistingFact(3, rows[2])
      },
      batchResult: { success: true }
    });

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 3
    });

    const result = await executePreparedCommissionImport(
      database,
      preflight,
      rows,
      commissionRowContexts(["insert", "update", "unchanged"]),
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
  }
);

test(
  "zero-row booking new import batches ledger only",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({
      batchResult: { success: true }
    });

    const preflight = await makePreflight({ rows_seen: 0 });

    const result = await executePreparedBookingImport(
      database,
      preflight,
      [],
      [],
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 1);
    assert.equal(database.__calls.batchStatements[0].length, 1);

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 0);
    assert.equal(result.ledger_plan.rows_inserted, 0);
    assert.equal(result.ledger_plan.rows_updated, 0);
    assert.equal(result.ledger_plan.rows_unchanged, 0);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");
  }
);

test(
  "zero-row commission new import batches ledger only",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({
      batchResult: { success: true }
    });

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 0
    });

    const result = await executePreparedCommissionImport(
      database,
      preflight,
      [],
      [],
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 1);
    assert.equal(database.__calls.batchStatements[0].length, 1);

    assert.equal(result.import_status, "completed");
    assert.equal(result.ledger_plan.rows_seen, 0);
  }
);

test(
  "ingestion-run read error propagates unchanged",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const sentinel = new Error("ingestion-run read failed");

    const database = makeOrchestratorFake({
      ingestionRunError: sentinel
    });

    const preflight = await makePreflight({ rows_seen: 1 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [bookingRow(1)],
          bookingRowContexts(["insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.factReads.length, 0);
    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "middle booking fact-read error propagates unchanged with no batch",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const sentinel = new Error("booking fact read failed");

    const database = makeOrchestratorFake({
      factReadErrorAt: 1,
      factReadError: sentinel
    });

    const preflight = await makePreflight({ rows_seen: 3 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [bookingRow(1), bookingRow(2), bookingRow(3)],
          bookingRowContexts(["insert", "insert", "insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.batchCalls, 0);
    assert.equal(database.__calls.factReads.length, 2);
  }
);

test(
  "middle commission fact-read error propagates unchanged with no batch",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const sentinel = new Error("commission fact read failed");

    const database = makeOrchestratorFake({
      factReadErrorAt: 1,
      factReadError: sentinel
    });

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 3
    });

    await assert.rejects(
      () =>
        executePreparedCommissionImport(
          database,
          preflight,
          [commissionRow(1), commissionRow(2), commissionRow(3)],
          commissionRowContexts(["insert", "insert", "insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "pure booking planner failure causes no batch",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const rows = [
      bookingRow(1),
      { ...bookingRow(2), source_record_key: "   " },
      bookingRow(3)
    ];

    const database = makeOrchestratorFake({
      batchResult: { success: true }
    });

    const preflight = await makePreflight({ rows_seen: 3 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          rows,
          bookingRowContexts(["insert", "insert", "insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      /Invalid booking current-state input: source_record_key/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "pure commission planner failure causes no batch",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const rows = [
      commissionRow(1),
      { ...commissionRow(2), commission_record_key: "   " },
      commissionRow(3)
    ];

    const database = makeOrchestratorFake({
      batchResult: { success: true }
    });

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 3
    });

    await assert.rejects(
      () =>
        executePreparedCommissionImport(
          database,
          preflight,
          rows,
          commissionRowContexts(["insert", "insert", "insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      /Invalid commission current-state input: commission_record_key/
    );

    assert.equal(database.__calls.batchCalls, 0);
  }
);

test(
  "booking atomic batch thrown error propagates unchanged",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const sentinel = new Error("booking batch failed");

    const database = makeOrchestratorFake({
      batchError: sentinel
    });

    const preflight = await makePreflight({ rows_seen: 1 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [bookingRow(1)],
          bookingRowContexts(["insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "commission atomic batch rejected promise propagates unchanged",
  async () => {
    const {
      executePreparedCommissionImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const sentinel = new Error("commission batch rejected");

    const database = makeOrchestratorFake({
      batchRejection: sentinel
    });

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 1
    });

    await assert.rejects(
      () =>
        executePreparedCommissionImport(
          database,
          preflight,
          [commissionRow(1)],
          commissionRowContexts(["insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "concurrency race: dedupe sees new, batch unique-constraint error propagates with no retry",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const sentinel = new Error(
      "UNIQUE constraint failed: report_ingestion_runs"
    );

    const database = makeOrchestratorFake({
      existingIngestionRun: null,
      batchError: sentinel
    });

    const preflight = await makePreflight({ rows_seen: 1 });

    await assert.rejects(
      () =>
        executePreparedBookingImport(
          database,
          preflight,
          [bookingRow(1)],
          bookingRowContexts(["insert"]),
          ORCHESTRATOR_CONTEXT
        ),
      (error) => error === sentinel
    );

    assert.equal(database.__calls.ingestionRunReads.length, 1);
    assert.equal(database.__calls.factReads.length, 1);
    assert.equal(database.__calls.batchCalls, 1);
  }
);

test(
  "completed result ledger_plan carries planner ledger values and no extra keys",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({
      batchResult: { success: true }
    });

    const preflight = await makePreflight({ rows_seen: 0 });

    const result = await executePreparedBookingImport(
      database,
      preflight,
      [],
      [],
      ORCHESTRATOR_CONTEXT
    );

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);

    assert.equal(result.import_status, "completed");
    assert.equal(
      result.ingestion_run_id,
      ORCHESTRATOR_CONTEXT.ingestion_run_id
    );
    assert.equal(
      result.ledger_plan.ingestion_run_id,
      result.ingestion_run_id
    );
    assert.equal(result.ledger_plan.status, "completed");
    assert.equal(result.ledger_plan.error_summary, null);
  }
);

test(
  "duplicate result ledger_plan is exactly null with no extra keys",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 1 });

    const database = makeOrchestratorFake({
      existingIngestionRun: {
        ingestion_run_id: "run-existing",
        source: preflight.source,
        report_type: preflight.report_type,
        source_file_sha256: preflight.source_file_sha256
      }
    });

    const result = await executePreparedBookingImport(
      database,
      preflight,
      [bookingRow(1)],
      bookingRowContexts(["insert"]),
      ORCHESTRATOR_CONTEXT
    );

    assert.deepEqual(Object.keys(result), [
      "import_status",
      "ingestion_run_id",
      "ledger_plan"
    ]);
    assert.equal(result.import_status, "duplicate");
    assert.equal(result.ingestion_run_id, "run-existing");
    assert.equal(result.ledger_plan, null);
  }
);

test(
  "orchestrator does not mutate prepared inputs",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 3 });
    const rows = [bookingRow(1), bookingRow(2), bookingRow(3)];
    const contexts = bookingRowContexts([
      "insert",
      "update",
      "unchanged"
    ]);

    const preflightSnapshot = JSON.stringify(preflight);
    const rowsSnapshot = JSON.stringify(rows);
    const contextsSnapshot = JSON.stringify(contexts);
    const contextSnapshot = JSON.stringify(ORCHESTRATOR_CONTEXT);

    const database = makeOrchestratorFake({
      bookingFactsByKey: {
        "bk-2": bookingExistingFact(2, rows[1], {
          source_row_hash: "hash-old-2"
        }),
        "bk-3": bookingExistingFact(3, rows[2])
      },
      batchResult: { success: true }
    });

    await executePreparedBookingImport(
      database,
      preflight,
      rows,
      contexts,
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(JSON.stringify(preflight), preflightSnapshot);
    assert.equal(JSON.stringify(rows), rowsSnapshot);
    assert.equal(JSON.stringify(contexts), contextsSnapshot);
    assert.equal(
      JSON.stringify(ORCHESTRATOR_CONTEXT),
      contextSnapshot
    );
  }
);

test(
  "orchestrator never calls database.run or database.exec",
  async () => {
    const {
      executePreparedBookingImport
    } = await import(
      "../reporting-importer-orchestrator-v0.1.mjs"
    );

    const database = makeOrchestratorFake({
      batchResult: { success: true }
    });

    const preflight = await makePreflight({ rows_seen: 1 });

    await executePreparedBookingImport(
      database,
      preflight,
      [bookingRow(1)],
      bookingRowContexts(["insert"]),
      ORCHESTRATOR_CONTEXT
    );

    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
    assert.equal(database.__calls.batchCalls, 1);
  }
);
