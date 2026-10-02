import {pathToFileURL} from "node:url";
import {runProductionGrowthSnapshot} from "./growth-snapshot-production-v1.mjs";
import {appendGrowthSnapshot} from "./growth-history-v1.mjs";
export async function runGrowthDaily({snapshotRunner=runProductionGrowthSnapshot,append=appendGrowthSnapshot}={}){const snapshot=await snapshotRunner();const result=append(snapshot);return{result,snapshot};}
async function main(){const r=await runGrowthDaily();console.log(JSON.stringify({result:r.result,snapshot:r.snapshot},null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(`ERROR=${e?.message??e}`);process.exitCode=1;});
