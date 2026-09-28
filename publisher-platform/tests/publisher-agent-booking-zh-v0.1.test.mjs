import assert from "node:assert/strict";
import test from "node:test";
import { handleAppRequest } from "../app-worker-v0.1.mjs";

const ORIGIN = "https://publishers.getchinaflow.com";

test("Chinese agent booking page is localized and shares the same launch API", async () => {
  const response = await handleAppRequest(
    new Request(ORIGIN + "/zh/agent-booking"),
    { APP_ORIGIN: ORIGIN, AGENT_BOOKING_ENABLED: "true" }
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /代客订酒店/);
  assert.match(html, /为客户预订酒店/);
  assert.match(html, /打开 Trip\.com/);
  assert.match(html, /\/api\/agent-booking\/launch\?product=hotel/);
  assert.match(html, /location\.assign\(zh \? "\/zh\/login" : "\/login"\)/);
  assert.match(html, /此合作伙伴账户尚未开通代客预订功能/);
  assert.doesNotMatch(html, /10021103|330739613|Allianceid|trip_sub1/);
});

test("English agent booking page remains English", async () => {
  const response = await handleAppRequest(
    new Request(ORIGIN + "/agent-booking"),
    { APP_ORIGIN: ORIGIN, AGENT_BOOKING_ENABLED: "true" }
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Agent Booking/);
  assert.match(html, /Book hotels for your clients/);
});
