import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearPersistentHalt, reviewPersistentHalt } from "../halt-recovery-v1.mjs";
import { MAILOPOLY_ACCOUNT } from "../foundation-v1.mjs";
import { ROUND_2_TEMPLATES } from "../runner-v2.mjs";

function pipeline({ status = "Prepared", sentDate = "", language = "EN" } = {}) {
  const header = Array(31).fill("");
  const row = Array(31).fill("");
  row[0] = "102";
  row[3] = "Example Publisher";
  row[13] = "owner@example.com";
  row[26] = "round2-zh-20260928";
  row[28] = status;
  row[29] = sentDate;
  row[30] = language;
  return [header, row];
}

function deps({ values = pipeline(), records = [], sent = [] } = {}) {
  return {
    readPipelineValues: async () => values,
    readLedger: async () => ({ version: 1, records }),
    listMailboxFolders: async () => ({
      success: true,
      accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [{ name: "INBOX" }, { name: "已发送邮件" }] }],
    }),
    searchSentEmails: async () => sent,
  };
}

async function lock(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chinaflow-halt-recovery-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const haltPath = path.join(dir, "halt.json");
  await fs.writeFile(haltPath, JSON.stringify({
    version: 1,
    prospectId: "102",
    reason: "CONTROLLED_LIVE_FAILED",
    createdAt: "2026-10-01T14:04:13.000Z",
  }) + "\n", { mode: 0o600 });
  return haltPath;
}

test("safe retry is authorized only when no durable send crossed the fence", async (t) => {
  const haltPath = await lock(t);
  const report = await reviewPersistentHalt({ haltPath, dependencies: deps() });
  assert.equal(report.assessment.clearable, true);
  assert.equal(report.assessment.disposition, "safe_retry");
  assert.match(report.authorizationToken, /^HALT-[0-9a-f]{24}$/);
  assert.equal(report.mailopoly.exactMatchCount, 0);
});

test("exact sent plus Sheet Sent is safe to unlock without retry", async (t) => {
  const haltPath = await lock(t);
  const subject = ROUND_2_TEMPLATES.EN.subject;
  const records = [{
    campaign: "round2-zh-20260928",
    prospect_id: "102",
    send_state: "sheet_synced",
    last_error: null,
  }];
  const sent = [{
    recipient: "owner@example.com",
    sender: MAILOPOLY_ACCOUNT,
    subject,
    timestamp: "2026-10-01T14:05:00Z",
  }];
  const report = await reviewPersistentHalt({
    haltPath,
    dependencies: deps({
      values: pipeline({ status: "Sent", sentDate: "2026-10-01" }),
      records,
      sent,
    }),
  });
  assert.equal(report.assessment.clearable, true);
  assert.equal(report.assessment.disposition, "safe_skip");
});

test("ambiguous in-flight evidence remains blocked", async (t) => {
  const haltPath = await lock(t);
  const records = [{
    campaign: "round2-zh-20260928",
    prospect_id: "102",
    send_state: "ambiguous",
    last_error: "SEND_AMBIGUOUS",
  }];
  const report = await reviewPersistentHalt({ haltPath, dependencies: deps({ records }) });
  assert.equal(report.assessment.clearable, false);
  assert.equal(report.authorizationToken, null);
  assert.equal(report.assessment.reason, "RECONCILIATION_REQUIRED");
});

test("clear archives the exact reviewed lock and never restarts service", async (t) => {
  const haltPath = await lock(t);
  const dependencies = deps();
  const review = await reviewPersistentHalt({ haltPath, dependencies });
  await assert.rejects(
    () => clearPersistentHalt({ authorization: "HALT-bad", haltPath, dependencies }),
    /authorization token mismatch/,
  );
  await fs.access(haltPath);
  const cleared = await clearPersistentHalt({
    authorization: review.authorizationToken,
    haltPath,
    dependencies,
    now: () => new Date("2026-10-02T00:00:00.000Z"),
  });
  assert.equal(cleared.status, "cleared");
  assert.equal(cleared.serviceRestarted, false);
  await assert.rejects(() => fs.access(haltPath));
  const archived = await fs.readFile(cleared.archivePath, "utf8");
  assert.match(archived, /"prospectId":"102"/);
});

test("missing lock is a clean no-op", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chinaflow-no-halt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const report = await reviewPersistentHalt({
    haltPath: path.join(dir, "missing.json"),
    dependencies: deps(),
  });
  assert.equal(report.status, "no_halt");
  assert.equal(report.clearable, false);
});
