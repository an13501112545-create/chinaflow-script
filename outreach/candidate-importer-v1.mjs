import { CONFIG } from "./runner-v2.mjs";

export const STAGING_STATUS = "Staging";
const TRACKING_PREFIX = "https://publishers.getchinaflow.com/r/";
const TOKEN_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED_HEADERS = Object.freeze({
  0: "ID", 3: "Publisher / Website", 4: "Website URL", 13: "Email",
  26: "Outreach Campaign", 27: "Tracking URL", 28: "Round 2 Status",
  29: "Round 2 Sent Date", 30: "Round 2 Language",
});

function text(value, max = 512) {
  const out = String(value ?? "").trim();
  if (out.length > max) throw new Error("candidate field too long");
  return out;
}

function host(value) {
  let url;
  try { url = new URL(text(value, 2048)); }
  catch { throw new Error("websiteUrl is invalid"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("websiteUrl is invalid");
  }
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

export function normalizeCandidate(input) {
  if (!input || typeof input !== "object") throw new Error("candidate is required");
  const publisher = text(input.publisher, 200);
  const websiteUrl = text(input.websiteUrl, 2048);
  const email = text(input.email, 320).toLowerCase();
  const language = text(input.language, 2).toUpperCase();
  if (!publisher) throw new Error("publisher is required");
  if (!EMAIL_RE.test(email)) throw new Error("email is invalid");
  if (!websiteUrl) throw new Error("websiteUrl is required");
  host(websiteUrl);
  if (!new Set(["ZH", "EN"]).has(language)) throw new Error("language must be ZH or EN");
  return Object.freeze({
    publisher, websiteUrl, email, language,
    batch: text(input.batch || "Auto Sourcing", 100),
    priority: text(input.priority || "P1", 20),
    primaryMarket: text(input.primaryMarket || "Global inbound China", 120),
    publisherType: text(input.publisherType || "China inbound travel publisher", 160),
    strategicValueScore: text(input.strategicValueScore || "", 20),
    chinaStrength: text(input.chinaStrength || "", 80),
    commercialIntent: text(input.commercialIntent || "", 80),
    currentMonetization: text(input.currentMonetization || "", 200),
    contact: text(input.contact || "", 120),
    title: text(input.title || "", 120),
    linkedInPhone: text(input.linkedInPhone || "", 200),
    owner: text(input.owner || "Chris An", 120),
    pipelineStatus: text(input.pipelineStatus || "Research Complete", 80),
    notes: text(input.notes || "", 500),
    researchSource: text(input.researchSource || "", 500),
  });
}

function assertSheet(values) {
  if (!Array.isArray(values) || values.length < 1) throw new Error("Sales Pipeline has no header row");
  for (const [index, expected] of Object.entries(REQUIRED_HEADERS)) {
    if (values[0]?.[Number(index)] !== expected) throw new Error(`header mismatch at column ${Number(index) + 1}`);
  }
}

export function trackingTokenFromUrl(value) {
  const raw = text(value, 2048);
  if (!raw.startsWith(TRACKING_PREFIX)) return null;
  const token = raw.slice(TRACKING_PREFIX.length);
  return TOKEN_RE.test(token) ? token : null;
}

export function planCandidateImport({ values, candidate, campaign = CONFIG.campaign }) {
  assertSheet(values);
  if (campaign !== CONFIG.campaign) throw new Error("campaign is not exact");
  const normalized = normalizeCandidate(candidate);
  const targetHost = host(normalized.websiteUrl);
  const rows = values.slice(1);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const emailMatch = String(row[13] ?? "").trim().toLowerCase() === normalized.email;
    let hostMatch = false;
    try { hostMatch = host(row[4]) === targetHost; } catch {}
    if (!emailMatch && !hostMatch) continue;
    const token = trackingTokenFromUrl(row[27]);
    if (String(row[26] ?? "").trim() === "" && String(row[28] ?? "").trim() === STAGING_STATUS &&
        String(row[29] ?? "").trim() === "" && token) {
      return Object.freeze({ status: "resume", prospectId: String(row[0]).trim(), sheetRow: i + 2,
        campaign, candidate: normalized, token, row: [...row] });
    }
    return Object.freeze({ status: "duplicate", reason: emailMatch ? "email" : "website",
      existingProspectId: String(row[0] ?? "").trim(), sheetRow: i + 2 });
  }
  const ids = rows.map(r => Number.parseInt(String(r[0] ?? ""), 10)).filter(Number.isFinite);
  return Object.freeze({ status: "new", prospectId: String((ids.length ? Math.max(...ids) : 0) + 1),
    sheetRow: values.length + 1, campaign, candidate: normalized });
}

export function buildStagingRow(plan, token) {
  if (plan?.status !== "new") throw new Error("new plan required");
  if (!TOKEN_RE.test(String(token ?? ""))) throw new Error("tracking token is invalid");
  const c = plan.candidate;
  const row = Array(31).fill("");
  row[0]=plan.prospectId; row[1]=c.batch; row[2]=c.priority; row[3]=c.publisher; row[4]=c.websiteUrl;
  row[5]=c.primaryMarket; row[6]=c.publisherType; row[7]=c.strategicValueScore; row[8]=c.chinaStrength;
  row[9]=c.commercialIntent; row[10]=c.currentMonetization; row[11]=c.contact; row[12]=c.title;
  row[13]=c.email; row[14]=c.linkedInPhone; row[15]=c.owner; row[16]=c.pipelineStatus; row[20]="Email";
  row[24]=c.notes; row[25]=c.researchSource; row[26]=""; row[27]=TRACKING_PREFIX+token;
  row[28]=STAGING_STATUS; row[29]=""; row[30]=c.language;
  return row;
}

export function finalizePreparedRow(row, campaign = CONFIG.campaign) {
  if (!Array.isArray(row) || row.length < 31) throw new Error("staging row is invalid");
  if (campaign !== CONFIG.campaign) throw new Error("campaign is not exact");
  if (String(row[28] ?? "").trim() !== STAGING_STATUS) throw new Error("row is not Staging");
  if (String(row[26] ?? "").trim() !== "") throw new Error("staging campaign must be blank");
  if (String(row[29] ?? "").trim() !== "") throw new Error("staging sent date must be blank");
  if (!trackingTokenFromUrl(row[27])) throw new Error("staging tracking URL is invalid");
  if (!["ZH", "EN"].includes(String(row[30] ?? "").trim())) throw new Error("staging language is invalid");
  const out = [...row]; out[26] = campaign; out[28] = "Prepared"; return out;
}
