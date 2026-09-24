import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  sqlite.exec(`
    INSERT INTO publisher_users(user_id,email,email_normalized)
      VALUES ('u','owner@example.test','owner@example.test');
    INSERT INTO publishers(
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id
    ) VALUES (
      'p','p','Publisher','active',
      'chinaflow-publisher-terms-v1','2026-01-01 00:00:00','u'
    );
    INSERT INTO publisher_commercial_terms(
      commercial_terms_id,publisher_id,terms_source,terms_reference,
      publisher_share_bps,settlement_currency,minimum_payout_micros,
      settlement_cycle,payout_days_after_cycle_end,effective_from,created_at
    ) VALUES (
      'pct_custom_p','p','account_specific','custom-v2',8000,'USD',50000000,
      'monthly',20,'2026-07-01 00:00:00','2026-07-01 00:00:01'
    );
  `);
  t.after(() => sqlite.close());
  return sqlite;
}

function insert(sqlite, overrides = {}) {
  const row = {
    id: 'ncr_1', publisher: 'p', terms: 'pct_custom_p', source: 'trip.com',
    type: 'supplier_settlement', ref: 'settlement-2026-08-line-1', period: '2026-08',
    currency: 'USD', amount: 10000000, recognized: '2026-08-05 00:00:00', ...overrides
  };
  return sqlite.prepare(`INSERT INTO publisher_net_commission_revenue(
    net_commission_entry_id,publisher_id,commercial_terms_id,source,source_type,
    source_reference,settlement_period,settlement_currency,
    net_commission_revenue_micros,recognized_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,row.publisher,row.terms,row.source,row.type,row.ref,row.period,
    row.currency,row.amount,row.recognized
  );
}

test("0013 creates an empty append-only net commission revenue ledger", t => {
  const sqlite = fixture(t);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_net_commission_revenue").get().n, 0);
  const names = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
    AND name LIKE 'tr_publisher_net_commission_%' ORDER BY name`).all().map(row => row.name);
  assert.deepEqual(names, [
    'tr_publisher_net_commission_no_delete',
    'tr_publisher_net_commission_no_update',
    'tr_publisher_net_commission_validate_terms'
  ]);
});

test("0013 accepts positive settlement facts and negative reconciliation reversals", t => {
  const sqlite = fixture(t);
  insert(sqlite);
  insert(sqlite, {
    id:'ncr_2', type:'reconciliation_adjustment', ref:'settlement-2026-08-reversal-1', amount:-2500000
  });
  const rows = sqlite.prepare(`SELECT source_type,net_commission_revenue_micros
    FROM publisher_net_commission_revenue ORDER BY net_commission_entry_id`).all()
    .map(row => ({...row}));
  assert.deepEqual(rows, [
    {source_type:'supplier_settlement',net_commission_revenue_micros:10000000},
    {source_type:'reconciliation_adjustment',net_commission_revenue_micros:-2500000}
  ]);
});

test("0013 rejects duplicate accounting source references", t => {
  const sqlite = fixture(t);
  insert(sqlite);
  assert.throws(() => insert(sqlite,{id:'ncr_2'}), /UNIQUE constraint failed/);
});

test("0013 enforces current effective commercial terms and matching settlement currency", t => {
  const sqlite = fixture(t);
  assert.throws(() => insert(sqlite,{terms:'pct_v1_p'}), /invalid net commission commercial terms snapshot/);
  assert.throws(() => insert(sqlite,{currency:'CAD'}), /invalid net commission commercial terms snapshot/);
  assert.throws(() => insert(sqlite,{recognized:'2026-06-05 00:00:00',period:'2026-06',terms:'pct_custom_p'}), /invalid net commission commercial terms snapshot/);
});

test("0013 requires settlement period to match recognition month and nonzero facts", t => {
  const sqlite = fixture(t);
  assert.throws(() => insert(sqlite,{period:'2026-09'}), /settlement period mismatch/);
  assert.throws(() => insert(sqlite,{amount:0}), /CHECK constraint failed/);
});

test("0013 commercial terms ownership cannot cross publisher boundary", t => {
  const sqlite = fixture(t);
  sqlite.exec(`
    INSERT INTO publishers(publisher_id,slug,display_name,account_status)
      VALUES ('q','q','Other','active');
  `);
  assert.throws(() => insert(sqlite,{publisher:'q'}), /invalid net commission commercial terms snapshot/);
});

test("0013 ledger rows cannot be updated or deleted", t => {
  const sqlite = fixture(t);
  insert(sqlite);
  assert.throws(() => sqlite.exec("UPDATE publisher_net_commission_revenue SET net_commission_revenue_micros=1"), /append-only/);
  assert.throws(() => sqlite.exec("DELETE FROM publisher_net_commission_revenue"), /append-only/);
});

test("0013 contains no automatic earnings or payout columns", t => {
  const sqlite = fixture(t);
  const columns = sqlite.prepare("PRAGMA table_info(publisher_net_commission_revenue)").all().map(row => row.name);
  assert.ok(!columns.includes('publisher_earnings_micros'));
  assert.ok(!columns.includes('payout_amount_micros'));
  assert.ok(!columns.includes('paid_at'));
});
