import test from "node:test";
import assert from "node:assert/strict";

import {
  createBookingRecordKey
} from "../reporting-importer-core-v0.1.mjs";


test(
  "booking source_record_key is deterministic SHA-256 of canonical identity tuple",
  async () => {
    const key = await createBookingRecordKey({
      source: "trip.com",
      aid: "10021103",
      sid: "123456",
      source_order_id: "BOOKING-001",
      raw_product_line: "htl"
    });

    assert.equal(
      key,
      "44d7a7aed728d2fe31d30beaab36d69d6ce4e476e261320ebf29bd26cfe3e86f"
    );
  }
);

test(
  "commission commission_record_key is deterministic SHA-256 of canonical identity tuple",
  async () => {
    const {
      createCommissionRecordKey
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const key = await createCommissionRecordKey({
      source: "trip.com",
      aid: "10021103",
      sid: "123456",
      source_order_id: "BOOKING-001",
      commission_month: "2026-08",
      raw_product_line: "htl",
      sub_order_type: "hotel",
      plan_type: "standard"
    });

    assert.equal(
      key,
      "6a65817055252ed4cda18518b4e88db95a96ec289dd60849785ac00865a47c97"
    );
  }
);
test(
  "money parser converts decimal strings to exact micros without floating-point rounding",
  async () => {
    const {
      parseMoneyToMicros
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.equal(
      parseMoneyToMicros("1234.567890"),
      1234567890
    );

    assert.equal(
      parseMoneyToMicros("-12.345678"),
      -12345678
    );
  }
);
test(
  "money normalization preserves raw value and uses null micros when parsing fails",
  async () => {
    const {
      normalizeMoneyField
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      normalizeMoneyField("12.3456789"),
      {
        raw: "12.3456789",
        micros: null
      }
    );

    assert.deepEqual(
      normalizeMoneyField(null),
      {
        raw: null,
        micros: null
      }
    );
  }
);
test(
  "currency normalization preserves known currency and never invents USD when missing",
  async () => {
    const {
      normalizeCurrency
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.equal(
      normalizeCurrency("USD"),
      "USD"
    );

    assert.equal(
      normalizeCurrency(null),
      null
    );

    assert.equal(
      normalizeCurrency(undefined),
      null
    );

    assert.equal(
      normalizeCurrency(""),
      null
    );
  }
);
test(
  "Trip.com product and status normalization preserves raw provider values",
  async () => {
    const {
      normalizeTripProductLine,
      normalizeTripOrderStatus,
      normalizeTripCommissionStatus
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      normalizeTripProductLine("htl"),
      {
        raw: "htl",
        normalized: "hotel"
      }
    );

    assert.deepEqual(
      normalizeTripProductLine("future_product"),
      {
        raw: "future_product",
        normalized: "unknown"
      }
    );

    assert.deepEqual(
      normalizeTripOrderStatus("S"),
      {
        raw: "S",
        normalized: "successful"
      }
    );

    assert.deepEqual(
      normalizeTripOrderStatus("X_NEW"),
      {
        raw: "X_NEW",
        normalized: "unknown"
      }
    );

    assert.deepEqual(
      normalizeTripCommissionStatus("UNDER_REVIEW"),
      {
        raw: "UNDER_REVIEW",
        normalized: "under_review"
      }
    );

    assert.deepEqual(
      normalizeTripCommissionStatus("FUTURE_STATUS"),
      {
        raw: "FUTURE_STATUS",
        normalized: "unknown"
      }
    );
  }
);
test(
  "trip_sub1 attribution preserves matched, unmatched, and missing states",
  async () => {
    const {
      resolveTripSub1Attribution
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const matchedPlacement = {
      publisher_id: "flightflex",
      placement: "flightflex_flights_yyz_bjs_test"
    };

    assert.deepEqual(
      resolveTripSub1Attribution(
        "flightflex_flights_yyz_bjs_test",
        matchedPlacement
      ),
      {
        attributed_publisher_id: "flightflex",
        attributed_placement: "flightflex_flights_yyz_bjs_test",
        attribution_status: "matched"
      }
    );

    assert.deepEqual(
      resolveTripSub1Attribution(
        "unknown_trip_sub1",
        null
      ),
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: "unmatched"
      }
    );

    assert.deepEqual(
      resolveTripSub1Attribution(
        null,
        null
      ),
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: "missing_trip_sub1"
      }
    );
  }
);
test(
  "booking identity rejects whitespace-only required fields before hashing",
  async () => {
    await assert.rejects(
      () =>
        createBookingRecordKey({
          source: "trip.com",
          aid: "10021103",
          sid: "123456",
          source_order_id: "   ",
          raw_product_line: "htl"
        }),
      /Missing booking identity field: source_order_id/
    );
  }
);
test(
  "batch preflight rejects duplicate record keys before persistence",
  async () => {
    const {
      assertUniqueRecordKeys
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        assertUniqueRecordKeys(
          [
            "record-key-001",
            "record-key-002",
            "record-key-001"
          ],
          "booking"
        ),
      /Duplicate booking record key: record-key-001/
    );

    assert.doesNotThrow(
      () =>
        assertUniqueRecordKeys(
          [
            "record-key-001",
            "record-key-002"
          ],
          "booking"
        )
    );
  }
);
test(
  "commission identity rejects missing commission_month with commission-specific error",
  async () => {
    const {
      createCommissionRecordKey
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        createCommissionRecordKey({
          source: "trip.com",
          aid: "10021103",
          sid: "123456",
          source_order_id: "BOOKING-001",
          commission_month: "",
          raw_product_line: "htl",
          sub_order_type: "hotel",
          plan_type: "standard"
        }),
      /Missing commission identity field: commission_month/
    );
  }
);
test(
  "provider normalization treats inherited object keys as unknown",
  async () => {
    const {
      normalizeTripProductLine,
      normalizeTripOrderStatus,
      normalizeTripCommissionStatus
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      normalizeTripProductLine("toString"),
      {
        raw: "toString",
        normalized: "unknown"
      }
    );

    assert.deepEqual(
      normalizeTripOrderStatus("constructor"),
      {
        raw: "constructor",
        normalized: "unknown"
      }
    );

    assert.deepEqual(
      normalizeTripCommissionStatus("__proto__"),
      {
        raw: "__proto__",
        normalized: "unknown"
      }
    );
  }
);
test(
  "trip_sub1 attribution treats whitespace-only tracking keys as missing",
  async () => {
    const {
      resolveTripSub1Attribution
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      resolveTripSub1Attribution(
        "   ",
        null
      ),
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: "missing_trip_sub1"
      }
    );
  }
);

test(
  "Trip.com booking row normalization builds persistence-ready booking facts",
  async () => {
    const {
      normalizeTripBookingRow
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const normalized =
      await normalizeTripBookingRow(
        {
          orderId: "BOOKING-001",
          sid: "123456",
          sidName: "FlightFlex",
          productLine: "htl",
          orderStatus: "S",
          amount: "123.45",
          currency: "CAD",
          orderDate: "2026-08-19 10:30:00",
          productStartDate: "2026-09-01",
          productEndDate: "2026-09-03",
          bookingWindow: "13",
          departureCity: "Toronto",
          departureCountry: "Canada",
          arrivalCity: "Beijing",
          arrivalCountry: "China",
          orderPlatform: "Web",
          region: "CA",
          ouid: "opaque-ouid-001",
          tripSub1: "flightflex_flights_yyz_bjs_test",
          tripSub3: "campaign-a"
        },
        {
          source: "trip.com",
          aid: "10021103",
          matchedPlacement: {
            publisher_id: "flightflex",
            placement: "flightflex_flights_yyz_bjs_test"
          }
        }
      );

    assert.equal(
      normalized.source_record_key,
      "44d7a7aed728d2fe31d30beaab36d69d6ce4e476e261320ebf29bd26cfe3e86f"
    );

    assert.equal(normalized.source, "trip.com");
    assert.equal(normalized.source_order_id, "BOOKING-001");
    assert.equal(normalized.aid, "10021103");
    assert.equal(normalized.sid, "123456");
    assert.equal(normalized.sid_name, "FlightFlex");

    assert.equal(normalized.trip_sub1, "flightflex_flights_yyz_bjs_test");
    assert.equal(normalized.trip_sub3, "campaign-a");
    assert.equal(normalized.attributed_publisher_id, "flightflex");
    assert.equal(normalized.attributed_placement, "flightflex_flights_yyz_bjs_test");
    assert.equal(normalized.attribution_status, "matched");

    assert.equal(normalized.raw_product_line, "htl");
    assert.equal(normalized.normalized_product, "hotel");
    assert.equal(normalized.raw_order_status, "S");
    assert.equal(normalized.normalized_order_status, "successful");

    assert.equal(normalized.booking_amount_raw, "123.45");
    assert.equal(normalized.booking_amount_micros, 123450000);
    assert.equal(normalized.currency, "CAD");

    assert.equal(normalized.order_date, "2026-08-19 10:30:00");
    assert.equal(normalized.product_start_date, "2026-09-01");
    assert.equal(normalized.product_end_date, "2026-09-03");
    assert.equal(normalized.booking_window, "13");

    assert.equal(normalized.departure_city, "Toronto");
    assert.equal(normalized.departure_country, "Canada");
    assert.equal(normalized.arrival_city, "Beijing");
    assert.equal(normalized.arrival_country, "China");
    assert.equal(normalized.order_platform, "Web");
    assert.equal(normalized.booker_region, "CA");
    assert.equal(normalized.ouid, "opaque-ouid-001");
  }
);
test(
  "source row hash is deterministic across object key order and changes when row content changes",
  async () => {
    const {
      createSourceRowHash
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const rowA = {
      orderId: "BOOKING-001",
      productLine: "htl",
      orderStatus: "S",
      amount: "123.45"
    };

    const rowB = {
      amount: "123.45",
      orderStatus: "S",
      productLine: "htl",
      orderId: "BOOKING-001"
    };

    const rowChanged = {
      orderId: "BOOKING-001",
      productLine: "htl",
      orderStatus: "Q",
      amount: "123.45"
    };

    const hashA =
      await createSourceRowHash(rowA);

    const hashB =
      await createSourceRowHash(rowB);

    const hashChanged =
      await createSourceRowHash(rowChanged);

    assert.equal(hashA, hashB);
    assert.notEqual(hashA, hashChanged);

    assert.match(
      hashA,
      /^[0-9a-f]{64}$/
    );
  }
);
test(
  "Trip.com booking row normalization includes source_row_hash derived from the raw source row",
  async () => {
    const {
      normalizeTripBookingRow,
      createSourceRowHash
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      orderId: "BOOKING-001",
      sid: "123456",
      sidName: "FlightFlex",
      productLine: "htl",
      orderStatus: "S",
      amount: "123.45",
      currency: "CAD",
      tripSub1: "flightflex_flights_yyz_bjs_test"
    };

    const normalized =
      await normalizeTripBookingRow(
        row,
        {
          source: "trip.com",
          aid: "10021103",
          matchedPlacement: {
            publisher_id: "flightflex",
            placement: "flightflex_flights_yyz_bjs_test"
          }
        }
      );

    assert.equal(
      normalized.source_row_hash,
      await createSourceRowHash(row)
    );

    assert.match(
      normalized.source_row_hash,
      /^[0-9a-f]{64}$/
    );
  }
);
test(
  "Trip.com commission row normalization builds persistence-ready commission facts",
  async () => {
    const {
      normalizeTripCommissionRow
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      orderId: "BOOKING-001",
      sid: "123456",
      sidName: "FlightFlex",
      commissionMonth: "2026-08",
      productLine: "htl",
      subOrderType: "hotel",
      planType: "standard",
      orderStatus: "S",
      commissionStatus: "SETTLED",
      bookingAmount: "123.45",
      commissionAmount: "6.17",
      currency: "CAD",
      orderDate: "2026-08-19 10:30:00",
      checkOutOrIssueDate: "2026-09-03",
      ratio: "0.05",
      region: "CA",
      ouid: "opaque-ouid-001",
      tripSub1: "flightflex_flights_yyz_bjs_test",
      tripSub3: "campaign-a"
    };

    const normalized =
      await normalizeTripCommissionRow(
        row,
        {
          source: "trip.com",
          aid: "10021103",
          matchedPlacement: {
            publisher_id: "flightflex",
            placement: "flightflex_flights_yyz_bjs_test"
          }
        }
      );

    assert.equal(
      normalized.commission_record_key,
      "6a65817055252ed4cda18518b4e88db95a96ec289dd60849785ac00865a47c97"
    );

    assert.match(
      normalized.source_row_hash,
      /^[0-9a-f]{64}$/
    );

    assert.equal(normalized.source, "trip.com");
    assert.equal(normalized.source_order_id, "BOOKING-001");
    assert.equal(normalized.aid, "10021103");
    assert.equal(normalized.sid, "123456");
    assert.equal(normalized.sid_name, "FlightFlex");

    assert.equal(normalized.trip_sub1, "flightflex_flights_yyz_bjs_test");
    assert.equal(normalized.trip_sub3, "campaign-a");
    assert.equal(normalized.attributed_publisher_id, "flightflex");
    assert.equal(normalized.attributed_placement, "flightflex_flights_yyz_bjs_test");
    assert.equal(normalized.attribution_status, "matched");

    assert.equal(normalized.raw_product_line, "htl");
    assert.equal(normalized.normalized_product, "hotel");
    assert.equal(normalized.sub_order_type, "hotel");
    assert.equal(normalized.plan_type, "standard");

    assert.equal(normalized.raw_order_status, "S");
    assert.equal(normalized.normalized_order_status, "successful");
    assert.equal(normalized.raw_commission_status, "SETTLED");
    assert.equal(normalized.normalized_commission_status, "settled");

    assert.equal(normalized.booking_amount_raw, "123.45");
    assert.equal(normalized.booking_amount_micros, 123450000);
    assert.equal(normalized.commission_amount_raw, "6.17");
    assert.equal(normalized.commission_amount_micros, 6170000);
    assert.equal(normalized.currency, "CAD");

    assert.equal(normalized.commission_month, "2026-08");
    assert.equal(normalized.order_date, "2026-08-19 10:30:00");
    assert.equal(normalized.check_out_or_issue_date, "2026-09-03");
    assert.equal(normalized.ratio_raw, "0.05");
    assert.equal(normalized.region, "CA");
    assert.equal(normalized.ouid, "opaque-ouid-001");
  }
);

test(
  "booking batch preflight normalizes all rows and rejects duplicate source_record_key before persistence",
  async () => {
    const {
      preflightTripBookingRows
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const context = {
      source: "trip.com",
      aid: "10021103",
      matchedPlacement: {
        publisher_id: "flightflex",
        placement: "flightflex_flights_yyz_bjs_test"
      }
    };

    const uniqueRows = [
      {
        orderId: "BOOKING-001",
        sid: "123456",
        productLine: "htl",
        orderStatus: "S",
        amount: "123.45",
        currency: "CAD",
        tripSub1: "flightflex_flights_yyz_bjs_test"
      },
      {
        orderId: "BOOKING-002",
        sid: "123456",
        productLine: "htl",
        orderStatus: "S",
        amount: "200.00",
        currency: "CAD",
        tripSub1: "flightflex_flights_yyz_bjs_test"
      }
    ];

    const normalized =
      await preflightTripBookingRows(
        uniqueRows,
        context
      );

    assert.equal(normalized.length, 2);

    assert.match(
      normalized[0].source_record_key,
      /^[0-9a-f]{64}$/
    );

    assert.notEqual(
      normalized[0].source_record_key,
      normalized[1].source_record_key
    );

    await assert.rejects(
      () =>
        preflightTripBookingRows(
          [
            uniqueRows[0],
            {
              ...uniqueRows[0],
              amount: "999.99",
              orderStatus: "Q"
            }
          ],
          context
        ),
      /Duplicate booking record key:/
    );
  }
);
test(
  "commission batch preflight normalizes all rows and rejects duplicate commission_record_key before persistence",
  async () => {
    const {
      preflightTripCommissionRows
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const context = {
      source: "trip.com",
      aid: "10021103",
      matchedPlacement: {
        publisher_id: "flightflex",
        placement: "flightflex_flights_yyz_bjs_test"
      }
    };

    const uniqueRows = [
      {
        orderId: "BOOKING-001",
        sid: "123456",
        commissionMonth: "2026-08",
        productLine: "htl",
        subOrderType: "hotel",
        planType: "standard",
        orderStatus: "S",
        commissionStatus: "SETTLED",
        bookingAmount: "123.45",
        commissionAmount: "6.17",
        currency: "CAD",
        tripSub1: "flightflex_flights_yyz_bjs_test"
      },
      {
        orderId: "BOOKING-002",
        sid: "123456",
        commissionMonth: "2026-08",
        productLine: "htl",
        subOrderType: "hotel",
        planType: "standard",
        orderStatus: "S",
        commissionStatus: "SETTLED",
        bookingAmount: "200.00",
        commissionAmount: "10.00",
        currency: "CAD",
        tripSub1: "flightflex_flights_yyz_bjs_test"
      }
    ];

    const normalized =
      await preflightTripCommissionRows(
        uniqueRows,
        context
      );

    assert.equal(normalized.length, 2);

    assert.match(
      normalized[0].commission_record_key,
      /^[0-9a-f]{64}$/
    );

    assert.notEqual(
      normalized[0].commission_record_key,
      normalized[1].commission_record_key
    );

    await assert.rejects(
      () =>
        preflightTripCommissionRows(
          [
            uniqueRows[0],
            {
              ...uniqueRows[0],
              commissionAmount: "9.99",
              commissionStatus: "UNDER_REVIEW"
            }
          ],
          context
        ),
      /Duplicate commission record key:/
    );
  }
);

test(
  "source file SHA-256 hashes exact raw bytes for ingestion dedupe",
  async () => {
    const {
      createSourceFileSha256
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const lfBytes =
      new TextEncoder().encode(
        "trip-report-v0.1\n"
      );

    const crlfBytes =
      new TextEncoder().encode(
        "trip-report-v0.1\r\n"
      );

    const lfHash =
      await createSourceFileSha256(
        lfBytes
      );

    const crlfHash =
      await createSourceFileSha256(
        crlfBytes
      );

    assert.equal(
      lfHash,
      "0514db9bf331a6ae64526645e759c694f5fce092a6e16aaea4c05bb2242d043b"
    );

    assert.notEqual(
      lfHash,
      crlfHash
    );

    assert.match(
      crlfHash,
      /^[0-9a-f]{64}$/
    );
  }
);
test(
  "ingestion run preflight builds audit metadata from exact source file bytes",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const fileBytes =
      new TextEncoder().encode(
        "trip-report-v0.1\n"
      );

    const preflight =
      await createIngestionRunPreflight({
        source: "trip.com",
        report_type: "booking",
        source_filename: "booking-report.csv",
        report_period_from: "2026-08-01",
        report_period_to: "2026-08-20",
        file_bytes: fileBytes,
        rows_seen: 2
      });

    assert.deepEqual(
      preflight,
      {
        source: "trip.com",
        report_type: "booking",
        source_filename: "booking-report.csv",
        report_period_from: "2026-08-01",
        report_period_to: "2026-08-20",
        source_file_sha256:
          "0514db9bf331a6ae64526645e759c694f5fce092a6e16aaea4c05bb2242d043b",
        rows_seen: 2
      }
    );
  }
);
test(
  "ingestion run preflight rejects missing source and report_type before persistence",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const fileBytes =
      new TextEncoder().encode(
        "trip-report-v0.1\n"
      );

    await assert.rejects(
      () =>
        createIngestionRunPreflight({
          source: "   ",
          report_type: "booking",
          file_bytes: fileBytes,
          rows_seen: 1
        }),
      /Missing ingestion field: source/
    );

    await assert.rejects(
      () =>
        createIngestionRunPreflight({
          source: "trip.com",
          report_type: "",
          file_bytes: fileBytes,
          rows_seen: 1
        }),
      /Missing ingestion field: report_type/
    );
  }
);

test(
  "ingestion preflight rejects missing file_bytes explicitly",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        createIngestionRunPreflight({
          source: "trip.com",
          report_type: "booking",
          rows_seen: 1
        }),
      /Missing ingestion field: file_bytes/
    );

    await assert.rejects(
      () =>
        createIngestionRunPreflight({
          source: "trip.com",
          report_type: "booking",
          file_bytes: null,
          rows_seen: 1
        }),
      /Missing ingestion field: file_bytes/
    );
  }
);
test(
  "ingestion preflight rejects invalid file_bytes types explicitly",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const invalidValues = [
      "not-bytes",
      123,
      { bytes: true },
      true
    ];

    for (const fileBytes of invalidValues) {
      await assert.rejects(
        () =>
          createIngestionRunPreflight({
            source: "trip.com",
            report_type: "booking",
            file_bytes: fileBytes,
            rows_seen: 1
          }),
        /Invalid ingestion field: file_bytes/
      );
    }
  }
);
test(
  "ingestion preflight rejects missing rows_seen explicitly",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const fileBytes =
      new Uint8Array([1, 2, 3]);

    await assert.rejects(
      () =>
        createIngestionRunPreflight({
          source: "trip.com",
          report_type: "booking",
          file_bytes: fileBytes
        }),
      /Missing ingestion field: rows_seen/
    );

    await assert.rejects(
      () =>
        createIngestionRunPreflight({
          source: "trip.com",
          report_type: "booking",
          file_bytes: fileBytes,
          rows_seen: null
        }),
      /Missing ingestion field: rows_seen/
    );
  }
);
test(
  "ingestion preflight rejects invalid rows_seen values explicitly",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const fileBytes =
      new Uint8Array([1, 2, 3]);

    const invalidValues = [
      -1,
      1.5,
      "10",
      NaN,
      Infinity,
      -Infinity,
      {}
    ];

    for (const rowsSeen of invalidValues) {
      await assert.rejects(
        () =>
          createIngestionRunPreflight({
            source: "trip.com",
            report_type: "booking",
            file_bytes: fileBytes,
            rows_seen: rowsSeen
          }),
        /Invalid ingestion field: rows_seen/
      );
    }
  }
);
test(
  "ingestion preflight accepts rows_seen = 0",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight =
      await createIngestionRunPreflight({
        source: "trip.com",
        report_type: "booking",
        file_bytes: new Uint8Array([1, 2, 3]),
        rows_seen: 0
      });

    assert.equal(preflight.rows_seen, 0);
  }
);
test(
  "ingestion preflight hashes zero-length binary input deterministically",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight =
      await createIngestionRunPreflight({
        source: "trip.com",
        report_type: "booking",
        file_bytes: new Uint8Array(0),
        rows_seen: 0
      });

    assert.equal(
      preflight.source_file_sha256,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );

    assert.match(
      preflight.source_file_sha256,
      /^[0-9a-f]{64}$/
    );
  }
);
test(
  "ingestion preflight accepts ArrayBuffer and ArrayBuffer views",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const arrayBuffer =
      new Uint8Array([1, 2, 3]).buffer;

    const dataView =
      new DataView(
        new Uint8Array([1, 2, 3]).buffer
      );

    const arrayBufferPreflight =
      await createIngestionRunPreflight({
        source: "trip.com",
        report_type: "booking",
        file_bytes: arrayBuffer,
        rows_seen: 1
      });

    const dataViewPreflight =
      await createIngestionRunPreflight({
        source: "trip.com",
        report_type: "booking",
        file_bytes: dataView,
        rows_seen: 1
      });

    assert.match(
      arrayBufferPreflight.source_file_sha256,
      /^[0-9a-f]{64}$/
    );

    assert.equal(
      dataViewPreflight.source_file_sha256,
      arrayBufferPreflight.source_file_sha256
    );
  }
);
test(
  "ingestion preflight preserves original source and report_type values without trimming",
  async () => {
    const {
      createIngestionRunPreflight
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight =
      await createIngestionRunPreflight({
        source: " trip.com ",
        report_type: " booking ",
        file_bytes: new Uint8Array([1, 2, 3]),
        rows_seen: 1
      });

    assert.equal(preflight.source, " trip.com ");
    assert.equal(preflight.report_type, " booking ");
  }
);
test(
  "booking batch attribution resolves each row independently by trip_sub1",
  async () => {
    const {
      preflightTripBookingRows
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const context = {
      source: "trip.com",
      aid: "10021103",
      placementsByTripSub1:
        new Map([
          [
            "flightflex_flights_yyz_bjs_test",
            {
              publisher_id: "flightflex",
              placement:
                "flightflex_flights_yyz_bjs_test"
            }
          ],
          [
            "flightflex_auto_china_hotels_generic_test",
            {
              publisher_id: "flightflex",
              placement:
                "flightflex_auto_china_hotels_generic_test"
            }
          ]
        ])
    };

    const rows = [
      {
        orderId: "MIXED-001",
        sid: "123456",
        productLine: "htl",
        orderStatus: "S",
        amount: "100.00",
        currency: "CAD",
        tripSub1:
          "flightflex_flights_yyz_bjs_test"
      },
      {
        orderId: "MIXED-002",
        sid: "123456",
        productLine: "htl",
        orderStatus: "S",
        amount: "200.00",
        currency: "CAD",
        tripSub1:
          "flightflex_auto_china_hotels_generic_test"
      },
      {
        orderId: "MIXED-003",
        sid: "123456",
        productLine: "htl",
        orderStatus: "S",
        amount: "300.00",
        currency: "CAD",
        tripSub1: "unknown_trip_sub1"
      },
      {
        orderId: "MIXED-004",
        sid: "123456",
        productLine: "htl",
        orderStatus: "S",
        amount: "400.00",
        currency: "CAD",
        tripSub1: "   "
      }
    ];

    const normalized =
      await preflightTripBookingRows(
        rows,
        context
      );

    assert.deepEqual(
      normalized.map(
        row => ({
          publisher:
            row.attributed_publisher_id,
          placement:
            row.attributed_placement,
          status:
            row.attribution_status
        })
      ),
      [
        {
          publisher: "flightflex",
          placement:
            "flightflex_flights_yyz_bjs_test",
          status: "matched"
        },
        {
          publisher: "flightflex",
          placement:
            "flightflex_auto_china_hotels_generic_test",
          status: "matched"
        },
        {
          publisher: null,
          placement: null,
          status: "unmatched"
        },
        {
          publisher: null,
          placement: null,
          status: "missing_trip_sub1"
        }
      ]
    );
  }
);

test(
  "commission batch attribution resolves each row independently by trip_sub1",
  async () => {
    const {
      preflightTripCommissionRows
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const context = {
      source: "trip.com",
      aid: "10021103",
      placementsByTripSub1:
        new Map([
          [
            "flightflex_flights_yyz_bjs_test",
            {
              publisher_id: "flightflex",
              placement:
                "flightflex_flights_yyz_bjs_test"
            }
          ],
          [
            "flightflex_auto_china_hotels_generic_test",
            {
              publisher_id: "flightflex",
              placement:
                "flightflex_auto_china_hotels_generic_test"
            }
          ]
        ])
    };

    const rows = [
      {
        orderId: "COMM-MIXED-001",
        sid: "123456",
        commissionMonth: "2026-08",
        productLine: "htl",
        subOrderType: "hotel",
        planType: "standard",
        orderStatus: "S",
        commissionStatus: "SETTLED",
        bookingAmount: "100.00",
        commissionAmount: "5.00",
        currency: "CAD",
        tripSub1:
          "flightflex_flights_yyz_bjs_test"
      },
      {
        orderId: "COMM-MIXED-002",
        sid: "123456",
        commissionMonth: "2026-08",
        productLine: "htl",
        subOrderType: "hotel",
        planType: "standard",
        orderStatus: "S",
        commissionStatus: "UNDER_REVIEW",
        bookingAmount: "200.00",
        commissionAmount: "10.00",
        currency: "CAD",
        tripSub1:
          "flightflex_auto_china_hotels_generic_test"
      },
      {
        orderId: "COMM-MIXED-003",
        sid: "123456",
        commissionMonth: "2026-08",
        productLine: "htl",
        subOrderType: "hotel",
        planType: "standard",
        orderStatus: "S",
        commissionStatus: "SETTLED",
        bookingAmount: "300.00",
        commissionAmount: "15.00",
        currency: "CAD",
        tripSub1: "unknown_trip_sub1"
      },
      {
        orderId: "COMM-MIXED-004",
        sid: "123456",
        commissionMonth: "2026-08",
        productLine: "htl",
        subOrderType: "hotel",
        planType: "standard",
        orderStatus: "S",
        commissionStatus: "SETTLED",
        bookingAmount: "400.00",
        commissionAmount: "20.00",
        currency: "CAD",
        tripSub1: "   "
      }
    ];

    const normalized =
      await preflightTripCommissionRows(
        rows,
        context
      );

    assert.deepEqual(
      normalized.map(
        row => ({
          publisher:
            row.attributed_publisher_id,
          placement:
            row.attributed_placement,
          status:
            row.attribution_status
        })
      ),
      [
        {
          publisher: "flightflex",
          placement:
            "flightflex_flights_yyz_bjs_test",
          status: "matched"
        },
        {
          publisher: "flightflex",
          placement:
            "flightflex_auto_china_hotels_generic_test",
          status: "matched"
        },
        {
          publisher: null,
          placement: null,
          status: "unmatched"
        },
        {
          publisher: null,
          placement: null,
          status: "missing_trip_sub1"
        }
      ]
    );
  }
);
