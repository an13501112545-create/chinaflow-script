import test from "node:test";
import assert from "node:assert/strict";

function makeFakeDatabase(config = {}) {
  const calls = {
    prepareSql: [],
    bindValues: [],
    readCalls: []
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

      return statement;
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

    assert.equal(
      typeof database.run,
      "undefined"
    );
    assert.equal(
      typeof database.batch,
      "undefined"
    );
    assert.equal(
      typeof database.exec,
      "undefined"
    );
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
