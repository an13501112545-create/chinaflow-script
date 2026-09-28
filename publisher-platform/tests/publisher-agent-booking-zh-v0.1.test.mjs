import assert from "node:assert/strict";
import test from "node:test";
import { handleAppRequest } from "../app-worker-v0.1.mjs";

const ORIGIN = "https://publishers.getchinaflow.com";

test("Chinese agent booking page is fully server-localized and shares launch API", async () => {
  const response = await handleAppRequest(new Request(ORIGIN + "/zh/agent-booking"), {
    APP_ORIGIN: ORIGIN, AGENT_BOOKING_ENABLED: "true"
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /代客订酒店/);
  assert.match(html, /为客户预订酒店/);
  assert.match(html, /打开 Trip\.com/);
  assert.match(html, /\/api\/agent-booking\/launch\?product=hotel/);
  assert.match(html, /location\.assign\("\/zh\/login"\)/);
  assert.match(html, /当前合作伙伴账户尚未满足代客预订开通条件/);
  assert.match(html, /暂时无法生成预订链接/);
  assert.doesNotMatch(html, /\bzh \?/);
  assert.doesNotMatch(html, /10021103|330739613|Allianceid|trip_sub1/);
});

test("English agent booking page remains English and contains no server locale variable", async () => {
  const response = await handleAppRequest(new Request(ORIGIN + "/agent-booking"), {
    APP_ORIGIN: ORIGIN, AGENT_BOOKING_ENABLED: "true"
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Agent Booking/);
  assert.match(html, /Book hotels for your clients/);
  assert.match(html, /location\.assign\("\/login"\)/);
  assert.doesNotMatch(html, /\bzh \?/);
});
