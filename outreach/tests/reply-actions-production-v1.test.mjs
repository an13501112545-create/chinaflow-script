import assert from "node:assert/strict";
import {test} from "node:test";
import {createReplyActionProductionAdapters} from "../reply-actions-production-v1.mjs";

test("reply action Sheet write is disabled by default before credential access",async()=>{
  let reads=0,calls=0;const d=createReplyActionProductionAdapters({fsImpl:{readFile:async()=>{reads++;return ""}},fetchImpl:async()=>{calls++}});
  await assert.rejects(()=>d.writeCell({row:2,field:"status",value:"Delivery Failed"}),/DISABLED/);assert.equal(reads,0);assert.equal(calls,0);
});
test("only Q V W logical fields are allowed",async()=>{
  const d=createReplyActionProductionAdapters({env:{ALLOW_REPLY_ACTION_SHEET_WRITE:"YES"},fsImpl:{readFile:async()=>{throw new Error("should not read")}}});
  await assert.rejects(()=>d.writeCell({row:2,field:"email",value:"x"}),/not allowed/);
});
