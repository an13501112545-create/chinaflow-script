import {pathToFileURL} from "node:url";
import {acknowledgeReplyAlert,listReplyAlerts} from "./reply-alerts-v1.mjs";
export function parseArgs(argv){if(argv.length===0)return{action:"list"};if(argv.length===2&&argv[0]==="--ack"&&argv[1])return{action:"ack",emailId:argv[1]};throw new Error("usage: reply-alerts-cli-v1.mjs [--ack EMAIL_ID]");}
async function main(){const a=parseArgs(process.argv.slice(2));const r=a.action==="list"?await listReplyAlerts():await acknowledgeReplyAlert(a.emailId);console.log(JSON.stringify(r,null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(`ERROR=${e?.message??e}`);process.exitCode=1;});
