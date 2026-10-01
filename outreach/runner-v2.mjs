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
  campaign: 26,
  trackingUrl: 27,
  status: 28,
  sentDate: 29,
  language: 30,
});

const TRACKING_URL_PATTERN = /^https:\/\/publishers\.getchinaflow\.com\/r\/[0-9a-f]{64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
    subject: "帮客户订中国酒店，也可以获得额外佣金",
    paragraphs: Object.freeze([
      "您好 {{publisher}} 团队，",
      "我是 ChinaFlow 的 Chris。",
      "如果贵司主要服务来中国旅游的海外客人，平时会协助客户规划行程或预订酒店，现在可以通过 ChinaFlow 增加一条新的佣金收入渠道。",
      "贵司可以通过 ChinaFlow 的 Agent Booking（代客预订）功能进入 Trip.com，像平时一样为客户搜索和预订酒店。订单仍由 Trip.com 提供和完成，贵司不需要自己对接酒店库存，也不需要开发预订或支付系统；符合条件的订单可以通过贵司自己的 ChinaFlow 账户追踪并产生佣金。",
      "如果贵司还有自己的英文网站、中国旅游攻略、目的地介绍或行程内容，也可以通过 ChinaFlow 将这些内容连接到 Trip.com 的相关旅游产品，让已有的网站流量产生更多商业价值。",
      "简单来说，一个 ChinaFlow 账户可以同时覆盖：团队为客户代订酒店 + 网站内容带来的预订。",
      "ChinaFlow 目前已经开放在线注册和自助开通流程。您可以直接进入中文版网站了解合作方式并开始注册：",
      "<a href=\"{{trackingUrl}}\">访问 ChinaFlow 中文版并开始注册</a>",
      "如在开通过程中有任何问题，也可以直接回复这封邮件，或加我微信联系：13501112545（微信同号）。",
    ]),
  }),
  EN: Object.freeze({
    subject: "Earn additional commission when booking China hotels for clients",
    paragraphs: Object.freeze([
      "Hello {{publisher}} team,",
      "I'm Chris, founder of ChinaFlow.",
      "If you help international travelers plan trips to China or book hotels for clients, ChinaFlow now gives you an additional way to earn commission from those bookings.",
      "With ChinaFlow Agent Booking, your team can open Trip.com through your ChinaFlow account and search and book hotels as usual. Trip.com continues to provide and fulfill the booking, so you do not need to build hotel inventory, booking, or payment infrastructure. Eligible bookings can be tracked through your own ChinaFlow account and generate commission.",
      "If you also operate an English-language website, China travel guides, destination pages, or itinerary content, ChinaFlow can connect that existing traffic with relevant Trip.com travel products as an additional monetization channel.",
      "In short, one ChinaFlow account can cover both bookings made by your team for clients and bookings generated from your website content.",
      "ChinaFlow now supports online registration and self-service onboarding. You can review how it works and start registering here:",
      "<a href=\"{{trackingUrl}}\">Visit ChinaFlow and start registration</a>",
      "If you have any questions during setup, just reply to this email. You can also reach me on WeChat at 13501112545.",
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
  const status = String(value(COLUMN.status)).trim();
  const sentDate = String(value(COLUMN.sentDate)).trim();

  if (!id) throw new OutreachValidationError(rowNumber, "ID is blank");
  if (!publisher) throw new OutreachValidationError(rowNumber, "Publisher / Website is blank");
  if (!email) throw new OutreachValidationError(rowNumber, "Email is blank");
  if (!EMAIL_PATTERN.test(email)) throw new OutreachValidationError(rowNumber, "Email syntax is invalid");
  if (language !== "ZH" && language !== "EN") throw new OutreachValidationError(rowNumber, "Language must be exactly ZH or EN");
  if (!TRACKING_URL_PATTERN.test(trackingUrl)) throw new OutreachValidationError(rowNumber, "Tracking URL is invalid");
  if (campaign !== CONFIG.campaign) throw new OutreachValidationError(rowNumber, "Campaign is not exact");
  if (status !== "Prepared") throw new OutreachValidationError(rowNumber, "Round 2 Status is not exact Prepared");
  if (sentDate) throw new OutreachValidationError(rowNumber, "Round 2 Sent Date is not blank");

  return Object.freeze({
    id,
    publisher,
    email,
    language,
    trackingUrl,
    campaign,
    status,
    sentDate,
    row: rowNumber,
  });
}

export function isEligible(row) {
  return String(row[COLUMN.campaign] ?? "").trim() === CONFIG.campaign
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