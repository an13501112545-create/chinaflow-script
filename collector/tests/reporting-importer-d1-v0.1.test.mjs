import test from "node:test";
import assert from "node:assert/strict";

function makeFakeDatabase(config = {}) {
  const calls = {
    prepareSql: [],
    bindValues: [],
    readCalls: [],
    runCalls: 0,
    batchCalls: 0,
    execCalls: 0,
    statements: []
  };

  const database = {
    __calls: calls,

    prepare(sql) {
      calls.prepareSql.push(sql);

      const statement = {
        bind(...values) {
          calls.bindValues.push(values);
          return statement;
        },

        all() {
          calls.readCalls.push("all");
          return config.allResult;
        },

        first() {
          calls.readCalls.push("first");
          return config.firstResult;
        }
      };

      calls.statements.push(statement);
      return statement;
    },

    run() {
      calls.runCalls += 1;
      return config.runResult;
    },

    batch() {
      calls.batchCalls += 1;
      return config.batchResult;
    },

    exec() {
      calls.execCalls += 1;
      return config.execResult;
    }
  };

  return database;
}

test(
  "D1 loadActiveTripPublisherPlacements rejects null database",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    await assert.rejects(
      () => loadActiveTripPublisherPlacements(null),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 loadActiveTripPublisherPlacements rejects database without prepare()",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    await assert.rejects(
      () => loadActiveTripPublisherPlacements({}),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 findExistingIngestionRun rejects unavailable database",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        findExistingIngestionRun(
          null,
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc"
          }
        ),
      /D1 binding unavailable/
    );

    await assert.rejects(
      () =>
        findExistingIngestionRun(
          {},
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc"
          }
        ),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 placement lookup prepares SELECT against publisher_placements and binds trip.com,1",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        allResult: { results: [] }
      });

    await loadActiveTripPublisherPlacements(database);

    assert.equal(database.__calls.prepareSql.length, 1);
    assert.match(
      database.__calls.prepareSql[0],
      /SELECT/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /publisher_placements/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /supplier\s*=\s*\?1/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /is_active\s*=\s*\?2/i
    );

    assert.deepEqual(
      database.__calls.bindValues[0],
      ["trip.com", 1]
    );
  }
);

test(
  "D1 placement lookup uses read-only all()",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        allResult: { results: [] }
      });

    await loadActiveTripPublisherPlacements(database);

    assert.deepEqual(
      database.__calls.readCalls,
      ["all"]
    );

    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.batchCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
  }
);

test(
  "D1 placement lookup returns result.results unchanged",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const rows = [
      {
        supplier: "trip.com",
        is_active: 1,
        external_tracking_key: "key-a",
        publisher_id: "publisher-a",
        placement: "placement-a"
      }
    ];

    const database =
      makeFakeDatabase({
        allResult: {
          results: rows,
          success: true,
          meta: { duration: 1 }
        }
      });

    const result =
      await loadActiveTripPublisherPlacements(database);

    assert.equal(result, rows);
  }
);

test(
  "D1 placement lookup returns [] for empty results",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        allResult: { results: [] }
      });

    const result =
      await loadActiveTripPublisherPlacements(database);

    assert.deepEqual(result, []);
  }
);

test(
  "D1 placement lookup rejects result without results Array",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const malformedResults = [
      null,
      undefined,
      "rows",
      { rows: [] },
      123
    ];

    for (const results of malformedResults) {
      const database =
        makeFakeDatabase({
          allResult: { results }
        });

      await assert.rejects(
        () =>
          loadActiveTripPublisherPlacements(database),
        /Invalid D1 result: publisher_placements/
      );
    }
  }
);

test(
  "D1 ingestion lookup prepares SELECT against report_ingestion_runs with LIMIT 1",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    const preflight = {
      source: "trip.com",
      report_type: "booking",
      source_file_sha256: "abc123"
    };

    await findExistingIngestionRun(database, preflight);

    assert.equal(database.__calls.prepareSql.length, 1);
    assert.match(
      database.__calls.prepareSql[0],
      /SELECT/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /report_ingestion_runs/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /LIMIT\s+1/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /source\s*=\s*\?1/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /report_type\s*=\s*\?2/i
    );
    assert.match(
      database.__calls.prepareSql[0],
      /source_file_sha256\s*=\s*\?3/i
    );

    assert.deepEqual(
      database.__calls.bindValues[0],
      ["trip.com", "booking", "abc123"]
    );
  }
);

test(
  "D1 ingestion lookup binds source/report_type with spaces exactly without trimming",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    const preflight = {
      source: " trip.com ",
      report_type: " booking ",
      source_file_sha256: "abc123"
    };

    await findExistingIngestionRun(database, preflight);

    assert.deepEqual(
      database.__calls.bindValues[0],
      [" trip.com ", " booking ", "abc123"]
    );
  }
);

test(
  "D1 ingestion lookup returns null when first() returns null",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    const result =
      await findExistingIngestionRun(
        database,
        {
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: "abc123"
        }
      );

    assert.equal(result, null);
  }
);

test(
  "D1 ingestion lookup returns the same row object when first() returns a row",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const row = {
      ingestion_run_id: "run-001",
      source: "trip.com",
      report_type: "booking",
      source_file_sha256: "abc123"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const result =
      await findExistingIngestionRun(
        database,
        {
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: "abc123"
        }
      );

    assert.equal(result, row);
  }
);

test(
  "D1 ingestion lookup rejects malformed first() results",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const malformedResults = [
      [],
      "row",
      123
    ];

    for (const firstResult of malformedResults) {
      const database =
        makeFakeDatabase({
          firstResult
        });

      await assert.rejects(
        () =>
          findExistingIngestionRun(
            database,
            {
              source: "trip.com",
              report_type: "booking",
              source_file_sha256: "abc123"
            }
          ),
        /Invalid D1 result: report_ingestion_runs/
      );
    }
  }
);

test(
  "D1 integration: placement rows feed buildTripSub1PlacementMap directly",
  async () => {
    const {
      loadActiveTripPublisherPlacements
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const rows = [
      {
        supplier: "trip.com",
        is_active: 1,
        external_tracking_key:
          "flightflex_flights_yyz_bjs_test",
        publisher_id: "flightflex",
        placement:
          "flightflex_flights_yyz_bjs_test"
      }
    ];

    const database =
      makeFakeDatabase({
        allResult: { results: rows }
      });

    const placementRows =
      await loadActiveTripPublisherPlacements(database);

    const map =
      buildTripSub1PlacementMap(placementRows);

    assert.deepEqual(
      map.get("flightflex_flights_yyz_bjs_test"),
      {
        publisher_id: "flightflex",
        placement:
          "flightflex_flights_yyz_bjs_test"
      }
    );
  }
);

test(
  "D1 integration: existing run feeds planSourceFileDedupe directly",
  async () => {
    const {
      findExistingIngestionRun
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      ingestion_run_id: "run-001",
      source: "trip.com",
      report_type: "booking",
      source_file_sha256: "abc123",
      status: "completed"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const preflight = {
      source: "trip.com",
      report_type: "booking",
      source_file_sha256: "abc123"
    };

    const existingRun =
      await findExistingIngestionRun(
        database,
        preflight
      );

    const plan =
      planSourceFileDedupe(
        preflight,
        existingRun
      );

    assert.deepEqual(plan, {
      dedupe_status: "duplicate",
      should_import: false,
      existing_ingestion_run_id: "run-001"
    });
  }
);

test(
  "D1 findExistingBookingFact rejects unavailable database",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        findExistingBookingFact(null, {
          source_record_key: "booking-key"
        }),
      /D1 binding unavailable/
    );

    await assert.rejects(
      () =>
        findExistingBookingFact({}, {
          source_record_key: "booking-key"
        }),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 booking fact lookup prepares SELECT against trip_bookings with minimal columns",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    await findExistingBookingFact(database, {
      source_record_key: "booking-key"
    });

    const sql = database.__calls.prepareSql[0];

    assert.match(sql, /SELECT/i);
    assert.match(sql, /trip_bookings/i);
    assert.match(sql, /booking_fact_id/i);
    assert.match(sql, /source_record_key/i);
    assert.match(sql, /source_row_hash/i);
    assert.match(sql, /attributed_publisher_id/i);
    assert.match(sql, /attributed_placement/i);
    assert.match(sql, /attribution_status/i);
    assert.match(sql, /WHERE\s+source_record_key\s*=\s*\?1/i);
    assert.match(sql, /LIMIT\s+1/i);
  }
);

test(
  "D1 booking fact lookup binds source_record_key exactly",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    await findExistingBookingFact(database, {
      source_record_key: " booking-key "
    });

    assert.deepEqual(
      database.__calls.bindValues[0],
      [" booking-key "]
    );
  }
);

test(
  "D1 booking fact lookup returns null when first() returns null",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    const result =
      await findExistingBookingFact(database, {
        source_record_key: "booking-key"
      });

    assert.equal(result, null);
  }
);

test(
  "D1 booking fact lookup returns the same row object",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const row = {
      booking_fact_id: "fact-1",
      source_record_key: "booking-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const result =
      await findExistingBookingFact(database, {
        source_record_key: "booking-key"
      });

    assert.equal(result, row);
  }
);

test(
  "D1 booking fact lookup rejects malformed first() results",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    for (const firstResult of [[], "row", 123]) {
      const database =
        makeFakeDatabase({
          firstResult
        });

      await assert.rejects(
        () =>
          findExistingBookingFact(database, {
            source_record_key: "booking-key"
          }),
        /Invalid D1 result: trip_bookings/
      );
    }
  }
);

test(
  "D1 integration: booking fact feeds planBookingCurrentState unchanged",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      booking_fact_id: "fact-1",
      source_record_key: "booking-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const normalizedRow = {
      source_record_key: "booking-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const existingFact =
      await findExistingBookingFact(database, normalizedRow);

    const plan =
      planBookingCurrentState(normalizedRow, existingFact);

    assert.deepEqual(plan, {
      state_action: "unchanged",
      existing_fact_id: "fact-1"
    });
  }
);

test(
  "D1 integration: booking attribution-only change produces update",
  async () => {
    const {
      findExistingBookingFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      booking_fact_id: "fact-1",
      source_record_key: "booking-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const normalizedRow = {
      source_record_key: "booking-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "unmatched"
    };

    const existingFact =
      await findExistingBookingFact(database, normalizedRow);

    const plan =
      planBookingCurrentState(normalizedRow, existingFact);

    assert.deepEqual(plan, {
      state_action: "update",
      existing_fact_id: "fact-1"
    });
  }
);

test(
  "D1 findExistingCommissionFact rejects unavailable database",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        findExistingCommissionFact(null, {
          commission_record_key: "commission-key"
        }),
      /D1 binding unavailable/
    );

    await assert.rejects(
      () =>
        findExistingCommissionFact({}, {
          commission_record_key: "commission-key"
        }),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 commission fact lookup prepares SELECT against trip_commissions with minimal columns",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    await findExistingCommissionFact(database, {
      commission_record_key: "commission-key"
    });

    const sql = database.__calls.prepareSql[0];

    assert.match(sql, /SELECT/i);
    assert.match(sql, /trip_commissions/i);
    assert.match(sql, /commission_fact_id/i);
    assert.match(sql, /commission_record_key/i);
    assert.match(sql, /source_row_hash/i);
    assert.match(sql, /attributed_publisher_id/i);
    assert.match(sql, /attributed_placement/i);
    assert.match(sql, /attribution_status/i);
    assert.match(
      sql,
      /WHERE\s+commission_record_key\s*=\s*\?1/i
    );
    assert.match(sql, /LIMIT\s+1/i);
  }
);

test(
  "D1 commission fact lookup binds commission_record_key exactly",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    await findExistingCommissionFact(database, {
      commission_record_key: " commission-key "
    });

    assert.deepEqual(
      database.__calls.bindValues[0],
      [" commission-key "]
    );
  }
);

test(
  "D1 commission fact lookup returns null when first() returns null",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database =
      makeFakeDatabase({
        firstResult: null
      });

    const result =
      await findExistingCommissionFact(database, {
        commission_record_key: "commission-key"
      });

    assert.equal(result, null);
  }
);

test(
  "D1 commission fact lookup returns the same row object",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const row = {
      commission_fact_id: "fact-1",
      commission_record_key: "commission-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const result =
      await findExistingCommissionFact(database, {
        commission_record_key: "commission-key"
      });

    assert.equal(result, row);
  }
);

test(
  "D1 commission fact lookup rejects malformed first() results",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    for (const firstResult of [[], "row", 123]) {
      const database =
        makeFakeDatabase({
          firstResult
        });

      await assert.rejects(
        () =>
          findExistingCommissionFact(database, {
            commission_record_key: "commission-key"
          }),
        /Invalid D1 result: trip_commissions/
      );
    }
  }
);

test(
  "D1 integration: commission fact feeds planCommissionCurrentState unchanged",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      commission_fact_id: "fact-1",
      commission_record_key: "commission-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const normalizedRow = {
      commission_record_key: "commission-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const existingFact =
      await findExistingCommissionFact(database, normalizedRow);

    const plan =
      planCommissionCurrentState(normalizedRow, existingFact);

    assert.deepEqual(plan, {
      state_action: "unchanged",
      existing_fact_id: "fact-1"
    });
  }
);

test(
  "D1 integration: commission attribution-only change produces update",
  async () => {
    const {
      findExistingCommissionFact
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      commission_fact_id: "fact-1",
      commission_record_key: "commission-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: "flightflex",
      attributed_placement: "placement-a",
      attribution_status: "matched"
    };

    const database =
      makeFakeDatabase({
        firstResult: row
      });

    const normalizedRow = {
      commission_record_key: "commission-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "unmatched"
    };

    const existingFact =
      await findExistingCommissionFact(database, normalizedRow);

    const plan =
      planCommissionCurrentState(normalizedRow, existingFact);

    assert.deepEqual(plan, {
      state_action: "update",
      existing_fact_id: "fact-1"
    });
  }
);

const BOOKING_INSERT_ORDER = [
  "booking_fact_id",
  "source_record_key",
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "raw_order_status",
  "normalized_order_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "currency",
  "order_date",
  "product_start_date",
  "product_end_date",
  "booking_window",
  "departure_city",
  "departure_country",
  "arrival_city",
  "arrival_country",
  "order_platform",
  "booker_region",
  "ouid",
  "first_seen_at",
  "last_seen_at",
  "first_ingestion_run_id",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

const BOOKING_UPDATE_MATERIAL_ORDER = [
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "raw_order_status",
  "normalized_order_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "currency",
  "order_date",
  "product_start_date",
  "product_end_date",
  "booking_window",
  "departure_city",
  "departure_country",
  "arrival_city",
  "arrival_country",
  "order_platform",
  "booker_region",
  "ouid",
  "last_seen_at",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

const COMMISSION_INSERT_ORDER = [
  "commission_fact_id",
  "commission_record_key",
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "sub_order_type",
  "raw_order_status",
  "normalized_order_status",
  "raw_commission_status",
  "normalized_commission_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "commission_amount_raw",
  "commission_amount_micros",
  "currency",
  "commission_month",
  "order_date",
  "check_out_or_issue_date",
  "ratio_raw",
  "plan_type",
  "region",
  "ouid",
  "first_seen_at",
  "last_seen_at",
  "first_ingestion_run_id",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

const COMMISSION_UPDATE_MATERIAL_ORDER = [
  "source",
  "source_order_id",
  "aid",
  "sid",
  "sid_name",
  "source_row_hash",
  "trip_sub1",
  "trip_sub3",
  "attributed_publisher_id",
  "attributed_placement",
  "attribution_status",
  "raw_product_line",
  "normalized_product",
  "sub_order_type",
  "raw_order_status",
  "normalized_order_status",
  "raw_commission_status",
  "normalized_commission_status",
  "booking_amount_raw",
  "booking_amount_micros",
  "commission_amount_raw",
  "commission_amount_micros",
  "currency",
  "commission_month",
  "order_date",
  "check_out_or_issue_date",
  "ratio_raw",
  "plan_type",
  "region",
  "ouid",
  "last_seen_at",
  "last_ingestion_run_id",
  "source_ingested_at",
  "raw_payload_json"
];

function makeValueMap(fields) {
  const map = {};

  for (const field of fields) {
    map[field] = `value-of-${field}`;
  }

  return map;
}

function makeBookingInsertPlan(overrides = {}) {
  const values = makeValueMap(BOOKING_INSERT_ORDER);
  values.booking_fact_id = "new-booking-fact";
  values.currency = null;
  values.booking_amount_micros = 0;

  const plan = {
    persistence_action: "insert",
    booking_fact_id: "new-booking-fact",
    values
  };

  return Object.assign(plan, overrides);
}

function makeCommissionInsertPlan(overrides = {}) {
  const values = makeValueMap(COMMISSION_INSERT_ORDER);
  values.commission_fact_id = "new-commission-fact";
  values.currency = null;
  values.commission_amount_micros = -500;

  const plan = {
    persistence_action: "insert",
    commission_fact_id: "new-commission-fact",
    values
  };

  return Object.assign(plan, overrides);
}

test(
  "D1 prepareBookingFactWriteStatement rejects unavailable database",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    assert.throws(
      () =>
        prepareBookingFactWriteStatement(
          null,
          makeBookingInsertPlan()
        ),
      /D1 binding unavailable/
    );

    assert.throws(
      () =>
        prepareBookingFactWriteStatement(
          {},
          makeBookingInsertPlan()
        ),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 prepareBookingFactWriteStatement rejects malformed plans",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});

    const malformed = [
      null,
      [],
      "plan",
      123,
      {},
      { persistence_action: "insert" },
      { persistence_action: "insert", booking_fact_id: "f" },
      {
        persistence_action: "insert",
        booking_fact_id: "f",
        values: null
      },
      {
        persistence_action: "insert",
        booking_fact_id: "f",
        values: []
      },
      {
        persistence_action: "delete",
        booking_fact_id: "f",
        values: {}
      },
      {
        persistence_action: "UPDATE_MATERIAL",
        booking_fact_id: "f",
        values: {}
      },
      {
        persistence_action: "insert",
        booking_fact_id: "  ",
        values: {}
      },
      {
        persistence_action: "insert",
        booking_fact_id: 123,
        values: {}
      }
    ];

    for (const plan of malformed) {
      assert.throws(
        () =>
          prepareBookingFactWriteStatement(database, plan),
        /Invalid booking D1 persistence plan/
      );
    }
  }
);

test(
  "D1 booking INSERT prepares INSERT INTO trip_bookings with 37 ordered columns",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeBookingInsertPlan();

    const statement =
      prepareBookingFactWriteStatement(database, plan);

    const sql = database.__calls.prepareSql[0];

    assert.match(sql, /INSERT\s+INTO\s+trip_bookings/i);
    assert.equal(database.__calls.prepareSql.length, 1);
    assert.equal(database.__calls.bindValues.length, 1);

    const binds = database.__calls.bindValues[0];
    assert.equal(binds.length, 37);

    assert.equal(binds[0], "new-booking-fact");

    const columnsPart = sql
      .slice(
        sql.indexOf("(") + 1,
        sql.indexOf(")")
      );

    const sqlColumns = columnsPart
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    assert.deepEqual(
      sqlColumns,
      BOOKING_INSERT_ORDER
    );

    for (let i = 1; i <= 37; i += 1) {
      assert.match(sql, new RegExp(`\\?${i}`));
    }

    assert.equal(statement, database.__calls.statements[0]);
  }
);

test(
  "D1 booking INSERT binds all 37 values in exact order preserving null/0/payload",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeBookingInsertPlan();
    plan.values.raw_payload_json = '{"raw":true}';

    prepareBookingFactWriteStatement(database, plan);

    const binds = database.__calls.bindValues[0];

    assert.equal(binds[0], "new-booking-fact");

    for (let i = 0; i < BOOKING_INSERT_ORDER.length; i += 1) {
      const field = BOOKING_INSERT_ORDER[i];
      if (field === "booking_fact_id") {
        continue;
      }
      assert.equal(
        binds[i],
        plan.values[field],
        `bind index ${i} (${field})`
      );
    }
  }
);

test(
  "D1 booking UPDATE MATERIAL prepares correct SET list and WHERE",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = {
      persistence_action: "update_material",
      booking_fact_id: "existing-booking-fact",
      values: makeValueMap(BOOKING_UPDATE_MATERIAL_ORDER)
    };

    prepareBookingFactWriteStatement(database, plan);

    const sql = database.__calls.prepareSql[0];
    assert.match(sql, /UPDATE\s+trip_bookings/i);

    const setClause = sql
      .split(/\nWHERE\s+/i)[0]
      .replace(/UPDATE\s+trip_bookings/i, "")
      .replace(/\bSET\b/i, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s*=\s*\?\d+$/i)[0]);

    assert.deepEqual(
      setClause,
      BOOKING_UPDATE_MATERIAL_ORDER
    );

    assert.match(
      sql,
      /WHERE\s+booking_fact_id\s*=\s*\?34/i
    );

    const setOnly = sql.split(/\nWHERE\s+/i)[0];

    assert.doesNotMatch(setOnly, /source_record_key/i);
    assert.doesNotMatch(setOnly, /booking_fact_id\s*=/i);
    assert.doesNotMatch(setOnly, /first_seen_at/i);
    assert.doesNotMatch(setOnly, /first_ingestion_run_id/i);

    const binds = database.__calls.bindValues[0];
    assert.equal(binds.length, 34);
    assert.equal(binds[33], "existing-booking-fact");

    for (let i = 0; i < BOOKING_UPDATE_MATERIAL_ORDER.length; i += 1) {
      assert.equal(
        binds[i],
        plan.values[BOOKING_UPDATE_MATERIAL_ORDER[i]]
      );
    }
  }
);

test(
  "D1 booking UPDATE OBSERVATION has 3 SET columns and 4 binds",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = {
      persistence_action: "update_observation",
      booking_fact_id: "existing-booking-fact",
      values: {
        last_seen_at: "2025-01-01T00:00:00Z",
        last_ingestion_run_id: "run-1",
        source_ingested_at: "2025-01-01T00:00:00Z"
      }
    };

    prepareBookingFactWriteStatement(database, plan);

    const sql = database.__calls.prepareSql[0];
    assert.match(sql, /UPDATE\s+trip_bookings/i);
    assert.match(sql, /last_seen_at\s*=\s*\?1/i);
    assert.match(sql, /last_ingestion_run_id\s*=\s*\?2/i);
    assert.match(sql, /source_ingested_at\s*=\s*\?3/i);
    assert.match(
      sql,
      /WHERE\s+booking_fact_id\s*=\s*\?4/i
    );

    assert.doesNotMatch(sql, /source_row_hash/i);
    assert.doesNotMatch(sql, /attributed_publisher_id/i);
    assert.doesNotMatch(sql, /raw_payload_json/i);

    assert.deepEqual(
      database.__calls.bindValues[0],
      [
        "2025-01-01T00:00:00Z",
        "run-1",
        "2025-01-01T00:00:00Z",
        "existing-booking-fact"
      ]
    );
  }
);

test(
  "D1 prepareCommissionFactWriteStatement rejects unavailable database",
  async () => {
    const {
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    assert.throws(
      () =>
        prepareCommissionFactWriteStatement(
          null,
          makeCommissionInsertPlan()
        ),
      /D1 binding unavailable/
    );

    assert.throws(
      () =>
        prepareCommissionFactWriteStatement(
          {},
          makeCommissionInsertPlan()
        ),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 prepareCommissionFactWriteStatement rejects malformed plans",
  async () => {
    const {
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});

    const malformed = [
      null,
      [],
      "plan",
      123,
      {},
      { persistence_action: "insert" },
      { persistence_action: "insert", commission_fact_id: "f" },
      {
        persistence_action: "insert",
        commission_fact_id: "f",
        values: null
      },
      {
        persistence_action: "insert",
        commission_fact_id: "f",
        values: []
      },
      {
        persistence_action: "upsert",
        commission_fact_id: "f",
        values: {}
      },
      {
        persistence_action: "INSERT",
        commission_fact_id: "f",
        values: {}
      },
      {
        persistence_action: "insert",
        commission_fact_id: "  ",
        values: {}
      },
      {
        persistence_action: "insert",
        commission_fact_id: 123,
        values: {}
      }
    ];

    for (const plan of malformed) {
      assert.throws(
        () =>
          prepareCommissionFactWriteStatement(database, plan),
        /Invalid commission D1 persistence plan/
      );
    }
  }
);

test(
  "D1 commission INSERT prepares INSERT INTO trip_commissions with 38 ordered columns",
  async () => {
    const {
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeCommissionInsertPlan();

    const statement =
      prepareCommissionFactWriteStatement(database, plan);

    const sql = database.__calls.prepareSql[0];

    assert.match(sql, /INSERT\s+INTO\s+trip_commissions/i);
    assert.equal(database.__calls.prepareSql.length, 1);
    assert.equal(database.__calls.bindValues.length, 1);

    const binds = database.__calls.bindValues[0];
    assert.equal(binds.length, 38);
    assert.equal(binds[0], "new-commission-fact");

    const columnsPart = sql
      .slice(
        sql.indexOf("(") + 1,
        sql.indexOf(")")
      );

    const sqlColumns = columnsPart
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    assert.deepEqual(
      sqlColumns,
      COMMISSION_INSERT_ORDER
    );

    for (let i = 1; i <= 38; i += 1) {
      assert.match(sql, new RegExp(`\\?${i}`));
    }

    assert.equal(statement, database.__calls.statements[0]);
  }
);

test(
  "D1 commission INSERT binds all 38 values preserving negative/null",
  async () => {
    const {
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeCommissionInsertPlan();

    prepareCommissionFactWriteStatement(database, plan);

    const binds = database.__calls.bindValues[0];

    assert.equal(binds[0], "new-commission-fact");

    const commissionAmountMicrosIndex =
      COMMISSION_INSERT_ORDER.indexOf("commission_amount_micros");

    assert.equal(
      binds[commissionAmountMicrosIndex],
      -500
    );

    for (let i = 0; i < COMMISSION_INSERT_ORDER.length; i += 1) {
      const field = COMMISSION_INSERT_ORDER[i];
      if (field === "commission_fact_id") {
        continue;
      }
      assert.equal(
        binds[i],
        plan.values[field],
        `bind index ${i} (${field})`
      );
    }
  }
);

test(
  "D1 commission UPDATE MATERIAL prepares correct SET list and WHERE",
  async () => {
    const {
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = {
      persistence_action: "update_material",
      commission_fact_id: "existing-commission-fact",
      values: makeValueMap(COMMISSION_UPDATE_MATERIAL_ORDER)
    };

    prepareCommissionFactWriteStatement(database, plan);

    const sql = database.__calls.prepareSql[0];
    assert.match(sql, /UPDATE\s+trip_commissions/i);

    const setClause = sql
      .split(/\nWHERE\s+/i)[0]
      .replace(/UPDATE\s+trip_commissions/i, "")
      .replace(/\bSET\b/i, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s*=\s*\?\d+$/i)[0]);

    assert.deepEqual(
      setClause,
      COMMISSION_UPDATE_MATERIAL_ORDER
    );

    assert.match(
      sql,
      /WHERE\s+commission_fact_id\s*=\s*\?35/i
    );

    const setOnly = sql.split(/\nWHERE\s+/i)[0];

    assert.doesNotMatch(setOnly, /commission_record_key/i);
    assert.doesNotMatch(setOnly, /commission_fact_id\s*=/i);
    assert.doesNotMatch(setOnly, /first_seen_at/i);
    assert.doesNotMatch(setOnly, /first_ingestion_run_id/i);

    const binds = database.__calls.bindValues[0];
    assert.equal(binds.length, 35);
    assert.equal(binds[34], "existing-commission-fact");

    for (let i = 0; i < COMMISSION_UPDATE_MATERIAL_ORDER.length; i += 1) {
      assert.equal(
        binds[i],
        plan.values[COMMISSION_UPDATE_MATERIAL_ORDER[i]]
      );
    }
  }
);

test(
  "D1 commission UPDATE OBSERVATION has 3 SET columns and 4 binds",
  async () => {
    const {
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = {
      persistence_action: "update_observation",
      commission_fact_id: "existing-commission-fact",
      values: {
        last_seen_at: "2025-01-01T00:00:00Z",
        last_ingestion_run_id: "run-1",
        source_ingested_at: "2025-01-01T00:00:00Z"
      }
    };

    prepareCommissionFactWriteStatement(database, plan);

    const sql = database.__calls.prepareSql[0];
    assert.match(sql, /UPDATE\s+trip_commissions/i);
    assert.match(sql, /last_seen_at\s*=\s*\?1/i);
    assert.match(sql, /last_ingestion_run_id\s*=\s*\?2/i);
    assert.match(sql, /source_ingested_at\s*=\s*\?3/i);
    assert.match(
      sql,
      /WHERE\s+commission_fact_id\s*=\s*\?4/i
    );

    assert.doesNotMatch(sql, /raw_payload_json/i);
    assert.doesNotMatch(sql, /source_row_hash/i);
    assert.doesNotMatch(sql, /attributed_publisher_id/i);

    assert.deepEqual(
      database.__calls.bindValues[0],
      [
        "2025-01-01T00:00:00Z",
        "run-1",
        "2025-01-01T00:00:00Z",
        "existing-commission-fact"
      ]
    );
  }
);

test(
  "D1 write statements preserve fact ID whitespace exactly",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeBookingInsertPlan({
      booking_fact_id: " fact-with-spaces "
    });

    prepareBookingFactWriteStatement(database, plan);

    assert.equal(
      database.__calls.bindValues[0][0],
      " fact-with-spaces "
    );
  }
);

test(
  "D1 write statements do not execute run/batch/exec",
  async () => {
    const {
      prepareBookingFactWriteStatement,
      prepareCommissionFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});

    prepareBookingFactWriteStatement(
      database,
      makeBookingInsertPlan()
    );
    prepareBookingFactWriteStatement(database, {
      persistence_action: "update_material",
      booking_fact_id: "existing-booking-fact",
      values: makeValueMap(BOOKING_UPDATE_MATERIAL_ORDER)
    });
    prepareBookingFactWriteStatement(database, {
      persistence_action: "update_observation",
      booking_fact_id: "existing-booking-fact",
      values: {
        last_seen_at: "a",
        last_ingestion_run_id: "b",
        source_ingested_at: "c"
      }
    });

    prepareCommissionFactWriteStatement(
      database,
      makeCommissionInsertPlan()
    );
    prepareCommissionFactWriteStatement(database, {
      persistence_action: "update_material",
      commission_fact_id: "existing-commission-fact",
      values: makeValueMap(COMMISSION_UPDATE_MATERIAL_ORDER)
    });
    prepareCommissionFactWriteStatement(database, {
      persistence_action: "update_observation",
      commission_fact_id: "existing-commission-fact",
      values: {
        last_seen_at: "a",
        last_ingestion_run_id: "b",
        source_ingested_at: "c"
      }
    });

    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.batchCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
  }
);

test(
  "D1 write statements do not mutate the persistence plan",
  async () => {
    const {
      prepareBookingFactWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeBookingInsertPlan();
    const snapshot = JSON.stringify(plan);

    prepareBookingFactWriteStatement(database, plan);

    assert.equal(JSON.stringify(plan), snapshot);
  }
);

const LEDGER_INSERT_ORDER = [
  "ingestion_run_id",
  "source",
  "report_type",
  "report_period_from",
  "report_period_to",
  "source_filename",
  "source_file_sha256",
  "started_at",
  "completed_at",
  "rows_seen",
  "rows_inserted",
  "rows_updated",
  "rows_unchanged",
  "rows_rejected",
  "status",
  "error_summary"
];

function makeLedgerPlan(overrides = {}) {
  const plan = {
    ingestion_run_id: "run-001",
    source: "trip.com",
    report_type: "booking",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    source_filename: "booking-report.csv",
    source_file_sha256: "abc123",
    started_at: "2026-08-01T00:00:00Z",
    completed_at: "2026-08-01T00:05:00Z",
    rows_seen: 3,
    rows_inserted: 1,
    rows_updated: 1,
    rows_unchanged: 1,
    rows_rejected: 0,
    status: "completed",
    error_summary: null
  };

  return Object.assign(plan, overrides);
}

function makeZeroLedgerPlan(overrides = {}) {
  const plan = makeLedgerPlan({
    rows_seen: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_unchanged: 0,
    rows_rejected: 0
  });

  return Object.assign(plan, overrides);
}

test(
  "D1 ledger write statement rejects unavailable database",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    assert.throws(
      () =>
        prepareSuccessfulIngestionRunWriteStatement(
          null,
          makeLedgerPlan()
        ),
      /D1 binding unavailable/
    );

    assert.throws(
      () =>
        prepareSuccessfulIngestionRunWriteStatement(
          {},
          makeLedgerPlan()
        ),
      /D1 binding unavailable/
    );
  }
);

test(
  "D1 ledger write statement rejects malformed ledger plans",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});

    const malformed = [
      null,
      [],
      "ledger",
      123,
      {},
      makeLedgerPlan({ ingestion_run_id: "   " }),
      makeLedgerPlan({ source: "   " }),
      makeLedgerPlan({ report_type: "   " }),
      makeLedgerPlan({ source_file_sha256: "   " }),
      makeLedgerPlan({ started_at: "   " }),
      makeLedgerPlan({ completed_at: "   " }),
      makeLedgerPlan({ status: "   " }),
      makeLedgerPlan({ status: "processing" }),
      makeLedgerPlan({ status: "COMPLETED" }),
      makeLedgerPlan({ error_summary: "" }),
      makeLedgerPlan({ rows_seen: -1 }),
      makeLedgerPlan({ rows_seen: 1.5 }),
      makeLedgerPlan({ rows_inserted: -1 }),
      makeLedgerPlan({ rows_updated: 1.5 }),
      makeLedgerPlan({ rows_unchanged: "1" }),
      makeLedgerPlan({ rows_rejected: 1 }),
      makeLedgerPlan({ rows_seen: 3, rows_unchanged: 2 }),
      makeLedgerPlan({ report_period_from: 123 }),
      makeLedgerPlan({ report_period_to: {} }),
      makeLedgerPlan({ source_filename: [] })
    ];

    for (const plan of malformed) {
      assert.throws(
        () =>
          prepareSuccessfulIngestionRunWriteStatement(
            database,
            plan
          ),
        /Invalid successful ingestion D1 plan/
      );
    }
  }
);

test(
  "D1 ledger write statement prepares INSERT into report_ingestion_runs with 16 ordered columns",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const statement =
      prepareSuccessfulIngestionRunWriteStatement(
        database,
        makeLedgerPlan()
      );

    const sql = database.__calls.prepareSql[0];

    assert.match(
      sql,
      /INSERT\s+INTO\s+report_ingestion_runs/i
    );
    assert.equal(database.__calls.prepareSql.length, 1);
    assert.equal(database.__calls.bindValues.length, 1);
    assert.equal(statement, database.__calls.statements[0]);

    const columnsPart = sql.slice(
      sql.indexOf("(") + 1,
      sql.indexOf(")")
    );

    const sqlColumns = columnsPart
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    assert.deepEqual(sqlColumns, LEDGER_INSERT_ORDER);

    for (let i = 1; i <= 16; i += 1) {
      assert.match(sql, new RegExp(`\\?${i}`));
    }

    assert.doesNotMatch(sql, /\bUPDATE\b/i);
    assert.doesNotMatch(sql, /DELETE/i);
    assert.doesNotMatch(sql, /REPLACE/i);
    assert.doesNotMatch(sql, /UPSERT/i);
    assert.doesNotMatch(sql, /ON\s+CONFLICT/i);
  }
);

test(
  "D1 ledger write statement binds 16 values in exact order",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeLedgerPlan({
      ingestion_run_id: " run-with-spaces ",
      started_at: " started ",
      completed_at: " completed "
    });

    prepareSuccessfulIngestionRunWriteStatement(database, plan);

    const binds = database.__calls.bindValues[0];
    assert.equal(binds.length, 16);

    for (let i = 0; i < LEDGER_INSERT_ORDER.length; i += 1) {
      const field = LEDGER_INSERT_ORDER[i];
      assert.equal(
        binds[i],
        plan[field],
        `bind index ${i} (${field})`
      );
    }
  }
);

test(
  "D1 ledger write statement preserves optional null values",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeLedgerPlan({
      report_period_from: null,
      report_period_to: null,
      source_filename: null
    });

    prepareSuccessfulIngestionRunWriteStatement(database, plan);

    const binds = database.__calls.bindValues[0];

    assert.equal(binds[3], null);
    assert.equal(binds[4], null);
    assert.equal(binds[5], null);
  }
);

test(
  "D1 ledger write statement binds zero-row ledger counters correctly",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});

    prepareSuccessfulIngestionRunWriteStatement(
      database,
      makeZeroLedgerPlan()
    );

    const binds = database.__calls.bindValues[0];

    assert.deepEqual(
      binds.slice(9, 14),
      [0, 0, 0, 0, 0]
    );
  }
);

test(
  "D1 ledger write statement binds status completed and error_summary null",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});

    prepareSuccessfulIngestionRunWriteStatement(
      database,
      makeLedgerPlan()
    );

    const binds = database.__calls.bindValues[0];

    assert.equal(binds[14], "completed");
    assert.equal(binds[15], null);
  }
);

test(
  "D1 ledger write statement returns exact bind() result and executes nothing",
  async () => {
    const {
      prepareSuccessfulIngestionRunWriteStatement
    } = await import(
      "../reporting-importer-d1-v0.1.mjs"
    );

    const database = makeFakeDatabase({});
    const plan = makeLedgerPlan();
    const snapshot = JSON.stringify(plan);

    const statement =
      prepareSuccessfulIngestionRunWriteStatement(database, plan);

    assert.equal(statement, database.__calls.statements[0]);
    assert.equal(database.__calls.prepareSql.length, 1);
    assert.equal(database.__calls.bindValues.length, 1);
    assert.equal(database.__calls.runCalls, 0);
    assert.equal(database.__calls.batchCalls, 0);
    assert.equal(database.__calls.execCalls, 0);
    assert.deepEqual(database.__calls.readCalls, []);
    assert.equal(JSON.stringify(plan), snapshot);
  }
);
