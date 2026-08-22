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

test(
  "source-file dedupe plans new import when existingRun is null",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planSourceFileDedupe(
        {
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: "abc123"
        },
        null
      ),
      {
        dedupe_status: "new",
        should_import: true,
        existing_ingestion_run_id: null
      }
    );
  }
);

test(
  "source-file dedupe plans new import when existingRun is undefined",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planSourceFileDedupe(
        {
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: "abc123"
        },
        undefined
      ),
      {
        dedupe_status: "new",
        should_import: true,
        existing_ingestion_run_id: null
      }
    );
  }
);

test(
  "source-file dedupe plans duplicate for exact identity and returns existing ingestion_run_id",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planSourceFileDedupe(
        {
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: "abc123"
        },
        {
          ingestion_run_id: "run-001",
          source: "trip.com",
          report_type: "booking",
          source_file_sha256: "abc123",
          status: "completed"
        }
      ),
      {
        dedupe_status: "duplicate",
        should_import: false,
        existing_ingestion_run_id: "run-001"
      }
    );
  }
);

test(
  "source-file dedupe mismatches on different source",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planSourceFileDedupe(
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123"
          },
          {
            ingestion_run_id: "run-001",
            source: "other-source",
            report_type: "booking",
            source_file_sha256: "abc123"
          }
        ),
      /Mismatched ingestion dedupe candidate/
    );
  }
);

test(
  "source-file dedupe mismatches on different report_type",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planSourceFileDedupe(
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123"
          },
          {
            ingestion_run_id: "run-001",
            source: "trip.com",
            report_type: "commission",
            source_file_sha256: "abc123"
          }
        ),
      /Mismatched ingestion dedupe candidate/
    );
  }
);

test(
  "source-file dedupe mismatches on different source_file_sha256",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planSourceFileDedupe(
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123"
          },
          {
            ingestion_run_id: "run-001",
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "different-hash"
          }
        ),
      /Mismatched ingestion dedupe candidate/
    );
  }
);

test(
  "source-file dedupe ignores status for duplicate classification",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const status of ["completed", "failed"]) {
      assert.deepEqual(
        planSourceFileDedupe(
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123"
          },
          {
            ingestion_run_id: "run-001",
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123",
            status
          }
        ),
        {
          dedupe_status: "duplicate",
          should_import: false,
          existing_ingestion_run_id: "run-001"
        }
      );
    }
  }
);

test(
  "source-file dedupe fails when matching row lacks ingestion_run_id",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const ingestionRunId of [undefined, null, "", "   "]) {
      assert.throws(
        () =>
          planSourceFileDedupe(
            {
              source: "trip.com",
              report_type: "booking",
              source_file_sha256: "abc123"
            },
            {
              ingestion_run_id: ingestionRunId,
              source: "trip.com",
              report_type: "booking",
              source_file_sha256: "abc123"
            }
          ),
        /Invalid ingestion dedupe candidate: ingestion_run_id/
      );
    }
  }
);

test(
  "source-file dedupe fails on non-string ingestion_run_id",
  async () => {
    const {
      planSourceFileDedupe
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planSourceFileDedupe(
          {
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123"
          },
          {
            ingestion_run_id: 123,
            source: "trip.com",
            report_type: "booking",
            source_file_sha256: "abc123"
          }
        ),
      /Invalid ingestion dedupe candidate: ingestion_run_id/
    );
  }
);

test(
  "placement map builds empty Map from empty array",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([]);

    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
  }
);

test(
  "placement map builds a single correct mapping",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key:
            "flightflex_flights_yyz_bjs_test",
          publisher_id: "flightflex",
          placement:
            "flightflex_flights_yyz_bjs_test"
        }
      ]);

    assert.equal(map.size, 1);
    assert.deepEqual(
      map.get(
        "flightflex_flights_yyz_bjs_test"
      ),
      {
        publisher_id: "flightflex",
        placement:
          "flightflex_flights_yyz_bjs_test"
      }
    );
  }
);

test(
  "placement map builds multiple mappings",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "key-a",
          publisher_id: "publisher-a",
          placement: "placement-a"
        },
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "key-b",
          publisher_id: "publisher-b",
          placement: "placement-b"
        }
      ]);

    assert.equal(map.size, 2);
    assert.deepEqual(
      map.get("key-a"),
      {
        publisher_id: "publisher-a",
        placement: "placement-a"
      }
    );
    assert.deepEqual(
      map.get("key-b"),
      {
        publisher_id: "publisher-b",
        placement: "placement-b"
      }
    );
  }
);

test(
  "placement map keys are exact and case-sensitive",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "abc",
          publisher_id: "p1",
          placement: "abc"
        },
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "ABC",
          publisher_id: "p2",
          placement: "ABC"
        },
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: " abc ",
          publisher_id: "p3",
          placement: " abc "
        }
      ]);

    assert.equal(map.size, 3);
    assert.equal(map.get("abc").publisher_id, "p1");
    assert.equal(map.get("ABC").publisher_id, "p2");
    assert.equal(map.get(" abc ").publisher_id, "p3");
    assert.equal(map.has("Abc"), false);
  }
);

test(
  "placement map preserves leading and trailing spaces in keys and values",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "  key  ",
          publisher_id: "  publisher  ",
          placement: "  placement  "
        }
      ]);

    assert.equal(map.size, 1);
    assert.deepEqual(
      map.get("  key  "),
      {
        publisher_id: "  publisher  ",
        placement: "  placement  "
      }
    );
  }
);

test(
  "placement map handles __proto__ key safely",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "__proto__",
          publisher_id: "publisher-proto",
          placement: "placement-proto"
        }
      ]);

    assert.equal(map.size, 1);
    assert.deepEqual(
      map.get("__proto__"),
      {
        publisher_id: "publisher-proto",
        placement: "placement-proto"
      }
    );
  }
);

test(
  "placement map rejects duplicate external_tracking_key",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        buildTripSub1PlacementMap([
          {
            supplier: "trip.com",
            is_active: 1,
            external_tracking_key: "dup-key",
            publisher_id: "publisher-a",
            placement: "placement-a"
          },
          {
            supplier: "trip.com",
            is_active: 1,
            external_tracking_key: "dup-key",
            publisher_id: "publisher-b",
            placement: "placement-b"
          }
        ]),
      /Duplicate publisher placement tracking key: dup-key/
    );
  }
);

test(
  "placement map rejects invalid external_tracking_key",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const invalidKeys = [
      undefined,
      null,
      "",
      "   ",
      123
    ];

    for (const key of invalidKeys) {
      assert.throws(
        () =>
          buildTripSub1PlacementMap([
            {
              supplier: "trip.com",
              is_active: 1,
              external_tracking_key: key,
              publisher_id: "publisher-a",
              placement: "placement-a"
            }
          ]),
        /Invalid publisher placement candidate: external_tracking_key/
      );
    }
  }
);

test(
  "placement map rejects invalid publisher_id",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const invalidIds = [
      undefined,
      null,
      "",
      "   ",
      123
    ];

    for (const publisherId of invalidIds) {
      assert.throws(
        () =>
          buildTripSub1PlacementMap([
            {
              supplier: "trip.com",
              is_active: 1,
              external_tracking_key: "key-a",
              publisher_id: publisherId,
              placement: "placement-a"
            }
          ]),
        /Invalid publisher placement candidate: publisher_id/
      );
    }
  }
);

test(
  "placement map rejects invalid placement",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const invalidPlacements = [
      undefined,
      null,
      "",
      "   ",
      123
    ];

    for (const placement of invalidPlacements) {
      assert.throws(
        () =>
          buildTripSub1PlacementMap([
            {
              supplier: "trip.com",
              is_active: 1,
              external_tracking_key: "key-a",
              publisher_id: "publisher-a",
              placement
            }
          ]),
        /Invalid publisher placement candidate: placement/
      );
    }
  }
);

test(
  "placement map rejects non-trip.com supplier",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        buildTripSub1PlacementMap([
          {
            supplier: "expedia.com",
            is_active: 1,
            external_tracking_key: "key-a",
            publisher_id: "publisher-a",
            placement: "placement-a"
          }
        ]),
      /Invalid publisher placement candidate: supplier/
    );
  }
);

test(
  "placement map rejects inactive rows",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const isActive of [0, null, undefined, "1", true]) {
      assert.throws(
        () =>
          buildTripSub1PlacementMap([
            {
              supplier: "trip.com",
              is_active: isActive,
              external_tracking_key: "key-a",
              publisher_id: "publisher-a",
              placement: "placement-a"
            }
          ]),
        /Invalid publisher placement candidate: is_active/
      );
    }
  }
);

test(
  "placement map rejects non-array input",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const input of [null, undefined, {}, "rows", 123]) {
      assert.throws(
        () => buildTripSub1PlacementMap(input),
        /Invalid publisher placement rows/
      );
    }
  }
);

test(
  "placement map values contain only publisher_id and placement",
  async () => {
    const {
      buildTripSub1PlacementMap
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key: "key-a",
          publisher_id: "publisher-a",
          placement: "placement-a",
          placement_id: "ignored",
          effective_from: "2026-01-01",
          effective_to: "2026-12-31"
        }
      ]);

    assert.deepEqual(
      map.get("key-a"),
      {
        publisher_id: "publisher-a",
        placement: "placement-a"
      }
    );

    assert.deepEqual(
      Object.keys(map.get("key-a")).sort(),
      ["placement", "publisher_id"]
    );
  }
);

test(
  "placement map integrates with booking normalization",
  async () => {
    const {
      buildTripSub1PlacementMap,
      normalizeTripBookingRow
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key:
            "flightflex_flights_yyz_bjs_test",
          publisher_id: "flightflex",
          placement:
            "flightflex_flights_yyz_bjs_test"
        }
      ]);

    const normalized =
      await normalizeTripBookingRow(
        {
          orderId: "BOOKING-001",
          sid: "123456",
          productLine: "htl",
          orderStatus: "S",
          amount: "123.45",
          currency: "CAD",
          tripSub1:
            "flightflex_flights_yyz_bjs_test"
        },
        {
          source: "trip.com",
          aid: "10021103",
          placementsByTripSub1: map
        }
      );

    assert.equal(
      normalized.attributed_publisher_id,
      "flightflex"
    );
    assert.equal(
      normalized.attributed_placement,
      "flightflex_flights_yyz_bjs_test"
    );
    assert.equal(
      normalized.attribution_status,
      "matched"
    );
  }
);

test(
  "placement map integrates with commission normalization",
  async () => {
    const {
      buildTripSub1PlacementMap,
      normalizeTripCommissionRow
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const map =
      buildTripSub1PlacementMap([
        {
          supplier: "trip.com",
          is_active: 1,
          external_tracking_key:
            "flightflex_auto_china_hotels_generic_test",
          publisher_id: "flightflex",
          placement:
            "flightflex_auto_china_hotels_generic_test"
        }
      ]);

    const normalized =
      await normalizeTripCommissionRow(
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
          tripSub1:
            "flightflex_auto_china_hotels_generic_test"
        },
        {
          source: "trip.com",
          aid: "10021103",
          placementsByTripSub1: map
        }
      );

    assert.equal(
      normalized.attributed_publisher_id,
      "flightflex"
    );
    assert.equal(
      normalized.attributed_placement,
      "flightflex_auto_china_hotels_generic_test"
    );
    assert.equal(
      normalized.attribution_status,
      "matched"
    );
  }
);

test(
  "booking current-state: null existing fact plans insert",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        null
      ),
      {
        state_action: "insert",
        existing_fact_id: null
      }
    );
  }
);

test(
  "booking current-state: undefined existing fact plans insert",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: null,
          attributed_placement: null,
          attribution_status: "unmatched"
        },
        undefined
      ),
      {
        state_action: "insert",
        existing_fact_id: null
      }
    );
  }
);

test(
  "booking current-state: exact material equality plans unchanged",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "unchanged",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: different source_row_hash plans update",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-2",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: different attributed_publisher_id plans update",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex-b",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex-a",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: different attributed_placement plans update",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-b",
          attribution_status: "matched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: different attribution_status plans update",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "unmatched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: matched-to-unmatched attribution change plans update",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: null,
          attributed_placement: null,
          attribution_status: "unmatched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: unmatched-to-matched attribution change plans update",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "booking-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: null,
          attributed_placement: null,
          attribution_status: "unmatched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "booking current-state: source_record_key mismatch throws",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingCurrentState(
          {
            source_record_key: "booking-key-a",
            source_row_hash: "hash-1",
            attributed_publisher_id: null,
            attributed_placement: null,
            attribution_status: "unmatched"
          },
          {
            booking_fact_id: "fact-1",
            source_record_key: "booking-key-b",
            source_row_hash: "hash-1",
            attributed_publisher_id: null,
            attributed_placement: null,
            attribution_status: "unmatched"
          }
        ),
      /Mismatched booking current-state candidate/
    );
  }
);

test(
  "booking current-state: invalid booking_fact_id throws",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const bookingFactId of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planBookingCurrentState(
            {
              source_record_key: "booking-key",
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            },
            {
              booking_fact_id: bookingFactId,
              source_record_key: "booking-key",
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            }
          ),
        /Invalid booking current-state candidate: booking_fact_id/
      );
    }
  }
);

test(
  "booking current-state: invalid existing source_row_hash throws",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const sourceRowHash of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planBookingCurrentState(
            {
              source_record_key: "booking-key",
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            },
            {
              booking_fact_id: "fact-1",
              source_record_key: "booking-key",
              source_row_hash: sourceRowHash,
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            }
          ),
        /Invalid booking current-state candidate: source_row_hash/
      );
    }
  }
);

test(
  "booking current-state: invalid incoming source_record_key throws",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const sourceRecordKey of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planBookingCurrentState(
            {
              source_record_key: sourceRecordKey,
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            },
            null
          ),
        /Invalid booking current-state input: source_record_key/
      );
    }
  }
);

test(
  "booking current-state: invalid incoming source_row_hash throws",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const sourceRowHash of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planBookingCurrentState(
            {
              source_record_key: "booking-key",
              source_row_hash: sourceRowHash,
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            },
            null
          ),
        /Invalid booking current-state input: source_row_hash/
      );
    }
  }
);

test(
  "booking current-state: malformed existing attribution throws",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const incoming = {
      source_record_key: "booking-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "unmatched"
    };

    const malformedAttributions = [
      {
        attributed_publisher_id: 123,
        attributed_placement: null,
        attribution_status: "unmatched"
      },
      {
        attributed_publisher_id: null,
        attributed_placement: 123,
        attribution_status: "unmatched"
      },
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: null
      },
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: "   "
      }
    ];

    for (const attribution of malformedAttributions) {
      assert.throws(
        () =>
          planBookingCurrentState(
            incoming,
            {
              booking_fact_id: "fact-1",
              source_record_key: "booking-key",
              source_row_hash: "hash-1",
              ...attribution
            }
          ),
        /Invalid booking current-state candidate: attribution/
      );
    }
  }
);

test(
  "booking current-state: null vs undefined attribution values are not equivalent",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingCurrentState(
          {
            source_record_key: "booking-key",
            source_row_hash: "hash-1",
            attributed_publisher_id: null,
            attributed_placement: undefined,
            attribution_status: "unmatched"
          },
          {
            booking_fact_id: "fact-1",
            source_record_key: "booking-key",
            source_row_hash: "hash-1",
            attributed_publisher_id: null,
            attributed_placement: null,
            attribution_status: "unmatched"
          }
        ),
      /Invalid booking current-state input: attribution/
    );
  }
);

test(
  "booking current-state: leading/trailing spaces compared exactly",
  async () => {
    const {
      planBookingCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planBookingCurrentState(
        {
          source_record_key: "  booking-key  ",
          source_row_hash: "  hash-1  ",
          attributed_publisher_id: "  flightflex  ",
          attributed_placement: "  placement-a  ",
          attribution_status: "  matched  "
        },
        {
          booking_fact_id: "fact-1",
          source_record_key: "  booking-key  ",
          source_row_hash: "  hash-1  ",
          attributed_publisher_id: "  flightflex  ",
          attributed_placement: "  placement-a  ",
          attribution_status: "  matched  "
        }
      ),
      {
        state_action: "unchanged",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "commission current-state: null existing fact plans insert",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCommissionCurrentState(
        {
          commission_record_key: "commission-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        null
      ),
      {
        state_action: "insert",
        existing_fact_id: null
      }
    );
  }
);

test(
  "commission current-state: exact material equality plans unchanged",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCommissionCurrentState(
        {
          commission_record_key: "commission-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        {
          commission_fact_id: "fact-1",
          commission_record_key: "commission-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "unchanged",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "commission current-state: different source_row_hash plans update",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCommissionCurrentState(
        {
          commission_record_key: "commission-key",
          source_row_hash: "hash-2",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        },
        {
          commission_fact_id: "fact-1",
          commission_record_key: "commission-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "commission current-state: attribution-only change plans update",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCommissionCurrentState(
        {
          commission_record_key: "commission-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: null,
          attributed_placement: null,
          attribution_status: "unmatched"
        },
        {
          commission_fact_id: "fact-1",
          commission_record_key: "commission-key",
          source_row_hash: "hash-1",
          attributed_publisher_id: "flightflex",
          attributed_placement: "placement-a",
          attribution_status: "matched"
        }
      ),
      {
        state_action: "update",
        existing_fact_id: "fact-1"
      }
    );
  }
);

test(
  "commission current-state: commission_record_key mismatch throws",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planCommissionCurrentState(
          {
            commission_record_key: "commission-key-a",
            source_row_hash: "hash-1",
            attributed_publisher_id: null,
            attributed_placement: null,
            attribution_status: "unmatched"
          },
          {
            commission_fact_id: "fact-1",
            commission_record_key: "commission-key-b",
            source_row_hash: "hash-1",
            attributed_publisher_id: null,
            attributed_placement: null,
            attribution_status: "unmatched"
          }
        ),
      /Mismatched commission current-state candidate/
    );
  }
);

test(
  "commission current-state: invalid commission_fact_id throws",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const commissionFactId of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planCommissionCurrentState(
            {
              commission_record_key: "commission-key",
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            },
            {
              commission_fact_id: commissionFactId,
              commission_record_key: "commission-key",
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            }
          ),
        /Invalid commission current-state candidate: commission_fact_id/
      );
    }
  }
);

test(
  "commission current-state: invalid existing source_row_hash throws",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const sourceRowHash of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planCommissionCurrentState(
            {
              commission_record_key: "commission-key",
              source_row_hash: "hash-1",
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            },
            {
              commission_fact_id: "fact-1",
              commission_record_key: "commission-key",
              source_row_hash: sourceRowHash,
              attributed_publisher_id: null,
              attributed_placement: null,
              attribution_status: "unmatched"
            }
          ),
        /Invalid commission current-state candidate: source_row_hash/
      );
    }
  }
);

test(
  "commission current-state: malformed existing attribution throws",
  async () => {
    const {
      planCommissionCurrentState
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const incoming = {
      commission_record_key: "commission-key",
      source_row_hash: "hash-1",
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "unmatched"
    };

    const malformedAttributions = [
      {
        attributed_publisher_id: 123,
        attributed_placement: null,
        attribution_status: "unmatched"
      },
      {
        attributed_publisher_id: null,
        attributed_placement: 123,
        attribution_status: "unmatched"
      },
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: null
      },
      {
        attributed_publisher_id: null,
        attributed_placement: null,
        attribution_status: "   "
      }
    ];

    for (const attribution of malformedAttributions) {
      assert.throws(
        () =>
          planCommissionCurrentState(
            incoming,
            {
              commission_fact_id: "fact-1",
              commission_record_key: "commission-key",
              source_row_hash: "hash-1",
              ...attribution
            }
          ),
        /Invalid commission current-state candidate: attribution/
      );
    }
  }
);

test(
  "observation metadata: insert returns all five metadata fields",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCurrentStateObservationMetadata(
        {
          state_action: "insert",
          existing_fact_id: null
        },
        {
          ingestion_run_id: "run-001",
          observed_at: "2026-08-21T22:00:00.000Z"
        }
      ),
      {
        first_seen_at: "2026-08-21T22:00:00.000Z",
        last_seen_at: "2026-08-21T22:00:00.000Z",
        first_ingestion_run_id: "run-001",
        last_ingestion_run_id: "run-001",
        source_ingested_at: "2026-08-21T22:00:00.000Z"
      }
    );
  }
);

test(
  "observation metadata: insert first_seen_at equals last_seen_at",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCurrentStateObservationMetadata(
        {
          state_action: "insert",
          existing_fact_id: null
        },
        {
          ingestion_run_id: "run-001",
          observed_at: "2026-08-21T22:00:00.000Z"
        }
      );

    assert.equal(result.first_seen_at, result.last_seen_at);
  }
);

test(
  "observation metadata: insert first_ingestion_run_id equals last_ingestion_run_id",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCurrentStateObservationMetadata(
        {
          state_action: "insert",
          existing_fact_id: null
        },
        {
          ingestion_run_id: "run-001",
          observed_at: "2026-08-21T22:00:00.000Z"
        }
      );

    assert.equal(
      result.first_ingestion_run_id,
      result.last_ingestion_run_id
    );
  }
);

test(
  "observation metadata: update returns exactly latest-observation fields",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCurrentStateObservationMetadata(
        {
          state_action: "update",
          existing_fact_id: "fact-1"
        },
        {
          ingestion_run_id: "run-002",
          observed_at: "2026-08-21T23:00:00.000Z"
        }
      ),
      {
        last_seen_at: "2026-08-21T23:00:00.000Z",
        last_ingestion_run_id: "run-002",
        source_ingested_at: "2026-08-21T23:00:00.000Z"
      }
    );
  }
);

test(
  "observation metadata: update omits first-observation fields",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCurrentStateObservationMetadata(
        {
          state_action: "update",
          existing_fact_id: "fact-1"
        },
        {
          ingestion_run_id: "run-002",
          observed_at: "2026-08-21T23:00:00.000Z"
        }
      );

    assert.equal("first_seen_at" in result, false);
    assert.equal("first_ingestion_run_id" in result, false);
  }
);

test(
  "observation metadata: unchanged uses same shape as update",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.deepEqual(
      planCurrentStateObservationMetadata(
        {
          state_action: "unchanged",
          existing_fact_id: "fact-1"
        },
        {
          ingestion_run_id: "run-003",
          observed_at: "2026-08-22T00:00:00.000Z"
        }
      ),
      {
        last_seen_at: "2026-08-22T00:00:00.000Z",
        last_ingestion_run_id: "run-003",
        source_ingested_at: "2026-08-22T00:00:00.000Z"
      }
    );
  }
);

test(
  "observation metadata: unchanged omits first-observation fields",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCurrentStateObservationMetadata(
        {
          state_action: "unchanged",
          existing_fact_id: "fact-1"
        },
        {
          ingestion_run_id: "run-003",
          observed_at: "2026-08-22T00:00:00.000Z"
        }
      );

    assert.equal("first_seen_at" in result, false);
    assert.equal("first_ingestion_run_id" in result, false);
  }
);

test(
  "observation metadata: source_ingested_at equals observed_at for every action",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const observedAt = "2026-08-21T22:30:00.000Z";

    for (const state_action of [
      "insert",
      "update",
      "unchanged"
    ]) {
      const result =
        planCurrentStateObservationMetadata(
          {
            state_action,
            existing_fact_id: null
          },
          {
            ingestion_run_id: "run-001",
            observed_at: observedAt
          }
        );

      assert.equal(result.source_ingested_at, observedAt);
    }
  }
);

test(
  "observation metadata: ingestion_run_id with spaces is preserved exactly",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCurrentStateObservationMetadata(
        {
          state_action: "insert",
          existing_fact_id: null
        },
        {
          ingestion_run_id: " run-001 ",
          observed_at: "2026-08-21T22:00:00.000Z"
        }
      );

    assert.equal(result.first_ingestion_run_id, " run-001 ");
    assert.equal(result.last_ingestion_run_id, " run-001 ");
  }
);

test(
  "observation metadata: observed_at with spaces is preserved exactly",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCurrentStateObservationMetadata(
        {
          state_action: "insert",
          existing_fact_id: null
        },
        {
          ingestion_run_id: "run-001",
          observed_at: " 2026-08-21T22:00:00.000Z "
        }
      );

    assert.equal(
      result.first_seen_at,
      " 2026-08-21T22:00:00.000Z "
    );
    assert.equal(
      result.last_seen_at,
      " 2026-08-21T22:00:00.000Z "
    );
    assert.equal(
      result.source_ingested_at,
      " 2026-08-21T22:00:00.000Z "
    );
  }
);

test(
  "observation metadata: invalid ingestion_run_id throws",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const ingestionRunId of [
      undefined,
      null,
      "",
      "   ",
      123
    ]) {
      assert.throws(
        () =>
          planCurrentStateObservationMetadata(
            {
              state_action: "insert",
              existing_fact_id: null
            },
            {
              ingestion_run_id: ingestionRunId,
              observed_at: "2026-08-21T22:00:00.000Z"
            }
          ),
        /Invalid observation context: ingestion_run_id/
      );
    }
  }
);

test(
  "observation metadata: invalid observed_at throws",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const observedAt of [
      undefined,
      null,
      "",
      "   ",
      123
    ]) {
      assert.throws(
        () =>
          planCurrentStateObservationMetadata(
            {
              state_action: "insert",
              existing_fact_id: null
            },
            {
              ingestion_run_id: "run-001",
              observed_at: observedAt
            }
          ),
        /Invalid observation context: observed_at/
      );
    }
  }
);

test(
  "observation metadata: null statePlan throws",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planCurrentStateObservationMetadata(
          null,
          {
            ingestion_run_id: "run-001",
            observed_at: "2026-08-21T22:00:00.000Z"
          }
        ),
      /Invalid current-state observation plan/
    );
  }
);

test(
  "observation metadata: array statePlan throws",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planCurrentStateObservationMetadata(
          [],
          {
            ingestion_run_id: "run-001",
            observed_at: "2026-08-21T22:00:00.000Z"
          }
        ),
      /Invalid current-state observation plan/
    );
  }
);

test(
  "observation metadata: unknown state_action throws",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const stateAction of [
      "INSERT",
      "UPDATE",
      "UNCHANGED",
      "delete",
      "",
      undefined
    ]) {
      assert.throws(
        () =>
          planCurrentStateObservationMetadata(
            {
              state_action: stateAction,
              existing_fact_id: null
            },
            {
              ingestion_run_id: "run-001",
              observed_at: "2026-08-21T22:00:00.000Z"
            }
          ),
        /Invalid current-state observation plan/
      );
    }
  }
);

test(
  "observation metadata: does not mutate statePlan or context",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const statePlan = {
      state_action: "insert",
      existing_fact_id: null
    };

    const context = {
      ingestion_run_id: "run-001",
      observed_at: "2026-08-21T22:00:00.000Z"
    };

    const statePlanBefore = JSON.stringify(statePlan);
    const contextBefore = JSON.stringify(context);

    planCurrentStateObservationMetadata(statePlan, context);

    assert.equal(JSON.stringify(statePlan), statePlanBefore);
    assert.equal(JSON.stringify(context), contextBefore);
  }
);

test(
  "observation metadata: repeated identical inputs produce deep-equal outputs",
  async () => {
    const {
      planCurrentStateObservationMetadata
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const statePlan = {
      state_action: "update",
      existing_fact_id: "fact-1"
    };

    const context = {
      ingestion_run_id: "run-002",
      observed_at: "2026-08-21T23:00:00.000Z"
    };

    const first =
      planCurrentStateObservationMetadata(statePlan, context);
    const second =
      planCurrentStateObservationMetadata(statePlan, context);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
  }
);

const BOOKING_NORMALIZED_ROW = {
  source_record_key: "booking-key",
  source_row_hash: "hash-1",
  source: "trip.com",
  source_order_id: "BOOKING-001",
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

const COMMISSION_NORMALIZED_ROW = {
  commission_record_key: "commission-key",
  source_row_hash: "hash-1",
  source: "trip.com",
  source_order_id: "BOOKING-001",
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

const INSERT_OBSERVATION = {
  first_seen_at: "2026-08-21T22:00:00.000Z",
  last_seen_at: "2026-08-21T22:00:00.000Z",
  first_ingestion_run_id: "run-001",
  last_ingestion_run_id: "run-001",
  source_ingested_at: "2026-08-21T22:00:00.000Z"
};

const LATEST_OBSERVATION = {
  last_seen_at: "2026-08-22T00:00:00.000Z",
  last_ingestion_run_id: "run-002",
  source_ingested_at: "2026-08-22T00:00:00.000Z"
};

test(
  "booking persistence: insert maps to persistence_action insert",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.persistence_action, "insert");
  }
);

test(
  "booking persistence: insert booking_fact_id comes exactly from new_fact_id",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: " fact-new ",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.booking_fact_id, " fact-new ");
    assert.equal(result.values.booking_fact_id, " fact-new ");
  }
);

test(
  "booking persistence: insert values contain exact complete booking schema field set",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.deepEqual(
      Object.keys(result.values).sort(),
      [
        "aid",
        "arrival_city",
        "arrival_country",
        "attributed_placement",
        "attributed_publisher_id",
        "attribution_status",
        "booker_region",
        "booking_amount_micros",
        "booking_amount_raw",
        "booking_fact_id",
        "booking_window",
        "currency",
        "departure_city",
        "departure_country",
        "first_ingestion_run_id",
        "first_seen_at",
        "last_ingestion_run_id",
        "last_seen_at",
        "normalized_order_status",
        "normalized_product",
        "order_date",
        "order_platform",
        "ouid",
        "product_end_date",
        "product_start_date",
        "raw_order_status",
        "raw_payload_json",
        "raw_product_line",
        "sid",
        "sid_name",
        "source",
        "source_ingested_at",
        "source_order_id",
        "source_record_key",
        "source_row_hash",
        "trip_sub1",
        "trip_sub3"
      ]
    );
  }
);

test(
  "booking persistence: insert preserves null currency",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.values.currency, null);
  }
);

test(
  "booking persistence: insert preserves 0 booking_amount_micros",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        { ...BOOKING_NORMALIZED_ROW, booking_amount_micros: 0 },
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.values.booking_amount_micros, 0);
  }
);

test(
  "booking persistence: insert preserves exact raw_payload_json string",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: " {\"raw\": true} "
        }
      );

    assert.equal(result.values.raw_payload_json, " {\"raw\": true} ");
  }
);

test(
  "booking persistence: insert contains all five observation fields",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.values.first_seen_at, INSERT_OBSERVATION.first_seen_at);
    assert.equal(result.values.last_seen_at, INSERT_OBSERVATION.last_seen_at);
    assert.equal(
      result.values.first_ingestion_run_id,
      INSERT_OBSERVATION.first_ingestion_run_id
    );
    assert.equal(
      result.values.last_ingestion_run_id,
      INSERT_OBSERVATION.last_ingestion_run_id
    );
    assert.equal(
      result.values.source_ingested_at,
      INSERT_OBSERVATION.source_ingested_at
    );
  }
);

test(
  "booking persistence: insert requires existing_fact_id to be null",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingFactPersistence(
          BOOKING_NORMALIZED_ROW,
          { state_action: "insert", existing_fact_id: "fact-1" },
          INSERT_OBSERVATION,
          {
            new_fact_id: "fact-new",
            raw_payload_json: "{\"raw\":true}"
          }
        ),
      /Invalid fact persistence state plan/
    );
  }
);

test(
  "booking persistence: insert missing/blank/non-string new_fact_id fails",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const newFactId of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planBookingFactPersistence(
            BOOKING_NORMALIZED_ROW,
            { state_action: "insert", existing_fact_id: null },
            INSERT_OBSERVATION,
            {
              new_fact_id: newFactId,
              raw_payload_json: "{\"raw\":true}"
            }
          ),
        /Invalid booking persistence context: new_fact_id/
      );
    }
  }
);

test(
  "booking persistence: insert missing/blank/non-string raw_payload_json fails",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const rawPayloadJson of [undefined, null, "", "   ", 123]) {
      assert.throws(
        () =>
          planBookingFactPersistence(
            BOOKING_NORMALIZED_ROW,
            { state_action: "insert", existing_fact_id: null },
            INSERT_OBSERVATION,
            {
              new_fact_id: "fact-new",
              raw_payload_json: rawPayloadJson
            }
          ),
        /Invalid booking persistence context: raw_payload_json/
      );
    }
  }
);

test(
  "booking persistence: update maps to update_material",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.persistence_action, "update_material");
  }
);

test(
  "booking persistence: update uses exact existing_fact_id",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: " fact-1 " },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.booking_fact_id, " fact-1 ");
  }
);

test(
  "booking persistence: update values exclude booking_fact_id and source_record_key",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("booking_fact_id" in result.values, false);
    assert.equal("source_record_key" in result.values, false);
  }
);

test(
  "booking persistence: update excludes first-observation metadata",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        { ...LATEST_OBSERVATION, first_seen_at: "x", first_ingestion_run_id: "y" },
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("first_seen_at" in result.values, false);
    assert.equal("first_ingestion_run_id" in result.values, false);
  }
);

test(
  "booking persistence: update includes latest three observation fields",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.values.last_seen_at, LATEST_OBSERVATION.last_seen_at);
    assert.equal(
      result.values.last_ingestion_run_id,
      LATEST_OBSERVATION.last_ingestion_run_id
    );
    assert.equal(
      result.values.source_ingested_at,
      LATEST_OBSERVATION.source_ingested_at
    );
  }
);

test(
  "booking persistence: update includes raw_payload_json",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.values.raw_payload_json, "{\"raw\":true}");
  }
);

test(
  "booking persistence: update preserves attribution-only material values exactly",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = {
      ...BOOKING_NORMALIZED_ROW,
      source_row_hash: "hash-1",
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "unmatched"
    };

    const result =
      planBookingFactPersistence(
        row,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.values.source_row_hash, "hash-1");
    assert.equal(result.values.attributed_publisher_id, null);
    assert.equal(result.values.attributed_placement, null);
    assert.equal(result.values.attribution_status, "unmatched");
  }
);

test(
  "booking persistence: unchanged maps to update_observation",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "unchanged", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        {}
      );

    assert.equal(result.persistence_action, "update_observation");
  }
);

test(
  "booking persistence: unchanged values contain exactly three keys",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "unchanged", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        {}
      );

    assert.deepEqual(
      Object.keys(result.values).sort(),
      [
        "last_ingestion_run_id",
        "last_seen_at",
        "source_ingested_at"
      ]
    );
  }
);

test(
  "booking persistence: unchanged does not contain raw_payload_json or material fields",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "unchanged", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("raw_payload_json" in result.values, false);
    assert.equal("source_row_hash" in result.values, false);
    assert.equal("attributed_publisher_id" in result.values, false);
    assert.equal("attributed_placement" in result.values, false);
    assert.equal("attribution_status" in result.values, false);
  }
);

test(
  "commission persistence: insert complete exact commission schema field set",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.deepEqual(
      Object.keys(result.values).sort(),
      [
        "aid",
        "attributed_placement",
        "attributed_publisher_id",
        "attribution_status",
        "booking_amount_micros",
        "booking_amount_raw",
        "check_out_or_issue_date",
        "commission_amount_micros",
        "commission_amount_raw",
        "commission_fact_id",
        "commission_month",
        "commission_record_key",
        "currency",
        "first_ingestion_run_id",
        "first_seen_at",
        "last_ingestion_run_id",
        "last_seen_at",
        "normalized_commission_status",
        "normalized_order_status",
        "normalized_product",
        "order_date",
        "ouid",
        "plan_type",
        "ratio_raw",
        "raw_commission_status",
        "raw_order_status",
        "raw_payload_json",
        "raw_product_line",
        "region",
        "sid",
        "sid_name",
        "source",
        "source_ingested_at",
        "source_order_id",
        "source_row_hash",
        "sub_order_type",
        "trip_sub1",
        "trip_sub3"
      ]
    );
  }
);

test(
  "commission persistence: insert preserves negative commission_amount_micros",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.values.commission_amount_micros, -5000000);
  }
);

test(
  "commission persistence: insert preserves null currency",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: "fact-new",
          raw_payload_json: "{\"raw\":true}"
        }
      );

    assert.equal(result.values.currency, null);
  }
);

test(
  "commission persistence: update maps to update_material",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.persistence_action, "update_material");
  }
);

test(
  "commission persistence: update excludes commission_fact_id / commission_record_key",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("commission_fact_id" in result.values, false);
    assert.equal("commission_record_key" in result.values, false);
  }
);

test(
  "commission persistence: update excludes first-observation metadata",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        { ...LATEST_OBSERVATION, first_seen_at: "x", first_ingestion_run_id: "y" },
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("first_seen_at" in result.values, false);
    assert.equal("first_ingestion_run_id" in result.values, false);
  }
);

test(
  "commission persistence: update includes latest observation + raw_payload_json",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal(result.values.last_seen_at, LATEST_OBSERVATION.last_seen_at);
    assert.equal(
      result.values.last_ingestion_run_id,
      LATEST_OBSERVATION.last_ingestion_run_id
    );
    assert.equal(
      result.values.source_ingested_at,
      LATEST_OBSERVATION.source_ingested_at
    );
    assert.equal(result.values.raw_payload_json, "{\"raw\":true}");
  }
);

test(
  "commission persistence: unchanged maps to update_observation",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "unchanged", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        {}
      );

    assert.equal(result.persistence_action, "update_observation");
  }
);

test(
  "commission persistence: unchanged contains exactly three values",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "unchanged", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        {}
      );

    assert.deepEqual(
      Object.keys(result.values).sort(),
      [
        "last_ingestion_run_id",
        "last_seen_at",
        "source_ingested_at"
      ]
    );
  }
);

test(
  "commission persistence: unchanged excludes raw_payload_json and material fields",
  async () => {
    const {
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planCommissionFactPersistence(
        COMMISSION_NORMALIZED_ROW,
        { state_action: "unchanged", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("raw_payload_json" in result.values, false);
    assert.equal("source_row_hash" in result.values, false);
    assert.equal("attributed_publisher_id" in result.values, false);
  }
);

test(
  "persistence: unknown / uppercase state_action rejected",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    for (const stateAction of ["INSERT", "UPDATE", "UNCHANGED", "delete", ""]) {
      assert.throws(
        () =>
          planBookingFactPersistence(
            BOOKING_NORMALIZED_ROW,
            { state_action: stateAction, existing_fact_id: "fact-1" },
            LATEST_OBSERVATION,
            { raw_payload_json: "{\"raw\":true}" }
          ),
        /Invalid fact persistence state plan/
      );
    }
  }
);

test(
  "persistence: update with null existing_fact_id rejected",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingFactPersistence(
          BOOKING_NORMALIZED_ROW,
          { state_action: "update", existing_fact_id: null },
          LATEST_OBSERVATION,
          { raw_payload_json: "{\"raw\":true}" }
        ),
      /Invalid fact persistence state plan/
    );
  }
);

test(
  "persistence: unchanged with blank existing_fact_id rejected",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingFactPersistence(
          BOOKING_NORMALIZED_ROW,
          { state_action: "unchanged", existing_fact_id: "   " },
          LATEST_OBSERVATION,
          {}
        ),
      /Invalid fact persistence state plan/
    );
  }
);

test(
  "persistence: insert with non-null existing_fact_id rejected",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingFactPersistence(
          BOOKING_NORMALIZED_ROW,
          { state_action: "insert", existing_fact_id: undefined },
          INSERT_OBSERVATION,
          {
            new_fact_id: "fact-new",
            raw_payload_json: "{\"raw\":true}"
          }
        ),
      /Invalid fact persistence state plan/
    );
  }
);

test(
  "persistence: invalid observation metadata rejected",
  async () => {
    const {
      planBookingFactPersistence,
      planCommissionFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    assert.throws(
      () =>
        planBookingFactPersistence(
          BOOKING_NORMALIZED_ROW,
          { state_action: "insert", existing_fact_id: null },
          null,
          { new_fact_id: "fact-new", raw_payload_json: "{\"raw\":true}" }
        ),
      /Invalid booking persistence observation metadata/
    );

    assert.throws(
      () =>
        planCommissionFactPersistence(
          COMMISSION_NORMALIZED_ROW,
          { state_action: "update", existing_fact_id: "fact-1" },
          { last_seen_at: "   ", last_ingestion_run_id: "r", source_ingested_at: "s" },
          { raw_payload_json: "{\"raw\":true}" }
        ),
      /Invalid commission persistence observation metadata/
    );
  }
);

test(
  "persistence: context whitespace strings are preserved exactly when valid",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        BOOKING_NORMALIZED_ROW,
        { state_action: "insert", existing_fact_id: null },
        INSERT_OBSERVATION,
        {
          new_fact_id: " fact-new ",
          raw_payload_json: " {\"raw\": true} "
        }
      );

    assert.equal(result.booking_fact_id, " fact-new ");
    assert.equal(result.values.raw_payload_json, " {\"raw\": true} ");
  }
);

test(
  "persistence: no input mutation",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const normalizedRow = { ...BOOKING_NORMALIZED_ROW };
    const statePlan = { state_action: "update", existing_fact_id: "fact-1" };
    const observationMetadata = { ...LATEST_OBSERVATION };
    const context = { raw_payload_json: "{\"raw\":true}" };

    const rowBefore = JSON.stringify(normalizedRow);
    const planBefore = JSON.stringify(statePlan);
    const metadataBefore = JSON.stringify(observationMetadata);
    const contextBefore = JSON.stringify(context);

    planBookingFactPersistence(
      normalizedRow,
      statePlan,
      observationMetadata,
      context
    );

    assert.equal(JSON.stringify(normalizedRow), rowBefore);
    assert.equal(JSON.stringify(statePlan), planBefore);
    assert.equal(JSON.stringify(observationMetadata), metadataBefore);
    assert.equal(JSON.stringify(context), contextBefore);
  }
);

test(
  "persistence: deterministic deep-equal results",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const args = [
      BOOKING_NORMALIZED_ROW,
      { state_action: "update", existing_fact_id: "fact-1" },
      LATEST_OBSERVATION,
      { raw_payload_json: "{\"raw\":true}" }
    ];

    const first = planBookingFactPersistence(...args);
    const second = planBookingFactPersistence(...args);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
  }
);

test(
  "persistence: extra unknown normalizedRow property is not copied into values",
  async () => {
    const {
      planBookingFactPersistence
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const result =
      planBookingFactPersistence(
        { ...BOOKING_NORMALIZED_ROW, unexpected_field: "leak" },
        { state_action: "update", existing_fact_id: "fact-1" },
        LATEST_OBSERVATION,
        { raw_payload_json: "{\"raw\":true}" }
      );

    assert.equal("unexpected_field" in result.values, false);
  }
);

function makeStatePlan(action) {
  return action === "insert"
    ? { state_action: "insert", existing_fact_id: null }
    : { state_action: action, existing_fact_id: "fact-1" };
}

function makeSuccessfulContext(overrides = {}) {
  return Object.assign(
    {
      ingestion_run_id: "run-001",
      started_at: "2026-08-01T00:00:00Z",
      observed_at: "2026-08-01T00:05:00Z"
    },
    overrides
  );
}

const SUCCESSFUL_RUN_KEYS = [
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

async function makePreflight(overrides = {}) {
  const {
    createIngestionRunPreflight
  } = await import(
    "../reporting-importer-core-v0.1.mjs"
  );

  const base = await createIngestionRunPreflight({
    source: "trip.com",
    report_type: "booking",
    source_filename: "booking-report.csv",
    report_period_from: "2026-08-01",
    report_period_to: "2026-08-20",
    file_bytes: new TextEncoder().encode("report-v0.1\n"),
    rows_seen: 3
  });

  return Object.assign(base, overrides);
}

test(
  "successful ingestion run counts insert/update/unchanged and locks completed",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight();
    const context = makeSuccessfulContext();

    const result = planSuccessfulIngestionRun(
      preflight,
      [
        makeStatePlan("insert"),
        makeStatePlan("update"),
        makeStatePlan("unchanged")
      ],
      context
    );

    assert.equal(result.status, "completed");
    assert.equal(result.error_summary, null);
    assert.equal(result.rows_rejected, 0);
    assert.equal(result.rows_inserted, 1);
    assert.equal(result.rows_updated, 1);
    assert.equal(result.rows_unchanged, 1);
    assert.equal(result.rows_seen, 3);
    assert.equal(
      result.rows_inserted +
        result.rows_updated +
        result.rows_unchanged +
        result.rows_rejected,
      result.rows_seen
    );
    assert.deepEqual(Object.keys(result), SUCCESSFUL_RUN_KEYS);
  }
);

test(
  "successful ingestion run maps every output field exactly",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight();
    const context = makeSuccessfulContext({
      ingestion_run_id: " run-with-spaces ",
      started_at: " started-at ",
      observed_at: " observed-at "
    });

    const result = planSuccessfulIngestionRun(
      preflight,
      [
        makeStatePlan("insert"),
        makeStatePlan("update"),
        makeStatePlan("unchanged")
      ],
      context
    );

    assert.equal(result.ingestion_run_id, " run-with-spaces ");
    assert.equal(result.source, "trip.com");
    assert.equal(result.report_type, "booking");
    assert.equal(result.report_period_from, "2026-08-01");
    assert.equal(result.report_period_to, "2026-08-20");
    assert.equal(result.source_filename, "booking-report.csv");
    assert.equal(
      result.source_file_sha256,
      preflight.source_file_sha256
    );
    assert.equal(result.started_at, " started-at ");
    assert.equal(result.completed_at, " observed-at ");
    assert.equal(result.rows_seen, 3);
  }
);

test(
  "successful ingestion run preserves optional null preflight values",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({
      source_filename: null,
      report_period_from: null,
      report_period_to: null,
      rows_seen: 1
    });
    const context = makeSuccessfulContext();

    const result = planSuccessfulIngestionRun(
      preflight,
      [makeStatePlan("insert")],
      context
    );

    assert.equal(result.source_filename, null);
    assert.equal(result.report_period_from, null);
    assert.equal(result.report_period_to, null);
  }
);

test(
  "successful ingestion run accepts zero-row import",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 0 });
    const context = makeSuccessfulContext();

    const result = planSuccessfulIngestionRun(
      preflight,
      [],
      context
    );

    assert.equal(result.rows_seen, 0);
    assert.equal(result.rows_inserted, 0);
    assert.equal(result.rows_updated, 0);
    assert.equal(result.rows_unchanged, 0);
    assert.equal(result.rows_rejected, 0);
    assert.equal(result.status, "completed");
  }
);

test(
  "successful ingestion run rejects preflight length mismatch",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 3 });
    const context = makeSuccessfulContext();

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          [makeStatePlan("insert")],
          context
        ),
      /Successful ingestion row count mismatch/
    );
  }
);

test(
  "successful ingestion run rejects malformed preflight",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const context = makeSuccessfulContext();

    const malformed = [
      null,
      [],
      "preflight",
      {},
      { source: "   ", report_type: "booking", source_file_sha256: "h", rows_seen: 0 },
      { source: "trip.com", report_type: "   ", source_file_sha256: "h", rows_seen: 0 },
      { source: "trip.com", report_type: "booking", source_file_sha256: "   ", rows_seen: 0 },
      { source: "trip.com", report_type: "booking", source_file_sha256: 123, rows_seen: 0 },
      { source: "trip.com", report_type: "booking", source_file_sha256: "h", rows_seen: -1 },
      { source: "trip.com", report_type: "booking", source_file_sha256: "h", rows_seen: 1.5 },
      { source: "trip.com", report_type: "booking", source_file_sha256: "h", rows_seen: "1" },
      { source: "trip.com", report_type: "booking", source_file_sha256: "h", rows_seen: null }
    ];

    for (const preflight of malformed) {
      assert.throws(
        () =>
          planSuccessfulIngestionRun(
            preflight,
            [],
            context
          ),
        /Invalid successful ingestion preflight/
      );
    }
  }
);

test(
  "successful ingestion run rejects non-array and malformed state plans",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const context = makeSuccessfulContext();
    const preflight = await makePreflight({ rows_seen: 1 });

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          { state_action: "insert" },
          context
        ),
      /Invalid successful ingestion state plans/
    );

    const badPlans = [
      [null],
      [{}],
      [{ state_action: "INSERT" }],
      [{ state_action: "UPDATE" }],
      [{ state_action: "unchanged!" }],
      ["insert"]
    ];

    for (const statePlans of badPlans) {
      assert.throws(
        () =>
          planSuccessfulIngestionRun(
            { source: "trip.com", report_type: "booking", source_file_sha256: "h", rows_seen: 1 },
            statePlans,
            context
          ),
        /Invalid successful ingestion state plans/
      );
    }
  }
);

test(
  "successful ingestion run rejects missing or blank context fields",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 1 });
    const plans = [makeStatePlan("insert")];

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { started_at: "a", observed_at: "b" }
        ),
      /Invalid successful ingestion context: ingestion_run_id/
    );

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { ingestion_run_id: "r", observed_at: "b" }
        ),
      /Invalid successful ingestion context: started_at/
    );

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { ingestion_run_id: "r", started_at: "a" }
        ),
      /Invalid successful ingestion context: observed_at/
    );

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { ingestion_run_id: "   ", started_at: "a", observed_at: "b" }
        ),
      /Invalid successful ingestion context: ingestion_run_id/
    );

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { ingestion_run_id: "r", started_at: "   ", observed_at: "b" }
        ),
      /Invalid successful ingestion context: started_at/
    );

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { ingestion_run_id: "r", started_at: "a", observed_at: "   " }
        ),
      /Invalid successful ingestion context: observed_at/
    );

    assert.throws(
      () =>
        planSuccessfulIngestionRun(
          preflight,
          plans,
          { ingestion_run_id: 123, started_at: "a", observed_at: "b" }
        ),
      /Invalid successful ingestion context: ingestion_run_id/
    );
  }
);

test(
  "successful ingestion run does not mutate inputs and is deterministic",
  async () => {
    const {
      planSuccessfulIngestionRun
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight();
    const plans = [
      makeStatePlan("insert"),
      makeStatePlan("update"),
      makeStatePlan("unchanged")
    ];
    const context = makeSuccessfulContext();

    const preflightSnapshot = JSON.stringify(preflight);
    const plansSnapshot = JSON.stringify(plans);
    const contextSnapshot = JSON.stringify(context);

    const first = planSuccessfulIngestionRun(preflight, plans, context);
    const second = planSuccessfulIngestionRun(preflight, plans, context);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);

    assert.equal(JSON.stringify(preflight), preflightSnapshot);
    assert.equal(JSON.stringify(plans), plansSnapshot);
    assert.equal(JSON.stringify(context), contextSnapshot);
  }
);

const ORCH_CONTEXT = {
  ingestion_run_id: "run-orch-001",
  started_at: "2026-08-22T00:00:00.000Z",
  observed_at: "2026-08-22T00:05:00.000Z"
};

function makeBookingOrchRow(index) {
  return {
    ...BOOKING_NORMALIZED_ROW,
    source_record_key: `booking-key-${index}`,
    source_row_hash: `hash-${index}`
  };
}

function makeCommissionOrchRow(index) {
  return {
    ...COMMISSION_NORMALIZED_ROW,
    commission_record_key: `commission-key-${index}`,
    source_row_hash: `hash-${index}`
  };
}

function makeBookingExistingFact(index, row, overrides = {}) {
  return {
    booking_fact_id: `fact-${index}`,
    source_record_key: row.source_record_key,
    source_row_hash: row.source_row_hash,
    attributed_publisher_id: row.attributed_publisher_id,
    attributed_placement: row.attributed_placement,
    attribution_status: row.attribution_status,
    ...overrides
  };
}

function makeCommissionExistingFact(index, row, overrides = {}) {
  return {
    commission_fact_id: `fact-${index}`,
    commission_record_key: row.commission_record_key,
    source_row_hash: row.source_row_hash,
    attributed_publisher_id: row.attributed_publisher_id,
    attributed_placement: row.attributed_placement,
    attribution_status: row.attribution_status,
    ...overrides
  };
}

function makeOrchRowContexts(actions) {
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

async function buildBookingOrchestration(actions) {
  const rows = actions.map((action, index) =>
    makeBookingOrchRow(index)
  );

  const facts = actions.map((action, index) => {
    if (action === "insert") {
      return null;
    }

    return makeBookingExistingFact(
      index,
      rows[index],
      action === "update"
        ? { source_row_hash: `old-hash-${index}` }
        : {}
    );
  });

  const contexts = makeOrchRowContexts(actions);
  const preflight = await makePreflight({
    rows_seen: actions.length
  });

  return {
    preflight,
    rows,
    facts,
    contexts,
    context: ORCH_CONTEXT
  };
}

async function buildCommissionOrchestration(actions) {
  const rows = actions.map((action, index) =>
    makeCommissionOrchRow(index)
  );

  const facts = actions.map((action, index) => {
    if (action === "insert") {
      return null;
    }

    return makeCommissionExistingFact(
      index,
      rows[index],
      action === "update"
        ? { source_row_hash: `old-hash-${index}` }
        : {}
    );
  });

  const contexts = makeOrchRowContexts(actions);
  const preflight = await makePreflight({
    report_type: "commission",
    rows_seen: actions.length
  });

  return {
    preflight,
    rows,
    facts,
    contexts,
    context: ORCH_CONTEXT
  };
}

test(
  "orchestration: booking rejects non-array inputs",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 0 });

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          "not-an-array",
          [],
          [],
          ORCH_CONTEXT
        ),
      /Invalid successful ingestion orchestration input/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [],
          "not-an-array",
          [],
          ORCH_CONTEXT
        ),
      /Invalid successful ingestion orchestration input/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [],
          [],
          "not-an-array",
          ORCH_CONTEXT
        ),
      /Invalid successful ingestion orchestration input/
    );
  }
);

test(
  "orchestration: commission rejects non-array inputs",
  async () => {
    const {
      planSuccessfulCommissionIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 0
    });

    assert.throws(
      () =>
        planSuccessfulCommissionIngestion(
          preflight,
          null,
          [],
          [],
          ORCH_CONTEXT
        ),
      /Invalid successful ingestion orchestration input/
    );

    assert.throws(
      () =>
        planSuccessfulCommissionIngestion(
          preflight,
          [],
          null,
          [],
          ORCH_CONTEXT
        ),
      /Invalid successful ingestion orchestration input/
    );

    assert.throws(
      () =>
        planSuccessfulCommissionIngestion(
          preflight,
          [],
          [],
          null,
          ORCH_CONTEXT
        ),
      /Invalid successful ingestion orchestration input/
    );
  }
);

test(
  "orchestration: booking rejects row count mismatches",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = makeBookingOrchRow(0);
    const preflight = await makePreflight({ rows_seen: 1 });

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [],
          [null],
          [{}],
          ORCH_CONTEXT
        ),
      /Successful ingestion orchestration row count mismatch/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [row],
          [],
          [{}],
          ORCH_CONTEXT
        ),
      /Successful ingestion orchestration row count mismatch/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [row],
          [null],
          [],
          ORCH_CONTEXT
        ),
      /Successful ingestion orchestration row count mismatch/
    );
  }
);

test(
  "orchestration: commission rejects row count mismatches",
  async () => {
    const {
      planSuccessfulCommissionIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const row = makeCommissionOrchRow(0);
    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 2
    });

    assert.throws(
      () =>
        planSuccessfulCommissionIngestion(
          preflight,
          [row],
          [null],
          [{}],
          ORCH_CONTEXT
        ),
      /Successful ingestion orchestration row count mismatch/
    );
  }
);

test(
  "orchestration: booking happy path insert/update/unchanged",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const {
      preflight,
      rows,
      facts,
      contexts,
      context
    } = await buildBookingOrchestration([
      "insert",
      "update",
      "unchanged"
    ]);

    const result = planSuccessfulBookingIngestion(
      preflight,
      rows,
      facts,
      contexts,
      context
    );

    assert.deepEqual(
      result.state_plans.map((p) => p.state_action),
      ["insert", "update", "unchanged"]
    );

    assert.deepEqual(
      result.persistence_plans.map((p) => p.persistence_action),
      ["insert", "update_material", "update_observation"]
    );

    assert.equal(result.state_plans.length, 3);
    assert.equal(result.persistence_plans.length, 3);
    assert.deepEqual(Object.keys(result), [
      "state_plans",
      "persistence_plans",
      "ledger_plan"
    ]);

    assert.equal(result.ledger_plan.rows_seen, 3);
    assert.equal(result.ledger_plan.rows_inserted, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");
  }
);

test(
  "orchestration: commission happy path insert/update/unchanged",
  async () => {
    const {
      planSuccessfulCommissionIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const {
      preflight,
      rows,
      facts,
      contexts,
      context
    } = await buildCommissionOrchestration([
      "insert",
      "update",
      "unchanged"
    ]);

    const result = planSuccessfulCommissionIngestion(
      preflight,
      rows,
      facts,
      contexts,
      context
    );

    assert.deepEqual(
      result.state_plans.map((p) => p.state_action),
      ["insert", "update", "unchanged"]
    );

    assert.deepEqual(
      result.persistence_plans.map((p) => p.persistence_action),
      ["insert", "update_material", "update_observation"]
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
  "orchestration: update_observation maps to rows_unchanged, not rows_updated",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const {
      preflight,
      rows,
      facts,
      contexts,
      context
    } = await buildBookingOrchestration([
      "insert",
      "update",
      "unchanged"
    ]);

    const result = planSuccessfulBookingIngestion(
      preflight,
      rows,
      facts,
      contexts,
      context
    );

    const observationPlans = result.persistence_plans.filter(
      (p) => p.persistence_action === "update_observation"
    );

    assert.equal(observationPlans.length, 1);
    assert.equal(result.ledger_plan.rows_updated, 1);
    assert.equal(result.ledger_plan.rows_unchanged, 1);
  }
);

test(
  "orchestration: one ingestion run identity spans rows and ledger",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const {
      preflight,
      rows,
      facts,
      contexts,
      context
    } = await buildBookingOrchestration([
      "insert",
      "update",
      "unchanged"
    ]);

    const result = planSuccessfulBookingIngestion(
      preflight,
      rows,
      facts,
      contexts,
      context
    );

    assert.equal(result.ledger_plan.ingestion_run_id, context.ingestion_run_id);
    assert.equal(result.ledger_plan.started_at, context.started_at);
    assert.equal(result.ledger_plan.completed_at, context.observed_at);

    for (const plan of result.persistence_plans) {
      assert.equal(
        plan.values.last_ingestion_run_id,
        context.ingestion_run_id
      );
      assert.equal(plan.values.last_seen_at, context.observed_at);
      assert.equal(plan.values.source_ingested_at, context.observed_at);

      if (plan.persistence_action === "insert") {
        assert.equal(
          plan.values.first_ingestion_run_id,
          context.ingestion_run_id
        );
        assert.equal(plan.values.first_seen_at, context.observed_at);
      }
    }
  }
);

test(
  "orchestration: zero-row booking import still plans ledger",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 0 });

    const result = planSuccessfulBookingIngestion(
      preflight,
      [],
      [],
      [],
      ORCH_CONTEXT
    );

    assert.deepEqual(result.state_plans, []);
    assert.deepEqual(result.persistence_plans, []);
    assert.equal(result.ledger_plan.rows_seen, 0);
    assert.equal(result.ledger_plan.rows_inserted, 0);
    assert.equal(result.ledger_plan.rows_updated, 0);
    assert.equal(result.ledger_plan.rows_unchanged, 0);
    assert.equal(result.ledger_plan.rows_rejected, 0);
    assert.equal(result.ledger_plan.status, "completed");
  }
);

test(
  "orchestration: zero-row commission import still plans ledger",
  async () => {
    const {
      planSuccessfulCommissionIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({
      report_type: "commission",
      rows_seen: 0
    });

    const result = planSuccessfulCommissionIngestion(
      preflight,
      [],
      [],
      [],
      ORCH_CONTEXT
    );

    assert.deepEqual(result.state_plans, []);
    assert.deepEqual(result.persistence_plans, []);
    assert.equal(result.ledger_plan.rows_seen, 0);
    assert.equal(result.ledger_plan.status, "completed");
  }
);

test(
  "orchestration: child planner errors propagate unchanged",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 1 });
    const row = makeBookingOrchRow(0);

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [{ ...row, source_record_key: "   " }],
          [null],
          [{ new_fact_id: "nf-0", raw_payload_json: "{}" }],
          ORCH_CONTEXT
        ),
      /Invalid booking current-state input: source_record_key/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [row],
          [null],
          [{ new_fact_id: "nf-0", raw_payload_json: "{}" }],
          { ...ORCH_CONTEXT, observed_at: "   " }
        ),
      /Invalid observation context: observed_at/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [row],
          [null],
          [{ raw_payload_json: "{}" }],
          ORCH_CONTEXT
        ),
      /Invalid booking persistence context: new_fact_id/
    );

    assert.throws(
      () =>
        planSuccessfulBookingIngestion(
          preflight,
          [row],
          [null],
          [{ new_fact_id: "nf-0", raw_payload_json: "{}" }],
          { ...ORCH_CONTEXT, started_at: "   " }
        ),
      /Invalid successful ingestion context: started_at/
    );
  }
);

test(
  "orchestration: middle row failure returns no partial output",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const preflight = await makePreflight({ rows_seen: 3 });

    const rows = [
      makeBookingOrchRow(0),
      { ...makeBookingOrchRow(1), source_record_key: "   " },
      makeBookingOrchRow(2)
    ];

    let threw = false;
    try {
      planSuccessfulBookingIngestion(
        preflight,
        rows,
        [null, null, null],
        makeOrchRowContexts(["insert", "insert", "insert"]),
        ORCH_CONTEXT
      );
    } catch {
      threw = true;
    }

    assert.equal(threw, true);
  }
);

test(
  "orchestration: inputs are not mutated and output is deterministic",
  async () => {
    const {
      planSuccessfulBookingIngestion
    } = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const {
      preflight,
      rows,
      facts,
      contexts,
      context
    } = await buildBookingOrchestration([
      "insert",
      "update",
      "unchanged"
    ]);

    const preflightSnapshot = JSON.stringify(preflight);
    const rowsSnapshot = JSON.stringify(rows);
    const factsSnapshot = JSON.stringify(facts);
    const contextsSnapshot = JSON.stringify(contexts);
    const contextSnapshot = JSON.stringify(context);

    const first = planSuccessfulBookingIngestion(
      preflight,
      rows,
      facts,
      contexts,
      context
    );
    const second = planSuccessfulBookingIngestion(
      preflight,
      rows,
      facts,
      contexts,
      context
    );

    assert.deepEqual(first, second);
    assert.notEqual(first, second);

    assert.equal(JSON.stringify(preflight), preflightSnapshot);
    assert.equal(JSON.stringify(rows), rowsSnapshot);
    assert.equal(JSON.stringify(facts), factsSnapshot);
    assert.equal(JSON.stringify(contexts), contextsSnapshot);
    assert.equal(JSON.stringify(context), contextSnapshot);
  }
);
