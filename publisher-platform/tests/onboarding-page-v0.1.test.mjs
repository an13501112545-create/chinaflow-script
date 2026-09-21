import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../app-worker-v0.1.mjs", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  minify: false,
  loader: { ".md": "text" }
});

const worker = (
  await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
  )
).default;

const env = {
  APP_ORIGIN: "https://publisher.example.test",
  APP_ENVIRONMENT: "test",
  CHINAFLOW_RUNTIME_ORIGIN: "https://runtime.example.test"
};

test("GET /onboarding serves onboarding application shell", async () => {
  const response = await worker.fetch(
    new Request("https://publisher.example.test/onboarding"),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const html = await response.text();

  assert.match(html, /<title>ChinaFlow Publisher Onboarding<\/title>/);
  assert.match(html, /\/api\/auth\/session/);
  assert.match(html, /\/api\/onboarding\/draft/);
  assert.match(html, /\/api\/onboarding\/terms/);
  assert.match(html, /\/legal\/chinaflow-publisher-terms-v1/);
});

test("onboarding page contains create, accept, and installation states", async () => {
  const response = await worker.fetch(
    new Request("https://publisher.example.test/onboarding"),
    env
  );

  const html = await response.text();

  assert.match(html, /display_name/);
  assert.match(html, /hostname/);
  assert.match(html, /chinaflow-publisher-terms-v1/);
  assert.match(html, /data-chinaflow-install/);
  assert.match(html, /https:\/\/runtime\.example\.test/);
  assert.match(html, /\/runtime\/loader\.js/);
});

test("onboarding rejects mutation methods", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await worker.fetch(
      new Request("https://publisher.example.test/onboarding", { method }),
      env
    );

    assert.equal(response.status, 405);
  }
});

test("onboarding runtime origin fails closed when missing", async () => {
  const response = await worker.fetch(
    new Request("https://publisher.example.test/onboarding"),
    {
      APP_ORIGIN: "https://publisher.example.test",
      APP_ENVIRONMENT: "test"
    }
  );

  assert.equal(response.status, 500);
});


async function page(
  t,
  accountStatus = "draft",
  installStatus = "pending",
  verificationStatus = "unverified",
  reviewStatus = "pending"
) {
  const response = await worker.fetch(new Request(env.APP_ORIGIN + "/onboarding"), env);
  const html = await response.text();
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
    const classes = new Set((match[0].match(/class="([^"]+)"/)?.[1] ?? "").split(" "));
    const handlers = {};
    elements.set(match[1], { textContent: "", disabled: false,
      classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
      classes, addEventListener: (event, fn) => { handlers[event] = fn; },
      click: () => handlers.click?.()
    });
  }
  const document = { getElementById: id => elements.get(id) };
  const calls = [];
  let verifyDetected = true;
  let submitStatus = 200;
  const fetch = async (url, options) => {
    calls.push({ url, options });
    let body = {};
    let status = 200;
    if (url.endsWith("/draft")) body = { draft: {
      publisher: { account_status: accountStatus, install_public_key: "cfi_0123456789abcdef0123456789abcdef" },
      primary_domain: {
        install_status: installStatus,
        verification_status: verificationStatus,
        review_status: reviewStatus,
        monetization_status: "disabled",
        reviewed_at: reviewStatus === "pending" ? null : "2026-09-21 00:00:00"
      }
    } };
    if (url.endsWith("/terms")) body = { terms: { terms_version: "chinaflow-publisher-terms-v1", accepted: true } };
    if (url.endsWith("/verify-install")) body = { verification: {
      detected: verifyDetected, install_status: verifyDetected ? "detected" : "not_detected",
      verification_status: verifyDetected ? "verified" : "unverified"
    } };
    if (url.endsWith("/submit")) {
      status = submitStatus;
      body = status === 200 ? { submission: { account_status: "pending_review", submitted: true } } : { error: "conflict" };
    }
    return new Response(JSON.stringify(body), { status });
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, fetch, location: { assign() { assert.fail("Unexpected login redirect"); } }, navigator: {}
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const element = id => elements.get(id);
  const visible = id => {
    const el = element(id);
    const inInstall = ["verify-button", "submit-button", "snippet", "copy-button"].includes(id);
    return !!el && !el.classes.has("hidden") && (!inInstall || !element("install").classes.has("hidden"));
  };
  return { calls, element, visible, settle,
    failVerify() { verifyDetected = false; }, failSubmit() { submitStatus = 409; } };
}

test("onboarding verifies then submits without client tenant selectors", async t => {
  const p = await page(t);
  assert.equal(p.visible("verify-button"), true);
  assert.equal(p.visible("submit-button"), false);
  p.element("verify-button").click();
  await p.settle();
  assert.equal(p.visible("submit-button"), true);
  p.element("submit-button").click();
  await p.settle();
  assert.equal(p.visible("submitted"), true);
  assert.equal(p.visible("create"), false);
  assert.equal(p.visible("install"), false);
  for (const path of ["/verify-install", "/submit"]) {
    const call = p.calls.find(c => c.url.endsWith(path));
    assert.deepEqual(JSON.parse(JSON.stringify(call.options)), { method: "POST" });
  }
});

test("pending review refresh shows stable submitted state without loading draft-only terms", async t => {
  const p = await page(t, "pending_review");
  assert.equal(p.visible("submitted"), true);
  assert.match(p.element("submission-status").textContent, /pending review/i);
  for (const id of ["create", "terms", "install"]) assert.equal(p.visible(id), false);
  assert.equal(p.calls.some(c => c.url.endsWith("/terms")), false);
});

test("approved review refresh shows provisioning state", async t => {
  const p = await page(
    t,
    "pending_review",
    "detected",
    "verified",
    "approved"
  );
  assert.equal(p.visible("submitted"), true);
  assert.match(p.element("submission-heading").textContent, /review approved/i);
  assert.match(p.element("submission-status").textContent, /provisioning/i);
  for (const id of ["create", "terms", "install"]) assert.equal(p.visible(id), false);
  assert.equal(p.calls.some(c => c.url.endsWith("/terms")), false);
});

test("rejected review refresh never falls back to create publisher", async t => {
  const p = await page(
    t,
    "rejected",
    "detected",
    "verified",
    "rejected"
  );
  assert.equal(p.visible("submitted"), true);
  assert.match(p.element("submission-heading").textContent, /not approved/i);
  assert.equal(p.visible("create"), false);
  assert.equal(p.calls.some(c => c.url.endsWith("/terms")), false);
});

test("failed verification remains retryable and does not reveal submit", async t => {
  const p = await page(t);
  p.failVerify();
  p.element("verify-button").click();
  await p.settle();
  assert.equal(p.visible("submit-button"), false);
  assert.equal(p.element("verify-button").disabled, false);
});

test("server-observed verified draft enables submit; conflict never shows submitted", async t => {
  const p = await page(t, "draft", "detected", "verified");
  assert.equal(p.visible("submit-button"), true);
  p.failSubmit();
  p.element("submit-button").click();
  await p.settle();
  assert.equal(p.visible("submitted"), false);
  assert.equal(p.element("submit-button").disabled, false);
});
