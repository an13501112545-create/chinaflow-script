import crypto from "node:crypto";
import fs from "node:fs/promises";

export const CONFIG = Object.freeze({
  campaign: "round2-zh-20260928",
  spreadsheetId: "1YClmIpGjgt7b_fyomhOTRrNUKZAmVXIlS-cMycIAE_4",
  sheetName: "Sales Pipeline",
  credentialPath: "/home/ubuntu/.config/chinaflow/google-sheets-service-account.json",
  minIntervalMinutes: 6,
  maxIntervalMinutes: 12,
  hourlyHardCap: 8,
  dailyHardCap: 60,
  concurrency: 1,
  sendMode: "ONE_AT_A_TIME",
  scope: "https://www.googleapis.com/auth/spreadsheets",
});

export const SEND_STATES = Object.freeze([
  "prepared",
  "send_started",
  "sent_confirmed",
  "sheet_synced",
  "ambiguous",
  "failed",
]);

const COLUMN = Object.freeze({
  id: 0,
  publisher: 3,
  email: 13,
  primaryStatus: 16,
  campaign: 26,
  trackingUrl: 27,
  status: 28,
  sentDate: 29,
  language: 30,
});

const TRACKING_URL_PATTERN = /^https:\/\/publishers\.getchinaflow\.com\/r\/[0-9a-f]{64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERMANENT_SUPPRESSION_STATUSES = new Set(["Invalid Email", "Delivery Failed"]);
const EXPECTED_HEADERS = Object.freeze({
  0: "ID",
  3: "Publisher / Website",
  13: "Email",
  26: "Outreach Campaign",
  27: "Tracking URL",
  28: "Round 2 Status",
  29: "Round 2 Sent Date",
  30: "Round 2 Language",
});

export const ROUND_2_TEMPLATES = Object.freeze({
  ZH: Object.freeze({
    subject: "你们平时帮客人订中国酒店吗？",
    paragraphs: Object.freeze([
      "你好，{{publisher}} 团队，",
      "我是 Chris，做 ChinaFlow 的。",
      "想问一下，你们平时会帮海外客人订中国酒店吗？",
      "我可以给你们一个专属 Trip.com 订房链接。客人需要中国酒店时，用这个链接在 Trip.com 正常预订。",
      "不用改网站，不用安装代码，也不用对接 API。",
      "客人入住离店、Trip.com 确认有效佣金后，我们按合作约定分佣。",
      "简单说：同样的订房业务，多一份佣金机会。",
      "有兴趣直接回复这封邮件，我把专属预订入口发给你们，咱们先试一单。",
      "Chris | ChinaFlow | 微信：13501112545",
      "<a href=\"{{trackingUrl}}\">了解 ChinaFlow 合作方式或注册</a>",
    ]),
  }),
  EN: Object.freeze({
    subject: "Do you book hotels in China for your clients?",
    paragraphs: Object.freeze([
      "Hello {{publisher}} team,",
      "I'm Chris from ChinaFlow.",
      "Do you help international travelers book hotels in China?",
      "I can send you a dedicated Trip.com booking link. When a client needs a hotel in China, use it to book on Trip.com as usual.",
      "No website changes, no code to install, and no API integration.",
      "After the guest checks out and Trip.com verifies eligible commissions, we share those commissions with you under our agreed terms.",
      "Same booking service, with a chance to earn commission.",
      "If you're interested, just reply to this email. I'll send your dedicated booking link so we can try it with one booking.",
      "Chris | ChinaFlow | WeChat: 13501112545",
      "<a href=\"{{trackingUrl}}\">Learn about ChinaFlow or register</a>",
    ]),
  }),
});

export class OutreachValidationError extends Error {
  constructor(row, reason) {
    super(`sheet row ${row}: ${reason}`);
    this.name = "OutreachValidationError";
    this.row = row;
    this.reason = reason;
  }
}

export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function validateProspect(row, rowNumber) {
  const value = (index) => row[index] ?? "";
  const id = String(value(COLUMN.id)).trim();
  const publisher = String(value(COLUMN.publisher)).trim();
  const email = String(value(COLUMN.email)).trim();
  const language = String(value(COLUMN.language)).trim();
  const trackingUrl = String(value(COLUMN.trackingUrl)).trim();
  const campaign = String(value(COLUMN.campaign)).trim();
  const primaryStatus = String(value(COLUMN.primaryStatus)).trim();
  const status = String(value(COLUMN.status)).trim();
  const sentDate = String(value(COLUMN.sentDate)).trim();

  if (!id) throw new OutreachValidationError(rowNumber, "ID is blank");
  if (!publisher) throw new OutreachValidationError(rowNumber, "Publisher / Website is blank");
  if (!email) throw new OutreachValidationError(rowNumber, "Email is blank");
  if (!EMAIL_PATTERN.test(email)) throw new OutreachValidationError(rowNumber, "Email syntax is invalid");
  if (language !== "ZH" && language !== "EN") throw new OutreachValidationError(rowNumber, "Language must be exactly ZH or EN");
  if (!TRACKING_URL_PATTERN.test(trackingUrl)) throw new OutreachValidationError(rowNumber, "Tracking URL is invalid");
  if (campaign !== CONFIG.campaign) throw new OutreachValidationError(rowNumber, "Campaign is not exact");
  if (PERMANENT_SUPPRESSION_STATUSES.has(primaryStatus)) throw new OutreachValidationError(rowNumber, "Primary Status is permanently suppressed");
  if (status !== "Prepared") throw new OutreachValidationError(rowNumber, "Round 2 Status is not exact Prepared");
  if (sentDate) throw new OutreachValidationError(rowNumber, "Round 2 Sent Date is not blank");

  return Object.freeze({
    id,
    publisher,
    email,
    language,
    trackingUrl,
    campaign,
    primaryStatus,
    status,
    sentDate,
    row: rowNumber,
  });
}

export function isEligible(row) {
  return String(row[COLUMN.campaign] ?? "").trim() === CONFIG.campaign
    && !PERMANENT_SUPPRESSION_STATUSES.has(String(row[COLUMN.primaryStatus] ?? "").trim())
    && String(row[COLUMN.status] ?? "").trim() === "Prepared"
    && isBlank(row[COLUMN.sentDate]);
}

export function selectFirstEligible(values) {
  if (!Array.isArray(values) || values.length < 1) {
    throw new Error("Sales Pipeline response has no header row");
  }
  for (const [index, expected] of Object.entries(EXPECTED_HEADERS)) {
    if (values[0]?.[Number(index)] !== expected) {
      throw new Error(`header mismatch at column ${Number(index) + 1}`);
    }
  }

  const eligibleRows = [];
  for (let index = 1; index < values.length; index += 1) {
    if (isEligible(values[index])) eligibleRows.push({ row: values[index], rowNumber: index + 1 });
  }
  if (eligibleRows.length === 0) return { total: 0, prospect: null };
  return {
    total: eligibleRows.length,
    prospect: validateProspect(eligibleRows[0].row, eligibleRows[0].rowNumber),
  };
}

export function buildPayload(prospect) {
  const template = ROUND_2_TEMPLATES[prospect.language];
  const publisher = escapeHtml(prospect.publisher);
  const trackingUrl = escapeHtml(prospect.trackingUrl);
  const body = template.paragraphs
    .map((paragraph) => paragraph
      .replaceAll("{{publisher}}", publisher)
      .replaceAll("{{trackingUrl}}", trackingUrl))
    .map((paragraph) => "<p>" + paragraph + "</p>")
    .join("");
  return Object.freeze({
    to: prospect.email,
    subject: template.subject,
    body,
  });
}

export function nextIntervalMinutes(randomInt = crypto.randomInt) {
  return randomInt(CONFIG.minIntervalMinutes, CONFIG.maxIntervalMinutes + 1);
}

export function scheduleNext(currentTime = new Date(), randomInt = crypto.randomInt) {
  const interval = nextIntervalMinutes(randomInt);
  return Object.freeze({
    currentTime: new Date(currentTime),
    interval,
    nextSendAt: new Date(new Date(currentTime).getTime() + interval * 60 * 1000),
  });
}

function confirmedTimestamp(record) {
  return record.mailopoly_accepted_at ? Date.parse(record.mailopoly_accepted_at) : NaN;
}

export function rateCounts(records, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const confirmed = records.filter((record) => Number.isFinite(confirmedTimestamp(record))
    && ["sent_confirmed", "sheet_synced"].includes(record.send_state));
  return {
    sentLast60Minutes: confirmed.filter((record) => nowMs - confirmedTimestamp(record) < 60 * 60 * 1000
      && nowMs >= confirmedTimestamp(record)).length,
    sentToday: confirmed.filter((record) => confirmedTimestamp(record) >= dayStart.getTime()
      && confirmedTimestamp(record) <= nowMs).length,
  };
}

export function canSend(records, now = new Date()) {
  const counts = rateCounts(records, now);
  return Object.freeze({
    ...counts,
    allowed: counts.sentLast60Minutes < CONFIG.hourlyHardCap && counts.sentToday < CONFIG.dailyHardCap,
  });
}

export function resendDecision(record) {
  if (["send_started", "ambiguous", "sent_confirmed", "sheet_synced"].includes(record.send_state)) {
    return Object.freeze({ allowed: false, reason: `${record.send_state} requires reconciliation or is already sent` });
  }
  return Object.freeze({ allowed: true, reason: "controlled retry may be considered" });
}

export function reconciliationDecision(result) {
  if (result === "found") return Object.freeze({ state: "sent_confirmed", retryAllowed: false });
  if (result === "not_found") return Object.freeze({ state: "failed", retryAllowed: true });
  return Object.freeze({ state: "ambiguous", retryAllowed: false });
}

export function isProviderStop(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const text = String(error?.message ?? error ?? "").toLowerCase();
  return [401, 403, 429, 503].includes(status)
    || /rate.?limit|quota|subscription limit|authentication failure|mailbox.*unavailable|provider.*unavailable/.test(text);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: CONFIG.scope,
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString("base64url")}`;
  const response = await fetch(credentials.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`OAuth token request returned HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload.access_token !== "string") throw new Error("OAuth token response lacked access token");
  return payload.access_token;
}

export async function readPipelineValues({
  credentialPath = CONFIG.credentialPath,
  fetchImpl = fetch,
} = {}) {
  const credentials = JSON.parse(await fs.readFile(credentialPath, "utf8"));
  const token = await getAccessToken({ ...credentials, fetch: fetchImpl });
  const range = `'${CONFIG.sheetName}'!A1:AE`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(CONFIG.spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Sheets API request returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.values)) throw new Error("Sheets API response did not contain values");
  return payload.values;
}

export function formatDryRunReport(selection, payload, schedule) {
  const prospect = selection.prospect;
  return [
    `ROW=${prospect.row}`,
    `ID=${prospect.id}`,
    `PUBLISHER=${prospect.publisher}`,
    `EMAIL=${prospect.email}`,
    `LANGUAGE=${prospect.language}`,
    "TRACKING_URL_VALID=YES",
    `SUBJECT=${payload.subject}`,
    "PAYLOAD_VALID=YES",
    "",
    `SEND_MODE=${CONFIG.sendMode}`,
    `CONCURRENCY=${CONFIG.concurrency}`,
    `NEXT_INTERVAL_MINUTES=${schedule.interval}`,
    `NEXT_SEND_AT=${schedule.nextSendAt.toISOString()}`,
    `HOURLY_HARD_CAP=${CONFIG.hourlyHardCap}`,
    `DAILY_HARD_CAP=${CONFIG.dailyHardCap}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const selection = selectFirstEligible(await readPipelineValues());
    if (!selection.prospect) throw new Error("no eligible Prepared prospect found");
    const payload = buildPayload(selection.prospect);
    console.log(formatDryRunReport(selection, payload, scheduleNext()));
  } catch (error) {
    console.error(`DRY_RUN_FAIL_CLOSED=${error.message}`);
    process.exitCode = 1;
  }
}