import fs from "node:fs/promises";
import path from "node:path";

export const REPLY_ALERT_PATH="/var/lib/chinaflow-outreach/reply-alerts-v1.json";

async function readAlerts(fsImpl=fs,alertPath=REPLY_ALERT_PATH){
  try{
    const p=JSON.parse(await fsImpl.readFile(alertPath,"utf8"));
    if(!p||p.version!==1||!Array.isArray(p.pending)) throw new Error("reply alert state malformed");
    return {version:1,pending:p.pending};
  }catch(e){if(e?.code==="ENOENT") return {version:1,pending:[]};throw e;}
}
async function writeAlerts(state,{fsImpl=fs,alertPath=REPLY_ALERT_PATH}={}){
  const dir=path.dirname(alertPath),tmp=alertPath+`.tmp.${process.pid}`;
  await fsImpl.mkdir(dir,{recursive:true,mode:0o700});
  await fsImpl.writeFile(tmp,JSON.stringify(state,null,2)+"\n",{mode:0o600});
  await fsImpl.rename(tmp,alertPath);await fsImpl.chmod(alertPath,0o600);
}
export async function enqueueReplyAlert(event,{fsImpl=fs,alertPath=REPLY_ALERT_PATH}={}){
  if(!event?.emailId||event?.type!=="human_reply"||!event?.prospectId) throw new Error("invalid human reply alert");
  const state=await readAlerts(fsImpl,alertPath);
  if(state.pending.some(x=>x.emailId===event.emailId)) return {added:false,pending:state.pending.length};
  const item={emailId:String(event.emailId),prospectId:String(event.prospectId),publisher:String(event.publisher??""),receivedAt:String(event.receivedAt??""),subject:String(event.subject??"").slice(0,180)};
  state.pending.push(item);await writeAlerts(state,{fsImpl,alertPath});return {added:true,pending:state.pending.length};
}
export async function listReplyAlerts({fsImpl=fs,alertPath=REPLY_ALERT_PATH}={}){return (await readAlerts(fsImpl,alertPath)).pending;}
export async function acknowledgeReplyAlert(emailId,{fsImpl=fs,alertPath=REPLY_ALERT_PATH}={}){
  const state=await readAlerts(fsImpl,alertPath);const before=state.pending.length;
  state.pending=state.pending.filter(x=>x.emailId!==String(emailId));
  if(state.pending.length===before) return {removed:false,pending:before};
  await writeAlerts(state,{fsImpl,alertPath});return {removed:true,pending:state.pending.length};
}
