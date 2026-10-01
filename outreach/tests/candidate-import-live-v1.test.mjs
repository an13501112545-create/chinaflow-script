import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandidateImport } from "../candidate-import-live-v1.mjs";

const header=["ID","Batch","Priority","Publisher / Website","Website URL","Primary Market","Publisher Type","Strategic Value Score","China Content / Traffic Strength","Commercial Intent Strength","Current Monetization","Contact","Title","Email","LinkedIn / Phone","Owner","Status","First Contact Date","Last Contact Date","Next Follow-up Date","Channel","Reply Summary","Next Action","Pitch / Materials","Notes","Research Source","Outreach Campaign","Tracking URL","Round 2 Status","Round 2 Sent Date","Round 2 Language"];
const candidate={publisher:"Example China Travel",websiteUrl:"https://example-china.test/",email:"bd@example-china.test",language:"EN"};
const token="a".repeat(64), hash="c".repeat(64);
function existing(){const r=Array(31).fill("");Object.assign(r,{0:"196",3:"Existing",4:"https://existing.test",13:"x@existing.test",26:"round2-zh-20260928",27:`https://publishers.getchinaflow.com/r/${"b".repeat(64)}`,28:"Prepared",30:"EN"});return r;}

test("dry run performs zero writes",async()=>{
  let writes=0;
  const result=await runCandidateImport({candidate,dependencies:{
    readPipelineValues:async()=>[header,existing()],appendStagingRow:async()=>{writes++},
    readSheetRow:async()=>{throw new Error("unexpected")},generateToken:()=>token,hashToken:async()=>hash,
    ensureAttribution:async()=>{writes++},readAttribution:async()=>null,finalizePreparedRow:async()=>{writes++},
  }});
  assert.equal(result.status,"dry_run");assert.equal(result.writes,0);assert.equal(writes,0);
});

test("live gate blocks all writes by default",async()=>{
  let writes=0;
  const result=await runCandidateImport({candidate,live:true,env:{},dependencies:{
    readPipelineValues:async()=>[header,existing()],appendStagingRow:async()=>{writes++},generateToken:()=>token,
  }});
  assert.equal(result.status,"blocked");assert.equal(writes,0);
});

test("live import writes staging, D1, Prepared in exact order",async()=>{
  let row;const calls=[];
  const result=await runCandidateImport({candidate,live:true,env:{CHINAFLOW_CANDIDATE_IMPORT_LIVE:"YES"},dependencies:{
    readPipelineValues:async()=>[header,existing()],generateToken:()=>token,
    hashToken:async v=>{assert.equal(v,token);return hash},
    appendStagingRow:async v=>{calls.push("staging");row=[...v];return{sheetRow:3}},
    readSheetRow:async()=>[...row],ensureAttribution:async v=>{calls.push("d1");assert.equal(v.tokenHash,hash)},
    readAttribution:async()=>({token_hash:hash}),finalizePreparedRow:async(_n,v)=>{calls.push("prepared");row=[...v]},
  }});
  assert.equal(result.status,"prepared");assert.equal(result.writes,3);
  assert.deepEqual(calls,["staging","d1","prepared"]);assert.equal(row[28],"Prepared");
});

test("D1 mismatch leaves row Staging and never finalizes",async()=>{
  let row,finalized=false;
  await assert.rejects(()=>runCandidateImport({candidate,live:true,env:{CHINAFLOW_CANDIDATE_IMPORT_LIVE:"YES"},dependencies:{
    readPipelineValues:async()=>[header,existing()],generateToken:()=>token,hashToken:async()=>hash,
    appendStagingRow:async v=>{row=[...v];return{sheetRow:3}},readSheetRow:async()=>[...row],
    ensureAttribution:async()=>{},readAttribution:async()=>({token_hash:"d".repeat(64)}),
    finalizePreparedRow:async()=>{finalized=true},
  }}),/D1 attribution readback mismatch/);
  assert.equal(finalized,false);assert.equal(row[28],"Staging");assert.equal(row[26],"");
});
