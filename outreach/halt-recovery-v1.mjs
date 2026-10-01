import crypto from "node:crypto";
import fs from "node:fs/promises";
import { HALT_LOCK_PATH } from "./halt-guard-v1.mjs";
import { CONFIG, ROUND_2_TEMPLATES } from "./runner-v2.mjs";
import { MAILOPOLY_ACCOUNT, resolveCanonicalMailopolySentFolder } from "./foundation-v1.mjs";
import { createProductionAdapters } from "./production-adapters-v1.mjs";

const COLUMN = Object.freeze({
  id: 0, publisher: 3, email: 13, campaign: 26,
  status: 28, sentDate: 29, language: 30,
});

function clean(value) { return String(value ?? "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function parseHalt(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("halt lock is malformed JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("halt lock payload is invalid");
  const prospectId = clean(parsed.prospectId);
  if (!prospectId) throw new Error("halt lock prospectId is missing");
  return Object.freeze({
    version: Number(parsed.version ?? 0),
    prospectId,
    reason: clean(parsed.reason) || "UNKNOWN",
    createdAt: clean(parsed.createdAt) || null,
  });
}

function findProspect(values, prospectId) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) throw new Error("pipeline values missing");
  const matches = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] ?? [];
    if (clean(row[COLUMN.id]) !== prospectId) continue;
    matches.push(Object.freeze({
      id: prospectId,
      row: i + 1,
      publisher: clean(row[COLUMN.publisher]),
      email: lower(row[COLUMN.email]),
      campaign: clean(row[COLUMN.campaign]),
      round2Status: clean(row[COLUMN.status]),
      sentDate: clean(row[COLUMN.sentDate]),
      language: clean(row[COLUMN.language]),
    }));
  }
  if (matches.length !== 1) throw new Error("halt prospect does not map to exactly one Sheet row");
  return matches[0];
}

function findLedgerMatches(ledger, prospectId) {
  if (!ledger || !Array.isArray(ledger.records)) throw new Error("ledger records missing");
  return ledger.records.filter((record) =>
    record?.campaign === CONFIG.campaign && String(record?.prospect_id) === prospectId);
}

function exactSentCount(messages, prospect, subject) {
  if (!Array.isArray(messages)) throw new Error("Mailopoly Sent results missing");
  return messages.filter((item) =>
    lower(item?.recipient) === prospect.email &&
    lower(item?.sender) === lower(MAILOPOLY_ACCOUNT) &&
    clean(item?.subject) === subject
  ).length;
}

export function assessHaltEvidence({ prospect, ledgerMatches, sentMatchCount }) {
  const ledgerState = ledgerMatches.length === 1 ? clean(ledgerMatches[0]?.send_state) : null;
  const sheetPrepared = prospect.campaign === CONFIG.campaign &&
    prospect.round2Status === "Prepared" && !prospect.sentDate;
  const sheetSent = prospect.campaign === CONFIG.campaign &&
    prospect.round2Status === "Sent" && /^\d{4}-\d{2}-\d{2}$/.test(prospect.sentDate);
  if (ledgerMatches.length > 1) {
    return Object.freeze({ clearable: false, disposition: "blocked", reason: "MULTIPLE_LEDGER_RECORDS", ledgerState });
  }
  if (sheetPrepared && sentMatchCount === 0 && (ledgerMatches.length === 0 || ledgerState === "prepared")) {
    return Object.freeze({ clearable: true, disposition: "safe_retry", reason: "NO_SEND_CROSSED_DURABLE_FENCE", ledgerState });
  }
  if (sheetSent && sentMatchCount === 1 &&
      ["sent_confirmed", "sheet_synced", "ambiguous"].includes(ledgerState)) {
    return Object.freeze({ clearable: true, disposition: "safe_skip", reason: "EXACT_SENT_AND_SHEET_SENT", ledgerState });
  }
  return Object.freeze({ clearable: false, disposition: "blocked", reason: "RECONCILIATION_REQUIRED", ledgerState });
}

function authorizationToken({ lockSha256, halt, prospect, assessment, sentMatchCount }) {
  const payload = JSON.stringify({
    lockSha256,
    prospectId: halt.prospectId,
    haltReason: halt.reason,
    campaign: prospect.campaign,
    sheetStatus: prospect.round2Status,
    sentDate: prospect.sentDate,
    ledgerState: assessment.ledgerState,
    sentMatchCount,
    disposition: assessment.disposition,
  });
  return "HALT-" + sha256(payload).slice(0, 24);
}

export async function reviewPersistentHalt({
  haltPath = HALT_LOCK_PATH,
  fsImpl = fs,
  dependencies = createProductionAdapters(),
} = {}) {
  let raw;
  try { raw = await fsImpl.readFile(haltPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ status: "no_halt", haltPath, clearable: false });
    throw error;
  }
  const halt = parseHalt(raw);
  const lockSha256 = sha256(raw);
  const [values, ledger] = await Promise.all([
    dependencies.readPipelineValues(),
    dependencies.readLedger(),
  ]);
  const prospect = findProspect(values, halt.prospectId);
  const template = ROUND_2_TEMPLATES[prospect.language];
  if (!template?.subject) throw new Error("halt prospect language is invalid");
  const mailboxPayload = await dependencies.listMailboxFolders({ account: MAILOPOLY_ACCOUNT });
  const sentFolder = resolveCanonicalMailopolySentFolder(mailboxPayload).folder.name;
  const sentMessages = await dependencies.searchSentEmails({
    account: MAILOPOLY_ACCOUNT,
    folder: sentFolder,
    recipient: prospect.email,
    subject: template.subject,
    campaign: CONFIG.campaign,
  });
  const ledgerMatches = findLedgerMatches(ledger, halt.prospectId);
  const sentMatchCount = exactSentCount(sentMessages, prospect, template.subject);
  const assessment = assessHaltEvidence({ prospect, ledgerMatches, sentMatchCount });
  const report = {
    status: "reviewed",
    haltPath,
    halt,
    prospect,
    ledger: {
      matchCount: ledgerMatches.length,
      state: assessment.ledgerState,
      lastError: ledgerMatches.length === 1 ? ledgerMatches[0]?.last_error ?? null : null,
    },
    mailopoly: { sentFolder, exactMatchCount: sentMatchCount },
    assessment,
    lockSha256,
  };
  return Object.freeze({
    ...report,
    authorizationToken: assessment.clearable
      ? authorizationToken({ lockSha256, halt, prospect, assessment, sentMatchCount })
      : null,
  });
}

export async function clearPersistentHalt({
  authorization,
  haltPath = HALT_LOCK_PATH,
  fsImpl = fs,
  dependencies = createProductionAdapters(),
  now = () => new Date(),
} = {}) {
  const review = await reviewPersistentHalt({ haltPath, fsImpl, dependencies });
  if (review.status === "no_halt") return review;
  if (!review.assessment.clearable) throw new Error("halt is not clearable; reconciliation required");
  if (!authorization || authorization !== review.authorizationToken) throw new Error("halt authorization token mismatch");
  const freshRaw = await fsImpl.readFile(haltPath, "utf8");
  if (sha256(freshRaw) !== review.lockSha256) throw new Error("halt lock changed during review");
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const archivePath = haltPath + ".cleared." + stamp + "." + review.lockSha256.slice(0, 12);
  await fsImpl.rename(haltPath, archivePath);
  return Object.freeze({
    status: "cleared",
    prospectId: review.halt.prospectId,
    haltReason: review.halt.reason,
    disposition: review.assessment.disposition,
    archivePath,
    serviceRestarted: false,
  });
}
