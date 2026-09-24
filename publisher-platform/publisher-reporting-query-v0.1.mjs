import { validateSession } from "./auth-session-validate-v0.1.mjs";

const MAX_MONTHS = 24;

export function publisherReportingQueryEnabled(env) {
  return env?.PUBLISHER_REPORTING_QUERY_ENABLED === "true";
}

function failure(status, error) {
  return { status, body: { error } };
}

function monthOrdinal(value) {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  return year * 12 + month - 1;
}

function validPlacement(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
}

function validateQueryObject(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) return null;
  const fromOrdinal = monthOrdinal(query.from);
  const toOrdinal = monthOrdinal(query.to);
  if (fromOrdinal === null || toOrdinal === null || fromOrdinal > toOrdinal ||
      toOrdinal - fromOrdinal + 1 > MAX_MONTHS) return null;
  if (query.placement !== null && !validPlacement(query.placement)) return null;
  return { from: query.from, to: query.to, placement: query.placement };
}

export function parsePublisherReportingQuery(searchParams) {
  if (!(searchParams instanceof URLSearchParams)) return null;
  const allowed = new Set(["from", "to", "placement"]);
  for (const key of searchParams.keys()) if (!allowed.has(key)) return null;
  for (const key of allowed) if (searchParams.getAll(key).length > 1) return null;

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const placement = searchParams.has("placement") ? searchParams.get("placement") : null;
  return validateQueryObject({ from, to, placement });
}

const ELIGIBLE_SESSION = `SELECT 1 FROM publisher_sessions s
  JOIN publisher_users u ON u.user_id = s.user_id
  WHERE s.session_id = ? AND s.user_id = ? AND s.revoked_at IS NULL
    AND julianday(s.expires_at) > julianday('now') AND u.user_status = 'active'`;

async function resolvePublisher(database, session) {
  const result = await database.prepare(`
    SELECT p.publisher_id
    FROM publisher_memberships m
    JOIN publishers p ON p.publisher_id = m.publisher_id
    WHERE m.user_id = ?
      AND m.membership_status = 'active'
      AND p.account_status = 'active'
      AND EXISTS (${ELIGIBLE_SESSION})
    ORDER BY m.created_at, m.membership_id, p.publisher_id
    LIMIT 2
  `).bind(session.userId, session.sessionId, session.userId).all();
  const rows = result?.results ?? [];
  if (rows.length === 0) return failure(404, "not_found");
  if (rows.length !== 1 || typeof rows[0]?.publisher_id !== "string") return failure(409, "conflict");
  return { publisherId: rows[0].publisher_id };
}

function querySql(table, amountColumns, placementFiltered) {
  const periodColumn = table === "trip_bookings"
    ? "substr(order_date, 1, 7)"
    : "commission_month";
  const sums = amountColumns.flatMap(column => [
    `COUNT(${column}) AS ${column}_rows`,
    `SUM(${column}) AS ${column}`
  ]).join(",\n      ");
  return `SELECT attributed_placement AS placement, currency,
      COUNT(*) AS rows_count,
      ${sums}
    FROM ${table}
    WHERE attributed_publisher_id = ?1
      AND ${periodColumn} >= ?2
      AND ${periodColumn} <= ?3
      ${placementFiltered ? "AND attributed_placement = ?4" : ""}
    GROUP BY attributed_placement, currency
    ORDER BY attributed_placement, currency`;
}

function earningsQuerySql(placementFiltered) {
  return `SELECT attributed_placement AS placement, earnings_currency AS currency,
      COUNT(*) AS rows_count,
      COUNT(publisher_earnings_micros) AS publisher_earnings_micros_rows,
      SUM(publisher_earnings_micros) AS publisher_earnings_micros
    FROM publisher_earnings_entries
    WHERE publisher_id = ?1
      AND settlement_cycle_month >= ?2
      AND settlement_cycle_month <= ?3
      ${placementFiltered ? "AND attributed_placement = ?4" : ""}
    GROUP BY attributed_placement, earnings_currency
    ORDER BY attributed_placement, earnings_currency`;
}

function integerOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid reporting aggregate result");
  return number;
}

function normalizeRows(rows, amountColumns) {
  if (!Array.isArray(rows)) throw new Error("Invalid reporting aggregate result");
  return rows.map(row => {
    if (typeof row?.placement !== "string" || row.placement.length === 0 ||
        (row.currency !== null && typeof row.currency !== "string")) {
      throw new Error("Invalid reporting aggregate result");
    }
    const count = Number(row.rows_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid reporting aggregate result");
    const output = { placement: row.placement, currency: row.currency ?? null, rows: count };
    for (const column of amountColumns) {
      const amountRows = Number(row[`${column}_rows`]);
      if (!Number.isSafeInteger(amountRows) || amountRows < 0 || amountRows > count) {
        throw new Error("Invalid reporting aggregate result");
      }
      output[`${column}_rows`] = amountRows;
      output[column] = amountRows === 0 ? null : integerOrNull(row[column]);
      if (amountRows > 0 && output[column] === null) {
        throw new Error("Invalid reporting aggregate result");
      }
    }
    return output;
  });
}

function safeAdd(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("Reporting aggregate overflow");
  return value;
}

function totalsByCurrency(rows, amountColumns) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.currency === null ? "\u0000" : row.currency;
    if (!grouped.has(key)) {
      const initial = { currency: row.currency, rows: 0 };
      for (const column of amountColumns) {
        initial[`${column}_rows`] = 0;
        initial[column] = null;
      }
      grouped.set(key, initial);
    }
    const total = grouped.get(key);
    total.rows = safeAdd(total.rows, row.rows);
    for (const column of amountColumns) {
      total[`${column}_rows`] = safeAdd(total[`${column}_rows`], row[`${column}_rows`]);
      if (row[column] !== null) {
        total[column] = total[column] === null ? row[column] : safeAdd(total[column], row[column]);
      }
    }
  }
  return [...grouped.values()].sort((a, b) => String(a.currency ?? "").localeCompare(String(b.currency ?? "")));
}

function normalizeCommercialTerms(row) {
  if (!row) return null;
  const publisherShareBps = Number(row.publisher_share_bps);
  const minimumPayoutMicros = Number(row.minimum_payout_micros);
  const payoutDays = Number(row.payout_days_after_cycle_end);
  if (
    !["standard_terms", "account_specific"].includes(row.terms_source) ||
    typeof row.terms_reference !== "string" || !row.terms_reference ||
    !Number.isSafeInteger(publisherShareBps) || publisherShareBps < 0 || publisherShareBps > 10000 ||
    typeof row.settlement_currency !== "string" || !/^[A-Z]{3}$/.test(row.settlement_currency) ||
    !Number.isSafeInteger(minimumPayoutMicros) || minimumPayoutMicros < 0 ||
    row.settlement_cycle !== "monthly" ||
    !Number.isSafeInteger(payoutDays) || payoutDays < 0 || payoutDays > 365 ||
    typeof row.effective_from !== "string" || !row.effective_from
  ) {
    throw new Error("Invalid commercial terms result");
  }
  return {
    terms_source: row.terms_source,
    terms_reference: row.terms_reference,
    publisher_share_bps: publisherShareBps,
    chinaflow_share_bps: 10000 - publisherShareBps,
    settlement_currency: row.settlement_currency,
    minimum_payout_micros: minimumPayoutMicros,
    settlement_cycle: row.settlement_cycle,
    payout_days_after_cycle_end: payoutDays,
    effective_from: row.effective_from
  };
}

async function loadCommercialTerms(database, publisherId) {
  const row = await database.prepare(`
    SELECT
      terms_source,terms_reference,publisher_share_bps,settlement_currency,
      minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
    FROM publisher_commercial_terms
    WHERE publisher_id = ?
      AND julianday(effective_from) <= julianday('now')
    ORDER BY julianday(effective_from) DESC, created_at DESC, commercial_terms_id DESC
    LIMIT 1
  `).bind(publisherId).first();
  return normalizeCommercialTerms(row);
}

async function loadAggregate(database, publisherId, query, table, amountColumns) {
  const sql = querySql(table, amountColumns, query.placement !== null);
  const statement = database.prepare(sql);
  const bound = query.placement === null
    ? statement.bind(publisherId, query.from, query.to)
    : statement.bind(publisherId, query.from, query.to, query.placement);
  const result = await bound.all();
  return normalizeRows(result?.results, amountColumns);
}

async function loadEarningsAggregate(database, publisherId, query) {
  const sql = earningsQuerySql(query.placement !== null);
  const statement = database.prepare(sql);
  const bound = query.placement === null
    ? statement.bind(publisherId, query.from, query.to)
    : statement.bind(publisherId, query.from, query.to, query.placement);
  const result = await bound.all();
  return normalizeRows(result?.results, ["publisher_earnings_micros"]);
}

export async function getPublisherReportingSummary(database, token, query) {
  const valid = validateQueryObject(query);
  if (!valid) return failure(400, "invalid_input");

  const session = await validateSession(database, token);
  if (!session) return failure(401, "unauthenticated");
  const authorization = await resolvePublisher(database, session);
  if (authorization.status) return authorization;

  const commercialTerms = await loadCommercialTerms(database, authorization.publisherId);
  const bookingRows = await loadAggregate(
    database, authorization.publisherId, valid, "trip_bookings", ["booking_amount_micros"]
  );
  const commissionRows = await loadAggregate(
    database, authorization.publisherId, valid, "trip_commissions",
    ["booking_amount_micros", "commission_amount_micros"]
  );
  const earningsRows = await loadEarningsAggregate(
    database, authorization.publisherId, valid
  );

  return {
    status: 200,
    body: {
      reporting: {
        publisher_id: authorization.publisherId,
        period: { from: valid.from, to: valid.to },
        period_basis: {
          bookings: "order_date_month",
          commissions: "commission_month",
          earnings: "settlement_cycle_month"
        },
        placement: valid.placement,
        commercial_terms: commercialTerms,
        bookings: {
          rows: bookingRows.reduce((sum, row) => sum + row.rows, 0),
          by_currency: totalsByCurrency(bookingRows, ["booking_amount_micros"]),
          by_placement: bookingRows
        },
        commissions: {
          rows: commissionRows.reduce((sum, row) => sum + row.rows, 0),
          by_currency: totalsByCurrency(
            commissionRows, ["booking_amount_micros", "commission_amount_micros"]
          ),
          by_placement: commissionRows
        },
        earnings: {
          rows: earningsRows.reduce((sum, row) => sum + row.rows, 0),
          by_currency: totalsByCurrency(earningsRows, ["publisher_earnings_micros"]),
          by_placement: earningsRows
        }
      }
    }
  };
}
