import fs from "node:fs/promises";
import {
  LEDGER_PATH,
  MAILOPOLY_ACCOUNT,
  assertMailopolyAccount,
  readLedger as readDurableLedger,
  writeLedger as writeDurableLedger,
} from "./foundation-v1.mjs";

export const SHEET_SPREADSHEET_ID = "1YClmIpGjgt7b_fyomhOTRrNUKZAmVXIlS-cMycIAE_4";
export const SHEET_NAME = "Sales Pipeline";
export const GOOGLE_CREDENTIAL_PATH = "/home/ubuntu/.config/chinaflow/google-sheets-service-account.json";
export const MAILOPOLY_API_KEY_PATH = "/home/ubuntu/.config/chinaflow/mailopoly-api-key";
export const MAILOPOLY_ENDPOINT = "https://fastapi.prod.aws.mailopoly.com/mcp-server/";

function jsonContent(payload) {
  const item = (payload?.result?.content ?? payload?.content ?? []).find((entry) => entry.type === "text");
  if (!item?.text) throw new Error("Mailopoly response content missing");
  try { return JSON.parse(item.text); } catch { throw new Error("Mailopoly response content malformed"); }
}

async function googleAccessToken({ fsImpl, fetchImpl, credentialPath }) {
  const credentials = JSON.parse(await fsImpl.readFile(credentialPath, "utf8"));
  if (!credentials.client_email || !credentials.private_key || !credentials.token_uri) throw new Error("Google credentials malformed");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encode(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const crypto = await import("node:crypto");
  let signature;
  try {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${claim}`);
    signer.end();
    signature = signer.sign(credentials.private_key).toString("base64url");
  } catch {
    throw new Error("Google credentials malformed");
  }
  const assertion = `${header}.${claim}.${signature}`;
  const response = await fetchImpl(credentials.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error("Google token request failed");
  const payload = await response.json();
  if (typeof payload.access_token !== "string") throw new Error("Google token response malformed");
  return payload.access_token;
}

function sheetRange(row) {
  if (!Number.isInteger(row) || row < 2) throw new Error("invalid Sheet row");
  return `'${SHEET_NAME}'!AC${row}:AD${row}`;
}

export function createProductionAdapters({
  fsImpl = fs,
  fetchImpl = fetch,
  env = process.env,
  credentialPath = GOOGLE_CREDENTIAL_PATH,
  mailopolyKeyPath = MAILOPOLY_API_KEY_PATH,
  ledgerPath = LEDGER_PATH,
} = {}) {
  const readPipelineValues = async () => {
    const token = await googleAccessToken({ fsImpl, fetchImpl, credentialPath });
    const range = `'${SHEET_NAME}'!A1:AE`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Google Sheet read failed");
    const payload = await response.json();
    if (!Array.isArray(payload.values)) throw new Error("Google Sheet response malformed");
    return payload.values;
  };

  const syncSheet = async (mutation) => {
    if (!mutation || mutation.range || mutation.columns?.join(",") !== "AC,AD" || mutation.status !== "Sent" || !/^\d{4}-\d{2}-\d{2}$/.test(mutation.sentDate ?? "")) throw new Error("Sheet mutation outside AC/AD contract");
    const range = sheetRange(mutation.sheetRow);
    const token = await googleAccessToken({ fsImpl, fetchImpl, credentialPath });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [["Sent", mutation.sentDate]] }),
    });
    if (!response.ok) throw new Error("Google Sheet write failed");
    return response.json();
  };

  const mailboxCall = async (name, args) => {
    const key = (await fsImpl.readFile(mailopolyKeyPath, "utf8")).trim();
    if (!key) throw new Error("Mailopoly key missing");
    const response = await fetchImpl(MAILOPOLY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    });
    if (!response.ok) throw new Error("Mailopoly request failed");
    const payload = await response.json();
    if (payload.error || payload.result?.isError === true) throw new Error("Mailopoly response rejected");
    return payload.result;
  };

  const listMailboxFolders = async ({ account }) => {
    assertMailopolyAccount(account);
    return jsonContent(await mailboxCall("list_mailbox_folders", { account }));
  };

  const searchSentEmails = async ({ account, folder, recipient, subject, campaign }) => {
    assertMailopolyAccount(account);
    const result = jsonContent(await mailboxCall("search_emails", {
      query: `to:${recipient} subject:"${subject}"`,
      folder,
      sender: account,
      campaign,
      limit: 50,
    }));
    return (result.results ?? []).map((item) => ({
      recipient: typeof item.to === "string" ? item.to : item.to?.email,
      sender: item.sender_email,
      subject: item.subject,
      timestamp: item.timestamp_received,
    }));
  };

  const sendEmail = async (request) => {
    if (env.REAL_SEND_ENABLED !== "YES" || env.AUTHORIZED_PROSPECT_ID !== String(request.prospectId)) throw new Error("REAL_SEND_DISABLED");
    assertMailopolyAccount(request.fromAccount);
    const provider = jsonContent(await mailboxCall("send_email", {
      from_account: MAILOPOLY_ACCOUNT,
      to: request.recipient,
      subject: request.subject,
      body: request.body,
      content_type: request.contentType,
    }));
    if (provider?.success === true) {
      return { accepted: true, messageId: provider.email_id ?? provider.message_id ?? null };
    }
    if (provider?.success === false) {
      return { accepted: false, rejected: true };
    }
    return { accepted: null };

  };

  return {
    readPipelineValues,
    listMailboxFolders,
    searchSentEmails,
    sendEmail,
    syncSheet,
    readLedger: () => readDurableLedger(ledgerPath),
    writeLedger: (ledger) => writeDurableLedger(ledgerPath, ledger),
    now: () => new Date(),
    ledgerPath,
  };
}