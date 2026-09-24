const RECONCILE = "publisher.commission.reconcile";
const RECOGNIZE = "publisher.net_commission_revenue.record";

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

function currency(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function timestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function integerOrNull(value) {
  return value === null || Number.isSafeInteger(value);
}

function nonzeroInteger(value) {
  return Number.isSafeInteger(value) && value !== 0;
}

function reconciliationPayload(payload) {
  const keys = [
    "commission_fact_id","commission_record_key","publisher_id","attributed_placement",
    "decision","supplier_commission_amount_micros_snapshot","supplier_currency_snapshot",
    "approved_commission_micros","approved_currency","evidence_reference","effective_at"
  ];
  if (!exactKeys(payload, keys)) return null;
  if (![payload.commission_fact_id,payload.commission_record_key,payload.publisher_id,
    payload.attributed_placement,payload.evidence_reference].every(value => text(value, 512))) return null;
  if (!new Set(["approved","reversed"]).has(payload.decision)) return null;
  if (!integerOrNull(payload.supplier_commission_amount_micros_snapshot)) return null;
  if (!(payload.supplier_currency_snapshot === null || currency(payload.supplier_currency_snapshot))) return null;
  if ((payload.supplier_commission_amount_micros_snapshot === null) !== (payload.supplier_currency_snapshot === null)) return null;
  if (!nonzeroInteger(payload.approved_commission_micros) || !currency(payload.approved_currency)) return null;
  if (!timestamp(payload.effective_at)) return null;
  return {...payload};
}

function netRevenuePayload(payload) {
  const keys = [
    "reconciliation_id","commission_fact_id","publisher_id","attributed_placement",
    "evidence_type","evidence_reference","currency","net_commission_revenue_micros","effective_at"
  ];
  if (!exactKeys(payload, keys)) return null;
  if (![payload.reconciliation_id,payload.commission_fact_id,payload.publisher_id,
    payload.attributed_placement,payload.evidence_reference].every(value => text(value, 512))) return null;
  if (!new Set(["supplier_settlement","reconciliation_adjustment"]).has(payload.evidence_type)) return null;
  if (!currency(payload.currency) || !nonzeroInteger(payload.net_commission_revenue_micros)) return null;
  if (!timestamp(payload.effective_at)) return null;
  return {...payload};
}

export function validatePublisherReconciliationCommand(input, idempotencyKey) {
  if (!text(idempotencyKey, 512) || !exactKeys(input, ["command_type","payload"])) return null;
  if (input.command_type === RECONCILE) {
    const payload = reconciliationPayload(input.payload);
    if (!payload || payload.evidence_reference !== idempotencyKey) return null;
    return { command_type: RECONCILE, payload };
  }
  if (input.command_type === RECOGNIZE) {
    const payload = netRevenuePayload(input.payload);
    if (!payload || payload.evidence_reference !== idempotencyKey) return null;
    return { command_type: RECOGNIZE, payload };
  }
  return null;
}

function same(row, payload, fields) {
  return fields.every(field => row?.[field] === payload[field]);
}

const RECONCILIATION_FIELDS = [
  "commission_fact_id","commission_record_key","publisher_id","attributed_placement","decision",
  "supplier_commission_amount_micros_snapshot","supplier_currency_snapshot",
  "approved_commission_micros","approved_currency","evidence_reference","effective_at"
];

const NET_REVENUE_FIELDS = [
  "reconciliation_id","commission_fact_id","publisher_id","attributed_placement","evidence_type",
  "evidence_reference","currency","net_commission_revenue_micros","effective_at"
];

async function readReconciliationByEvidence(database, payload) {
  return database.prepare(`SELECT reconciliation_id,${RECONCILIATION_FIELDS.join(",")}
    FROM publisher_commission_reconciliations
    WHERE commission_fact_id = ? AND evidence_reference = ? LIMIT 1`)
    .bind(payload.commission_fact_id, payload.evidence_reference).first();
}

async function readNetRevenueByEvidence(database, payload) {
  return database.prepare(`SELECT net_commission_entry_id,${NET_REVENUE_FIELDS.join(",")}
    FROM publisher_net_commission_revenue_entries
    WHERE publisher_id = ? AND evidence_type = ? AND evidence_reference = ? LIMIT 1`)
    .bind(payload.publisher_id, payload.evidence_type, payload.evidence_reference).first();
}

function constraintMessage(error) {
  return [error?.message,error?.cause?.message].filter(value => typeof value === "string").join("\n");
}

async function insertReconciliation(database, payload, runtime) {
  const existing = await readReconciliationByEvidence(database, payload);
  if (existing) {
    return same(existing, payload, RECONCILIATION_FIELDS)
      ? success(200, { reconciliation: { reconciliation_id: existing.reconciliation_id, created: false } })
      : failure(409, "conflict");
  }
  const id = `rec_${runtime.create_id()}`;
  try {
    const row = await database.prepare(`INSERT INTO publisher_commission_reconciliations(
      reconciliation_id,commission_fact_id,commission_record_key,publisher_id,attributed_placement,
      decision,supplier_commission_amount_micros_snapshot,supplier_currency_snapshot,
      approved_commission_micros,approved_currency,evidence_reference,effective_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING reconciliation_id`).bind(
      id,payload.commission_fact_id,payload.commission_record_key,payload.publisher_id,
      payload.attributed_placement,payload.decision,payload.supplier_commission_amount_micros_snapshot,
      payload.supplier_currency_snapshot,payload.approved_commission_micros,payload.approved_currency,
      payload.evidence_reference,payload.effective_at
    ).first();
    if (row?.reconciliation_id !== id) throw new Error("reconciliation insert mismatch");
    return success(201, { reconciliation: { reconciliation_id: id, created: true } });
  } catch (error) {
    const raced = await readReconciliationByEvidence(database, payload);
    if (raced) {
      return same(raced, payload, RECONCILIATION_FIELDS)
        ? success(200, { reconciliation: { reconciliation_id: raced.reconciliation_id, created: false } })
        : failure(409, "conflict");
    }
    const message = constraintMessage(error);
    if (/invalid commission reconciliation fact snapshot|FOREIGN KEY constraint failed|CHECK constraint failed|UNIQUE constraint failed/u.test(message)) {
      return failure(409, "conflict");
    }
    throw error;
  }
}

async function insertNetRevenue(database, payload, runtime) {
  const existing = await readNetRevenueByEvidence(database, payload);
  if (existing) {
    return same(existing, payload, NET_REVENUE_FIELDS)
      ? success(200, { net_commission_revenue: { net_commission_entry_id: existing.net_commission_entry_id, created: false } })
      : failure(409, "conflict");
  }
  const id = `ncr_${runtime.create_id()}`;
  try {
    const row = await database.prepare(`INSERT INTO publisher_net_commission_revenue_entries(
      net_commission_entry_id,reconciliation_id,commission_fact_id,publisher_id,attributed_placement,
      evidence_type,evidence_reference,currency,net_commission_revenue_micros,effective_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    RETURNING net_commission_entry_id`).bind(
      id,payload.reconciliation_id,payload.commission_fact_id,payload.publisher_id,
      payload.attributed_placement,payload.evidence_type,payload.evidence_reference,payload.currency,
      payload.net_commission_revenue_micros,payload.effective_at
    ).first();
    if (row?.net_commission_entry_id !== id) throw new Error("net commission insert mismatch");
    return success(201, { net_commission_revenue: { net_commission_entry_id: id, created: true } });
  } catch (error) {
    const raced = await readNetRevenueByEvidence(database, payload);
    if (raced) {
      return same(raced, payload, NET_REVENUE_FIELDS)
        ? success(200, { net_commission_revenue: { net_commission_entry_id: raced.net_commission_entry_id, created: false } })
        : failure(409, "conflict");
    }
    const message = constraintMessage(error);
    if (/latest approved reconciliation|FOREIGN KEY constraint failed|CHECK constraint failed|UNIQUE constraint failed/u.test(message)) {
      return failure(409, "conflict");
    }
    throw error;
  }
}

export async function executePublisherReconciliationCommand(database, input, idempotencyKey, runtime) {
  const command = validatePublisherReconciliationCommand(input, idempotencyKey);
  if (!command) return failure(400, "invalid_input");
  if (!database || typeof database.prepare !== "function") throw new Error("D1 binding unavailable");
  if (!runtime || typeof runtime.create_id !== "function") throw new Error("runtime unavailable");
  return command.command_type === RECONCILE
    ? insertReconciliation(database, command.payload, runtime)
    : insertNetRevenue(database, command.payload, runtime);
}
