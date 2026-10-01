import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildStagingRow, planCandidateImport } from "./candidate-importer-v1.mjs";
import { runCandidateImport } from "./candidate-import-live-v1.mjs";
import { createCandidateImportProductionDependencies } from "./candidate-import-production-adapters-v1.mjs";
import { CONFIG } from "./runner-v2.mjs";

export function parseCandidateImportArgs(argv) {
  const args = { live:false, file:null, confirmCampaign:null };
  for (let i=0; i<argv.length; i+=1) {
    const value=argv[i];
    if (value === "--live") { args.live=true; continue; }
    if (value === "--file") { args.file=argv[++i] ?? null; continue; }
    if (value === "--confirm-campaign") { args.confirmCampaign=argv[++i] ?? null; continue; }
    throw new Error(`unknown argument: ${value}`);
  }
  if (!args.file) throw new Error("--file is required");
  if (args.live && args.confirmCampaign !== CONFIG.campaign) throw new Error("live campaign confirmation mismatch");
  return Object.freeze(args);
}

export function planCandidateBatchDryRun(values, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("candidate batch must be a non-empty array");
  const simulated=values.map(row=>[...row]);
  const results=[];
  const simulatedProspectIds=new Set();
  for (let index=0; index<candidates.length; index+=1) {
    const plan=planCandidateImport({values:simulated,candidate:candidates[index],campaign:CONFIG.campaign});
    if (plan.status === "duplicate") {
      results.push({index,publisher:String(candidates[index]?.publisher??""),status:"duplicate",reason:plan.reason,existingProspectId:plan.existingProspectId,writes:0});
      continue;
    }
    if (plan.status === "resume") {
      if (simulatedProspectIds.has(plan.prospectId)) {
        results.push({index,publisher:plan.candidate.publisher,status:"duplicate",reason:"batch_internal",existingProspectId:plan.prospectId,writes:0});
      } else {
        results.push({index,publisher:plan.candidate.publisher,status:"resume",prospectId:plan.prospectId,sheetRow:plan.sheetRow,writes:0});
      }
      continue;
    }
    const token=(index.toString(16).padStart(64,"0")).slice(-64);
    const staging=buildStagingRow(plan,token);
    simulated.push(staging);
    simulatedProspectIds.add(plan.prospectId);
    results.push({index,publisher:plan.candidate.publisher,status:"new",prospectId:plan.prospectId,simulatedSheetRow:simulated.length,writes:0});
  }
  return Object.freeze(results);
}

export async function runCandidateImportCli({ argv=process.argv.slice(2), env=process.env, fsImpl=fs, dependencyFactory=createCandidateImportProductionDependencies }={}) {
  const args=parseCandidateImportArgs(argv);
  const candidates=JSON.parse(await fsImpl.readFile(args.file,"utf8"));
  if (!Array.isArray(candidates) || candidates.length===0) throw new Error("candidate batch must be a non-empty array");
  const deps=dependencyFactory({env});
  if (!args.live) {
    const values=await deps.readPipelineValues();
    const results=planCandidateBatchDryRun(values,candidates);
    return {mode:"dry_run",campaign:CONFIG.campaign,total:candidates.length,newCount:results.filter(x=>x.status==="new").length,duplicateCount:results.filter(x=>x.status==="duplicate").length,resumeCount:results.filter(x=>x.status==="resume").length,writes:0,results};
  }
  const results=[];
  for (const candidate of candidates) {
    const result=await runCandidateImport({candidate,live:true,env,dependencies:dependencyFactory({env})});
    results.push({publisher:String(candidate?.publisher??""),...result});
    if (result.status !== "prepared" && result.status !== "duplicate") throw new Error(`unexpected live result: ${result.status}`);
  }
  return {mode:"live",campaign:CONFIG.campaign,total:candidates.length,preparedCount:results.filter(x=>x.status==="prepared").length,duplicateCount:results.filter(x=>x.status==="duplicate").length,results};
}

async function main() {
  const report=await runCandidateImportCli();
  console.log("=== CHINAFLOW CANDIDATE IMPORT REPORT ===");
  console.log(JSON.stringify(report,null,2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{ console.error(`ERROR=${error?.message??error}`); process.exitCode=1; });
}
