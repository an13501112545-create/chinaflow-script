import {pathToFileURL} from "node:url";
import {runProductionGrowthSnapshot} from "./growth-snapshot-production-v1.mjs";
export async function runGrowthSnapshotCli({runner=runProductionGrowthSnapshot}={}){return runner();}
async function main(){console.log(JSON.stringify(await runGrowthSnapshotCli(),null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(`ERROR=${e?.message??e}`);process.exitCode=1;});
