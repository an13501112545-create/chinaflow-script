import fs from "node:fs/promises";
import path from "node:path";

export const REPLY_ALERT_PATH="/var/lib/chinaflow-outreach/reply-alerts-v1.json";
const LEVELS=["initial","reminder_4h","urgent_12h","critical_24h"];

function isoNow(now=new Date()){return now.toISOString();}
function parseReceivedAt(value){
  if(typeof value!=="string"||!value.trim()) return null;
  const v=value.trim();
  const parsed=new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(v)?v:`${v}Z`);
  return Number.isFinite(parsed.getTime())?parsed:null;
}
function normalizeItem(item){
  if(!item||typeof item!=="object"||!item.emailId||!item.prospectId) throw new Error("reply alert item malformed");
  const status=["pending_response","responded","closed"].includes(item.status)?item.status:"pending_response";
  const alertedLevels=Array.isArray(item.alertedLevels)?item.alertedLevels.filter(x=>LEVELS.includes(x)):[];
  return {...item,status,alertedLevels,respondedAt:item.respondedAt??null,closedAt:item.closedAt??null};
}
async function readAlerts(fsImpl=fs,alertPath=REPLY_ALERT_PATH){
  try{
    const p=JSON.parse(await fsImpl.readFile(alertPath,"utf8"));
    if(!p||p.version!==1||!Array.isArray(p.pending)) throw new Error("reply alert state malformed");
    return {version:1,pending:p.pending.map(normalizeItem)};
  }catch(e){if(e?.code==="ENOENT") return {version:1,pending:[]};throw e;}
}
async function writeAlerts(state,{fsImpl=fs,alertPath=REPLY_ALERT_PATH}={}){
  const dir=path.dirname(alertPath),tmp=alertPath+`.tmp.${process.pid}`;
  await fsImpl.mkdir(dir,{recursive:true,mode:0o700});
  await fsImpl.writeFile(tmp,JSON.stringify(state,null,2)+"\n",{mode:0o600});
  await fsImpl.rename(tmp,alertPath);await fsImpl.chmod(alertPath,0o600);
}
export function replySlaLevel(item,now=new Date()){
  if(item.status!=="pending_response") return null;
  const received=parseReceivedAt(item.receivedAt);
  if(!received) return "initial";
  const hours=Math.max(0,(now.getTime()-received.getTime())/3600000);
  if(hours>=24)return"critical_24h";
  if(hours>=12)return"urgent_12h";
  if(hours>=4)return"reminder_4h";
  return"initial";
}
export async function enqueueReplyAlert(event,{fsImpl=fs,alertPath=REPLY_ALERT_PATH,now=new Date()}={}){
  if(!event?.emailId||event?.type!=="human_reply"||!event?.prospectId) throw new Error("invalid human reply alert");
  const state=await readAlerts(fsImpl,alertPath);
  if(state.pending.some(x=>x.emailId===event.emailId)) return {added:false,pending:state.pending.filter(x=>x.status==="pending_response").length};
  const item={emailId:String(event.emailId),prospectId:String(event.prospectId),publisher:String(event.publisher??""),receivedAt:String(event.receivedAt??""),subject:String(event.subject??"").slice(0,180),status:"pending_response",alertedLevels:[],detectedAt:isoNow(now),respondedAt:null,closedAt:null};
  state.pending.push(item);await writeAlerts(state,{fsImpl,alertPath});return {added:true,pending:state.pending.filter(x=>x.status==="pending_response").length};
}
export async function listReplyAlerts({fsImpl=fs,alertPath=REPLY_ALERT_PATH,now=new Date(),all=false}={}){
  const state=await readAlerts(fsImpl,alertPath);
  const pending=state.pending.filter(x=>x.status==="pending_response").map(x=>({...x,slaLevel:replySlaLevel(x,now)}));
  return all?pending:pending.filter(x=>!x.alertedLevels.includes(x.slaLevel));
}
export async function acknowledgeReplyAlert(emailId,{fsImpl=fs,alertPath=REPLY_ALERT_PATH,now=new Date()}={}){
  const state=await readAlerts(fsImpl,alertPath),item=state.pending.find(x=>x.emailId===String(emailId));
  if(!item||item.status!=="pending_response") return {acked:false,pending:state.pending.filter(x=>x.status==="pending_response").length};
  const level=replySlaLevel(item,now);
  if(!item.alertedLevels.includes(level)) item.alertedLevels.push(level);
  item.lastAlertedAt=isoNow(now);await writeAlerts(state,{fsImpl,alertPath});return {acked:true,level,pending:state.pending.filter(x=>x.status==="pending_response").length};
}
export async function markReplyResponded(emailId,{fsImpl=fs,alertPath=REPLY_ALERT_PATH,now=new Date()}={}){
  const state=await readAlerts(fsImpl,alertPath),item=state.pending.find(x=>x.emailId===String(emailId));
  if(!item||item.status!=="pending_response") return {updated:false};
  item.status="responded";item.respondedAt=isoNow(now);await writeAlerts(state,{fsImpl,alertPath});return {updated:true,status:item.status,respondedAt:item.respondedAt};
}
export async function closeReplyCase(emailId,{fsImpl=fs,alertPath=REPLY_ALERT_PATH,now=new Date()}={}){
  const state=await readAlerts(fsImpl,alertPath),item=state.pending.find(x=>x.emailId===String(emailId));
  if(!item||item.status==="closed") return {updated:false};
  item.status="closed";item.closedAt=isoNow(now);await writeAlerts(state,{fsImpl,alertPath});return {updated:true,status:item.status,closedAt:item.closedAt};
}
