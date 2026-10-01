import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { generateToken, hashToken } from "../publisher-platform/auth-token-v0.1.mjs";
import { CONFIG } from "./runner-v2.mjs";
import { createProductionAdapters, GOOGLE_CREDENTIAL_PATH, SHEET_NAME, SHEET_SPREADSHEET_ID } from "./production-adapters-v1.mjs";

const D1_DATABASE = "chinaflow-events-v0-1";
const D1_CONFIG = "collector/wrangler.production.jsonc";
const HASH_RE = /^[0-9a-f]{64}$/;

function requireSheetWrite(env) {
  if (env.ALLOW_CANDIDATE_SHEET_WRITE !== "YES") throw new Error("CANDIDATE_SHEET_WRITE_DISABLED");
}
function requireD1Write(env) {
  if (env.ALLOW_CANDIDATE_D1_WRITE !== "YES") throw new Error("CANDIDATE_D1_WRITE_DISABLED");
}
function sqlText(value) { return String(value).replaceAll("'", "''"); }

async function googleToken(fsImpl, fetchImpl, credentialPath) {
  const c = JSON.parse(await fsImpl.readFile(credentialPath, "utf8"));
  if (!c.client_email || !c.private_key || !c.token_uri) throw new Error("Google credentials malformed");
  const now=Math.floor(Date.now()/1000), enc=v=>Buffer.from(v).toString("base64url");
  const h=enc(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=enc(JSON.stringify({iss:c.client_email,scope:"https://www.googleapis.com/auth/spreadsheets",aud:c.token_uri,iat:now,exp:now+3600}));
  const signer=crypto.createSign("RSA-SHA256"); signer.update(`${h}.${claim}`); signer.end();
  let sig; try { sig=signer.sign(c.private_key).toString("base64url"); } catch { throw new Error("Google credentials malformed"); }
  const response=await fetchImpl(c.token_uri,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:`${h}.${claim}.${sig}`})});
  if(!response.ok) throw new Error("Google token request failed");
  const p=await response.json(); if(typeof p.access_token!=="string") throw new Error("Google token response malformed");
  return p.access_token;
}

function valuesUrl(range, suffix="") {
  return `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_SPREADSHEET_ID}/values/${encodeURIComponent(range)}${suffix}`;
}
function rowRange(row) {
  if(!Number.isInteger(row)||row<2) throw new Error("invalid Sheet row");
  return `'${SHEET_NAME}'!A${row}:AE${row}`;
}
function finalRange(row) { return `'${SHEET_NAME}'!AA${row}:AE${row}`; }
function parseAppendRow(value) {
  const m=String(value??"").match(/!A(\d+):AE(\d+)$/);
  if(!m||m[1]!==m[2]) throw new Error("Google append response malformed");
  return Number(m[1]);
}

function parseD1(raw) {
  const p=JSON.parse(raw), first=Array.isArray(p)?p[0]:p;
  if(first?.success!==true) throw new Error("D1 command failed");
  return first.results??[];
}

export function createCandidateImportProductionDependencies({
  fsImpl=fs, fetchImpl=fetch, execFileSyncImpl=execFileSync, env=process.env,
  credentialPath=GOOGLE_CREDENTIAL_PATH,
}={}) {
  const senderAdapters=createProductionAdapters({fsImpl,fetchImpl,env,credentialPath});
  const sheetToken=()=>googleToken(fsImpl,fetchImpl,credentialPath);
  const runD1=(sql)=>parseD1(execFileSyncImpl("/home/ubuntu/.nvm/versions/node/v22.23.2/bin/npx",["--no-install","wrangler","d1","execute",D1_DATABASE,"--remote","--config",D1_CONFIG,"--yes","--json","--command",sql],{encoding:"utf8",maxBuffer:10*1024*1024,env:{...process.env,...env,PATH:`/home/ubuntu/.nvm/versions/node/v22.23.2/bin:${env.PATH ?? process.env.PATH ?? ""}`}}));

  const readSheetRow=async row=>{
    const token=await sheetToken(), range=rowRange(row);
    const response=await fetchImpl(valuesUrl(range),{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok) throw new Error("Google Sheet row read failed");
    const p=await response.json(); return Array.isArray(p.values?.[0])?p.values[0]:[];
  };

  const appendStagingRow=async row=>{
    requireSheetWrite(env);
    if(!Array.isArray(row)||row.length!==31||row[26]!==""||row[28]!=="Staging"||row[29]!=="") throw new Error("invalid Staging row");
    const token=await sheetToken(), range=`'${SHEET_NAME}'!A:AE`;
    const response=await fetchImpl(valuesUrl(range,":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS"),{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({range,majorDimension:"ROWS",values:[row]})});
    if(!response.ok) throw new Error("Google Sheet append failed");
    const p=await response.json(); return {sheetRow:parseAppendRow(p.updates?.updatedRange)};
  };

  const finalizePreparedRow=async(rowNumber,row)=>{
    requireSheetWrite(env);
    if(!Array.isArray(row)||row[26]!==CONFIG.campaign||row[28]!=="Prepared"||row[29]!=="") throw new Error("invalid Prepared row");
    const token=await sheetToken(), range=finalRange(rowNumber);
    const response=await fetchImpl(valuesUrl(range,"?valueInputOption=RAW"),{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({range,majorDimension:"ROWS",values:[[row[26],row[27],row[28],row[29],row[30]]]})});
    if(!response.ok) throw new Error("Google Sheet finalize failed"); return response.json();
  };

  const readAttribution=async({prospectId,campaign})=>{
    const sql=`SELECT token_hash,pipeline_prospect_id,campaign FROM outreach_attributions WHERE pipeline_prospect_id='${sqlText(prospectId)}' AND campaign='${sqlText(campaign)}' LIMIT 2`;
    const rows=runD1(sql); if(rows.length>1) throw new Error("D1 attribution ambiguous"); return rows[0]??null;
  };

  const ensureAttribution=async({prospectId,campaign,tokenHash})=>{
    requireD1Write(env);
    if(campaign!==CONFIG.campaign||!/^\d+$/.test(String(prospectId))||!HASH_RE.test(String(tokenHash))) throw new Error("invalid attribution input");
    const current=await readAttribution({prospectId,campaign});
    if(current){if(current.token_hash!==tokenHash) throw new Error("existing D1 attribution mismatch");return {created:false};}
    const id=`oa_${crypto.randomUUID()}`;
    runD1(`INSERT INTO outreach_attributions (attribution_id,token_hash,pipeline_prospect_id,campaign,created_at,updated_at) VALUES ('${sqlText(id)}','${tokenHash}','${sqlText(prospectId)}','${sqlText(campaign)}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    return {created:true};
  };

  return {readPipelineValues:senderAdapters.readPipelineValues,readSheetRow,appendStagingRow,finalizePreparedRow,
    generateToken,hashToken,readAttribution,ensureAttribution};
}
