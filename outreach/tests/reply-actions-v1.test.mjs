import assert from "node:assert/strict";
import {test} from "node:test";
import {planReplyActions} from "../reply-actions-v1.mjs";
const mapped=(status="Contacted")=>({status:"mapped",prospect:{id:"94",sheetRow:95,status}});
test("human reply queues review without changing main Status",()=>{
  const [a]=planReplyActions([{emailId:"e1",date:"2026-10-02T01:00:00",subject:"Re: hello",type:"human_reply",mapping:mapped()}]);
  assert.equal(a.action,"queue_review");assert.equal(a.sheetWrite.status,undefined);assert.equal(a.sheetWrite.nextAction,"Review inbound reply and respond");
});
test("new permanent bounce plans Delivery Failed suppression",()=>{
  const [a]=planReplyActions([{emailId:"e2",type:"permanent_bounce",mapping:mapped()}]);
  assert.equal(a.action,"suppress_delivery");assert.equal(a.sheetWrite.status,"Delivery Failed");
});
test("already suppressed bounce does not rewrite Sheet",()=>{
  for(const status of ["Invalid Email","Delivery Failed"]){const [a]=planReplyActions([{emailId:"e",type:"permanent_bounce",mapping:mapped(status)}]);assert.equal(a.action,"mark_only");assert.equal(a.sheetWrite,null);}
});
test("auto reply and delay are mark-only",()=>{
  for(const type of ["auto_reply","delivery_delay"]){const [a]=planReplyActions([{emailId:"e",type,mapping:mapped()}]);assert.equal(a.action,"mark_only");assert.equal(a.sheetWrite,null);}
});
test("unmapped human reply is held and never marked processed",()=>{const [a]=planReplyActions([{emailId:"e",type:"human_reply",mapping:{status:"unmapped"}}]);assert.equal(a.sheetWrite,null);assert.equal(a.action,"manual_mapping_required");assert.equal(a.markProcessed,false);});

test("existing curated reply fields are never overwritten",()=>{
  const mapping={status:"mapped",prospect:{id:"124",sheetRow:125,status:"Referral Opportunity",replySummary:"Human reply: referral opportunity",nextAction:"Evaluate referral terms"}};
  const [a]=planReplyActions([{emailId:"pcj",date:"2026-09-30",subject:"Re",type:"human_reply",mapping}]);
  assert.equal(a.action,"mark_only");assert.equal(a.reason,"CURATED_REPLY_FIELDS_PRESENT");assert.equal(a.sheetWrite,null);
});
