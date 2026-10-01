import assert from "node:assert/strict";
import test from "node:test";
import { filterExactSentMatches, runControlledLiveSend } from "../controlled-live-v1.mjs";
import { MAILOPOLY_ACCOUNT, sanitizeOperationalError, toShanghaiDate } from "../foundation-v1.mjs";

const trackingUrl = `https://publishers.getchinaflow.com/r/${"a".repeat(64)}`;
const header = ["ID", "B", "C", "Publisher / Website", "E", "F", "G", "H", "I", "J", "K", "L", "M", "Email", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "Outreach Campaign", "Tracking URL", "Round 2 Status", "Round 2 Sent Date", "Round 2 Language"];
function row(overrides = {}) {
  const values = Array(31).fill("");
  Object.assign(values, { 0: "6", 3: "Publisher", 13: "owner@example.com", 26: "round2-zh-20260928", 27: trackingUrl, 28: "Prepared", 29: "", 30: "ZH" }, overrides);
  return values;
}
function makeHarness({ rows = [row()], ledgerRecords = [], preMatches = [], postMatchSequence, postMatches = [{ recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "帮客户订中国酒店，也可以获得额外佣金", timestamp: "2026-09-29T12:00:00.000Z" }], mailboxPayload, sendResult = { accepted: true, messageId: "message-1" }, sendError, fenceFailure = false, sheetReadback, syncError } = {}) {
  const calls = [];
  let ledger = { version: 1, records: structuredClone(ledgerRecords) };
  let sendCalls = 0;
  let postSearchCalls = 0;
  let sheetSynced = false;
  const payload = mailboxPayload ?? { success: true, accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [{ name: "INBOX" }, { name: "已发送邮件" }] }] };
  return {
    calls,
    readPipelineValues: async () => { calls.push("sheet-read"); return [header, ...(sheetSynced ? rows.map((values) => values.map((value, index) => index === 28 ? "Sent" : index === 29 ? "2026-09-29" : value)) : rows)]; },
    listMailboxFolders: async ({ account }) => { calls.push(`mailbox:${account}`); return payload; },
    searchSentEmails: async ({ account, folder }) => { calls.push(`search:${account}:${folder}`); if (sendCalls === 0) return preMatches; if (!postMatchSequence) return postMatches; const matches = postMatchSequence[Math.min(postSearchCalls, postMatchSequence.length - 1)]; postSearchCalls += 1; return matches; },
    sleep: async (milliseconds) => { calls.push("sleep:" + milliseconds); },
    sendEmail: async (args) => { calls.push("send"); sendCalls += 1; if (sendError) throw sendError; return sendResult; },
    syncSheet: async (mutation) => { calls.push("sheet-write"); if (syncError) throw syncError; assert.deepEqual(mutation.columns, ["AC", "AD"]); assert.equal(mutation.status, "Sent"); assert.equal(mutation.sentDate, "2026-09-29"); sheetSynced = true; return { ok: true }; },
    readLedger: async () => { calls.push("ledger-read"); return structuredClone(ledger); },
    writeLedger: async (next) => { calls.push("ledger-write"); if (fenceFailure) { ledger = { version: 1, records: [] }; return; } ledger = structuredClone(next); },
    now: () => new Date("2026-09-29T12:00:00.000Z"),
    get ledger() { return ledger; },
  };
}
function run(dependencies, overrides = {}) {
  return runControlledLiveSend({ campaign: "round2-zh-20260928", prospectId: "6", allowLiveSend: "YES", authorizedProspectId: "6", allowSheetWrite: "YES", dependencies, ...overrides });
}
function assertNoSend(result, harness) { assert.equal(result.sendAttempts, 0); assert.equal(harness.calls.includes("send"), false); }

test("happy path sends once, syncs AC/AD only, and reaches sheet_synced", async () => {
  const harness = makeHarness();
  const result = await run(harness);
  assert.equal(result.status, "pass");
  assert.equal(result.sendAttempts, 1);
  assert.equal(result.sheetWrites, 1);
  assert.equal(result.finalState, "sheet_synced");
  assert.deepEqual(harness.calls.filter((call) => call === "send"), ["send"]);
});

test("missing, mismatched, unprepared, and already dated Sheet prospects do not send", async () => {
  for (const rows of [[], [row({ 0: "7" })], [row({ 26: "other" })], [row({ 28: "Sent" })], [row({ 29: "2026-09-29" })]]) {
    const harness = makeHarness({ rows });
    assertNoSend(await run(harness), harness);
  }
});

test("unsafe ledger states block without send", async () => {
  for (const state of ["sheet_synced", "send_started", "ambiguous"]) {
    const harness = makeHarness({ ledgerRecords: [{ campaign: "round2-zh-20260928", prospect_id: "6", send_state: state }] });
    assertNoSend(await run(harness), harness);
  }
});

test("pre-send duplicate and duplicate ambiguity block without send", async () => {
  const exact = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "帮客户订中国酒店，也可以获得额外佣金", timestamp: "2026-09-29T12:00:00.000Z" };
  for (const preMatches of [[exact], [exact, { ...exact }]]) {
    const harness = makeHarness({ preMatches });
    assertNoSend(await run(harness), harness);
  }
});
test("account and Sent resolver failures block without send", async () => {
  for (const mailboxPayload of [
    { success: true, accounts: [] },
    { success: true, accounts: [{ account: MAILOPOLY_ACCOUNT }, { account: MAILOPOLY_ACCOUNT }] },
    { success: true, accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [{ name: "INBOX" }] }] },
    { success: true, accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [{ type: "sent" }, { system_type: "sent" }] }] },
  ]) {
    const harness = makeHarness({ mailboxPayload });
    assertNoSend(await run(harness), harness);
  }
});

test("rate caps and live authorization block without send", async () => {
  const recent = { send_state: "sheet_synced", mailopoly_accepted_at: "2026-09-29T11:30:00.000Z", campaign: "old", prospect_id: "old" };
  assertNoSend(await run(makeHarness({ ledgerRecords: Array.from({ length: 8 }, () => recent) })), makeHarness());
  assertNoSend(await run(makeHarness({ ledgerRecords: Array.from({ length: 60 }, () => ({ ...recent, mailopoly_accepted_at: "2026-09-29T00:30:00.000Z" })) })), makeHarness());
  assertNoSend(await run(makeHarness(), { allowLiveSend: "NO" }), makeHarness());
  assertNoSend(await run(makeHarness(), { authorizedProspectId: "7" }), makeHarness());
});

test("durable send_started readback failure blocks before send", async () => {
  const harness = makeHarness({ fenceFailure: true });
  assertNoSend(await run(harness), harness);
});

test("positive provider result reconciles and syncs", async () => {
  const harness = makeHarness();
  const result = await run(harness);
  assert.equal(result.status, "pass");
  assert.equal(harness.calls.filter((call) => call === "mailbox:" + MAILOPOLY_ACCOUNT).length, 2);
});

test("timeouts, resets, and clear rejection never retry or write Sheet", async () => {
  for (const error of [new Error("timeout"), Object.assign(new Error("connection reset"), { code: "ECONNRESET" })]) {
    const harness = makeHarness({ sendError: error });
    const result = await run(harness);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.sendAttempts, 1);
    assert.equal(result.retry, false);
    assert.equal(harness.calls.includes("sheet-write"), false);
    assert.equal(harness.ledger.records.find((record) => record.prospect_id === "6").send_state, "ambiguous");
  }
  const rejected = makeHarness({ sendResult: { rejected: true } });
  const rejectedResult = await run(rejected);
  assert.equal(rejectedResult.status, "failed");
  assert.equal(rejectedResult.sendAttempts, 1);
  assert.equal(rejected.calls.includes("sheet-write"), false);
  assert.equal(rejected.ledger.records.find((record) => record.prospect_id === "6").send_state, "failed");
});

test("delayed Sent indexing poll 2 confirms without resend", async () => {
  const exact = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "帮客户订中国酒店，也可以获得额外佣金", timestamp: "2026-09-29T12:00:00.000Z" };
  const harness = makeHarness({ postMatchSequence: [[], [exact]] });
  const result = await run(harness);
  assert.equal(result.status, "pass");
  assert.equal(result.sendAttempts, 1);
  assert.equal(harness.calls.filter((call) => call === "send").length, 1);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("sleep:")), ["sleep:5000"]);
});

test("delayed Sent indexing poll 3 confirms without resend", async () => {
  const exact = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "帮客户订中国酒店，也可以获得额外佣金", timestamp: "2026-09-29T12:00:00.000Z" };
  const harness = makeHarness({ postMatchSequence: [[], [], [exact]] });
  const result = await run(harness);
  assert.equal(result.status, "pass");
  assert.equal(result.sendAttempts, 1);
  assert.equal(harness.calls.filter((call) => call === "send").length, 1);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("sleep:")), ["sleep:5000", "sleep:15000"]);
});

test("delayed Sent indexing poll 4 confirms without resend", async () => {
  const exact = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "帮客户订中国酒店，也可以获得额外佣金", timestamp: "2026-09-29T12:00:00.000Z" };
  const harness = makeHarness({ postMatchSequence: [[], [], [], [exact]] });
  const result = await run(harness);
  assert.equal(result.status, "pass");
  assert.equal(result.sendAttempts, 1);
  assert.equal(harness.calls.filter((call) => call === "send").length, 1);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("sleep:")), ["sleep:5000", "sleep:15000", "sleep:30000"]);
});

test("four empty delayed Sent polls become ambiguous without resend", async () => {
  const harness = makeHarness({ postMatchSequence: [[], [], [], []] });
  const result = await run(harness);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.sendAttempts, 1);
  assert.equal(harness.calls.filter((call) => call === "send").length, 1);
  assert.equal(harness.calls.includes("sheet-write"), false);
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("sleep:")), ["sleep:5000", "sleep:15000", "sleep:30000"]);
});

test("post-send zero or multiple matches become ambiguous without Sheet write", async () => {
  for (const postMatches of [[], [{}, {}]]) {
    const harness = makeHarness({ postMatches });
    const result = await run(harness);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.sendAttempts, 1);
    assert.equal(harness.calls.includes("sheet-write"), false);
  }
});

test("Sheet sync failure and readback mismatch do not send again", async () => {
  const syncFailure = makeHarness({ syncError: new Error("Sheet sync failed") });
  const failed = await run(syncFailure);
  assert.equal(failed.status, "blocked");
  assert.equal(failed.sendAttempts, 1);
  const mismatch = makeHarness({ sheetReadback: true });
  mismatch.readPipelineValues = async () => {
    mismatch.calls.push("sheet-read");
    return [header, row({ 28: "Prepared", 29: "" })];
  };
  const mismatchResult = await run(mismatch);
  assert.equal(mismatchResult.sendAttempts, 1);
  const mismatchSendCountAfterFirst = mismatch.calls.filter((call) => call === "send").length;
  const mismatchSecond = await run(mismatch);
  assert.equal(mismatchSecond.sendAttempts, 0);
  assert.equal(mismatch.calls.filter((call) => call === "send").length - mismatchSendCountAfterFirst, 0);
  assert.equal(mismatch.calls.includes("sheet-write"), true);
});

test("Sheet write failure blocks send on second invocation", async () => {
  const harness = makeHarness({ syncError: new Error("Sheet write unavailable") });
  const first = await run(harness);
  assert.equal(first.sendAttempts, 1);
  assert.equal(harness.ledger.records.find((record) => record.prospect_id === "6").send_state, "sent_confirmed");
  const sendCountAfterFirst = harness.calls.filter((call) => call === "send").length;
  const second = await run(harness);
  assert.equal(second.sendAttempts, 0);
  assert.equal(harness.calls.filter((call) => call === "send").length - sendCountAfterFirst, 0);
  assert.equal(harness.calls.filter((call) => call === "sheet-write").length, 1);
});

test("canonical account reaches every mocked Mailopoly call and no global network is used", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN_IN_TEST"); };
  try {
    const harness = makeHarness();
    const result = await run(harness);
    assert.equal(result.status, "pass");
    assert.equal(harness.calls.filter((call) => call.includes(MAILOPOLY_ACCOUNT)).length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate invocation after sent_confirmed is blocked", async () => {
  const harness = makeHarness({ ledgerRecords: [{ campaign: "round2-zh-20260928", prospect_id: "6", send_state: "sent_confirmed" }] });
  const result = await run(harness);
  assertNoSend(result, harness);
});

test("Shanghai date conversion handles UTC cross-day and invalid timestamps fail closed", () => {
  assert.equal(toShanghaiDate("2026-09-29T16:30:00.000Z"), "2026-09-30");
  assert.equal(toShanghaiDate("2026-09-29T12:00:00.000Z"), "2026-09-29");
  assert.throws(() => toShanghaiDate("not-a-timestamp"), /invalid timestamp/);
});

test("exact Sent verifier requires fields and bounded timestamps", () => {
  const valid = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-29T12:00:00.000Z" };
  assert.equal(filterExactSentMatches({ messages: [valid], recipient: valid.recipient, sender: valid.sender, subject: valid.subject, windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 1);
  assert.equal(filterExactSentMatches({ messages: [{ ...valid, timestamp: "2026-09-28T23:59:59Z" }, { ...valid, timestamp: "bad" }, { ...valid, sender: "other@example.com" }], recipient: valid.recipient, sender: valid.sender, subject: valid.subject, windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects recipient mismatch", () => {
  const message = { recipient: "other@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-29T12:00:00Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects subject mismatch", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "other subject", timestamp: "2026-09-29T12:00:00Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects sender mismatch", () => {
  const message = { recipient: "owner@example.com", sender: "other@example.com", subject: "subject", timestamp: "2026-09-29T12:00:00Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects missing timestamp", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects invalid timestamp", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "invalid" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects timestamp before window", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-28T23:59:59Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 0);
});

test("filterExactSentMatches rejects timestamp after window", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-30T00:00:01Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-30T00:00:00Z" }).length, 0);
});

test("filterExactSentMatches accepts exact lower boundary", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-29T00:00:00Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 1);
});

test("filterExactSentMatches accepts exact upper boundary", () => {
  const message = { recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", timestamp: "2026-09-29T23:59:59Z" };
  assert.equal(filterExactSentMatches({ messages: [message], recipient: "owner@example.com", sender: MAILOPOLY_ACCOUNT, subject: "subject", windowStart: "2026-09-29T00:00:00Z", windowEnd: "2026-09-29T23:59:59Z" }).length, 1);
});

test("operational errors redact email, URL, tracking token, Bearer, hex, and newlines", async () => {
  const sensitiveEmail = "owner@example.com";
  const sensitiveUrl = `https://publishers.getchinaflow.com/r/${"b".repeat(64)}`;
  const bearer = "Bearer test-value";
  const opaque = "c".repeat(40);
  const harness = makeHarness({ sendError: new Error(`timeout ${sensitiveEmail} ${sensitiveUrl} ${bearer} ${opaque}\nmore`) });
  const result = await run(harness);
  const error = result.reason;
  assert.equal(result.status, "ambiguous");
  assert.equal(error.includes(sensitiveEmail), false);
  assert.equal(error.includes(sensitiveUrl), false);
  assert.equal(error.includes(bearer), false);
  assert.equal(error.includes(opaque), false);
  assert.equal(error.includes("\n"), false);
  assert.equal(error.length <= 240, true);
  assert.equal(harness.ledger.records[0].last_error.includes(sensitiveEmail), false);
});

test("second invocation blocks after send_started crash before send", async () => {
  const harness = makeHarness();
  let reads = 0;
  const originalRead = harness.readLedger;
  harness.readLedger = async () => {
    reads += 1;
    if (reads === 2) throw new Error("simulated crash after fence");
    return originalRead();
  };
  const first = await run(harness);
  assert.equal(first.sendAttempts, 0);
  const sendsAfterFirst = harness.calls.filter((call) => call === "send").length;
  const second = await run(harness);
  assert.equal(second.sendAttempts, 0);
  assert.equal(harness.calls.filter((call) => call === "send").length, sendsAfterFirst);
  assert.equal(harness.ledger.records[0].send_state, "send_started");
});

test("provider-sent crash before sent_confirmed persistence blocks blind resend", async () => {
  const harness = makeHarness();
  let writes = 0;
  const originalWrite = harness.writeLedger;
  harness.writeLedger = async (next) => {
    writes += 1;
    if (writes === 2) throw new Error("persist crash after provider acceptance");
    return originalWrite(next);
  };
  const first = await run(harness);
  assert.equal(first.sendAttempts, 1);
  const sendsAfterFirst = harness.calls.filter((call) => call === "send").length;
  const second = await run(harness);
  assert.equal(second.sendAttempts, 0);
  assert.equal(harness.calls.filter((call) => call === "send").length, sendsAfterFirst);
  assert.equal(harness.ledger.records[0].send_state, "send_started");
});

test("sent_confirmed crash before post reconciliation blocks second send", async () => {
  const harness = makeHarness();
  let mailboxCalls = 0;
  const originalMailbox = harness.listMailboxFolders;
  harness.listMailboxFolders = async (args) => {
    mailboxCalls += 1;
    if (mailboxCalls === 2) throw new Error("crash before post reconciliation");
    return originalMailbox(args);
  };
  const first = await run(harness);
  assert.equal(first.sendAttempts, 1);
  const sendsAfterFirst = harness.calls.filter((call) => call === "send").length;
  assert.equal((await run(harness)).sendAttempts, 0);
  assert.equal(harness.calls.filter((call) => call === "send").length, sendsAfterFirst);
  assert.equal(harness.ledger.records[0].send_state, "sent_confirmed");
});

test("Sheet write success followed by readback crash blocks second send", async () => {
  const harness = makeHarness();
  let sheetReads = 0;
  const originalRead = harness.readPipelineValues;
  harness.readPipelineValues = async () => {
    sheetReads += 1;
    if (sheetReads === 2) throw new Error("crash before Sheet readback");
    return originalRead();
  };
  const first = await run(harness);
  assert.equal(first.sendAttempts, 1);
  const sendsAfterFirst = harness.calls.filter((call) => call === "send").length;
  assert.equal((await run(harness)).sendAttempts, 0);
  assert.equal(harness.calls.filter((call) => call === "send").length, sendsAfterFirst);
  assert.equal(harness.ledger.records[0].send_state, "sent_confirmed");
});

test("Sheet readback success followed by sheet_synced persistence crash blocks second send", async () => {
  const harness = makeHarness();
  let writes = 0;
  const originalWrite = harness.writeLedger;
  harness.writeLedger = async (next) => {
    writes += 1;
    if (writes === 3) throw new Error("crash before sheet_synced persistence");
    return originalWrite(next);
  };
  const first = await run(harness);
  assert.equal(first.sendAttempts, 1);
  const sendsAfterFirst = harness.calls.filter((call) => call === "send").length;
  assert.equal((await run(harness)).sendAttempts, 0);
  assert.equal(harness.calls.filter((call) => call === "send").length, sendsAfterFirst);
  assert.equal(harness.ledger.records[0].send_state, "sent_confirmed");
});