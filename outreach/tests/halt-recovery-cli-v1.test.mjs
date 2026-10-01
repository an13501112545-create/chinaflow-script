import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHaltRecoveryArgs, runHaltRecoveryCli } from "../halt-recovery-cli-v1.mjs";

test("CLI defaults to review-only mode", async () => {
  assert.deepEqual(parseHaltRecoveryArgs([]), { authorization: null });
  let reviewed = 0;
  const report = await runHaltRecoveryCli({
    argv: [],
    reviewer: async () => { reviewed += 1; return { status: "reviewed" }; },
  });
  assert.equal(reviewed, 1);
  assert.equal(report.status, "reviewed");
});

test("CLI clear path requires explicit authorization token", async () => {
  let got = null;
  const report = await runHaltRecoveryCli({
    argv: ["--authorize", "HALT-abc"],
    clearer: async ({ authorization }) => { got = authorization; return { status: "cleared" }; },
  });
  assert.equal(got, "HALT-abc");
  assert.equal(report.status, "cleared");
  assert.throws(() => parseHaltRecoveryArgs(["--authorize"]), /requires a token/);
  assert.throws(() => parseHaltRecoveryArgs(["--force"]), /unknown argument/);
});
