import {
  MAILOPOLY_ACCOUNT,
  guardedSend,
  guardedSheetSync,
  liveSendEligibility,
  makeLedgerRecord,
  markAccepted,
  markAmbiguous,
  markSendStarted,
  markSheetSynced,
  rateLimitAllowed,
  resolveCanonicalMailopolySentFolder,
  resolveMailopolyAccountMetadata,
  sanitizeOperationalError,
  toShanghaiDate,
} from "./foundation-v1.mjs";
import { buildPayload, validateProspect } from "./runner-v2.mjs";

const STATUS_PREPARED = "Prepared";
const STATUS_SENT = "Sent";

function result(status, details = {}) {
  return { status, sendAttempts: 0, sheetWrites: 0, retry: false, ...details };
}

export function filterExactSentMatches({ messages, recipient, subject, sender, windowStart, windowEnd }) {
  const start = new Date(windowStart).getTime();
  const end = new Date(windowEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  return messages.filter((item) => {
    const timestamp = new Date(item?.timestamp).getTime();
    return item?.recipient === recipient
      && item?.subject === subject
      && item?.sender === sender
      && Number.isFinite(timestamp)
      && timestamp >= start
      && timestamp <= end;
  });
}

function providerPositive(value) {
  return value && typeof value === "object"
    && value.accepted === true
    && value.rejected !== true
    && value.isError !== true;
}

function providerRejection(value) {
  return value && typeof value === "object"
    && (value.rejected === true || value.accepted === false || value.isError === true || value.status === "rejected");
}

function ambiguousError(error) {
  const text = String(error?.code ?? "") + " " + String(error?.message ?? error);
  return /timeout|timed out|reset|network|socket|unknown|unparseable|fetch/i.test(text);
}

function operationErrorCode(stage, error) {
  if (stage === "send" && ambiguousError(error)) return "SEND_AMBIGUOUS";
  if (stage === "send") return "SEND_REJECTED";
  if (stage === "mailbox") return "MAILBOX_READ_FAILED";
  if (stage === "search") return "SENT_SEARCH_FAILED";
  if (stage === "ledger") return "LEDGER_WRITE_FAILED";
  if (stage === "sheet-write") return "SHEET_WRITE_FAILED";
  if (stage === "sheet-readback") return "SHEET_READBACK_FAILED";
  return "CONTROLLED_LIVE_FAILED";
}

function ledgerRecord(ledger, campaign, prospectId) {
  return ledger.records.find((record) => record.campaign === campaign && record.prospect_id === String(prospectId));
}

function reconciliationWindow(attemptTime, endTime = attemptTime) {
  const end = new Date(endTime);
  return {
    windowStart: new Date(new Date(attemptTime).getTime() - 24 * 60 * 60 * 1000),
    windowEnd: end,
  };
}

const POST_SEND_RECONCILIATION_DELAYS_MS = Object.freeze([0, 5_000, 15_000, 30_000]);

async function waitForPostSendExactMatch({ dependencies, sentFolder, prospect, campaign, subject, attemptStartedAt }) {
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (const delayMs of POST_SEND_RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);
    const results = await dependencies.searchSentEmails({
      account: MAILOPOLY_ACCOUNT,
      folder: sentFolder.folder.name,
      recipient: prospect.email,
      subject,
      campaign,
    });
    const matches = filterExactSentMatches({
      messages: results,
      recipient: prospect.email,
      subject,
      sender: MAILOPOLY_ACCOUNT,
      ...reconciliationWindow(attemptStartedAt, dependencies.now()),
    });
    if (matches.length === 1) return { status: "confirmed", matches };
    if (matches.length > 1) return { status: "ambiguous", matches };
  }
  return { status: "not_found", matches: [] };
}

async function persistRecord(dependencies, ledger, record) {
  const records = ledger.records.filter((item) => !(item.campaign === record.campaign && item.prospect_id === record.prospect_id));
  records.push(record);
  await dependencies.writeLedger({ ...ledger, records });
}

function findProspect(values, prospectId) {
  const matches = values.slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => String(row[0] ?? "").trim() === String(prospectId));
  if (matches.length !== 1) throw new Error("prospect was not uniquely found");
  return validateProspect(matches[0].row, matches[0].rowNumber);
}

function findReadback(values, prospectId) {
  const matches = values.slice(1).filter((row) => String(row[0] ?? "").trim() === String(prospectId));
  if (matches.length !== 1) throw new Error("prospect readback was not unique");
  return matches[0];
}

export async function runControlledLiveSend({
  campaign,
  prospectId,
  allowLiveSend,
  authorizedProspectId,
  allowSheetWrite,
  dependencies,
}) {
  let sendAttempts = 0;
  let operationStage = "sheet-read";
  const base = { sendAttempts, sheetWrites: 0, retry: false };
  try {
    const values = await dependencies.readPipelineValues();
    const prospect = findProspect(values, prospectId);
    if (prospect.campaign !== campaign || prospect.status !== STATUS_PREPARED || prospect.sentDate !== "") {
      return result("blocked", { ...base, reason: "prospect is not currently eligible" });
    }
    const payload = buildPayload(prospect);
    operationStage = "ledger";
    const ledger = await dependencies.readLedger();
    if (ledgerRecord(ledger, campaign, prospectId)) {
      return result("blocked", { ...base, reason: "prospect already has a ledger record" });
    }

    const attemptTime = dependencies.now();
    operationStage = "mailbox";
    const mailboxPayload = await dependencies.listMailboxFolders({ account: MAILOPOLY_ACCOUNT });
    const accountMetadata = resolveMailopolyAccountMetadata(mailboxPayload);
    const sentFolder = resolveCanonicalMailopolySentFolder(mailboxPayload);
    operationStage = "search";
    const preResults = await dependencies.searchSentEmails({
      account: MAILOPOLY_ACCOUNT,
      folder: sentFolder.folder.name,
      recipient: prospect.email,
      subject: payload.subject,
      campaign,
    });
    const preMatches = filterExactSentMatches({
      messages: preResults,
      recipient: prospect.email,
      subject: payload.subject,
      sender: MAILOPOLY_ACCOUNT,
      ...reconciliationWindow(attemptTime),
    });
    if (preMatches.length !== 0) return result("blocked", { ...base, reason: "pre-send duplicate exists" });

    const rate = rateLimitAllowed(ledger.records, dependencies.now());
    if (!rate.allowed) return result("blocked", { ...base, reason: "rate cap exceeded", rate });
    const authorized = liveSendEligibility({
      env: { ALLOW_LIVE_SEND: allowLiveSend, AUTHORIZED_PROSPECT_ID: authorizedProspectId },
      prospectId,
    });
    if (!authorized) return result("blocked", { ...base, reason: "live send guard blocked" });
    if (allowSheetWrite !== "YES") return result("blocked", { ...base, reason: "Sheet write guard blocked" });

    const prepared = makeLedgerRecord({
      campaign,
      prospectId,
      sheetRow: prospect.row,
      recipient: prospect.email,
      language: prospect.language,
      trackingUrl: prospect.trackingUrl,
    });
    const started = markSendStarted(prepared, dependencies.now().toISOString());
    operationStage = "ledger";
    await persistRecord(dependencies, ledger, started);
    operationStage = "ledger";
    const fencedLedger = await dependencies.readLedger();
    if (ledgerRecord(fencedLedger, campaign, prospectId)?.send_state !== "send_started") {
      return result("blocked", { ...base, reason: "durable send_started fence failed" });
    }
    const durableLedger = fencedLedger;
    let sendResult;
    operationStage = "send";
    try {
      sendResult = await guardedSend({
        env: { ALLOW_LIVE_SEND: allowLiveSend, AUTHORIZED_PROSPECT_ID: authorizedProspectId },
        prospectId,
        send: async () => {
          sendAttempts += 1;
          return dependencies.sendEmail({
            prospectId: String(prospectId),
            fromAccount: MAILOPOLY_ACCOUNT,
            recipient: prospect.email,
            subject: payload.subject,
            body: payload.body,
            contentType: "text/html",
          });
        },
      });
    } catch (error) {
      const message = operationErrorCode("send", error);
      const terminalRecord = ambiguousError(error)
        ? markAmbiguous(started, message)
        : { ...started, send_state: "failed", last_error: message };
      await persistRecord(dependencies, durableLedger, terminalRecord);
      return result(terminalRecord.send_state === "ambiguous" ? "ambiguous" : "failed", { ...base, sendAttempts, reason: message });
    }
    if (!providerPositive(sendResult)) {
      const failed = providerRejection(sendResult)
        ? { ...started, send_state: "failed", last_error: "provider rejected send" }
        : markAmbiguous(started, "provider result was not an explicit positive response");
      await persistRecord(dependencies, durableLedger, failed);
      return result(failed.send_state === "failed" ? "failed" : "ambiguous", { ...base, sendAttempts, reason: failed.last_error });
    }

    const accepted = markAccepted(started, { messageId: sendResult.messageId ?? null, acceptedAt: dependencies.now().toISOString() });
    try {
      await persistRecord(dependencies, durableLedger, accepted);
    } catch (error) {
      return result("ambiguous", { ...base, sendAttempts, reason: "LEDGER_WRITE_FAILED" });
    }
    operationStage = "mailbox";
    const postMailboxPayload = await dependencies.listMailboxFolders({ account: MAILOPOLY_ACCOUNT });
    const postAccountMetadata = resolveMailopolyAccountMetadata(postMailboxPayload);
    void accountMetadata;
    void postAccountMetadata;
    const postSentFolder = resolveCanonicalMailopolySentFolder(postMailboxPayload);
    operationStage = "search";
    const postReconciliation = await waitForPostSendExactMatch({
      dependencies,
      sentFolder: postSentFolder,
      prospect,
      campaign,
      subject: payload.subject,
      attemptStartedAt: started.attempt_started_at,
    });
    if (postReconciliation.status !== "confirmed") {
      const ambiguous = markAmbiguous(accepted, "post-send Sent reconciliation was not exactly one match");
      await persistRecord(dependencies, durableLedger, ambiguous);
      return result("ambiguous", { ...base, sendAttempts, postMatchCount: postReconciliation.matches.length, reason: "SEND_AMBIGUOUS" });
    }

    let sheetWrites = 0;
    operationStage = "sheet-write";
    await guardedSheetSync({
      env: { ALLOW_SHEET_WRITE: allowSheetWrite },
      record: accepted,
      sync: async ({ status, sentDate }) => {
        sheetWrites += 1;
        return dependencies.syncSheet({
          prospectId: String(prospectId),
          sheetRow: prospect.row,
          columns: ["AC", "AD"],
          status,
          sentDate,
        });
      },
    });
    operationStage = "sheet-readback";
    const sheetReadback = findReadback(await dependencies.readPipelineValues(), prospectId);
    if (String(sheetReadback[28] ?? "").trim() !== STATUS_SENT || String(sheetReadback[29] ?? "").trim() !== toShanghaiDate(accepted.mailopoly_accepted_at)) {
      return result("failed", { ...base, sendAttempts, sheetWrites, reason: "Sheet readback mismatch", finalState: "sent_confirmed" });
    }
    const synced = markSheetSynced(accepted, dependencies.now().toISOString());
    operationStage = "ledger";
    await persistRecord(dependencies, durableLedger, synced);
    return result("pass", { ...base, sendAttempts, sheetWrites, finalState: synced.send_state, postMatchCount: 1 });
  } catch (error) {
    if (sendAttempts === 1 && ambiguousError(error)) {
      return result("ambiguous", { ...base, sendAttempts, retry: false, reason: "SEND_AMBIGUOUS" });
    }
    return result("blocked", { ...base, sendAttempts, retry: false, reason: operationErrorCode(operationStage, error) });
  }
}