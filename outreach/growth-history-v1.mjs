import fs from "node:fs";
import path from "node:path";
export const GROWTH_HISTORY_PATH="/var/lib/chinaflow-growth/daily-snapshots.jsonl";
export function shanghaiDate(iso){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(iso));}
export function appendGrowthSnapshot(snapshot,{historyPath=GROWTH_HISTORY_PATH,fsImpl=fs}={}){
  if(!snapshot||snapshot.version!==1||typeof snapshot.generatedAt!=="string") throw new Error("invalid growth snapshot");
  const date=shanghaiDate(snapshot.generatedAt);
  let existing="";
  try{existing=fsImpl.readFileSync(historyPath,"utf8");}catch(e){if(e?.code!=="ENOENT")throw e;}
  for(const line of existing.split(/\n/).filter(Boolean)){
    const parsed=JSON.parse(line);
    if(parsed.date===date) return {status:"already_recorded",date,path:historyPath};
  }
  fsImpl.mkdirSync(path.dirname(historyPath),{recursive:true,mode:0o700});
  const record={date,...snapshot};
  const fd=fsImpl.openSync(historyPath,"a",0o600);
  try{fsImpl.writeSync(fd,JSON.stringify(record)+"\n");fsImpl.fsyncSync(fd);}finally{fsImpl.closeSync(fd);}
  fsImpl.chmodSync(historyPath,0o600);
  return {status:"recorded",date,path:historyPath};
}
export function readGrowthHistory({historyPath=GROWTH_HISTORY_PATH,fsImpl=fs}={}){
  try{return fsImpl.readFileSync(historyPath,"utf8").split(/\n/).filter(Boolean).map(x=>JSON.parse(x));}
  catch(e){if(e?.code==="ENOENT")return[];throw e;}
}
