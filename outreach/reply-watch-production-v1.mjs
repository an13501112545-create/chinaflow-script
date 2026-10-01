import fs from "node:fs/promises";
import { analyzeInboundMessages } from "./reply-watch-v1.mjs";
import { MAILOPOLY_API_KEY_PATH, MAILOPOLY_ENDPOINT, createProductionAdapters } from "./production-adapters-v1.mjs";
import { MAILOPOLY_ACCOUNT, toShanghaiDate } from "./foundation-v1.mjs";

function jsonContent(payload) {
  const item=(payload?.result?.content??payload?.content??[]).find(x=>x.type==="text");
  if(!item?.text) throw new Error("Mailopoly response content missing");
  try { return JSON.parse(item.text); } catch { throw new Error("Mailopoly response content malformed"); }
}

export function createReplyWatchProductionAdapters({fsImpl=fs,fetchImpl=fetch,mailopolyKeyPath=MAILOPOLY_API_KEY_PATH}={}) {
  const base=createProductionAdapters({fsImpl,fetchImpl});
  const call=async(name,args)=>{
    const key=(await fsImpl.readFile(mailopolyKeyPath,"utf8")).trim();
    if(!key) throw new Error("Mailopoly key missing");
    const response=await fetchImpl(MAILOPOLY_ENDPOINT,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:Date.now(),method:"tools/call",params:{name,arguments:args}})});
    if(!response.ok) throw new Error("Mailopoly request failed");
    const payload=await response.json();
    if(payload.error||payload.result?.isError===true) throw new Error("Mailopoly response rejected");
    return jsonContent(payload.result);
  };
  const searchReceived=async({startDate,endDate,limit=50})=>{
    const result=await call("search_emails",{query:"newer_than:30d",limit,start_date:startDate,end_date:endDate,email_type:"received",folder:"cleanbox",sort_order:"newest",account:MAILOPOLY_ACCOUNT,timezone:"Asia/Shanghai"});
    return Array.isArray(result.results)?result.results:[];
  };
  const getEmails=async ids=>{
    if(!Array.isArray(ids)||ids.length===0) return [];
    const result=await call("get_emails",{email_ids:ids.slice(0,25),body_chars:6000,include_action_links:false});
    return Array.isArray(result.results)?result.results:[];
  };
  return {readPipelineValues:base.readPipelineValues,searchReceived,getEmails};
}

export async function runProductionReplyWatch({days=7,now=new Date(),dependencies=createReplyWatchProductionAdapters()}={}) {
  if(!Number.isInteger(days)||days<1||days>30) throw new Error("days must be 1..30");
  const endDate=toShanghaiDate(now);
  const start=new Date(now.getTime()-(days-1)*24*60*60*1000);
  const startDate=toShanghaiDate(start);
  const [values,summaries]=await Promise.all([
    dependencies.readPipelineValues(),
    dependencies.searchReceived({startDate,endDate,limit:50}),
  ]);
  const ids=summaries.map(x=>x.email_id).filter(Boolean).slice(0,25);
  const details=await dependencies.getEmails(ids);
  const analyzed=analyzeInboundMessages(details,values);
  const relevant=analyzed.filter(x=>x.mapping.status!=="unmapped"||["permanent_bounce","delivery_delay"].includes(x.type));
  const counts={}; for(const item of relevant) counts[item.type]=(counts[item.type]||0)+1;
  return {mode:"read_only",startDate,endDate,scannedSummaries:summaries.length,readBodies:details.length,relevantCount:relevant.length,counts,relevant};
}
