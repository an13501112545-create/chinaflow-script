import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG,
  buildPayload,
  canSend,
  escapeHtml,
  formatDryRunReport,
  isProviderStop,
  reconciliationDecision,
  resendDecision,
  scheduleNext,
  selectFirstEligible,
} from "../runner-v2.mjs";

const header = [
  "ID", "B", "C", "Publisher / Website", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "Email", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "Outreach Campaign", "Tracking URL", "Round 2 Status", "Round 2 Sent Date", "Round 2 Language",
];

function row({
  id = "prospect-1",
  publisher = "Example <Publisher>",
  email = "owner@example.com",
  primaryStatus = "",
  campaign = CONFIG.campaign,
  trackingUrl = `https://publishers.getchinaflow.com/r/${"a".repeat(64)}`,
  status = "Prepared",
  sentDate = "",
  language = "ZH",
} = {}) {
  const values = Array(31).fill("");
  values[0] = id;
  values[3] = publisher;
  values[13] = email;
  values[16] = primaryStatus;
  values[26] = campaign;
  values[27] = trackingUrl;
  values[28] = status;
  values[29] = sentDate;
  values[30] = language;
  return values;
}

function sheet(...rows) {
  return [header, ...rows];
}

test("selects the first eligible prospect in stable sheet order only", () => {
  const result = selectFirstEligible(sheet(
    row({ id: "not-prepared", status: "Draft" }),
    row({ id: "first" }),
    row({ id: "second" }),
  ));
  assert.equal(result.total, 2);
  assert.equal(result.prospect.id, "first");
  assert.equal(result.prospect.row, 3);
});

test("Prepared requires blank sent date and exact campaign", () => {
  assert.equal(selectFirstEligible(sheet(row({ sentDate: "2026-09-29" }))).total, 0);
  assert.equal(selectFirstEligible(sheet(row({ campaign: "other" }))).total, 0);
});

test("permanent delivery failures are never eligible even when Prepared", () => {
  assert.equal(selectFirstEligible(sheet(row({ primaryStatus: "Invalid Email" }))).total, 0);
  assert.equal(selectFirstEligible(sheet(row({ primaryStatus: "Delivery Failed" }))).total, 0);
  assert.equal(selectFirstEligible(sheet(row({ primaryStatus: "Contacted" }))).total, 1);
});

test("invalid first eligible row fails closed instead of skipping", () => {
  assert.throws(
    () => selectFirstEligible(sheet(row({ email: "bad" }), row({ id: "later" }))),
    /Email syntax is invalid/,
  );
});

test("rejects invalid language and tracking URL variants", () => {
  assert.throws(() => selectFirstEligible(sheet(row({ language: "zh" }))), /Language/);
  assert.throws(() => selectFirstEligible(sheet(row({ trackingUrl: "https://publishers.getchinaflow.com/r/" + "A".repeat(64) }))), /Tracking URL/);
  assert.throws(() => selectFirstEligible(sheet(row({ trackingUrl: "https://publishers.getchinaflow.com/r/" + "a".repeat(63) }))), /Tracking URL/);
});

test("builds escaped HTML payload without signature text", () => {
  const prospect = selectFirstEligible(sheet(row({ language: "EN" }))).prospect;
  const payload = buildPayload(prospect);
  assert.match(payload.body, /Example &lt;Publisher&gt;/);
  assert.match(payload.body, /href="https:\/\/publishers\.getchinaflow\.com\/r\/[a-f0-9]{64}"/);
  assert.match(payload.body, /If you have any questions during setup/);
  assert.doesNotMatch(payload.body, /Founder, ChinaFlow/);
});

test("schedule interval is inclusive and constrained", () => {
  assert.equal(scheduleNext(new Date("2026-09-29T00:00:00Z"), () => 6).interval, 6);
  assert.equal(scheduleNext(new Date("2026-09-29T00:00:00Z"), () => 12).interval, 12);
  const schedule = scheduleNext(new Date("2026-09-29T00:00:00Z"), () => 9);
  assert.equal(schedule.nextSendAt.toISOString(), "2026-09-29T00:09:00.000Z");
});

test("rate caps count durable confirmed records only", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const records = Array.from({ length: 8 }, (_, index) => ({
    send_state: "sent_confirmed",
    mailopoly_accepted_at: new Date(now.getTime() - index * 60_000).toISOString(),
  }));
  records.push({ send_state: "ambiguous", mailopoly_accepted_at: now.toISOString() });
  assert.deepEqual(canSend(records, now), { sentLast60Minutes: 8, sentToday: 8, allowed: false });
  assert.equal(canSend([], now).allowed, true);
});

test("send_started, ambiguous, and confirmed records block resend", () => {
  for (const state of ["send_started", "ambiguous", "sent_confirmed", "sheet_synced"]) {
    assert.equal(resendDecision({ send_state: state }).allowed, false);
  }
  assert.equal(resendDecision({ send_state: "failed" }).allowed, true);
});

test("reconciliation only permits retry on a confirmed absence", () => {
  assert.deepEqual(reconciliationDecision("found"), { state: "sent_confirmed", retryAllowed: false });
  assert.deepEqual(reconciliationDecision("not_found"), { state: "failed", retryAllowed: true });
  assert.deepEqual(reconciliationDecision("unknown"), { state: "ambiguous", retryAllowed: false });
});

test("provider quota, auth, and availability failures stop the runner", () => {
  assert.equal(isProviderStop({ status: 429 }), true);
  assert.equal(isProviderStop({ status: 401 }), true);
  assert.equal(isProviderStop(new Error("subscription limit reached")), true);
  assert.equal(isProviderStop(new Error("ordinary recipient rejection")), false);
});

test("dry-run report redacts tracking URL and has one prospect", () => {
  const selection = selectFirstEligible(sheet(row()));
  const report = formatDryRunReport(selection, buildPayload(selection.prospect), scheduleNext(new Date(), () => 8));
  assert.match(report, /TRACKING_URL_VALID=YES/);
  assert.doesNotMatch(report, /publishers\.getchinaflow\.com\/r\//);
  assert.doesNotMatch(report, /private_key|access_token|Bearer/);
  assert.match(report, /CONCURRENCY=1/);
});

test("HTML escaping remains deterministic", () => {
  assert.equal(escapeHtml("<&>\"'"), "&lt;&amp;&gt;&quot;&#39;");
});