import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runDryRunLoop, runUnattendedDryRun } from "../unattended-runner-v1.mjs";

const lockPath = "/var/lib/chinaflow-outreach/unattended-runner-v1.lock";
const tracking = `https://publishers.getchinaflow.com/r/${"a".repeat(64)}`;
const header = ["ID","B","C","Publisher / Website","E","F","G","H","I","J","K","L","M","Email","O","P","Q","R","S","T","U","V","W","X","Y","Z","Outreach Campaign","Tracking URL","Round 2 Status","Round 2 Sent Date","Round 2 Language"];
const candidate = ["7","","","Publisher","","","","","","","","","","owner@example.com","","","","","","","","","","","","","round2-zh-20260928",tracking,"Prepared","","ZH"];
function deps(records = []) { return { readPipelineValues: async () => [header,candidate], readLedger: async () => ({version:1,records}) }; }

test("dry run selects one candidate and performs zero writes/sends", async () => {
  const r=await runUnattendedDryRun({manageLock:false,dependencies:deps(),now:new Date("2026-09-30T04:00:00Z"),randomInt:()=>9});
  assert.equal(r.status,"dry_run_ready"); assert.equal(r.prospectId,"7"); assert.equal(r.sends,0); assert.equal(r.writes,0); assert.equal(r.schedule.interval,9);
});

test("rate cap blocks readiness without writes/sends", async () => {
  const records=Array.from({length:8},(_,i)=>({send_state:"sheet_synced",mailopoly_accepted_at:new Date(Date.parse("2026-09-30T04:00:00Z")-i*1000).toISOString()}));
  const r=await runUnattendedDryRun({manageLock:false,dependencies:deps(records),now:new Date("2026-09-30T04:00:00Z"),randomInt:()=>6});
  assert.equal(r.status,"rate_blocked"); assert.equal(r.sends,0); assert.equal(r.writes,0);
});

test("existing lock fails closed before dependency access", async () => {
  fs.writeFileSync(lockPath,"test",{mode:0o600});
  try { const r=await runUnattendedDryRun({dependencies:{readPipelineValues:async()=>{throw new Error("must not read")}}}); assert.equal(r.status,"blocked"); assert.equal(r.reason,"LOCK_HELD"); }
  finally { fs.unlinkSync(lockPath); }
});
