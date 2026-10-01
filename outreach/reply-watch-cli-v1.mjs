import { pathToFileURL } from "node:url";
import { runProductionReplyWatch } from "./reply-watch-production-v1.mjs";

export function parseReplyWatchArgs(argv) {
  let days=7;
  for(let i=0;i<argv.length;i+=1){
    if(argv[i]==="--days"){days=Number(argv[++i]);continue;}
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  if(!Number.isInteger(days)||days<1||days>30) throw new Error("--days must be 1..30");
  return {days};
}
export async function runReplyWatchCli({argv=process.argv.slice(2),runner=runProductionReplyWatch}={}) {
  const {days}=parseReplyWatchArgs(argv);
  return runner({days});
}
async function main(){const report=await runReplyWatchCli();console.log("=== CHINAFLOW REPLY WATCH REPORT ===");console.log(JSON.stringify(report,null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(e=>{console.error(`ERROR=${e?.message??e}`);process.exitCode=1;});}
