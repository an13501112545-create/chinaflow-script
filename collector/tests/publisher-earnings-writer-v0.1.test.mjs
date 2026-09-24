import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  validatePublisherEarningsCommand,
  executePublisherEarningsCommand
} from "../publisher-earnings-writer-v0.1.mjs";
import { handleReportingImporterRequest } from "../reporting-importer-worker-v0.1.mjs";

const ROUTE = "https://internal.test/v1/internal/reporting/earnings";
const TOKEN = "reconciliation-test-token";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  sqlite.exec(`
    INSERT INTO publishers(publisher_id,slug,display_name,account_status) VALUES
      ('p','p','Publisher','active'),('q','q','Other','active'),('r','r','No Terms','active');
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
    ) VALUES
      ('c1','ck1','trip.com','o1','h1','p','pl-a','matched','10.00',10000000,'CNY','2026-08','t','t','r','r','t','{}'),
      ('c2','ck2','trip.com','o2','h2','r','pl-r','matched','5.00',5000000,'USD','2026-08','t','t','r','r','t','{}');
    INSERT INTO publisher_commission_reconciliations(
      reconciliation_id,commission_fact_id,commission_record_key,publisher_id,attributed_placement,
      decision,supplier_commission_amount_micros_snapshot,supplier_currency_snapshot,
      approved_commission_micros,approved_currency,evidence_reference,effective_at
    ) VALUES
      ('rec_1','c1','ck1','p','pl-a','approved',10000000,'CNY',10000000,'CNY','review-1','2026-08-05 00:00:00'),
      ('rec_2','c2','ck2','r','pl-r','approved',5000000,'USD',5000000,'USD','review-2','2026-08-05 00:00:00');

    INSERT INTO publisher_net_commission_revenue_entries(
      net_commission_entry_id,reconciliation_id,commission_fact_id,publisher_id,attributed_placement,
      evidence_type,evidence_reference,currency,net_commission_revenue_micros,effective_at
    ) VALUES
      ('ncr_1','rec_1','c1','p','pl-a','supplier_settlement','settlement-1','USD',8000000,'2026-08-10 00:00:00'),
      ('ncr_neg','rec_1','c1','p','pl-a','reconciliation_adjustment','adjustment-neg','USD',-1000000,'2026-08-11 00:00:00'),
      ('ncr_cny','rec_1','c1','p','pl-a','reconciliation_adjustment','adjustment-cny','CNY',8000000,'2026-08-12 00:00:00'),
      ('ncr_fraction','rec_1','c1','p','pl-a','reconciliation_adjustment','adjustment-fraction','USD',1,'2026-08-13 00:00:00'),
      ('ncr_no_terms','rec_2','c2','r','pl-r','supplier_settlement','settlement-r','USD',5000000,'2026-08-10 00:00:00');
  `);
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return sqlite.prepare(sql).get(...values) ?? null; },
            async all() { return { results: sqlite.prepare(sql).all(...values) }; },
            async run() { const x=sqlite.prepare(sql).run(...values); return {meta:{changes:Number(x.changes)}}; }
          };
        }
      };
    }
  };
  t.after(() => sqlite.close());
  return { sqlite, database };
}

function runtime(ids=["1","2","3","4"]) {
  const queue=[...ids];
  return { create_id() { const id=queue.shift(); if (!id) throw new Error("unexpected id request"); return id; } };
}

function command(netCommissionEntryId="ncr_1") {
  return {command_type:"publisher.earnings.record",payload:{net_commission_entry_id:netCommissionEntryId}};
}

function env(database, enabled="true", token=TOKEN) {
  return {
    PUBLISHER_RECONCILIATION_WRITER_ENABLED:"true",
    PUBLISHER_EARNINGS_WRITER_ENABLED:enabled,
    CHINAFLOW_RECONCILIATION_API_TOKEN:token,
    CHINAFLOW_REPORTING_IMPORT_TOKEN:"different-import-token",
    CHINAFLOW_EVENTS:database
  };
}

function request(body, {method="POST",auth=`Bearer ${TOKEN}`,idempotency="ncr_1",contentType="application/json",url=ROUTE}={}) {
  const headers={"content-type":contentType};
  if (auth !== null) headers.authorization=auth;
  if (idempotency !== null) headers["idempotency-key"]=idempotency;
  const init={method,headers};
  if (method !== "GET" && method !== "HEAD") init.body=typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url,init);
}

test("earnings writer accepts only exact source-identity command and idempotency key", () => {
  assert.deepEqual(validatePublisherEarningsCommand(command(),"ncr_1"),command());
  assert.equal(validatePublisherEarningsCommand(command(),"other"),null);
  assert.equal(validatePublisherEarningsCommand({...command(),extra:true},"ncr_1"),null);
  assert.equal(validatePublisherEarningsCommand(
    {command_type:"publisher.earnings.record",payload:{net_commission_entry_id:"ncr_1",publisher_earnings_micros:1}},
    "ncr_1"
  ),null);
  assert.equal(validatePublisherEarningsCommand(
    {command_type:"publisher.earnings.record",payload:{net_commission_entry_id:""}},""
  ),null);
});

test("same-currency exact earnings create once and exact retry is idempotent", async t => {
  const f=fixture(t); const rt=runtime();
  const first=await executePublisherEarningsCommand(f.database,command(),"ncr_1",rt);
  assert.deepEqual(first,{status:201,body:{publisher_earnings:{publisher_earnings_entry_id:"earn_1",created:true}}});
  const retry=await executePublisherEarningsCommand(f.database,command(),"ncr_1",rt);
  assert.deepEqual(retry,{status:200,body:{publisher_earnings:{publisher_earnings_entry_id:"earn_1",created:false}}});
  const row={...f.sqlite.prepare(`SELECT commercial_terms_id,net_commission_revenue_currency,
    net_commission_revenue_micros,publisher_share_bps,earnings_currency,publisher_earnings_micros,
    settlement_cycle_month FROM publisher_earnings_entries`).get()};

  assert.deepEqual(row,{commercial_terms_id:"pct_p_v1",net_commission_revenue_currency:"USD",
    net_commission_revenue_micros:8000000,publisher_share_bps:7000,earnings_currency:"USD",
    publisher_earnings_micros:5600000,settlement_cycle_month:"2026-08"});
});

test("cross-currency, missing terms and non-exact micros fail closed", async t => {
  const f=fixture(t);
  for (const net of ["ncr_cny","ncr_no_terms","ncr_fraction"]) {
    const result=await executePublisherEarningsCommand(f.database,command(net),net,runtime());
    assert.deepEqual(result,{status:409,body:{error:"conflict"}});
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM publisher_earnings_entries").get().n,0);
});

test("earnings writer resolves latest commercial terms effective at source time", async t => {
  const f=fixture(t);
  f.sqlite.prepare(`INSERT INTO publisher_commercial_terms(
    commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
    settlement_currency,minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
  ) VALUES ('pct_p_v2','p','account_specific','terms-v2',6000,'USD',100000000,'monthly',30,'2026-08-09 00:00:00')`).run();
  const result=await executePublisherEarningsCommand(f.database,command(),"ncr_1",runtime());
  assert.equal(result.status,201);
  const row={...f.sqlite.prepare(

    "SELECT commercial_terms_id,publisher_share_bps,publisher_earnings_micros FROM publisher_earnings_entries"
  ).get()};
  assert.deepEqual(row,{commercial_terms_id:"pct_p_v2",publisher_share_bps:6000,publisher_earnings_micros:4800000});
});

test("earnings writer preserves signed negative adjustments", async t => {
  const f=fixture(t);
  const result=await executePublisherEarningsCommand(f.database,command("ncr_neg"),"ncr_neg",runtime());
  assert.equal(result.status,201);
  assert.equal(f.sqlite.prepare("SELECT publisher_earnings_micros n FROM publisher_earnings_entries").get().n,-700000);
});

test("dark earnings route returns 404 before finance secret or D1 access", async () => {
  const darkEnv={
    PUBLISHER_EARNINGS_WRITER_ENABLED:"false",
    get CHINAFLOW_RECONCILIATION_API_TOKEN(){assert.fail("secret accessed");},
    get CHINAFLOW_EVENTS(){assert.fail("D1 accessed");}
  };
  const response=await handleReportingImporterRequest(request(command()),darkEnv,runtime());
  assert.equal(response.status,404);
});

test("earnings route requires POST, finance secret, exact auth and JSON", async t => {
  const f=fixture(t);
  for (const method of ["GET","PUT","PATCH","DELETE","OPTIONS"]) {

    const response=await handleReportingImporterRequest(request(null,{method}),env(f.database),runtime());
    assert.equal(response.status,405);
    assert.equal(response.headers.get("allow"),"POST");
  }
  assert.equal((await handleReportingImporterRequest(request(command(),{auth:null}),env(f.database),runtime())).status,401);
  assert.equal((await handleReportingImporterRequest(
    request(command(),{auth:"Bearer different-import-token"}),env(f.database),runtime()
  )).status,401);
  assert.equal((await handleReportingImporterRequest(
    request(command(),{contentType:"text/plain"}),env(f.database),runtime()
  )).status,415);
  assert.equal((await handleReportingImporterRequest(
    request(command(),{idempotency:null}),env(f.database),runtime()
  )).status,400);
  assert.equal((await handleReportingImporterRequest(
    request(command(),{url:ROUTE+"?x=1"}),env(f.database),runtime()
  )).status,400);
});

test("earnings route creates and retries without exposing finance secret", async t => {
  const f=fixture(t); const rt=runtime(["1","2"]);
  const first=await handleReportingImporterRequest(request(command()),env(f.database),rt);
  assert.equal(first.status,201);

  const firstBody=await first.json();
  assert.deepEqual(firstBody,{publisher_earnings:{publisher_earnings_entry_id:"earn_1",created:true}});
  assert.ok(!JSON.stringify(firstBody).includes(TOKEN));
  const retry=await handleReportingImporterRequest(request(command()),env(f.database),rt);
  assert.equal(retry.status,200);
  assert.deepEqual(await retry.json(),{publisher_earnings:{publisher_earnings_entry_id:"earn_1",created:false}});
});

test("reporting importer configs ship earnings writer dark without adding another secret", () => {
  for (const file of ["../wrangler.reporting-importer.test.jsonc","../wrangler.reporting-importer.production.jsonc"]) {
    const config=JSON.parse(readFileSync(new URL(file,import.meta.url),"utf8"));
    assert.equal(config.vars.PUBLISHER_RECONCILIATION_WRITER_ENABLED,"true");
    assert.equal(config.vars.PUBLISHER_EARNINGS_WRITER_ENABLED,"false");
    assert.deepEqual(
      config.secrets.required,
      ["CHINAFLOW_REPORTING_IMPORT_TOKEN","CHINAFLOW_RECONCILIATION_API_TOKEN"]
    );
  }
});
