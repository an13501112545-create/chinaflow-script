import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const built = await build({
  entryPoints: [new URL("../app-worker-v0.1.mjs", import.meta.url).pathname],
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
