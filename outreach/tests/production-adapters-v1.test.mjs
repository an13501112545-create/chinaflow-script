import assert from "node:assert/strict";
import test from "node:test";
import { createProductionAdapters, MAILOPOLY_API_KEY_PATH } from "../production-adapters-v1.mjs";
import { LEDGER_PATH, MAILOPOLY_ACCOUNT } from "../foundation-v1.mjs";

function response(body, ok = true) {
  return { ok, async json() { return body; } };
}
function fakeFs(files = {}) {
  return { readFile: async (file) => { if (!(file in files)) throw new Error("missing test file"); return files[file]; } };
}
function credentials() {
  return JSON.stringify({ client_email: "service@example.com", private_key: "not-a-real-key", token_uri: "https://oauth.example/token" });
}

test("Sheet read requests only A:AE and malformed credentials fail closed", async () => {
  const calls = [];
  const adapters = createProductionAdapters({ fsImpl: fakeFs({ "/cred": credentials() }), fetchImpl: async (url) => { calls.push(url); return response({ access_token: "token" }); }, credentialPath: "/cred" });
  await assert.rejects(() => adapters.readPipelineValues(), /Sheet read failed|credentials|key/);
  assert.equal(calls.length, 0);
});

test("Sheet adapter rejects arbitrary ranges and columns before network", async () => {
  let calls = 0;
  const adapters = createProductionAdapters({ fsImpl: fakeFs({ "/cred": credentials() }), fetchImpl: async () => { calls += 1; return response({}); }, credentialPath: "/cred" });
  await assert.rejects(() => adapters.syncSheet({ sheetRow: 7, columns: ["AB", "AC"], status: "Sent", sentDate: "2026-09-29" }), /AC\/AD/);
  await assert.rejects(() => adapters.syncSheet({ sheetRow: 7, range: "A:AE", columns: ["AC", "AD"], status: "Sent", sentDate: "2026-09-29" }), /AC\/AD/);
  assert.equal(calls, 0);
});

test("Mailopoly read adapter passes canonical account and rejects malformed response", async () => {
  const calls = [];
  const adapters = createProductionAdapters({ fsImpl: fakeFs({ [MAILOPOLY_API_KEY_PATH]: "test-key" }), fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return response({ result: { content: [{ type: "text", text: JSON.stringify({ success: true, accounts: [] }) }] } }); } });
  const payload = await adapters.listMailboxFolders({ account: MAILOPOLY_ACCOUNT });
  assert.deepEqual(payload.accounts, []);
  assert.equal(calls[0].params.arguments.account, MAILOPOLY_ACCOUNT);
  const malformed = createProductionAdapters({ fsImpl: fakeFs({ [MAILOPOLY_API_KEY_PATH]: "test-key" }), fetchImpl: async () => response({ result: { content: [{ type: "text", text: "not-json" }] } }) });
  await assert.rejects(() => malformed.listMailboxFolders({ account: MAILOPOLY_ACCOUNT }), /malformed/);
});

test("send adapter is disabled by default and makes zero network calls", async () => {
  let calls = 0;
  const adapters = createProductionAdapters({ fsImpl: fakeFs(), fetchImpl: async () => { calls += 1; return response({}); }, env: {} });
  await assert.rejects(() => adapters.sendEmail({ prospectId: "6", fromAccount: MAILOPOLY_ACCOUNT, recipient: "owner@example.com", subject: "subject", body: "body", contentType: "text/html" }), /REAL_SEND_DISABLED/);
  assert.equal(calls, 0);
});

test("ledger adapter uses the fixed production path", () => {
  const adapters = createProductionAdapters({ fsImpl: fakeFs(), fetchImpl: async () => response({}) });
  assert.equal(adapters.ledgerPath, LEDGER_PATH);
});

test("Mailopoly search adapter normalizes only candidate fields", async () => {
  const adapters = createProductionAdapters({ fsImpl: fakeFs({ [MAILOPOLY_API_KEY_PATH]: "test-key" }), fetchImpl: async () => response({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ to: "owner@example.com", sender_email: MAILOPOLY_ACCOUNT, subject: "subject", timestamp_received: "2026-09-29T12:00:00Z", body: "not returned" }] }) }] } }) });
  const results = await adapters.searchSentEmails({ account: MAILOPOLY_ACCOUNT, folder: "已发送邮件", recipient: "owner@example.com", subject: "subject", campaign: "round2-zh-20260928" });
  assert.deepEqual(results, [{ recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-29T12:00:00Z" }]);
});