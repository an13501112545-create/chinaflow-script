import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LEDGER_PATH = "/var/lib/chinaflow-outreach/";
export const SEND_STATES = Object.freeze([
  "prepared",
  "send_started",
  "sent_confirmed",
  "sheet_synced",
  "ambiguous",
  "failed",
]);
export const RATE_LIMITS = Object.freeze({
  minIntervalMinutes: 6,
  maxIntervalMinutes: 12,
  hourlyHardCap: 8,
  dailyHardCap: 60,
  concurrency: 1,
});

export function trackingUrlHash(trackingUrl) {
  return crypto.createHash("sha256").update(trackingUrl, "utf8").digest("hex");
}

export function toShanghaiDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function sanitizeOperationalError(error) {
  let message = String(error?.message ?? error)
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[opaque-token]")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (message.length > 240) message = `${message.slice(0, 237)}...`;
  return message;
}

export const MAILOPOLY_ACCOUNT = "chris.an@getchinaflow.com";

export function isValidMailopolyAccount(account) {
  return account === MAILOPOLY_ACCOUNT;
}

export function assertMailopolyAccount(account) {
  if (!isValidMailopolyAccount(account)) throw new Error("invalid Mailopoly account identifier");
  return account;
}

export function resolveMailopolyAccountMetadata(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid Mailopoly metadata payload");
  if (payload.success !== true) throw new Error("Mailopoly metadata request was not successful");
  if (!Array.isArray(payload.accounts)) throw new Error("Mailopoly accounts metadata is not an array");
  const matches = payload.accounts.filter((item) => item && item.account === MAILOPOLY_ACCOUNT);
  if (matches.length !== 1) throw new Error("Mailopoly canonical account match was not unique");
  return matches[0];
}

export function makeLedgerRecord({
  campaign,
  prospectId,
  sheetRow,
  recipient,
  language,
  trackingUrl,
  mailopolyMessageId = null,
  sendState = "prepared",
  attemptStartedAt = null,
  mailopolyAcceptedAt = null,
  sheetSyncedAt = null,
  lastError = null,
}) {
  if (!SEND_STATES.includes(sendState)) throw new Error(`invalid send state: ${sendState}`);
  return {
    campaign,
    prospect_id: String(prospectId),
    sheet_row: Number(sheetRow),
    recipient,
    language,
    tracking_url_hash: trackingUrlHash(trackingUrl),
    mailopoly_message_id: mailopolyMessageId,
    send_state: sendState,
    attempt_started_at: attemptStartedAt,
    mailopoly_accepted_at: mailopolyAcceptedAt,
    sheet_synced_at: sheetSyncedAt,
    last_error: lastError,
  };
}

export async function ensureLedgerDirectory(directory = LEDGER_PATH) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

export async function readLedger(directory = LEDGER_PATH) {
  const ledgerFile = path.join(directory, "ledger.json");
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerFile, "utf8"));
    if (!Array.isArray(parsed.records)) throw new Error("ledger records must be an array");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

export async function writeLedger(directory, ledger) {
  await ensureLedgerDirectory(directory);
  const ledgerFile = path.join(directory, "ledger.json");
  const temporaryFile = path.join(directory, `.ledger-${process.pid}-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryFile, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(temporaryFile, 0o600);
  await fs.rename(temporaryFile, ledgerFile);
  const directoryHandle = await fs.open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  await fs.chmod(ledgerFile, 0o600);
}

export async function upsertLedgerRecord(directory, record) {
  const ledger = await readLedger(directory);
  const index = ledger.records.findIndex((item) => item.campaign === record.campaign && item.prospect_id === record.prospect_id);
  if (index === -1) ledger.records.push(record);
  else ledger.records[index] = record;
  await writeLedger(directory, ledger);
  return record;
}

export function resendDecision(record) {
  if (!record) return { allowed: true, reason: "no ledger record" };
  if (["send_started", "ambiguous"].includes(record.send_state)) {
    return { allowed: false, reason: "reconciliation required" };
  }
  if (["sent_confirmed", "sheet_synced"].includes(record.send_state)) {
    return { allowed: false, reason: "already confirmed sent" };
  }
  if (record.send_state === "prepared") return { allowed: true, reason: "initial controlled attempt" };
  return { allowed: false, reason: "manual reconciliation required" };
}

export function markSendStarted(record, timestamp) {
  if (!resendDecision(record).allowed) throw new Error("send is blocked by ledger state");
  return { ...record, send_state: "send_started", attempt_started_at: timestamp, last_error: null };
}

export function markAccepted(record, { messageId, acceptedAt }) {
  if (record.send_state !== "send_started") throw new Error("send must be started before acceptance");
  return { ...record, mailopoly_message_id: messageId, mailopoly_accepted_at: acceptedAt, send_state: "sent_confirmed", last_error: null };
}

export function markAmbiguous(record, errorMessage) {
  if (!["send_started", "sent_confirmed", "ambiguous"].includes(record.send_state)) throw new Error("only an in-flight or confirmed send can become ambiguous");
  return { ...record, send_state: "ambiguous", last_error: errorMessage };
}

export function markSheetSynced(record, syncedAt) {
  if (record.send_state !== "sent_confirmed") throw new Error("Sheet sync requires confirmed send");
  return { ...record, send_state: "sheet_synced", sheet_synced_at: syncedAt };
}

const VERIFIED_SENT_FOLDER_NAME = "已发送邮件";

export function resolveSentFolderFromMetadata(folders) {
  const metadataMatches = folders.filter((folder) => folder.system_type === "sent" || folder.type === "sent");
  if (metadataMatches.length === 1) return { status: "resolved", method: "metadata", folder: metadataMatches[0] };
  if (metadataMatches.length > 1) return { status: "ambiguous", method: "unresolved", folder: null };
  const exactNameMatches = folders.filter((folder) => folder.name === VERIFIED_SENT_FOLDER_NAME);
  if (exactNameMatches.length === 1) return { status: "resolved", method: "verified_exact_name_fallback", folder: exactNameMatches[0] };
  return { status: "ambiguous", method: "unresolved", folder: null };
}

export function resolveSentFolder(folders) {
  return resolveSentFolderFromMetadata(folders);
}

export function resolveCanonicalMailopolySentFolder(payload) {
  const accountMetadata = resolveMailopolyAccountMetadata(payload);
  const resolved = resolveSentFolderFromMetadata(accountMetadata.folders ?? []);
  if (resolved.status !== "resolved") throw new Error("Mailopoly Sent folder was not uniquely resolved");
  return resolved;
}

export async function reconcileMailopoly({ account = MAILOPOLY_ACCOUNT, listFolders, searchSent, recipient, subject, startDate, endDate }) {
  const canonicalAccount = assertMailopolyAccount(account);
  const folderResult = resolveSentFolder(await listFolders({ account: canonicalAccount }));
  if (folderResult.status !== "resolved") return { status: "ambiguous", matchCount: 0, folder: null };
  const results = await searchSent({ account: canonicalAccount, folder: folderResult.folder.name, recipient, subject, startDate, endDate });
  const exact = results.filter((item) => item.recipient === recipient && item.subject === subject);
  if (exact.length > 1) return { status: "ambiguous", matchCount: exact.length, folder: folderResult.folder };
  if (exact.length === 1) return { status: "sent_confirmed", matchCount: 1, folder: folderResult.folder, match: exact[0] };
  return { status: "not_found", matchCount: 0, folder: folderResult.folder };
}

export function liveSendEligibility({ env = process.env, prospectId }) {
  return env.ALLOW_LIVE_SEND === "YES" && env.AUTHORIZED_PROSPECT_ID === String(prospectId);
}

export async function guardedSend({ env = process.env, prospectId, send }) {
  if (!liveSendEligibility({ env, prospectId })) throw new Error("live send guard blocked");
  return send();
}

export function sheetWriteEligibility({ env = process.env, record }) {
  return env.ALLOW_SHEET_WRITE === "YES" && record.send_state === "sent_confirmed";
}

export async function guardedSheetSync({ env = process.env, record, sync }) {
  if (!sheetWriteEligibility({ env, record })) throw new Error("Sheet write guard blocked");
  return sync({ status: "Sent", sentDate: toShanghaiDate(record.mailopoly_accepted_at) });
}

function acceptedTimestamp(record) {
  return Date.parse(record.mailopoly_accepted_at || "");
}

export function durableRateCounts(records, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const confirmed = records.filter((record) => ["sent_confirmed", "sheet_synced"].includes(record.send_state));
  return {
    sentLast60Minutes: confirmed.filter((record) => {
      const timestamp = acceptedTimestamp(record);
      return Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp < 60 * 60 * 1000;
    }).length,
    sentToday: confirmed.filter((record) => {
      const timestamp = acceptedTimestamp(record);
      return Number.isFinite(timestamp) && timestamp <= nowMs && toShanghaiDate(timestamp) === toShanghaiDate(now);
    }).length,
  };
}

export function rateLimitAllowed(records, now = new Date()) {
  const counts = durableRateCounts(records, now);
  return { ...counts, allowed: counts.sentLast60Minutes < RATE_LIMITS.hourlyHardCap && counts.sentToday < RATE_LIMITS.dailyHardCap };
}