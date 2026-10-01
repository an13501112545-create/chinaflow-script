import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  durableRateCounts,
  guardedSend,
  isValidMailopolyAccount,
  liveSendEligibility,
  MAILOPOLY_ACCOUNT,
  makeLedgerRecord,
  markAccepted,
  markAmbiguous,
  markSendStarted,
  markSheetSynced,
  rateLimitAllowed,
  readLedger,
  reconcileMailopoly,
  resendDecision,
  resolveCanonicalMailopolySentFolder,
  resolveMailopolyAccountMetadata,
  resolveSentFolder,
  resolveSentFolderFromMetadata,
  sheetWriteEligibility,
  trackingUrlHash,
  upsertLedgerRecord,
  assertMailopolyAccount,
} from "../foundation-v1.mjs";

const trackingUrl = `https://publishers.getchinaflow.com/r/${"a".repeat(64)}`;
const baseRecord = () => makeLedgerRecord({
  campaign: "round2-zh-20260928",
  prospectId: "6",
  sheetRow: 7,
  recipient: "sales@example.com",
  language: "ZH",
  trackingUrl,
});

test("canonical Mailopoly account accepts only the raw identifier", () => {
  assert.equal(MAILOPOLY_ACCOUNT, "chris.an@getchinaflow.com");
  assert.equal(isValidMailopolyAccount("chris.an@getchinaflow.com"), true);
  assert.equal(isValidMailopolyAccount("mailto:chris.an@getchinaflow.com"), false);
  assert.equal(isValidMailopolyAccount("[chris.an@getchinaflow.com](mailto:chris.an@getchinaflow.com)"), false);
  assert.throws(() => assertMailopolyAccount("mailto:chris.an@getchinaflow.com"), /invalid Mailopoly account/);
  assert.throws(() => assertMailopolyAccount("[chris.an@getchinaflow.com](mailto:chris.an@getchinaflow.com)"), /invalid Mailopoly account/);
});

test("account metadata adapter resolves one canonical account", () => {
  const result = resolveMailopolyAccountMetadata({ success: true, accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [] }] });
  assert.equal(result.account, MAILOPOLY_ACCOUNT);
});

test("account metadata adapter rejects zero canonical accounts", () => {
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true, accounts: [] }), /not unique/);
});

test("account metadata adapter rejects duplicate canonical accounts", () => {
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true, accounts: [{ account: MAILOPOLY_ACCOUNT }, { account: MAILOPOLY_ACCOUNT }] }), /not unique/);
});

test("account metadata adapter does not fall back to email", () => {
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true, accounts: [{ email: MAILOPOLY_ACCOUNT }] }), /not unique/);
});

test("account metadata adapter does not fall back to address", () => {
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true, accounts: [{ address: MAILOPOLY_ACCOUNT }] }), /not unique/);
});

test("account metadata adapter rejects Markdown account values", () => {
  const markdown = `[${MAILOPOLY_ACCOUNT}](mailto:${MAILOPOLY_ACCOUNT})`;
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true, accounts: [{ account: markdown }] }), /not unique/);
});

test("account metadata adapter rejects unsuccessful payloads", () => {
  assert.throws(() => resolveMailopolyAccountMetadata({ success: false, accounts: [{ account: MAILOPOLY_ACCOUNT }] }), /not successful/);
});

test("account metadata adapter rejects missing or non-array accounts", () => {
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true }), /not an array/);
  assert.throws(() => resolveMailopolyAccountMetadata({ success: true, accounts: {} }), /not an array/);
});

test("composed account and Sent resolver uses the verified exact-name fallback", () => {
  const result = resolveCanonicalMailopolySentFolder({ success: true, accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [{ name: "INBOX" }, { name: "已发送邮件" }] }] });
  assert.equal(result.method, "verified_exact_name_fallback");
  assert.equal(result.folder.name, "已发送邮件");
});

test("composed account and Sent resolver fails on ambiguous Sent folders", () => {
  assert.throws(() => resolveCanonicalMailopolySentFolder({ success: true, accounts: [{ account: MAILOPOLY_ACCOUNT, folders: [{ name: "Sent A", type: "sent" }, { name: "Sent B", system_type: "sent" }] }] }), /not uniquely resolved/);
});

test("ledger survives a new read process and stores only tracking hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chinaflow-ledger-"));
  try {
    await upsertLedgerRecord(directory, baseRecord());
    const ledger = await readLedger(directory);
    assert.equal(ledger.records.length, 1);
    assert.equal(ledger.records[0].tracking_url_hash, trackingUrlHash(trackingUrl));
    assert.equal((await readFile(path.join(directory, "ledger.json"), "utf8")).includes(trackingUrl), false);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "ledger.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical confirmed and sheet-synced states block resend", () => {
  assert.equal(resendDecision({ send_state: "sent_confirmed" }).allowed, false);
  assert.equal(resendDecision({ send_state: "sheet_synced" }).allowed, false);
  assert.equal(resendDecision({ send_state: "send_started" }).allowed, false);
  assert.equal(resendDecision({ send_state: "ambiguous" }).allowed, false);
});

test("send transitions are crash-safe and positive acceptance is confirmed", () => {
  const started = markSendStarted(baseRecord(), "2026-09-29T10:00:00Z");
  assert.equal(started.send_state, "send_started");
  const accepted = markAccepted(started, { messageId: "opaque-message-id", acceptedAt: "2026-09-29T10:01:00Z" });
  assert.equal(accepted.send_state, "sent_confirmed");
  assert.equal(markSheetSynced(accepted, "2026-09-29T10:02:00Z").send_state, "sheet_synced");
  assert.throws(() => markSheetSynced(started, "2026-09-29T10:02:00Z"), /confirmed send/);
  assert.equal(markAmbiguous(started, "timeout").send_state, "ambiguous");
});

test("one system_type sent metadata folder resolves with metadata priority", () => {
  const result = resolveSentFolderFromMetadata([{ name: "已发送邮件" }, { name: "Sent System", system_type: "sent" }]);
  assert.equal(result.status, "resolved");
  assert.equal(result.method, "metadata");
  assert.equal(result.folder.name, "Sent System");
});

test("one type sent metadata folder resolves with metadata priority", () => {
  const result = resolveSentFolderFromMetadata([{ name: "Sent Type", type: "sent" }, { name: "已发送邮件" }]);
  assert.equal(result.status, "resolved");
  assert.equal(result.method, "metadata");
  assert.equal(result.folder.name, "Sent Type");
});

test("zero metadata sent with exactly one verified name uses exact fallback", () => {
  const result = resolveSentFolderFromMetadata([{ name: "INBOX" }, { name: "已发送邮件" }]);
  assert.equal(result.status, "resolved");
  assert.equal(result.method, "verified_exact_name_fallback");
  assert.equal(result.folder.name, "已发送邮件");
});

test("zero metadata sent with no verified name fails closed", () => {
  assert.equal(resolveSentFolderFromMetadata([{ name: "INBOX" }]).status, "ambiguous");
});

test("zero metadata sent with duplicate verified names fails closed", () => {
  assert.equal(resolveSentFolderFromMetadata([{ name: "已发送邮件" }, { name: "已发送邮件" }]).status, "ambiguous");
});

test("multiple metadata sent folders fail closed even with verified name", () => {
  const result = resolveSentFolderFromMetadata([
    { name: "Sent A", system_type: "sent" },
    { name: "Sent B", type: "sent" },
    { name: "已发送邮件" },
  ]);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.folder, null);
});

test("fuzzy sent-like names are never production resolution", () => {
  assert.equal(resolveSentFolderFromMetadata([{ name: "Sent Items" }]).status, "ambiguous");
  assert.equal(resolveSentFolderFromMetadata([{ name: "已发送" }]).status, "ambiguous");
});

test("verified fallback name remains the literal 已发送邮件", () => {
  const result = resolveSentFolder([{ name: "已发送邮件" }]);
  assert.equal(result.method, "verified_exact_name_fallback");
  assert.equal(result.folder.name, "已发送邮件");
});

test("fresh Mailopoly exact duplicate blocks future send", async () => {
  let folderAccount;
  let searchAccount;
  const result = await reconcileMailopoly({
    listFolders: async ({ account }) => {
      folderAccount = account;
      return [{ name: "已发送邮件" }];
    },
    searchSent: async (query) => {
      searchAccount = query.account;
      return [{ ...query, recipient: "sales@example.com", subject: "subject" }];
    },
    recipient: "sales@example.com",
    subject: "subject",
    startDate: "2026-09-28",
    endDate: "2026-09-30",
  });
  assert.equal(result.status, "sent_confirmed");
  assert.equal(folderAccount, MAILOPOLY_ACCOUNT);
  assert.equal(searchAccount, MAILOPOLY_ACCOUNT);
  assert.equal(resendDecision({ send_state: result.status }).allowed, false);
});

test("unknown or multiple Sent folders make reconciliation ambiguous", async () => {
  assert.equal((await reconcileMailopoly({
    listFolders: async () => [{ name: "INBOX" }],
    searchSent: async () => [], recipient: "a", subject: "s", startDate: "", endDate: "",
  })).status, "ambiguous");
  assert.equal((await reconcileMailopoly({
    listFolders: async () => [{ name: "A", system_type: "sent" }, { name: "B", system_type: "sent" }],
    searchSent: async () => [], recipient: "a", subject: "s", startDate: "", endDate: "",
  })).status, "ambiguous");
});

test("live send requires both authorization keys and never defaults on", async () => {
  assert.equal(liveSendEligibility({ env: {}, prospectId: "6" }), false);
  assert.equal(liveSendEligibility({ env: { ALLOW_LIVE_SEND: "YES" }, prospectId: "6" }), false);
  assert.equal(liveSendEligibility({ env: { ALLOW_LIVE_SEND: "YES", AUTHORIZED_PROSPECT_ID: "7" }, prospectId: "6" }), false);
  assert.equal(liveSendEligibility({ env: { ALLOW_LIVE_SEND: "YES", AUTHORIZED_PROSPECT_ID: "6" }, prospectId: "6" }), true);
  await assert.rejects(() => guardedSend({ env: {}, prospectId: "6", send: async () => "sent" }), /guard blocked/);
});

test("Sheet write remains blocked by default and requires confirmed send", () => {
  assert.equal(sheetWriteEligibility({ env: {}, record: { send_state: "sent_confirmed" } }), false);
  assert.equal(sheetWriteEligibility({ env: { ALLOW_SHEET_WRITE: "YES" }, record: { send_state: "send_started" } }), false);
  assert.equal(sheetWriteEligibility({ env: { ALLOW_SHEET_WRITE: "YES" }, record: { send_state: "sent_confirmed" } }), true);
});

test("durable rate caps count confirmed historical records", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const records = Array.from({ length: 8 }, (_, index) => ({
    send_state: index === 7 ? "sheet_synced" : "sent_confirmed",
    mailopoly_accepted_at: new Date(now.getTime() - index * 60_000).toISOString(),
  }));
  assert.deepEqual(durableRateCounts(records, now), { sentLast60Minutes: 8, sentToday: 8 });
  assert.equal(rateLimitAllowed(records, now).allowed, false);
  assert.equal(rateLimitAllowed([], now).allowed, true);
});

test("message IDs and tracking URLs are not printed by ledger operations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chinaflow-ledger-output-"));
  try {
    const accepted = markAccepted(markSendStarted(baseRecord(), "2026-09-29T10:00:00Z"), {
      messageId: "opaque-message-id",
      acceptedAt: "2026-09-29T10:01:00Z",
    });
    await upsertLedgerRecord(directory, accepted);
    const serialized = await readFile(path.join(directory, "ledger.json"), "utf8");
    assert.match(serialized, /mailopoly_message_id/);
    assert.equal(serialized.includes(trackingUrl), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});