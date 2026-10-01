import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeInboundMessages, classifyInboundMessage, mapInboundToProspect } from "../reply-watch-v1.mjs";

const header=Array(31).fill("");
function row(id,publisher,website,email){const r=Array(31).fill("");r[0]=id;r[3]=publisher;r[4]=website;r[13]=email;r[16]="Contacted";r[26]="round2-zh-20260928";r[28]="Sent";r[29]="2026-10-01";return r;}
const values=[header,
  row("65","Tour Beijing","https://www.tour-beijing.com/","info@tour-beijing.com"),
  row("73","Yunnan Exploration","https://www.yunnanexploration.com/","contact@yunnanexploration.com"),
  row("77","CantonTradeFair.com","https://www.cantontradefair.com/","webmaster@cantontradefair.com"),
  row("85","Yiwu China","https://www.yiwu-china.com/","hello@yiwu-china.com"),
  row("94","China Hospitals Guide","https://chinahospitalsguide.com/","contact@chinahospitalsguide.com"),
  row("124","Private China Journeys","https://privatechinajourneys.com/","hello@privatechinajourneys.com"),
];

test("classifies permanent bounce and extracts failed recipient",()=>{
  const e=classifyInboundMessage({sender_email:"mailer-daemon@zoho.com.cn",subject:"Undelivered Mail Returned to Sender",body:"This is a permanent error. hello@yiwu-china.com ERROR CODE :550 - No Such User Here"});
  assert.equal(e.type,"permanent_bounce");assert.equal(e.targetEmail,"hello@yiwu-china.com");
});

test("classifies delivery delay before permanent-like wording",()=>{
  const e=classifyInboundMessage({sender_email:"mailer-daemon@zoho.com.cn",subject:"Mail Delivery Status Notification (Delay)",body:"WARNING MESSAGE ONLY. webmaster@cantontradefair.com Message will be retried for 4 more day(s)"});
  assert.equal(e.type,"delivery_delay");assert.equal(e.targetEmail,"webmaster@cantontradefair.com");
});

test("explicit automatic replies do not count as human replies",()=>{
  const a=classifyInboundMessage({sender_email:"contact@yunnanexploration.com",subject:"Charlie Lee Auto Reply",body:"We'll get back to you shortly."});
  const b=classifyInboundMessage({sender_email:"info@tour-beijing.com",subject:"Re: outreach",body:"This is an automatic reply. One of our trip advisors will contact you soon."});
  assert.equal(a.type,"auto_reply");assert.equal(b.type,"auto_reply");
});

test("human reply from alternate same-domain address maps uniquely",()=>{
  const e=classifyInboundMessage({sender_email:"partners@privatechinajourneys.com",subject:"Re: ChinaFlow x Private China Journeys",body:"We will pass on that proposal. However, we would be happy to explore a referral partnership."});
  assert.equal(e.type,"human_reply");
  const m=mapInboundToProspect(e,values);
  assert.equal(m.status,"mapped");assert.equal(m.matchBy,"domain");assert.equal(m.prospect.id,"124");
});

test("bounce recipient maps by extracted target email",()=>{
  const e=classifyInboundMessage({sender_email:"mailer-daemon@zoho.com.cn",subject:"Undelivered",body:"contact@chinahospitalsguide.com, ERROR CODE :554 - 5.7.1 Mail rejected due to antispam policy"});
  const m=mapInboundToProspect(e,values);
  assert.equal(e.type,"permanent_bounce");assert.equal(m.status,"mapped");assert.equal(m.matchBy,"target_email");assert.equal(m.prospect.id,"94");
});

test("batch analysis preserves mapping and event type",()=>{
  const out=analyzeInboundMessages([{email_id:"x1",date:"2026-09-30",sender_email:"partners@privatechinajourneys.com",subject:"Re",body:"Thanks, referral partnership may fit."}],values);
  assert.equal(out.length,1);assert.equal(out[0].type,"human_reply");assert.equal(out[0].mapping.prospect.id,"124");
});
