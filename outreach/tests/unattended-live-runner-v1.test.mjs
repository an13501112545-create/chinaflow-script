import assert from "node:assert/strict";
import test from "node:test";
import { runUnattendedLiveCycle } from "../unattended-live-runner-v1.mjs";

const header=["ID","B","C","Publisher / Website","E","F","G","H","I","J","K","L","M","Email","O","P","Q","R","S","T","U","V","W","X","Y","Z","Outreach Campaign","Tracking URL","Round 2 Status","Round 2 Sent Date","Round 2 Language"];
const row=["7","","","Publisher","","","","","","","","","","owner@example.com","","","","","","","","","","","","","round2-zh-20260928",`https://publishers.getchinaflow.com/r/${"a".repeat(64)}`,"Prepared","","ZH"];
const deps={readPipelineValues:async()=>[header,row],readLedger:async()=>({version:1,records:[]})};

test("live disabled never enters controlled sender",async()=>{
  let calls=0;
  const r=await runUnattendedLiveCycle({liveEnabled:false,dependencies:deps,controlledSend:async()=>{calls+=1;throw new Error("must not call");},randomInt:()=>9,now:new Date("2026-09-30T12:00:00Z")});
  assert.equal(r.status,"live_disabled");assert.equal(r.prospectId,"7");assert.equal(r.sends,0);assert.equal(r.writes,0);assert.equal(calls,0);
});

test("live enabled authorizes only selected prospect into controlled sender",async()=>{
  let args;
  const r=await runUnattendedLiveCycle({liveEnabled:true,dependencies:deps,controlledSend:async(x)=>{args=x;return{status:"pass",sendAttempts:1,sheetWrites:1};},randomInt:()=>8,now:new Date("2026-09-30T12:00:00Z")});
  assert.equal(r.status,"sent");assert.equal(r.prospectId,"7");assert.equal(r.sends,1);assert.equal(r.writes,1);
  assert.equal(args.prospectId,"7");assert.equal(args.authorizedProspectId,"7");assert.equal(args.allowLiveSend,"YES");assert.equal(args.allowSheetWrite,"YES");
});

test("non-pass controlled result halts fail-closed",async()=>{
  const r=await runUnattendedLiveCycle({liveEnabled:true,dependencies:deps,controlledSend:async()=>({status:"ambiguous",sendAttempts:1,sheetWrites:0}),randomInt:()=>6,now:new Date("2026-09-30T12:00:00Z")});
  assert.equal(r.status,"halted");assert.equal(r.sends,1);assert.equal(r.writes,0);
});
