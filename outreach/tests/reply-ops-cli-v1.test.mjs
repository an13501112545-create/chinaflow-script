import assert from "node:assert/strict";
import {test} from "node:test";
import {parseReplyOpsArgs,runReplyOpsCli} from "../reply-ops-cli-v1.mjs";
test("reply ops CLI defaults dry and accepts explicit live",()=>{assert.deepEqual(parseReplyOpsArgs([]),{live:false});assert.deepEqual(parseReplyOpsArgs(["--live"]),{live:true});assert.throws(()=>parseReplyOpsArgs(["--bad"]));});
test("CLI passes live flag",async()=>{let seen;await runReplyOpsCli({argv:["--live"],runner:async x=>{seen=x;return x}});assert.equal(seen.live,true);});
