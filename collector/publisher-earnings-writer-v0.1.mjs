const EARNINGS_RECORD = "publisher.earnings.record";

const failure = (status, error) => ({ status, body: { error } });
const success = (status, body) => ({ status, body });

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  const object = plainObject(value);
  if (!object) return false;
  const keys = Object.keys(object).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((key, index) => key === want[index]);
}

function text(value, max = 512) {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
}

export function validatePublisherEarningsCommand(input, idempotencyKey) {
  if (!exactKeys(input, ["command_type", "payload"])) return null;
  if (input.command_type !== EARNINGS_RECORD) return null;
  if (!exactKeys(input.payload, ["net_commission_entry_id"])) return null;
  const netCommissionEntryId = input.payload.net_commission_entry_id;
  if (!text(netCommissionEntryId, 512) || idempotencyKey !== netCommissionEntryId) return null;
  return { command_type: EARNINGS_RECORD, payload: { net_commission_entry_id: netCommissionEntryId } };
}

async function readExisting(database, netCommissionEntryId) {
  return database.prepare(`SELECT publisher_earnings_entry_id,net_commission_entry_id
    FROM publisher_earnings_entries
    WHERE net_commission_entry_id = ? LIMIT 1`)
    .bind(netCommissionEntryId).first();
}

async function loadBasis(database, netCommissionEntryId) {
  return database.prepare(`SELECT
      n.net_commission_entry_id,
      n.reconciliation_id,
      n.commission_fact_id,
      n.publisher_id,
      n.attributed_placement,
      n.currency AS net_commission_revenue_currency,
      n.net_commission_revenue_micros,
      n.effective_at,
      t.commercial_terms_id,
      t.publisher_share_bps,
      t.settlement_currency AS earnings_currency,
      strftime('%Y-%m', n.effective_at) AS settlement_cycle_month
    FROM publisher_net_commission_revenue_entries n
    JOIN publisher_commercial_terms t
      ON t.publisher_id = n.publisher_id
     AND julianday(t.effective_from) <= julianday(n.effective_at)
    WHERE n.net_commission_entry_id = ?
    ORDER BY julianday(t.effective_from) DESC, t.created_at DESC, t.commercial_terms_id DESC
    LIMIT 1`)
    .bind(netCommissionEntryId).first();
}

function calculateExactEarnings(basis) {
  if (!basis || typeof basis !== "object") return null;
  const amount = basis.net_commission_revenue_micros;
  const share = basis.publisher_share_bps;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(share) || share < 0 || share > 10000) return null;
  if (basis.net_commission_revenue_currency !== basis.earnings_currency) return null;
  if (typeof basis.settlement_cycle_month !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(basis.settlement_cycle_month)) return null;

  const product = BigInt(amount) * BigInt(share);
  if (product % 10000n !== 0n) return null;
  const earnings = product / 10000n;
  const value = Number(earnings);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

function constraintMessage(error) {
  return [error?.message, error?.cause?.message]
    .filter(value => typeof value === "string").join("\n");
}

export async function executePublisherEarningsCommand(database, input, idempotencyKey, runtime) {
  const command = validatePublisherEarningsCommand(input, idempotencyKey);
  if (!command) return failure(400, "invalid_input");
  if (!database || typeof database.prepare !== "function") throw new Error("D1 binding unavailable");
  if (!runtime || typeof runtime.create_id !== "function") throw new Error("runtime unavailable");

  const netCommissionEntryId = command.payload.net_commission_entry_id;
  const existing = await readExisting(database, netCommissionEntryId);
  if (existing) {
    return success(200, {
      publisher_earnings: {
        publisher_earnings_entry_id: existing.publisher_earnings_entry_id,
        created: false
      }
    });
  }

  const basis = await loadBasis(database, netCommissionEntryId);
  const earningsMicros = calculateExactEarnings(basis);
  if (earningsMicros === null) return failure(409, "conflict");

  const id = `earn_${runtime.create_id()}`;
  try {
    const row = await database.prepare(`INSERT INTO publisher_earnings_entries(
      publisher_earnings_entry_id,net_commission_entry_id,reconciliation_id,commission_fact_id,
      publisher_id,attributed_placement,commercial_terms_id,net_commission_revenue_currency,
      net_commission_revenue_micros,publisher_share_bps,earnings_currency,publisher_earnings_micros,
      settlement_cycle_month,effective_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING publisher_earnings_entry_id`).bind(
      id,basis.net_commission_entry_id,basis.reconciliation_id,basis.commission_fact_id,
      basis.publisher_id,basis.attributed_placement,basis.commercial_terms_id,
      basis.net_commission_revenue_currency,basis.net_commission_revenue_micros,
      basis.publisher_share_bps,basis.earnings_currency,earningsMicros,
      basis.settlement_cycle_month,basis.effective_at
    ).first();
    if (row?.publisher_earnings_entry_id !== id) throw new Error("publisher earnings insert mismatch");
    return success(201, {
      publisher_earnings: { publisher_earnings_entry_id: id, created: true }
    });
  } catch (error) {
    const raced = await readExisting(database, netCommissionEntryId);
    if (raced) {
      return success(200, {
        publisher_earnings: {
          publisher_earnings_entry_id: raced.publisher_earnings_entry_id,
          created: false
        }
      });
    }
    const message = constraintMessage(error);
    if (/invalid publisher earnings basis|FOREIGN KEY constraint failed|CHECK constraint failed|UNIQUE constraint failed/u.test(message)) {
      return failure(409, "conflict");
    }
    throw error;
  }
}
