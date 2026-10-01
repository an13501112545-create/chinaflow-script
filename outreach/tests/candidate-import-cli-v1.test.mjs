import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCandidateImportArgs, planCandidateBatchDryRun, runCandidateImportCli } from "../candidate-import-cli-v1.mjs";

const header=["ID","Batch","Priority","Publisher / Website","Website URL","Primary Market","Publisher Type","Strategic Value Score","China Content / Traffic Strength","Commercial Intent Strength","Current Monetization","Contact","Title","Email","LinkedIn / Phone","Owner","Status","First Contact Date","Last Contact Date","Next Follow-up Date","Channel","Reply Summary","Next Action","Pitch / Materials","Notes","Research Source","Outreach Campaign","Tracking URL","Round 2 Status","Round 2 Sent Date","Round 2 Language"];
function row(id="196") { const r=Array(31).fill(""); Object.assign(r,{0:id,3:"Existing",4:"https://existing.test/",13:"x@existing.test",26:"round2-zh-20260928",27:`https://publishers.getchinaflow.com/r/${"b".repeat(64)}`,28:"Prepared",30:"EN"}); return r; }
const a={publisher:"Alpha China",websiteUrl:"https://alpha.test/",email:"hello@alpha.test",language:"EN"};
const b={publisher:"Beta China",websiteUrl:"https://beta.test/",email:"hello@beta.test",language:"ZH"};

test("CLI defaults to dry-run and requires file",()=>{
  assert.deepEqual({...parseCandidateImportArgs(["--file","/tmp/c.json"])},{live:false,file:"/tmp/c.json",confirmCampaign:null});
  assert.throws(()=>parseCandidateImportArgs([]),/--file is required/);
});

test("live CLI requires exact campaign confirmation",()=>{
  assert.throws(()=>parseCandidateImportArgs(["--file","x","--live"]),/confirmation mismatch/);
  assert.throws(()=>parseCandidateImportArgs(["--file","x","--live","--confirm-campaign","wrong"]),/confirmation mismatch/);
  const parsed=parseCandidateImportArgs(["--file","x","--live","--confirm-campaign","round2-zh-20260928"]);
  assert.equal(parsed.live,true);
});

test("batch dry-run assigns sequential IDs and catches batch-internal duplicate",()=>{
  const out=planCandidateBatchDryRun([header,row()],[a,b,{...a,publisher:"Alpha Duplicate"}]);
  assert.equal(out[0].status,"new"); assert.equal(out[0].prospectId,"197");
  assert.equal(out[1].status,"new"); assert.equal(out[1].prospectId,"198");
  assert.equal(out[2].status,"duplicate"); assert.equal(out[2].reason,"batch_internal");
});

test("runCli dry-run performs one read and zero writes",async()=>{
  let reads=0,writes=0;
  const fakeFs={async readFile(){return JSON.stringify([a,b])}};
  const report=await runCandidateImportCli({argv:["--file","fake.json"],fsImpl:fakeFs,dependencyFactory:()=>({
    readPipelineValues:async()=>{reads++;return [header,row()]},
    appendStagingRow:async()=>{writes++},ensureAttribution:async()=>{writes++},finalizePreparedRow:async()=>{writes++},
  })});
  assert.equal(report.mode,"dry_run"); assert.equal(report.total,2); assert.equal(report.newCount,2); assert.equal(report.writes,0);
  assert.equal(reads,1); assert.equal(writes,0);
});
