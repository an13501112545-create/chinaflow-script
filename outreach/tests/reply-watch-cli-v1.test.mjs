import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReplyWatchArgs, runReplyWatchCli } from "../reply-watch-cli-v1.mjs";

test("reply watch CLI defaults to 7 days and validates bounds",()=>{
  assert.equal(parseReplyWatchArgs([]).days,7);
  assert.equal(parseReplyWatchArgs(["--days","4"]).days,4);
  assert.throws(()=>parseReplyWatchArgs(["--days","0"]),/1\.\.30/);
  assert.throws(()=>parseReplyWatchArgs(["--bad"]),/unknown argument/);
});

test("CLI passes days to read-only runner",async()=>{
  let got;
  const report=await runReplyWatchCli({argv:["--days","3"],runner:async x=>{got=x;return{mode:"read_only"}}});
  assert.equal(got.days,3);assert.equal(report.mode,"read_only");
});
