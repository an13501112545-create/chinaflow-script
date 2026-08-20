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

  const attribution =
    resolveTripSub1Attribution(
      row?.tripSub1,
      context?.matchedPlacement
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

  const attribution =
    resolveTripSub1Attribution(
      row?.tripSub1,
      context?.matchedPlacement
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
