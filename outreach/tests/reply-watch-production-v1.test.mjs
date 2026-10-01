import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplyWatchProductionAdapters, runProductionReplyWatch } from "../reply-watch-production-v1.mjs";
import { MAILOPOLY_ACCOUNT } from "../foundation-v1.mjs";

const header=Array(31).fill("");
function row(id,publisher,website,email){const r=Array(31).fill("");r[0]=id;r[3]=publisher;r[4]=website;r[13]=email;return r;}
const values=[header,row("85","Yiwu China","https://www.yiwu-china.com/","hello@yiwu-china.com"),row("124","Private China Journeys","https://privatechinajourneys.com/","hello@privatechinajourneys.com")];

test("production reply watch is read-only analysis of received mail",async()=>{
  const report=await runProductionReplyWatch({days:4,now:new Date("2026-10-01T14:00:00Z"),dependencies:{
    readPipelineValues:async()=>values,
    searchReceived:async()=>[{email_id:"b1"},{email_id:"h1"}],
    getEmails:async ids=>{assert.deepEqual(ids,["b1","h1"]);return[
      {email_id:"b1",date:"2026-10-01",sender_email:"mailer-daemon@zoho.com.cn",subject:"Undelivered Mail Returned to Sender",body:"Permanent error hello@yiwu-china.com 550 No Such User Here"},
      {email_id:"h1",date:"2026-09-30",sender_email:"partners@privatechinajourneys.com",subject:"Re: ChinaFlow",body:"We would be happy to explore a referral partnership."},
    ]},
  }});
  assert.equal(report.mode,"read_only");assert.equal(report.relevantCount,2);
  assert.equal(report.counts.permanent_bounce,1);assert.equal(report.counts.human_reply,1);
  assert.equal(report.relevant.find(x=>x.type==="human_reply").mapping.prospect.id,"124");
});

test("days outside 1..30 fail before dependency access",async()=>{
  let calls=0;
  await assert.rejects(()=>runProductionReplyWatch({days:0,dependencies:{readPipelineValues:async()=>{calls++}}}),/days must be 1\.\.30/);
  assert.equal(calls,0);
});

test("Mailopoly adapter only uses read tools and canonical account",async()=>{
  const calls=[];
  const fsImpl={async readFile(path){assert.equal(path,"/key");return "test-key"}};
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body.params);
    const name=body.params.name;
    const payload=name==="search_emails"?{results:[{email_id:"x"}]}:{results:[{email_id:"x",body:"hello"}]};
    return {ok:true,async json(){return {result:{content:[{type:"text",text:JSON.stringify(payload)}]}}}};
  };
  const a=createReplyWatchProductionAdapters({fsImpl,fetchImpl,mailopolyKeyPath:"/key"});
  assert.deepEqual(await a.searchReceived({startDate:"2026-09-28",endDate:"2026-10-01"}),[{email_id:"x"}]);
  assert.equal((await a.getEmails(["x"]))[0].body,"hello");
  assert.deepEqual(calls.map(x=>x.name),["search_emails","get_emails"]);
  assert.equal(calls[0].arguments.account,MAILOPOLY_ACCOUNT);
  assert.equal(calls.some(x=>x.name==="send_email"),false);
});
