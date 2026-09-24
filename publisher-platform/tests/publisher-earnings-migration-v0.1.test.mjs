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
    INSERT INTO publisher_commercial_terms(
      commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
      settlement_currency,minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
    ) VALUES
      ('pct_p_v1','p','standard_terms','terms-v1',7000,'USD',100000000,'monthly',30,'2026-08-01 00:00:00'),
      ('pct_q_v1','q','standard_terms','terms-v1',5000,'USD',100000000,'monthly',30,'2026-08-01 00:00:00');
    INSERT INTO trip_commissions(
      commission_fact_id,commission_record_key,source,source_order_id,source_row_hash,
      attributed_publisher_id,attributed_placement,attribution_status,
      commission_amount_raw,commission_amount_micros,currency,commission_month,
      first_seen_at,last_seen_at,first_ingestion_run_id,last_ingestion_run_id,
      source_ingested_at,raw_payload_json
    ) VALUES ('c1','ck1','trip.com','o1','h1','p','pl-a','matched','10.00',10000000,'CNY','2026-08','t','t','r','r','t','{}');
    INSERT INTO publisher_commission_reconciliations(
      reconciliation_id,commission_fact_id,commission_record_key,publisher_id,attributed_placement,
      decision,supplier_commission_amount_micros_snapshot,supplier_currency_snapshot,
      approved_commission_micros,approved_currency,evidence_reference,effective_at
    ) VALUES ('rec_1','c1','ck1','p','pl-a','approved',10000000,'CNY',10000000,'CNY','review-1','2026-08-05 00:00:00');
  `);
  t.after(() => sqlite.close());
  return sqlite;
}

function recognize(sqlite, overrides={}) {
  const row={id:'ncr_1',reconciliation:'rec_1',fact:'c1',publisher:'p',placement:'pl-a',
    type:'supplier_settlement',evidence:'settlement-1',currency:'USD',amount:8000000,
    effective:'2026-08-10 00:00:00',...overrides};
  sqlite.prepare(`INSERT INTO publisher_net_commission_revenue_entries(
    net_commission_entry_id,reconciliation_id,commission_fact_id,publisher_id,attributed_placement,
    evidence_type,evidence_reference,currency,net_commission_revenue_micros,effective_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,row.reconciliation,row.fact,row.publisher,row.placement,row.type,row.evidence,
    row.currency,row.amount,row.effective
  );
  return row;
}

function earn(sqlite, overrides={}) {
  const row={id:'earn_1',net:'ncr_1',reconciliation:'rec_1',fact:'c1',publisher:'p',placement:'pl-a',
    terms:'pct_p_v1',netCurrency:'USD',netAmount:8000000,share:7000,earningsCurrency:'USD',
    earningsAmount:5600000,cycle:'2026-08',effective:'2026-08-10 00:00:00',...overrides};
  return sqlite.prepare(`INSERT INTO publisher_earnings_entries(
    publisher_earnings_entry_id,net_commission_entry_id,reconciliation_id,commission_fact_id,
    publisher_id,attributed_placement,commercial_terms_id,net_commission_revenue_currency,
    net_commission_revenue_micros,publisher_share_bps,earnings_currency,publisher_earnings_micros,
    settlement_cycle_month,effective_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id,row.net,row.reconciliation,row.fact,row.publisher,row.placement,row.terms,row.netCurrency,
    row.netAmount,row.share,row.earningsCurrency,row.earningsAmount,row.cycle,row.effective
  );
}

test("0014 creates an empty earnings ledger without backfill", t => {
  const sqlite=fixture(t);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_earnings_entries").get().n,0);
});

test("0014 accrues exact same-currency Publisher earnings from Net Commission Revenue", t => {
  const sqlite=fixture(t); recognize(sqlite); earn(sqlite);
  const row={...sqlite.prepare(`SELECT net_commission_entry_id,publisher_id,attributed_placement,
    commercial_terms_id,net_commission_revenue_currency,net_commission_revenue_micros,
    publisher_share_bps,earnings_currency,publisher_earnings_micros,settlement_cycle_month
    FROM publisher_earnings_entries`).get()};
  assert.deepEqual(row,{
    net_commission_entry_id:'ncr_1',publisher_id:'p',attributed_placement:'pl-a',
    commercial_terms_id:'pct_p_v1',net_commission_revenue_currency:'USD',
    net_commission_revenue_micros:8000000,publisher_share_bps:7000,
    earnings_currency:'USD',publisher_earnings_micros:5600000,settlement_cycle_month:'2026-08'
  });
});

test("0014 rejects cross-currency earnings without an authoritative conversion fact", t => {
  const sqlite=fixture(t); recognize(sqlite,{currency:'CNY'});
  assert.throws(()=>earn(sqlite,{netCurrency:'CNY'}),/invalid publisher earnings basis/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_earnings_entries").get().n,0);
});

test("0014 validates exact Net Commission Revenue and tenant snapshots", t => {
  const sqlite=fixture(t); recognize(sqlite);
  const invalid = [
    {net:'missing'}, {reconciliation:'wrong'}, {fact:'wrong'}, {publisher:'q'}, {placement:'pl-b'},
    {netCurrency:'CNY'}, {netAmount:7999999}, {terms:'pct_q_v1'}, {share:5000},
    {earningsCurrency:'CNY'}, {earningsAmount:5599999}, {cycle:'2026-09'},
    {effective:'2026-08-11 00:00:00'}
  ];
  invalid.forEach((overrides,index) => {
    assert.throws(()=>earn(sqlite,{id:`earn_invalid_${index}`,...overrides}), /invalid publisher earnings basis|FOREIGN KEY constraint failed/);
  });
});

test("0014 refuses implicit micro rounding", t => {
  const sqlite=fixture(t); recognize(sqlite,{amount:1});
  assert.throws(()=>earn(sqlite,{netAmount:1,earningsAmount:1}),/invalid publisher earnings basis/);
  assert.throws(()=>earn(sqlite,{id:'earn_2',netAmount:1,earningsAmount:0}),/invalid publisher earnings basis/);
});

test("0014 uses the latest commercial terms effective at Net Commission Revenue time", t => {
  const sqlite=fixture(t); recognize(sqlite);
  sqlite.prepare(`INSERT INTO publisher_commercial_terms(
    commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
    settlement_currency,minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
  ) VALUES ('pct_p_v2','p','account_specific','terms-v2',6000,'USD',100000000,'monthly',30,'2026-08-09 00:00:00')`).run();
  assert.throws(()=>earn(sqlite),/invalid publisher earnings basis/);
  earn(sqlite,{id:'earn_2',terms:'pct_p_v2',share:6000,earningsAmount:4800000});
  assert.equal(sqlite.prepare("SELECT publisher_earnings_micros n FROM publisher_earnings_entries").get().n,4800000);
});

test("0014 preserves signed negative earnings adjustments", t => {
  const sqlite=fixture(t); recognize(sqlite,{amount:-1000000});
  earn(sqlite,{netAmount:-1000000,earningsAmount:-700000});
  assert.equal(sqlite.prepare("SELECT publisher_earnings_micros n FROM publisher_earnings_entries").get().n,-700000);
});

test("0014 allows only one earnings entry per Net Commission Revenue entry", t => {
  const sqlite=fixture(t); recognize(sqlite); earn(sqlite);
  assert.throws(()=>earn(sqlite,{id:'earn_2'}),/UNIQUE constraint failed/);
});

test("0014 prevents retroactive commercial terms from rewriting accrued earnings", t => {
  const sqlite=fixture(t); recognize(sqlite); earn(sqlite);
  assert.throws(()=>sqlite.prepare(`INSERT INTO publisher_commercial_terms(
    commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
    settlement_currency,minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
  ) VALUES ('pct_p_retro','p','account_specific','retro',6500,'USD',100000000,'monthly',30,'2026-08-05 00:00:00')`).run(),/retroactively change accrued earnings/);
  sqlite.prepare(`INSERT INTO publisher_commercial_terms(
    commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
    settlement_currency,minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
  ) VALUES ('pct_p_future','p','account_specific','future',6500,'USD',100000000,'monthly',30,'2026-09-01 00:00:00')`).run();
});

test("0014 earnings are append-only and contain no FX, payout or paid-state facts", t => {
  const sqlite=fixture(t); recognize(sqlite); earn(sqlite);
  assert.throws(()=>sqlite.exec("UPDATE publisher_earnings_entries SET publisher_earnings_micros=1"),/append-only/);
  assert.throws(()=>sqlite.exec("DELETE FROM publisher_earnings_entries"),/append-only/);
  const columns=sqlite.prepare("PRAGMA table_info(publisher_earnings_entries)").all().map(r=>r.name);
  for (const forbidden of ['fx_rate','fx_source','payout_amount_micros','payment_reference','paid_at']) assert.ok(!columns.includes(forbidden));
});
