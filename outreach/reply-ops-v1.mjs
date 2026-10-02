import { planReplyActions } from "./reply-actions-v1.mjs";
import { createReplyActionProductionAdapters } from "./reply-actions-production-v1.mjs";
import { markReplyWatchProcessed, runProductionReplyWatch } from "./reply-watch-production-v1.mjs";

export async function runReplyOps({live=false,env=process.env,watcher=runProductionReplyWatch,actionAdapters=createReplyActionProductionAdapters({env}),marker=markReplyWatchProcessed}={}){
  const watch=await watcher();
  const actions=planReplyActions(watch.relevant);
  if(!live) return {mode:"dry_run",watch,actions,writes:0,marked:0};
  if(env.CHINAFLOW_REPLY_OPS_LIVE!=="YES") return {mode:"blocked",reason:"REPLY_OPS_LIVE_DISABLED",watch,actions,writes:0,marked:0};
  let writes=0,marked=0;
  const results=[];
  for(const action of actions){
    if(action.sheetWrite){
      const out=await actionAdapters.writeAction({row:action.sheetRow,fields:action.sheetWrite});
      writes+=out.writes;
    }
    if(action.markProcessed!==false){
      await marker([action.emailId]);
      marked+=1;
    }
    results.push({emailId:action.emailId,type:action.type,action:action.action,prospectId:action.prospectId??null,status:action.markProcessed===false?"held_for_manual_mapping":"processed"});
  }
  return {mode:"live",watch:{...watch,relevant:undefined},actions:results,writes,marked};
}
