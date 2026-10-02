import { pathToFileURL } from "node:url";
import { runReplyOps } from "./reply-ops-v1.mjs";
export function parseReplyOpsArgs(argv){let live=false;for(const a of argv){if(a==="--live"){live=true;continue;}throw new Error(`unknown argument: ${a}`);}return {live};}
export async function runReplyOpsCli({argv=process.argv.slice(2),runner=runReplyOps}={}){const {live}=parseReplyOpsArgs(argv);return runner({live});}
async function main(){const report=await runReplyOpsCli();console.log("=== CHINAFLOW REPLY OPS REPORT ===");console.log(JSON.stringify(report,null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(e=>{console.error(`ERROR=${e?.message??e}`);process.exitCode=1;});}
