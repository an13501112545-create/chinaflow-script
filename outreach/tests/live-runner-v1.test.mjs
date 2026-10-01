import assert from "node:assert/strict";
import test from "node:test";
import { liveGuards, runLiveCycle, runLiveLoop } from "../live-runner-v1.mjs";

const tracking = `https://publishers.getchinaflow.com/r/${"a".repeat(64)}`;
const header = ["ID","B","C","Publisher / Website","E","F","G","H","I","J","K","L","M","Email","O","P","Q","R","S","T","U","V","W","X","Y","Z","Outreach Campaign","Tracking URL","Round 2 Status","Round 2 Sent Date","Round 2 Language"];
const row = ["7","","","Publisher","","","","","","","","","","owner@example.com","","","","","","","","","","","","","round2-zh-20260928",tracking,"Prepared","","EN"];
const enabled = { CHINAFLOW_OUTREACH_LIVE:"YES", REAL_SEND_ENABLED:"YES", ALLOW_SHEET_WRITE:"YES" };

function discovery(records = []) {
  return { readPipelineValues: async () => [header,row], readLedger: async () => ({version:1,records}) };
}

test("all three live guards are required", () => {
  assert.deepEqual(liveGuards(enabled), {liveEnabled:true,providerEnabled:true,sheetWriteEnabled:true});
  assert.equal(liveGuards({}).liveEnabled,false);
});

test("disabled guard blocks before any dependency access", async () => {
  const r = await runLiveCycle({ env:{}, discoveryDependencies:{readPipelineValues:async()=>{throw new Error("must not read")}} });
  assert.equal(r.status,"blocked"); assert.equal(r.reason,"LIVE_GUARD_DISABLED"); assert.equal(r.sendAttempts,0);
});

test("selected prospect becomes exact scoped authorization", async () => {
  let factoryId=null, call=null;
  const r = await runLiveCycle({ env:enabled, discoveryDependencies:discovery(), dependencyFactory:(id)=>{factoryId=id;return {tag:"scoped"};}, controlledSend:async(args)=>{call=args;return {status:"pass",sendAttempts:1,sheetWrites:1};}, now:new Date("2026-09-30T04:00:00Z") });
  assert.equal(r.status,"pass"); assert.equal(factoryId,"7"); assert.equal(call.prospectId,"7"); assert.equal(call.authorizedProspectId,"7"); assert.equal(call.allowLiveSend,"YES"); assert.equal(call.allowSheetWrite,"YES"); assert.equal(call.dependencies.tag,"scoped");
});

test("rate cap blocks before dependency factory and controlled send", async () => {
  const records=Array.from({length:8},(_,i)=>({send_state:"sheet_synced",mailopoly_accepted_at:new Date(Date.parse("2026-09-30T04:00:00Z")-i*1000).toISOString()}));
  let touched=false;
  const r=await runLiveCycle({env:enabled,discoveryDependencies:discovery(records),dependencyFactory:()=>{touched=true;return{};},controlledSend:async()=>{touched=true;return{};},now:new Date("2026-09-30T04:00:00Z")});
  assert.equal(r.status,"rate_blocked"); assert.equal(r.prospectId,"7"); assert.equal(touched,false); assert.equal(r.sendAttempts,0);
});

test("live loop continues only after nonterminal result and preserves pacing", async () => {
  let calls=0; const sleeps=[];
  const r=await runLiveLoop({runCycle:async()=>{calls+=1;return {status:"pass"};},sleep:async(ms)=>sleeps.push(ms),randomInt:()=>8,maxCycles:3});
  assert.equal(r.status,"stopped"); assert.equal(calls,3); assert.deepEqual(sleeps,[480000,480000]);
});

test("live loop fails closed on ambiguous without another cycle", async () => {
  let calls=0;
  const r=await runLiveLoop({runCycle:async()=>{calls+=1;return {status:"ambiguous",reason:"SEND_AMBIGUOUS"};},sleep:async()=>{throw new Error("must not sleep")},maxCycles:5});
  assert.equal(r.status,"fail_closed"); assert.equal(r.terminalStatus,"ambiguous"); assert.equal(calls,1);
});

test("live loop fails closed on blocked guard without retry", async () => {
  let calls=0;
  const r=await runLiveLoop({runCycle:async()=>{calls+=1;return {status:"blocked",reason:"LIVE_GUARD_DISABLED"};},sleep:async()=>{},maxCycles:5});
  assert.equal(r.status,"fail_closed"); assert.equal(r.reason,"LIVE_GUARD_DISABLED"); assert.equal(calls,1);
});
