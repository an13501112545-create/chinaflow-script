import test from "node:test";
import assert from "node:assert/strict";

const CONTEXT = {
  ingestion_run_id: "run-prep-001",
  started_at: "2026-08-22T00:00:00.000Z",
  observed_at: "2026-08-22T00:05:00.000Z"
};

const FILE_BYTES = new TextEncoder().encode(
  "trip-report-v0.1\n"
);

function placementRow(key, publisherId, placement) {
  return {
    supplier: "trip.com",
    is_active: 1,
    external_tracking_key: key,
    publisher_id: publisherId,
    placement
  };
}

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
    placement_rows: [
      placementRow(
        "flightflex_flights_yyz_bjs_test",
        "flightflex",
        "placement-a"
      )
    ],
    new_fact_ids: ["fact-booking-1"],
    context: CONTEXT,
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
    placement_rows: [
      placementRow(
        "flightflex_flights_yyz_bjs_test",
        "flightflex",
        "placement-a"
      )
    ],
    new_fact_ids: ["fact-commission-1"],
    context: CONTEXT,
    ...overrides
  };
}

test(
  "booking rejects source that is not trip.com",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ source: "other.com" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "booking rejects report_type that is not booking",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ report_type: "commission" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "commission rejects source that is not trip.com",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripCommissionImport(
          commissionInput({ source: "booking.com" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "commission rejects report_type that is not commission",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripCommissionImport(
          commissionInput({ report_type: "booking" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "booking cannot prepare with commission report_type",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ report_type: "commission" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "commission cannot prepare with booking report_type",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripCommissionImport(
          commissionInput({ report_type: "booking" })
        ),
      /Invalid Trip import preparation route/
    );
  }
);

test(
  "malformed top-level input is rejected",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () => prepareTripBookingImport(null),
      /Invalid Trip import preparation input/
    );

    await assert.rejects(
      () => prepareTripBookingImport([]),
      /Invalid Trip import preparation input/
    );

    await assert.rejects(
      () => prepareTripBookingImport("not-an-object"),
      /Invalid Trip import preparation input/
    );
  }
);

test(
  "nonblank aid is required",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ aid: "   " })
        ),
      /Invalid Trip import preparation input/
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ aid: null })
        ),
      /Invalid Trip import preparation input/
    );
  }
);

test(
  "rows must be an array",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ rows: "not-an-array" })
        ),
      /Invalid Trip import preparation input/
    );
  }
);

test(
  "placement_rows must be an array",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ placement_rows: null })
        ),
      /Invalid Trip import preparation input/
    );
  }
);

test(
  "new_fact_ids must be an array",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ new_fact_ids: "x" })
        ),
      /Invalid Trip import preparation input/
    );
  }
);

test(
  "fact ID count must equal rows count",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            rows: [bookingRow(), bookingRow()],
            new_fact_ids: ["only-one"]
          })
        ),
      /Invalid Trip import preparation input/
    );
  }
);

test(
  "blank fact ID is rejected",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ new_fact_ids: ["   "] })
        ),
      /Invalid Trip import preparation fact ids/
    );
  }
);

test(
  "duplicate fact ID is rejected",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            rows: [bookingRow(), bookingRow({ orderId: "BOOKING-002" })],
            new_fact_ids: ["fact-dup", "fact-dup"]
          })
        ),
      /Invalid Trip import preparation fact ids/
    );
  }
);

test(
  "invalid context object is rejected",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ context: null })
        ),
      /Invalid Trip import preparation context/
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({ context: [] })
        ),
      /Invalid Trip import preparation context/
    );
  }
);

test(
  "blank context fields are rejected",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            context: { ...CONTEXT, ingestion_run_id: "  " }
          })
        ),
      /Invalid Trip import preparation context/
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            context: { ...CONTEXT, started_at: "" }
          })
        ),
      /Invalid Trip import preparation context/
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            context: { ...CONTEXT, observed_at: null }
          })
        ),
      /Invalid Trip import preparation context/
    );
  }
);

test(
  "booking happy path composes real placement, normalization, and preflight",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const input = bookingInput();

    const result = await prepareTripBookingImport(input);

    assert.deepEqual(Object.keys(result), [
      "preflight",
      "normalized_rows",
      "row_contexts",
      "context"
    ]);

    assert.equal(result.context, input.context);

    assert.equal(result.preflight.source, "trip.com");
    assert.equal(result.preflight.report_type, "booking");
    assert.equal(result.preflight.source_filename, "booking-report.csv");
    assert.equal(result.preflight.rows_seen, 1);

    const normalized = result.normalized_rows[0];
    assert.equal(normalized.attribution_status, "matched");
    assert.equal(normalized.attributed_publisher_id, "flightflex");
    assert.equal(normalized.attributed_placement, "placement-a");
    assert.equal(normalized.normalized_product, "hotel");
    assert.equal(normalized.normalized_order_status, "successful");
    assert.equal(normalized.booking_amount_micros, 100000000);
    assert.equal(typeof normalized.source_record_key, "string");
    assert.equal(typeof normalized.source_row_hash, "string");

    assert.equal(result.row_contexts[0].new_fact_id, "fact-booking-1");
    assert.equal(
      result.row_contexts[0].raw_payload_json,
      JSON.stringify(input.rows[0])
    );
  }
);

test(
  "commission happy path composes real placement, normalization, and preflight",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const input = commissionInput();

    const result = await prepareTripCommissionImport(input);

    assert.deepEqual(Object.keys(result), [
      "preflight",
      "normalized_rows",
      "row_contexts",
      "context"
    ]);

    assert.equal(result.context, input.context);
    assert.equal(result.preflight.report_type, "commission");

    const normalized = result.normalized_rows[0];
    assert.equal(normalized.attribution_status, "matched");
    assert.equal(normalized.normalized_product, "hotel");
    assert.equal(normalized.normalized_commission_status, "settled");
    assert.equal(normalized.commission_amount_micros, 5000000);
    assert.equal(typeof normalized.commission_record_key, "string");
    assert.equal(typeof normalized.source_row_hash, "string");

    assert.equal(
      result.row_contexts[0].new_fact_id,
      "fact-commission-1"
    );
    assert.equal(
      result.row_contexts[0].raw_payload_json,
      JSON.stringify(input.rows[0])
    );
  }
);

test(
  "matched trip_sub1 attribution is applied",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripBookingImport(
      bookingInput()
    );

    assert.equal(
      result.normalized_rows[0].attribution_status,
      "matched"
    );
    assert.equal(
      result.normalized_rows[0].attributed_publisher_id,
      "flightflex"
    );
    assert.equal(
      result.normalized_rows[0].attributed_placement,
      "placement-a"
    );
  }
);

test(
  "unmatched trip_sub1 stays unattributed",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripBookingImport(
      bookingInput({
        rows: [bookingRow({ tripSub1: "unknown_key" })]
      })
    );

    assert.equal(
      result.normalized_rows[0].attribution_status,
      "unmatched"
    );
    assert.equal(
      result.normalized_rows[0].attributed_publisher_id,
      null
    );
    assert.equal(
      result.normalized_rows[0].attributed_placement,
      null
    );
  }
);

test(
  "missing trip_sub1 stays missing_trip_sub1",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripBookingImport(
      bookingInput({
        rows: [bookingRow({ tripSub1: null })]
      })
    );

    assert.equal(
      result.normalized_rows[0].attribution_status,
      "missing_trip_sub1"
    );
  }
);

test(
  "duplicate booking record key propagates exact core error",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            rows: [bookingRow(), bookingRow()],
            new_fact_ids: ["f1", "f2"]
          })
        ),
      /Duplicate booking record key/
    );
  }
);

test(
  "duplicate commission record key propagates exact core error",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripCommissionImport(
          commissionInput({
            rows: [commissionRow(), commissionRow()],
            new_fact_ids: ["f1", "f2"]
          })
        ),
      /Duplicate commission record key/
    );
  }
);

test(
  "invalid placement row propagates exact existing error",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            placement_rows: [
              placementRow("key", "flightflex", "placement-a"),
              { ...placementRow("key2", "pub", "p2"), supplier: "other" }
            ]
          })
        ),
      /Invalid publisher placement candidate: supplier/
    );
  }
);

test(
  "duplicate placement key propagates exact existing error",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    await assert.rejects(
      () =>
        prepareTripBookingImport(
          bookingInput({
            placement_rows: [
              placementRow("dup-key", "p1", "placement-1"),
              placementRow("dup-key", "p2", "placement-2")
            ]
          })
        ),
      /Duplicate publisher placement tracking key: dup-key/
    );
  }
);

test(
  "file hash uses exact file bytes",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );
    const core = await import(
      "../reporting-importer-core-v0.1.mjs"
    );

    const bytesA = new TextEncoder().encode("file-a\n");
    const bytesB = new TextEncoder().encode("file-b\n");

    const resultA = await prepareTripBookingImport(
      bookingInput({ file_bytes: bytesA })
    );
    const resultB = await prepareTripBookingImport(
      bookingInput({ file_bytes: bytesB })
    );

    const expectedA = await core.createSourceFileSha256(bytesA);

    assert.equal(resultA.preflight.source_file_sha256, expectedA);
    assert.notEqual(
      resultA.preflight.source_file_sha256,
      resultB.preflight.source_file_sha256
    );
  }
);

test(
  "preflight rows_seen equals rows.length exactly",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const rows = [
      bookingRow(),
      bookingRow({ orderId: "BOOKING-002" }),
      bookingRow({ orderId: "BOOKING-003" })
    ];

    const result = await prepareTripBookingImport(
      bookingInput({
        rows,
        new_fact_ids: ["f1", "f2", "f3"]
      })
    );

    assert.equal(result.preflight.rows_seen, rows.length);
    assert.equal(result.preflight.rows_seen, 3);
  }
);

test(
  "report metadata fields pass through unchanged",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripBookingImport(
      bookingInput({
        source_filename: "custom.csv",
        report_period_from: "2026-01-01",
        report_period_to: "2026-06-30"
      })
    );

    assert.equal(result.preflight.source_filename, "custom.csv");
    assert.equal(result.preflight.report_period_from, "2026-01-01");
    assert.equal(result.preflight.report_period_to, "2026-06-30");
  }
);

test(
  "3-row real flow preserves index alignment and raw payloads",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const rows = [
      bookingRow({ tripSub1: "flightflex_flights_yyz_bjs_test" }),
      bookingRow({ orderId: "BOOKING-002", tripSub1: "unknown_key" }),
      bookingRow({ orderId: "BOOKING-003", tripSub1: null })
    ];

    const factIds = [
      "fact-booking-1",
      "fact-booking-2",
      "fact-booking-3"
    ];

    const input = bookingInput({
      rows,
      new_fact_ids: factIds
    });

    const result = await prepareTripBookingImport(input);

    assert.equal(result.preflight.rows_seen, 3);

    assert.equal(
      result.normalized_rows[0].attribution_status,
      "matched"
    );
    assert.equal(
      result.normalized_rows[1].attribution_status,
      "unmatched"
    );
    assert.equal(
      result.normalized_rows[2].attribution_status,
      "missing_trip_sub1"
    );

    for (let index = 0; index < 3; index += 1) {
      assert.equal(
        result.row_contexts[index].new_fact_id,
        factIds[index]
      );
      assert.equal(
        result.row_contexts[index].raw_payload_json,
        JSON.stringify(rows[index])
      );
    }
  }
);

test(
  "supplied new_fact_id is preserved exactly",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripBookingImport(
      bookingInput({ new_fact_ids: ["  exact-id-1  "] })
    );

    assert.equal(
      result.row_contexts[0].new_fact_id,
      "  exact-id-1  "
    );
  }
);

test(
  "returned context is reference-equal to input.context",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const input = commissionInput();
    const result = await prepareTripCommissionImport(input);

    assert.equal(result.context, input.context);
  }
);

test(
  "zero-row booking preparation succeeds",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripBookingImport(
      bookingInput({
        rows: [],
        new_fact_ids: []
      })
    );

    assert.equal(result.preflight.rows_seen, 0);
    assert.deepEqual(result.normalized_rows, []);
    assert.deepEqual(result.row_contexts, []);
  }
);

test(
  "zero-row commission preparation succeeds",
  async () => {
    const { prepareTripCommissionImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const result = await prepareTripCommissionImport(
      commissionInput({
        rows: [],
        new_fact_ids: []
      })
    );

    assert.equal(result.preflight.rows_seen, 0);
    assert.deepEqual(result.normalized_rows, []);
    assert.deepEqual(result.row_contexts, []);
  }
);

test(
  "prepared inputs are not mutated",
  async () => {
    const { prepareTripBookingImport } = await import(
      "../reporting-importer-preparation-v0.1.mjs"
    );

    const input = bookingInput({
      rows: [
        bookingRow(),
        bookingRow({ orderId: "BOOKING-002", tripSub1: "unknown_key" })
      ],
      new_fact_ids: ["f1", "f2"]
    });

    const snapshot = JSON.stringify(input);

    await prepareTripBookingImport(input);

    assert.equal(JSON.stringify(input), snapshot);
  }
);
