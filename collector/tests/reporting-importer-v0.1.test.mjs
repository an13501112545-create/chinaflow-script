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
