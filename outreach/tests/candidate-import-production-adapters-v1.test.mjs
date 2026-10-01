import assert from "node:assert/strict";
import { test } from "node:test";
import { createCandidateImportProductionDependencies } from "../candidate-import-production-adapters-v1.mjs";

function harness(env={}) {
  let fetchCalls=0, execCalls=0, reads=0;
  const deps=createCandidateImportProductionDependencies({
    env,
    fsImpl:{async readFile(){reads++;throw new Error("unexpected fs read")}},
    fetchImpl:async()=>{fetchCalls++;throw new Error("unexpected fetch")},
    execFileSyncImpl:()=>{execCalls++;throw new Error("unexpected exec")},
  });
  return {deps,counts:()=>({fetchCalls,execCalls,reads})};
}

test("Sheet staging write is disabled by default before network access",async()=>{
  const h=harness();
  await assert.rejects(()=>h.deps.appendStagingRow(Array(31).fill("")),/CANDIDATE_SHEET_WRITE_DISABLED/);
  assert.deepEqual(h.counts(),{fetchCalls:0,execCalls:0,reads:0});
});

test("Sheet finalization is disabled by default before network access",async()=>{
  const h=harness();
  const row=Array(31).fill("");row[26]="round2-zh-20260928";row[28]="Prepared";
  await assert.rejects(()=>h.deps.finalizePreparedRow(200,row),/CANDIDATE_SHEET_WRITE_DISABLED/);
  assert.deepEqual(h.counts(),{fetchCalls:0,execCalls:0,reads:0});
});

test("D1 attribution write is disabled by default before wrangler access",async()=>{
  const h=harness();
  await assert.rejects(()=>h.deps.ensureAttribution({prospectId:"200",campaign:"round2-zh-20260928",tokenHash:"a".repeat(64)}),/CANDIDATE_D1_WRITE_DISABLED/);
  assert.deepEqual(h.counts(),{fetchCalls:0,execCalls:0,reads:0});
});

test("invalid Staging row fails before Google credential read when write gate enabled",async()=>{
  const h=harness({ALLOW_CANDIDATE_SHEET_WRITE:"YES"});
  const row=Array(31).fill("");row[26]="round2-zh-20260928";row[28]="Prepared";
  await assert.rejects(()=>h.deps.appendStagingRow(row),/invalid Staging row/);
  assert.deepEqual(h.counts(),{fetchCalls:0,execCalls:0,reads:0});
});

test("invalid D1 input fails before wrangler when D1 gate enabled",async()=>{
  const h=harness({ALLOW_CANDIDATE_D1_WRITE:"YES"});
  await assert.rejects(()=>h.deps.ensureAttribution({prospectId:"bad id",campaign:"round2-zh-20260928",tokenHash:"a".repeat(64)}),/invalid attribution input/);
  assert.deepEqual(h.counts(),{fetchCalls:0,execCalls:0,reads:0});
});
