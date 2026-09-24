import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  validatePublisherReconciliationCommand,
  executePublisherReconciliationCommand
} from "../publisher-reconciliation-writer-v0.1.mjs";
import { handleReportingImporterRequest } from "../reporting-importer-worker-v0.1.mjs";

const ROUTE = "https://internal.test/v1/internal/reporting/reconciliation";
const TOKEN = "reconciliation-test-token";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../migrations/", import.meta.url);
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

function reconcileCommand(overrides={}) {
  const payload={
    commission_fact_id:"c1", commission_record_key:"ck1", publisher_id:"p",
    attributed_placement:"pl-a", decision:"approved",
    supplier_commission_amount_micros_snapshot:10000000, supplier_currency_snapshot:"CNY",
    approved_commission_micros:10000000, approved_currency:"CNY",
    evidence_reference:"review-1", effective_at:"2026-08-05T00:00:00Z",
    ...overrides
  };
  return {command_type:"publisher.commission.reconcile",payload};
}

function revenueCommand(reconciliationId="rec_1", overrides={}) {
  const payload={
    reconciliation_id:reconciliationId, commission_fact_id:"c1", publisher_id:"p",
    attributed_placement:"pl-a", evidence_type:"supplier_settlement",
    evidence_reference:"settlement-1", currency:"USD",
    net_commission_revenue_micros:7000000, effective_at:"2026-08-10T00:00:00Z",
    ...overrides
  };
  return {command_type:"publisher.net_commission_revenue.record",payload};
}

function env(database, enabled="true", token=TOKEN) {
  return {
    PUBLISHER_RECONCILIATION_WRITER_ENABLED:enabled,
    CHINAFLOW_RECONCILIATION_API_TOKEN:token,
    CHINAFLOW_REPORTING_IMPORT_TOKEN:"different-import-token",
    CHINAFLOW_EVENTS:database
  };
}

function request(body, {method="POST",auth=`Bearer ${TOKEN}`,idempotency,contentType="application/json",url=ROUTE}={}) {
  const headers={"content-type":contentType};
  if (auth !== null) headers.authorization=auth;
  if (idempotency !== undefined) headers["idempotency-key"]=idempotency;
  const init={method,headers};
  if (method !== "GET" && method !== "HEAD") init.body=typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url,init);
}

test("writer validates exact command schema and evidence/idempotency equality", () => {
  const command=reconcileCommand();
  assert.deepEqual(validatePublisherReconciliationCommand(command,"review-1"),command);
  assert.equal(validatePublisherReconciliationCommand(command,"other"),null);
  assert.equal(validatePublisherReconciliationCommand({...command,extra:true},"review-1"),null);
  assert.equal(validatePublisherReconciliationCommand(reconcileCommand({approved_currency:"usd"}),"review-1"),null);
  assert.equal(validatePublisherReconciliationCommand(reconcileCommand({effective_at:"2026-08-05 00:00:00"}),"review-1"),null);
});

test("approved reconciliation creates once and exact retry is idempotent", async t => {
  const f=fixture(t); const rt=runtime();
  const first=await executePublisherReconciliationCommand(f.database,reconcileCommand(),"review-1",rt);
  assert.deepEqual(first,{status:201,body:{reconciliation:{reconciliation_id:"rec_1",created:true}}});
  const retry=await executePublisherReconciliationCommand(f.database,reconcileCommand(),"review-1",rt);
  assert.deepEqual(retry,{status:200,body:{reconciliation:{reconciliation_id:"rec_1",created:false}}});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM publisher_commission_reconciliations").get().n,1);
});

test("same evidence with different reconciliation payload is conflict", async t => {
  const f=fixture(t); const rt=runtime();
  assert.equal((await executePublisherReconciliationCommand(f.database,reconcileCommand(),"review-1",rt)).status,201);
  const conflict=await executePublisherReconciliationCommand(f.database,reconcileCommand({approved_commission_micros:9000000}),"review-1",rt);
  assert.deepEqual(conflict,{status:409,body:{error:"conflict"}});
});

test("reconciliation cannot approve unmatched or cross-tenant Supplier fact", async t => {
  const f=fixture(t);
  const unmatched=reconcileCommand({commission_fact_id:"c2",commission_record_key:"ck2",publisher_id:"p",attributed_placement:"pl-a",supplier_commission_amount_micros_snapshot:5000000,evidence_reference:"review-2"});
  assert.equal((await executePublisherReconciliationCommand(f.database,unmatched,"review-2",runtime())).status,409);
  const cross=reconcileCommand({publisher_id:"q",evidence_reference:"review-3"});
  assert.equal((await executePublisherReconciliationCommand(f.database,cross,"review-3",runtime())).status,409);
});

test("net revenue creates once, permits signed adjustment, and exact retry is idempotent", async t => {
  const f=fixture(t); const rt=runtime(["1","2","3"]);
  const rec=await executePublisherReconciliationCommand(f.database,reconcileCommand(),"review-1",rt);
  const recId=rec.body.reconciliation.reconciliation_id;
  const first=await executePublisherReconciliationCommand(f.database,revenueCommand(recId),"settlement-1",rt);
  assert.deepEqual(first,{status:201,body:{net_commission_revenue:{net_commission_entry_id:"ncr_2",created:true}}});
  const retry=await executePublisherReconciliationCommand(f.database,revenueCommand(recId),"settlement-1",rt);
  assert.deepEqual(retry,{status:200,body:{net_commission_revenue:{net_commission_entry_id:"ncr_2",created:false}}});
  const adjustment=revenueCommand(recId,{evidence_type:"reconciliation_adjustment",evidence_reference:"adjustment-1",net_commission_revenue_micros:-1000000});
  assert.equal((await executePublisherReconciliationCommand(f.database,adjustment,"adjustment-1",rt)).status,201);
});

test("later reversal blocks new Net Commission Revenue recognition", async t => {
  const f=fixture(t); const rt=runtime(["1","2","3"]);
  const rec=await executePublisherReconciliationCommand(f.database,reconcileCommand(),"review-1",rt);
  const reverse=reconcileCommand({decision:"reversed",evidence_reference:"review-2",effective_at:"2026-08-11T00:00:00Z"});
  assert.equal((await executePublisherReconciliationCommand(f.database,reverse,"review-2",rt)).status,201);
  const blocked=await executePublisherReconciliationCommand(f.database,revenueCommand(rec.body.reconciliation.reconciliation_id),"settlement-1",rt);
  assert.deepEqual(blocked,{status:409,body:{error:"conflict"}});
});

test("dark reconciliation route returns 404 before secret or D1 access", async () => {
  const darkEnv={
    PUBLISHER_RECONCILIATION_WRITER_ENABLED:"false",
    get CHINAFLOW_RECONCILIATION_API_TOKEN(){assert.fail("secret accessed");},
    get CHINAFLOW_EVENTS(){assert.fail("D1 accessed");}
  };
  const response=await handleReportingImporterRequest(request(reconcileCommand(),{idempotency:"review-1"}),darkEnv,runtime());
  assert.equal(response.status,404);
});

test("reconciliation route requires POST, independent secret, exact auth and JSON", async t => {
  const f=fixture(t);
  for (const method of ["GET","PUT","PATCH","DELETE","OPTIONS"]) {
    const response=await handleReportingImporterRequest(request(null,{method}),env(f.database),runtime());
    assert.equal(response.status,405);
    assert.equal(response.headers.get("allow"),"POST");
  }
  assert.equal((await handleReportingImporterRequest(request(reconcileCommand(),{auth:null,idempotency:"review-1"}),env(f.database),runtime())).status,401);
  assert.equal((await handleReportingImporterRequest(request(reconcileCommand(),{auth:"Bearer different-import-token",idempotency:"review-1"}),env(f.database),runtime())).status,401);
  assert.equal((await handleReportingImporterRequest(request(reconcileCommand(),{contentType:"text/plain",idempotency:"review-1"}),env(f.database),runtime())).status,415);
  assert.equal((await handleReportingImporterRequest(request(reconcileCommand(),{idempotency:undefined}),env(f.database),runtime())).status,400);
  assert.equal((await handleReportingImporterRequest(request("{".repeat(17000),{idempotency:"review-1"}),env(f.database),runtime())).status,400);
});

test("reconciliation route creates and retries without exposing secrets", async t => {
  const f=fixture(t); const rt=runtime(["1","2"]);
  const first=await handleReportingImporterRequest(request(reconcileCommand(),{idempotency:"review-1"}),env(f.database),rt);
  assert.equal(first.status,201);
  const firstBody=await first.json();
  assert.deepEqual(firstBody,{reconciliation:{reconciliation_id:"rec_1",created:true}});
  assert.ok(!JSON.stringify(firstBody).includes(TOKEN));
  const retry=await handleReportingImporterRequest(request(reconcileCommand(),{idempotency:"review-1"}),env(f.database),rt);
  assert.equal(retry.status,200);
  assert.deepEqual(await retry.json(),{reconciliation:{reconciliation_id:"rec_1",created:false}});
});

test("reporting importer configs require separate reconciliation secret and keep writer dark", () => {
  for (const file of ["../wrangler.reporting-importer.test.jsonc","../wrangler.reporting-importer.production.jsonc"]) {
    const config=JSON.parse(readFileSync(new URL(file,import.meta.url),"utf8"));
    const expected = file.includes(".test.") ? "true" : "false";
    assert.equal(config.vars.PUBLISHER_RECONCILIATION_WRITER_ENABLED, expected);
    assert.deepEqual(config.secrets.required,["CHINAFLOW_REPORTING_IMPORT_TOKEN","CHINAFLOW_RECONCILIATION_API_TOKEN"]);
  }
});
