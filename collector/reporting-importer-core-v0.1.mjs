function requireIdentityString(value, fieldName, recordType = "booking") {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new Error(
      `Missing ${recordType} identity field: ${fieldName}`
    );
  }

  return value;
}


async function sha256Hex(value) {
  const bytes =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return Array
    .from(new Uint8Array(digest))
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}


export async function createBookingRecordKey(identity) {
  const canonicalIdentity = [
    requireIdentityString(
      identity?.source,
      "source"
    ),
    requireIdentityString(
      identity?.aid,
      "aid"
    ),
    requireIdentityString(
      identity?.sid,
      "sid"
    ),
    requireIdentityString(
      identity?.source_order_id,
      "source_order_id"
    ),
    requireIdentityString(
      identity?.raw_product_line,
      "raw_product_line"
    )
  ];

  return sha256Hex(
    JSON.stringify(canonicalIdentity)
  );
}

export async function createCommissionRecordKey(identity) {
  const canonicalIdentity = [
    requireIdentityString(
      identity?.source,
      "source",
      "commission"
    ),
    requireIdentityString(
      identity?.aid,
      "aid",
      "commission"
    ),
    requireIdentityString(
      identity?.sid,
      "sid",
      "commission"
    ),
    requireIdentityString(
      identity?.source_order_id,
      "source_order_id",
      "commission"
    ),
    requireIdentityString(
      identity?.commission_month,
      "commission_month",
      "commission"
    ),
    requireIdentityString(
      identity?.raw_product_line,
      "raw_product_line",
      "commission"
    ),
    requireIdentityString(
      identity?.sub_order_type,
      "sub_order_type",
      "commission"
    ),
    requireIdentityString(
      identity?.plan_type,
      "plan_type",
      "commission"
    )
  ];

  return sha256Hex(
    JSON.stringify(canonicalIdentity)
  );
}
export function parseMoneyToMicros(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    value.match(
      /^([+-]?)(\d+)(?:\.(\d{1,6}))?$/
    );

  if (!match) {
    return null;
  }

  const sign =
    match[1] === "-"
      ? -1n
      : 1n;

  const whole =
    BigInt(match[2]);

  const fraction =
    BigInt(
      (match[3] || "")
        .padEnd(6, "0")
    );

  const micros =
    sign * (
      whole * 1000000n +
      fraction
    );

  const result =
    Number(micros);

  return Number.isSafeInteger(result)
    ? result
    : null;
}
export function normalizeMoneyField(value) {
  const raw =
    typeof value === "string"
      ? value
      : null;

  return {
    raw,
    micros:
      raw === null
        ? null
        : parseMoneyToMicros(raw)
  };
}
export function normalizeCurrency(value) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    return null;
  }

  return value;
}
const TRIP_PRODUCT_LINE_MAP = Object.freeze({
  htl: "hotel",
  flt: "flight",
  bdl: "flight_hotel",
  cru: "cruise",
  cr: "car_rental",
  atr: "airport_transfer",
  tr: "train",
  tnt: "tours_tickets",
  grp: "group_buy"
});

const TRIP_ORDER_STATUS_MAP = Object.freeze({
  S: "successful",
  W: "wait_pay",
  C: "canceled",
  Q: "refunded",
  P: "pending"
});

const TRIP_COMMISSION_STATUS_MAP = Object.freeze({
  PENDING_REVIEW: "pending_review",
  UNDER_REVIEW: "under_review",
  PENDING_SETTLED: "pending_settlement",
  SETTLED: "settled"
});


function normalizeProviderValue(value, mapping) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    return {
      raw: null,
      normalized: null
    };
  }

  return {
    raw: value,
    normalized:
      Object.prototype.hasOwnProperty.call(mapping, value)
        ? mapping[value]
        : "unknown"
  };
}


export function normalizeTripProductLine(value) {
  return normalizeProviderValue(
    value,
    TRIP_PRODUCT_LINE_MAP
  );
}


export function normalizeTripOrderStatus(value) {
  return normalizeProviderValue(
    value,
    TRIP_ORDER_STATUS_MAP
  );
}


export function normalizeTripCommissionStatus(value) {
  return normalizeProviderValue(
    value,
    TRIP_COMMISSION_STATUS_MAP
  );
}
export function resolveTripSub1Attribution(
  tripSub1,
  matchedPlacement
) {
  if (
    typeof tripSub1 !== "string" ||
    tripSub1.trim().length === 0
  ) {
    return {
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "missing_trip_sub1"
    };
  }

  if (!matchedPlacement) {
    return {
      attributed_publisher_id: null,
      attributed_placement: null,
      attribution_status: "unmatched"
    };
  }

  return {
    attributed_publisher_id:
      matchedPlacement.publisher_id,
    attributed_placement:
      matchedPlacement.placement,
    attribution_status:
      "matched"
  };
}
export function assertUniqueRecordKeys(
  recordKeys,
  recordType
) {
  const seen =
    new Set();

  for (const recordKey of recordKeys) {
    if (seen.has(recordKey)) {
      throw new Error(
        `Duplicate ${recordType} record key: ${recordKey}`
      );
    }

    seen.add(recordKey);
  }
}

export function buildTripSub1PlacementMap(placementRows) {
  if (!Array.isArray(placementRows)) {
    throw new Error(
      "Invalid publisher placement rows"
    );
  }

  const map =
    new Map();

  for (const row of placementRows) {
    if (row?.supplier !== "trip.com") {
      throw new Error(
        "Invalid publisher placement candidate: supplier"
      );
    }

    if (row?.is_active !== 1) {
      throw new Error(
        "Invalid publisher placement candidate: is_active"
      );
    }

    if (
      typeof row?.external_tracking_key !== "string" ||
      row.external_tracking_key.trim().length === 0
    ) {
      throw new Error(
        "Invalid publisher placement candidate: external_tracking_key"
      );
    }

    if (
      typeof row?.publisher_id !== "string" ||
      row.publisher_id.trim().length === 0
    ) {
      throw new Error(
        "Invalid publisher placement candidate: publisher_id"
      );
    }

    if (
      typeof row?.placement !== "string" ||
      row.placement.trim().length === 0
    ) {
      throw new Error(
        "Invalid publisher placement candidate: placement"
      );
    }

    const key =
      row.external_tracking_key;

    if (map.has(key)) {
      throw new Error(
        `Duplicate publisher placement tracking key: ${key}`
      );
    }

    map.set(
      key,
      {
        publisher_id: row.publisher_id,
        placement: row.placement
      }
    );
  }

  return map;
}

export async function normalizeTripBookingRow(row, context) {
  const source =
    context?.source;

  const aid =
    context?.aid;

  const sourceOrderId =
    row?.orderId;

  const sid =
    row?.sid;

  const product =
    normalizeTripProductLine(
      row?.productLine
    );

  const orderStatus =
    normalizeTripOrderStatus(
      row?.orderStatus
    );

  const amount =
    normalizeMoneyField(
      row?.amount
    );

  const matchedPlacement =
    context?.placementsByTripSub1 instanceof Map
      ? context.placementsByTripSub1.get(
          row?.tripSub1
        )
      : context?.matchedPlacement;

  const attribution =
    resolveTripSub1Attribution(
      row?.tripSub1,
      matchedPlacement
    );

  const sourceRecordKey =
    await createBookingRecordKey({
      source,
      aid,
      sid,
      source_order_id: sourceOrderId,
      raw_product_line: product.raw
    });

  const sourceRowHash =
    await createSourceRowHash(row);

  return {
    source_record_key:
      sourceRecordKey,
    source_row_hash:
      sourceRowHash,

    source,
    source_order_id:
      sourceOrderId,
    aid,
    sid,
    sid_name:
      row?.sidName ?? null,

    trip_sub1:
      row?.tripSub1 ?? null,
    trip_sub3:
      row?.tripSub3 ?? null,

    ...attribution,

    raw_product_line:
      product.raw,
    normalized_product:
      product.normalized,

    raw_order_status:
      orderStatus.raw,
    normalized_order_status:
      orderStatus.normalized,

    booking_amount_raw:
      amount.raw,
    booking_amount_micros:
      amount.micros,
    currency:
      normalizeCurrency(
        row?.currency
      ),

    order_date:
      row?.orderDate ?? null,
    product_start_date:
      row?.productStartDate ?? null,
    product_end_date:
      row?.productEndDate ?? null,
    booking_window:
      row?.bookingWindow ?? null,

    departure_city:
      row?.departureCity ?? null,
    departure_country:
      row?.departureCountry ?? null,
    arrival_city:
      row?.arrivalCity ?? null,
    arrival_country:
      row?.arrivalCountry ?? null,

    order_platform:
      row?.orderPlatform ?? null,
    booker_region:
      row?.region ?? null,
    ouid:
      row?.ouid ?? null
  };
}
function canonicalizeForHash(value) {
  if (Array.isArray(value)) {
    return value.map(
      item =>
        canonicalizeForHash(item)
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    const canonical = {};

    for (
      const key of
        Object.keys(value).sort()
    ) {
      canonical[key] =
        canonicalizeForHash(
          value[key]
        );
    }

    return canonical;
  }

  return value;
}

export async function createSourceRowHash(row) {
  return sha256Hex(
    JSON.stringify(
      canonicalizeForHash(row)
    )
  );
}
export async function normalizeTripCommissionRow(row, context) {
  const source =
    context?.source;

  const aid =
    context?.aid;

  const sourceOrderId =
    row?.orderId;

  const sid =
    row?.sid;

  const product =
    normalizeTripProductLine(
      row?.productLine
    );

  const orderStatus =
    normalizeTripOrderStatus(
      row?.orderStatus
    );

  const commissionStatus =
    normalizeTripCommissionStatus(
      row?.commissionStatus
    );

  const bookingAmount =
    normalizeMoneyField(
      row?.bookingAmount
    );

  const commissionAmount =
    normalizeMoneyField(
      row?.commissionAmount
    );

  const matchedPlacement =
    context?.placementsByTripSub1 instanceof Map
      ? context.placementsByTripSub1.get(
          row?.tripSub1
        )
      : context?.matchedPlacement;

  const attribution =
    resolveTripSub1Attribution(
      row?.tripSub1,
      matchedPlacement
    );

  const commissionRecordKey =
    await createCommissionRecordKey({
      source,
      aid,
      sid,
      source_order_id: sourceOrderId,
      commission_month: row?.commissionMonth,
      raw_product_line: product.raw,
      sub_order_type: row?.subOrderType,
      plan_type: row?.planType
    });

  const sourceRowHash =
    await createSourceRowHash(row);

  return {
    commission_record_key:
      commissionRecordKey,
    source_row_hash:
      sourceRowHash,

    source,
    source_order_id:
      sourceOrderId,
    aid,
    sid,
    sid_name:
      row?.sidName ?? null,

    trip_sub1:
      row?.tripSub1 ?? null,
    trip_sub3:
      row?.tripSub3 ?? null,

    ...attribution,

    raw_product_line:
      product.raw,
    normalized_product:
      product.normalized,

    sub_order_type:
      row?.subOrderType ?? null,
    plan_type:
      row?.planType ?? null,

    raw_order_status:
      orderStatus.raw,
    normalized_order_status:
      orderStatus.normalized,

    raw_commission_status:
      commissionStatus.raw,
    normalized_commission_status:
      commissionStatus.normalized,

    booking_amount_raw:
      bookingAmount.raw,
    booking_amount_micros:
      bookingAmount.micros,

    commission_amount_raw:
      commissionAmount.raw,
    commission_amount_micros:
      commissionAmount.micros,

    currency:
      normalizeCurrency(
        row?.currency
      ),

    commission_month:
      row?.commissionMonth ?? null,
    order_date:
      row?.orderDate ?? null,
    check_out_or_issue_date:
      row?.checkOutOrIssueDate ?? null,

    ratio_raw:
      row?.ratio ?? null,
    region:
      row?.region ?? null,
    ouid:
      row?.ouid ?? null
  };
}

export async function preflightTripBookingRows(rows, context) {
  const normalizedRows =
    await Promise.all(
      rows.map(
        row =>
          normalizeTripBookingRow(
            row,
            context
          )
      )
    );

  assertUniqueRecordKeys(
    normalizedRows.map(
      row =>
        row.source_record_key
    ),
    "booking"
  );

  return normalizedRows;
}
export async function preflightTripCommissionRows(rows, context) {
  const normalizedRows =
    await Promise.all(
      rows.map(
        row =>
          normalizeTripCommissionRow(
            row,
            context
          )
      )
    );

  assertUniqueRecordKeys(
    normalizedRows.map(
      row =>
        row.commission_record_key
    ),
    "commission"
  );

  return normalizedRows;
}

export async function createSourceFileSha256(bytes) {
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return Array
    .from(new Uint8Array(digest))
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

function isBinaryBufferSource(value) {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

export async function createIngestionRunPreflight(input) {
  if (
    typeof input?.source !== "string" ||
    input.source.trim().length === 0
  ) {
    throw new Error(
      "Missing ingestion field: source"
    );
  }

  if (
    typeof input?.report_type !== "string" ||
    input.report_type.trim().length === 0
  ) {
    throw new Error(
      "Missing ingestion field: report_type"
    );
  }

  if (
    input?.file_bytes === undefined ||
    input.file_bytes === null
  ) {
    throw new Error(
      "Missing ingestion field: file_bytes"
    );
  }

  if (
    !isBinaryBufferSource(
      input.file_bytes
    )
  ) {
    throw new Error(
      "Invalid ingestion field: file_bytes"
    );
  }

  if (
    input?.rows_seen === undefined ||
    input.rows_seen === null
  ) {
    throw new Error(
      "Missing ingestion field: rows_seen"
    );
  }

  if (
    typeof input.rows_seen !== "number" ||
    !Number.isInteger(input.rows_seen) ||
    input.rows_seen < 0
  ) {
    throw new Error(
      "Invalid ingestion field: rows_seen"
    );
  }

  const sourceFileSha256 =
    await createSourceFileSha256(
      input.file_bytes
    );

  return {
    source:
      input.source,
    report_type:
      input.report_type,
    source_filename:
      input?.source_filename ?? null,
    report_period_from:
      input?.report_period_from ?? null,
    report_period_to:
      input?.report_period_to ?? null,
    source_file_sha256:
      sourceFileSha256,
    rows_seen:
      input.rows_seen
  };
}

export function planSourceFileDedupe(preflight, existingRun) {
  if (
    existingRun === null ||
    existingRun === undefined
  ) {
    return {
      dedupe_status: "new",
      should_import: true,
      existing_ingestion_run_id: null
    };
  }

  const sourceMatches =
    existingRun.source === preflight.source;

  const reportTypeMatches =
    existingRun.report_type === preflight.report_type;

  const sourceFileSha256Matches =
    existingRun.source_file_sha256 ===
    preflight.source_file_sha256;

  if (
    !sourceMatches ||
    !reportTypeMatches ||
    !sourceFileSha256Matches
  ) {
    throw new Error(
      "Mismatched ingestion dedupe candidate"
    );
  }

  const ingestionRunId =
    existingRun.ingestion_run_id;

  if (
    typeof ingestionRunId !== "string" ||
    ingestionRunId.trim().length === 0
  ) {
    throw new Error(
      "Invalid ingestion dedupe candidate: ingestion_run_id"
    );
  }

  return {
    dedupe_status: "duplicate",
    should_import: false,
    existing_ingestion_run_id:
      ingestionRunId
  };
}

function isNonNullString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function assertIncomingAttribution(attribution, prefix) {
  if (
    attribution?.attributed_publisher_id !== null &&
    typeof attribution?.attributed_publisher_id !== "string"
  ) {
    throw new Error(
      `${prefix}: attribution`
    );
  }

  if (
    attribution?.attributed_placement !== null &&
    typeof attribution?.attributed_placement !== "string"
  ) {
    throw new Error(
      `${prefix}: attribution`
    );
  }

  if (!isNonNullString(attribution?.attribution_status)) {
    throw new Error(
      `${prefix}: attribution`
    );
  }
}

function assertExistingAttribution(existingFact, prefix) {
  if (
    existingFact?.attributed_publisher_id !== null &&
    typeof existingFact?.attributed_publisher_id !== "string"
  ) {
    throw new Error(
      `${prefix}: attribution`
    );
  }

  if (
    existingFact?.attributed_placement !== null &&
    typeof existingFact?.attributed_placement !== "string"
  ) {
    throw new Error(
      `${prefix}: attribution`
    );
  }

  if (!isNonNullString(existingFact?.attribution_status)) {
    throw new Error(
      `${prefix}: attribution`
    );
  }
}

function materialStateEqual(normalizedRow, existingFact) {
  return (
    normalizedRow.source_row_hash ===
      existingFact.source_row_hash &&
    normalizedRow.attributed_publisher_id ===
      existingFact.attributed_publisher_id &&
    normalizedRow.attributed_placement ===
      existingFact.attributed_placement &&
    normalizedRow.attribution_status ===
      existingFact.attribution_status
  );
}

export function planBookingCurrentState(normalizedRow, existingFact) {
  if (!isNonNullString(normalizedRow?.source_record_key)) {
    throw new Error(
      "Invalid booking current-state input: source_record_key"
    );
  }

  if (!isNonNullString(normalizedRow?.source_row_hash)) {
    throw new Error(
      "Invalid booking current-state input: source_row_hash"
    );
  }

  assertIncomingAttribution(
    normalizedRow,
    "Invalid booking current-state input"
  );

  if (
    existingFact === null ||
    existingFact === undefined
  ) {
    return {
      state_action: "insert",
      existing_fact_id: null
    };
  }

  if (
    existingFact.source_record_key !==
    normalizedRow.source_record_key
  ) {
    throw new Error(
      "Mismatched booking current-state candidate"
    );
  }

  if (!isNonNullString(existingFact?.booking_fact_id)) {
    throw new Error(
      "Invalid booking current-state candidate: booking_fact_id"
    );
  }

  if (!isNonNullString(existingFact?.source_row_hash)) {
    throw new Error(
      "Invalid booking current-state candidate: source_row_hash"
    );
  }

  assertExistingAttribution(
    existingFact,
    "Invalid booking current-state candidate"
  );

  return {
    state_action:
      materialStateEqual(normalizedRow, existingFact)
        ? "unchanged"
        : "update",
    existing_fact_id:
      existingFact.booking_fact_id
  };
}

export function planCommissionCurrentState(normalizedRow, existingFact) {
  if (!isNonNullString(normalizedRow?.commission_record_key)) {
    throw new Error(
      "Invalid commission current-state input: commission_record_key"
    );
  }

  if (!isNonNullString(normalizedRow?.source_row_hash)) {
    throw new Error(
      "Invalid commission current-state input: source_row_hash"
    );
  }

  assertIncomingAttribution(
    normalizedRow,
    "Invalid commission current-state input"
  );

  if (
    existingFact === null ||
    existingFact === undefined
  ) {
    return {
      state_action: "insert",
      existing_fact_id: null
    };
  }

  if (
    existingFact.commission_record_key !==
    normalizedRow.commission_record_key
  ) {
    throw new Error(
      "Mismatched commission current-state candidate"
    );
  }

  if (!isNonNullString(existingFact?.commission_fact_id)) {
    throw new Error(
      "Invalid commission current-state candidate: commission_fact_id"
    );
  }

  if (!isNonNullString(existingFact?.source_row_hash)) {
    throw new Error(
      "Invalid commission current-state candidate: source_row_hash"
    );
  }

  assertExistingAttribution(
    existingFact,
    "Invalid commission current-state candidate"
  );

  return {
    state_action:
      materialStateEqual(normalizedRow, existingFact)
        ? "unchanged"
        : "update",
    existing_fact_id:
      existingFact.commission_fact_id
  };
}

export function planCurrentStateObservationMetadata(statePlan, context) {
  if (
    statePlan === null ||
    typeof statePlan !== "object" ||
    Array.isArray(statePlan)
  ) {
    throw new Error(
      "Invalid current-state observation plan"
    );
  }

  if (
    statePlan.state_action !== "insert" &&
    statePlan.state_action !== "update" &&
    statePlan.state_action !== "unchanged"
  ) {
    throw new Error(
      "Invalid current-state observation plan"
    );
  }

  if (!isNonNullString(context?.ingestion_run_id)) {
    throw new Error(
      "Invalid observation context: ingestion_run_id"
    );
  }

  if (!isNonNullString(context?.observed_at)) {
    throw new Error(
      "Invalid observation context: observed_at"
    );
  }

  if (statePlan.state_action === "insert") {
    return {
      first_seen_at: context.observed_at,
      last_seen_at: context.observed_at,
      first_ingestion_run_id: context.ingestion_run_id,
      last_ingestion_run_id: context.ingestion_run_id,
      source_ingested_at: context.observed_at
    };
  }

  return {
    last_seen_at: context.observed_at,
    last_ingestion_run_id: context.ingestion_run_id,
    source_ingested_at: context.observed_at
  };
}

const OBSERVATION_INSERT_FIELDS = [
  "first_seen_at",
  "last_seen_at",
  "first_ingestion_run_id",
  "last_ingestion_run_id",
  "source_ingested_at"
];

const OBSERVATION_LATEST_FIELDS = [
  "last_seen_at",
  "last_ingestion_run_id",
  "source_ingested_at"
];

const BOOKING_MATERIAL_FIELDS = [
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
  "ouid"
];

const COMMISSION_MATERIAL_FIELDS = [
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
  "ouid"
];

function isNonNullObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function mapFields(source, fields) {
  const result = {};

  for (const field of fields) {
    result[field] = source[field];
  }

  return result;
}

function assertFactPersistenceStatePlan(statePlan) {
  if (!isNonNullObject(statePlan)) {
    throw new Error(
      "Invalid fact persistence state plan"
    );
  }

  if (
    statePlan.state_action !== "insert" &&
    statePlan.state_action !== "update" &&
    statePlan.state_action !== "unchanged"
  ) {
    throw new Error(
      "Invalid fact persistence state plan"
    );
  }

  if (statePlan.state_action === "insert") {
    if (statePlan.existing_fact_id !== null) {
      throw new Error(
        "Invalid fact persistence state plan"
      );
    }
  } else if (
    !isNonNullString(statePlan.existing_fact_id)
  ) {
    throw new Error(
      "Invalid fact persistence state plan"
    );
  }
}

function assertObservationMetadata(
  observationMetadata,
  stateAction,
  errorPrefix
) {
  if (!isNonNullObject(observationMetadata)) {
    throw new Error(
      `${errorPrefix} persistence observation metadata`
    );
  }

  const fields =
    stateAction === "insert"
      ? OBSERVATION_INSERT_FIELDS
      : OBSERVATION_LATEST_FIELDS;

  for (const field of fields) {
    if (!isNonNullString(observationMetadata[field])) {
      throw new Error(
        `${errorPrefix} persistence observation metadata`
      );
    }
  }
}

function assertPersistenceContext(
  context,
  stateAction,
  errorPrefix
) {
  if (stateAction === "insert") {
    if (!isNonNullString(context?.new_fact_id)) {
      throw new Error(
        `${errorPrefix} persistence context: new_fact_id`
      );
    }
  }

  if (stateAction !== "unchanged") {
    if (!isNonNullString(context?.raw_payload_json)) {
      throw new Error(
        `${errorPrefix} persistence context: raw_payload_json`
      );
    }
  }
}

export function planBookingFactPersistence(
  normalizedRow,
  statePlan,
  observationMetadata,
  context
) {
  if (!isNonNullObject(normalizedRow)) {
    throw new Error(
      "Invalid fact persistence normalized row"
    );
  }

  assertFactPersistenceStatePlan(statePlan);
  assertObservationMetadata(
    observationMetadata,
    statePlan.state_action,
    "Invalid booking"
  );
  assertPersistenceContext(
    context,
    statePlan.state_action,
    "Invalid booking"
  );

  if (statePlan.state_action === "insert") {
    return {
      persistence_action: "insert",
      booking_fact_id: context.new_fact_id,
      values: {
        booking_fact_id: context.new_fact_id,
        source_record_key:
          normalizedRow.source_record_key,
        ...mapFields(normalizedRow, BOOKING_MATERIAL_FIELDS),
        ...mapFields(observationMetadata, OBSERVATION_INSERT_FIELDS),
        raw_payload_json: context.raw_payload_json
      }
    };
  }

  if (statePlan.state_action === "update") {
    return {
      persistence_action: "update_material",
      booking_fact_id: statePlan.existing_fact_id,
      values: {
        ...mapFields(normalizedRow, BOOKING_MATERIAL_FIELDS),
        ...mapFields(observationMetadata, OBSERVATION_LATEST_FIELDS),
        raw_payload_json: context.raw_payload_json
      }
    };
  }

  return {
    persistence_action: "update_observation",
    booking_fact_id: statePlan.existing_fact_id,
    values:
      mapFields(observationMetadata, OBSERVATION_LATEST_FIELDS)
  };
}

export function planCommissionFactPersistence(
  normalizedRow,
  statePlan,
  observationMetadata,
  context
) {
  if (!isNonNullObject(normalizedRow)) {
    throw new Error(
      "Invalid fact persistence normalized row"
    );
  }

  assertFactPersistenceStatePlan(statePlan);
  assertObservationMetadata(
    observationMetadata,
    statePlan.state_action,
    "Invalid commission"
  );
  assertPersistenceContext(
    context,
    statePlan.state_action,
    "Invalid commission"
  );

  if (statePlan.state_action === "insert") {
    return {
      persistence_action: "insert",
      commission_fact_id: context.new_fact_id,
      values: {
        commission_fact_id: context.new_fact_id,
        commission_record_key:
          normalizedRow.commission_record_key,
        ...mapFields(normalizedRow, COMMISSION_MATERIAL_FIELDS),
        ...mapFields(observationMetadata, OBSERVATION_INSERT_FIELDS),
        raw_payload_json: context.raw_payload_json
      }
    };
  }

  if (statePlan.state_action === "update") {
    return {
      persistence_action: "update_material",
      commission_fact_id: statePlan.existing_fact_id,
      values: {
        ...mapFields(normalizedRow, COMMISSION_MATERIAL_FIELDS),
        ...mapFields(observationMetadata, OBSERVATION_LATEST_FIELDS),
        raw_payload_json: context.raw_payload_json
      }
    };
  }

  return {
    persistence_action: "update_observation",
    commission_fact_id: statePlan.existing_fact_id,
    values:
      mapFields(observationMetadata, OBSERVATION_LATEST_FIELDS)
  };
}
