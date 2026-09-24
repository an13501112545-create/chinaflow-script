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
    INSERT INTO publishers(publisher_id,slug,display_name,account_status)
      VALUES ('p','p','Publisher','active'),('q','q','Other','active');
    INSERT INTO trip_commissions(
      commission_fact_id,commission_record_key,source,source_order_id,source_row_hash,
      attributed_publisher_id,attributed_placement,attribution_status,
      commission_amount_raw,commission_amount_micros,currency,commission_month,
      first_seen_at,last_seen_at,first_ingestion_run_id,last_ingestion_run_id,
      source_ingested_at,raw_payload_json
    ) VALUES
      ('c1','ck1','trip.com','o1','h1','p','pl-a','matched','10.00',10000000,'CNY','2026-08','t','t','r','r','t','{}'),
      ('c2','ck2','trip.com','o2','h2',NULL,NULL,'unmatched','5.00',5000000,'CNY','2026-08','t','t','r','r','t','{}');
  `);
  t.after(() => sqlite.close());
  return sqlite;
}

function reconcile(sqlite, overrides={}) {
  const row={id:'rec_1',fact:'c1',key:'ck1',publisher:'p',placement:'pl-a',decision:'approved',
    supplierAmount:10000000,supplierCurrency:'CNY',approvedAmount:10000000,approvedCurrency:'CNY',
    evidence:'review-1',effective:'2026-08-05 00:00:00',...overrides};
  return sqlite.prepare(`INSERT INTO publisher_commission_reconciliations(
    reconciliation_id,commission_fact_id,commission_record_key,publisher_id,attributed_placement,
    decision,supplier_commission_amount_micros_snapshot,supplier_currency_snapshot,
    approved_commission_micros,approved_currency,evidence_reference,effective_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,row.fact,row.key,row.publisher,row.placement,row.decision,row.supplierAmount,
    row.supplierCurrency,row.approvedAmount,row.approvedCurrency,row.evidence,row.effective
  );
}

function recognize(sqlite, overrides={}) {
  const row={id:'ncr_1',reconciliation:'rec_1',fact:'c1',publisher:'p',placement:'pl-a',
    type:'supplier_settlement',evidence:'settlement-1',currency:'CNY',amount:8000000,
    effective:'2026-08-10 00:00:00',...overrides};
  return sqlite.prepare(`INSERT INTO publisher_net_commission_revenue_entries(
    net_commission_entry_id,reconciliation_id,commission_fact_id,publisher_id,attributed_placement,
    evidence_type,evidence_reference,currency,net_commission_revenue_micros,effective_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,row.reconciliation,row.fact,row.publisher,row.placement,row.type,row.evidence,
    row.currency,row.amount,row.effective
  );
}

test("0013 creates empty reconciliation and net revenue ledgers without backfill", t => {
  const sqlite=fixture(t);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_commission_reconciliations").get().n,0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_net_commission_revenue_entries").get().n,0);
});

test("0013 accepts explicit approval snapshot for a matched Supplier fact", t => {
  const sqlite=fixture(t); reconcile(sqlite);
  const row={...sqlite.prepare(`SELECT commission_fact_id,publisher_id,attributed_placement,decision,
    approved_commission_micros,approved_currency FROM publisher_commission_reconciliations`).get()};
  assert.deepEqual(row,{commission_fact_id:'c1',publisher_id:'p',attributed_placement:'pl-a',decision:'approved',approved_commission_micros:10000000,approved_currency:'CNY'});
});

test("0013 reconciliation rejects unmatched, cross-tenant, placement, key and snapshot mismatches", t => {
  const sqlite=fixture(t);
  for (const overrides of [
    {fact:'c2',key:'ck2',supplierAmount:5000000},
    {publisher:'q'},
    {placement:'pl-b'},
    {key:'wrong'},
    {supplierAmount:999},
    {supplierCurrency:'USD'}
  ]) assert.throws(()=>reconcile(sqlite,overrides), /invalid commission reconciliation fact snapshot|FOREIGN KEY constraint failed/);
});

test("0013 reconciliation history is append-only and permits later reversal decision", t => {
  const sqlite=fixture(t); reconcile(sqlite);
  reconcile(sqlite,{id:'rec_2',decision:'reversed',evidence:'review-2',effective:'2026-08-06 00:00:00'});
  assert.deepEqual(sqlite.prepare(`SELECT decision FROM publisher_commission_reconciliations ORDER BY effective_at`).all().map(r=>r.decision),['approved','reversed']);
  assert.throws(()=>sqlite.exec("UPDATE publisher_commission_reconciliations SET decision='reversed'"),/append-only/);
  assert.throws(()=>sqlite.exec("DELETE FROM publisher_commission_reconciliations"),/append-only/);
});

test("0013 net revenue requires the referenced reconciliation to remain latest approved", t => {
  const sqlite=fixture(t); reconcile(sqlite); recognize(sqlite);
  reconcile(sqlite,{id:'rec_2',decision:'reversed',evidence:'review-2',effective:'2026-08-11 00:00:00'});
  assert.throws(()=>recognize(sqlite,{id:'ncr_2',evidence:'settlement-2'}),/latest approved reconciliation/);
});

test("0013 net revenue supports signed actual retained facts and independent currency", t => {
  const sqlite=fixture(t); reconcile(sqlite);
  recognize(sqlite,{currency:'USD',amount:7000000});
  recognize(sqlite,{id:'ncr_2',type:'reconciliation_adjustment',evidence:'adjustment-1',currency:'USD',amount:-1000000});
  const rows=sqlite.prepare(`SELECT currency,net_commission_revenue_micros FROM publisher_net_commission_revenue_entries ORDER BY net_commission_entry_id`).all().map(r=>({...r}));
  assert.deepEqual(rows,[{currency:'USD',net_commission_revenue_micros:7000000},{currency:'USD',net_commission_revenue_micros:-1000000}]);
});

test("0013 net revenue preserves reconciliation publisher/placement identity and evidence idempotency", t => {
  const sqlite=fixture(t); reconcile(sqlite); recognize(sqlite);
  assert.throws(()=>recognize(sqlite,{id:'ncr_2',publisher:'q',evidence:'settlement-2'}),/latest approved reconciliation|FOREIGN KEY constraint failed/);
  assert.throws(()=>recognize(sqlite,{id:'ncr_3',placement:'pl-b',evidence:'settlement-3'}),/latest approved reconciliation|FOREIGN KEY constraint failed/);
  assert.throws(()=>recognize(sqlite,{id:'ncr_4'}),/UNIQUE constraint failed/);
});

test("0013 net revenue is append-only and contains no earnings, FX or payout facts", t => {
  const sqlite=fixture(t); reconcile(sqlite); recognize(sqlite);
  assert.throws(()=>sqlite.exec("UPDATE publisher_net_commission_revenue_entries SET net_commission_revenue_micros=1"),/append-only/);
  assert.throws(()=>sqlite.exec("DELETE FROM publisher_net_commission_revenue_entries"),/append-only/);
  const columns=sqlite.prepare("PRAGMA table_info(publisher_net_commission_revenue_entries)").all().map(r=>r.name);
  for (const forbidden of ['publisher_earnings_micros','fx_rate','payout_amount_micros','paid_at']) assert.ok(!columns.includes(forbidden));
});
