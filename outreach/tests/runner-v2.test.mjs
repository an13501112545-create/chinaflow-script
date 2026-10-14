import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG,
  ROUND_2_TEMPLATES,
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

test("ZH V3 offers a Trip.com trial booking by reply under agreed commission terms", () => {
  const prospect = selectFirstEligible(sheet(row({ language: "ZH" }))).prospect;
  const payload = buildPayload(prospect);
  assert.equal(payload.subject, "你们平时帮客人订中国酒店吗？");
  assert.ok(payload.body.startsWith("<p>你好，Example &lt;Publisher&gt; 团队，</p>"));
  assert.match(payload.body, /我是 Chris，做 ChinaFlow 的/);
  assert.match(payload.body, /帮海外客人订中国酒店/);
  assert.match(payload.body, /专属 Trip\.com 订房链接.*在 Trip\.com 正常预订/);
  assert.match(payload.body, /不用改网站，不用安装代码，也不用对接 API/);
  assert.match(payload.body, /客人入住离店、Trip\.com 确认有效佣金后，我们按合作约定分佣/);
  assert.match(payload.body, /多一份佣金机会/);
  assert.match(payload.body, /直接回复这封邮件.*我把专属预订入口发给你们.*先试一单/);
  assert.match(payload.body, /Chris \| ChinaFlow \| 微信：13501112545/);
});

test("EN V3 offers a Trip.com trial booking by reply under agreed commission terms", () => {
  const prospect = selectFirstEligible(sheet(row({ language: "EN" }))).prospect;
  const payload = buildPayload(prospect);
  assert.equal(payload.subject, "Do you book hotels in China for your clients?");
  assert.ok(payload.body.startsWith("<p>Hello Example &lt;Publisher&gt; team,</p>"));
  assert.match(payload.body, /I'm Chris from ChinaFlow/);
  assert.match(payload.body, /international travelers book hotels in China/);
  assert.match(payload.body, /dedicated Trip\.com booking link.*book on Trip\.com as usual/);
  assert.match(payload.body, /No website changes, no code to install, and no API integration/);
  assert.match(payload.body, /guest checks out and Trip\.com verifies eligible commissions.*under our agreed terms/);
  assert.match(payload.body, /chance to earn commission/);
  assert.match(payload.body, /just reply to this email.*I'll send your dedicated booking link.*try it with one booking/);
  assert.match(payload.body, /Chris \| ChinaFlow \| WeChat: 13501112545/);
});

for (const language of ["ZH", "EN"]) {
  test(`${language} keeps the tracked information/registration link last and secondary to reply`, () => {
    const prospect = selectFirstEligible(sheet(row({ language }))).prospect;
    const template = ROUND_2_TEMPLATES[language];
    const payload = buildPayload(prospect);
    const linkLabel = language === "ZH" ? "了解 ChinaFlow 合作方式或注册" : "Learn about ChinaFlow or register";
    const reply = language === "ZH" ? "直接回复这封邮件" : "just reply to this email";
    assert.equal(template.paragraphs.at(-1), `<a href="{{trackingUrl}}">${linkLabel}</a>`);
    assert.ok(payload.body.endsWith(`<p><a href="${prospect.trackingUrl}">${linkLabel}</a></p>`));
    assert.equal((payload.body.match(/<a\b/g) ?? []).length, 1);
    assert.ok(payload.body.indexOf(reply) < payload.body.indexOf("<a "));
    assert.equal((payload.body.match(/<p>/g) ?? []).length, template.paragraphs.length);
    assert.equal((payload.body.match(/<\/p>/g) ?? []).length, template.paragraphs.length);
    assert.doesNotMatch(payload.body, /\{\{(?:publisher|trackingUrl)\}\}|https?:\/\/(?:www\.)?getchinaflow\.com/);
    assert.doesNotMatch(payload.body, /\d+(?:\.\d+)?\s*[%％]|百分之|commission on (?:all|every) bookings?|所有订单.*佣金/i);
    assert.doesNotMatch(payload.body, /Website Monetization|website traffic|monetization channel|网站流量|网站内容带来的预订|Agent Booking/i);
    assert.doesNotMatch(payload.body, /Publisher Earnings|earnings.*track|tracked through your.*account|账户追踪|自助开通/i);
  });

  test(`${language} escapes publisher text and tracking URL attributes`, () => {
    const prospect = selectFirstEligible(sheet(row({ language, publisher: `<Team & "Partners" 'Group'>` }))).prospect;
    // Exercise the renderer's escaping directly; URL validation still rejects this suffix.
    const payload = buildPayload({ ...prospect, trackingUrl: `${prospect.trackingUrl}?note=<&>"'` });
    assert.match(payload.body, /&lt;Team &amp; &quot;Partners&quot; &#39;Group&#39;&gt;/);
    assert.ok(payload.body.includes(`href="${prospect.trackingUrl}?note=&lt;&amp;&gt;&quot;&#39;"`));
    assert.doesNotMatch(payload.body, /<Team|\{\{/);
  });
}

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