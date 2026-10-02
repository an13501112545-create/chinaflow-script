import crypto from "node:crypto";
import fs from "node:fs/promises";
import { GOOGLE_CREDENTIAL_PATH, SHEET_NAME, SHEET_SPREADSHEET_ID } from "./production-adapters-v1.mjs";

const ALLOWED_COLUMNS=Object.freeze({status:"Q",replySummary:"V",nextAction:"W"});

function valuesUrl(range,suffix=""){return `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_SPREADSHEET_ID}/values/${encodeURIComponent(range)}${suffix}`;}
async function googleToken(fsImpl,fetchImpl,credentialPath){
  const c=JSON.parse(await fsImpl.readFile(credentialPath,"utf8"));
  if(!c.client_email||!c.private_key||!c.token_uri) throw new Error("Google credentials malformed");
  const now=Math.floor(Date.now()/1000),enc=v=>Buffer.from(v).toString("base64url");
  const h=enc(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=enc(JSON.stringify({iss:c.client_email,scope:"https://www.googleapis.com/auth/spreadsheets",aud:c.token_uri,iat:now,exp:now+3600}));
  const signer=crypto.createSign("RSA-SHA256");signer.update(`${h}.${claim}`);signer.end();
  const sig=signer.sign(c.private_key).toString("base64url");
  const response=await fetchImpl(c.token_uri,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${h}.${claim}.${sig}`})});
  if(!response.ok) throw new Error("Google token request failed");
  const p=await response.json();if(typeof p.access_token!=="string") throw new Error("Google token response malformed");return p.access_token;
}

export function createReplyActionProductionAdapters({fsImpl=fs,fetchImpl=fetch,env=process.env,credentialPath=GOOGLE_CREDENTIAL_PATH}={}){
  const writeCell=async({row,field,value})=>{
    if(env.ALLOW_REPLY_ACTION_SHEET_WRITE!=="YES") throw new Error("REPLY_ACTION_SHEET_WRITE_DISABLED");
    if(!Number.isInteger(row)||row<2) throw new Error("invalid Sheet row");
    const col=ALLOWED_COLUMNS[field];if(!col) throw new Error("reply action field not allowed");
    const text=String(value??"");if(text.length>500) throw new Error("reply action value too long");
    const range=`'${SHEET_NAME}'!${col}${row}`;
    const token=await googleToken(fsImpl,fetchImpl,credentialPath);
    const response=await fetchImpl(valuesUrl(range,"?valueInputOption=RAW"),{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({range,majorDimension:"ROWS",values:[[text]]})});
    if(!response.ok) throw new Error("Google Sheet reply action write failed");
    return response.json();
  };
  return {writeCell};
}
