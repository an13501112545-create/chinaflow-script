import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

const forbiddenEnv = new Proxy({}, {
  get() {
    assert.fail("public legal page touched env/D1");
  }
});

const LEGAL_URL = "https://publisher.example.test/legal/chinaflow-publisher-terms-v1";

test("versioned legal page is public HTML sourced from authoritative terms", async () => {
  const response = await worker.fetch(new Request(LEGAL_URL), forbiddenEnv);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable"
  );

  const csp = response.headers.get("Content-Security-Policy");
  assert.ok(csp);
  assert.ok(!csp.includes("script-src"));
  assert.ok(!csp.includes("connect-src"));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);

  const html = await response.text();

  assert.match(html, /<title>ChinaFlow Publisher Program Terms<\/title>/);
  assert.match(html, /<h1>ChinaFlow Publisher Program Terms<\/h1>/);
  assert.match(html, /<h2>English Terms<\/h2>/);
  assert.match(html, /<h2>中文条款<\/h2>/);
  assert.match(html, /OMACAR PTE\. LTD\./);

  assert.ok(!html.includes("source_note:"));
  assert.ok(!html.includes("Reconstructed authoritative source candidate"));
});

test("versioned legal page rejects mutation methods without env/D1", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await worker.fetch(new Request(LEGAL_URL, { method }), forbiddenEnv);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
});

test("HEAD legal page has same public headers and no body", async () => {
  const get = await worker.fetch(new Request(LEGAL_URL), forbiddenEnv);
  const head = await worker.fetch(new Request(LEGAL_URL, { method: "HEAD" }), forbiddenEnv);

  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Type"), get.headers.get("Content-Type"));
  assert.equal(head.headers.get("Cache-Control"), get.headers.get("Cache-Control"));
  assert.equal(await head.text(), "");
});

test("query string cannot select another legal document", async () => {
  const response = await worker.fetch(
    new Request(`${LEGAL_URL}?file=other.md&version=v2`),
    forbiddenEnv
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ChinaFlow Publisher Program Terms/);
  assert.ok(!html.includes("other.md"));
});


test("actual Wrangler packaging and isolated workerd legal acceptance", async t => {
  const root = new URL("../../", import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), "chinaflow-legal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  execFileSync(
    new URL("node_modules/.bin/wrangler", root).pathname,
    [
      "deploy",
      "--dry-run",
      "--config",
      "wrangler.publisher-app.test.jsonc",
      "--outdir",
      directory
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: "pipe"
    }
  );

  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");

  const options = {
    modules: true,
    script: readFileSync(join(directory, "app-worker-v0.1.js"), "utf8"),
    compatibilityDate: "2026-08-14",
    cf: false,
    telemetry: { enabled: false }
  };

  const mf = new Miniflare(
    convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options
  );

  t.after(() => mf.dispose());

  const get = await mf.dispatchFetch(LEGAL_URL);
  const body = await get.text();

  assert.equal(get.status, 200);
  assert.equal(get.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.match(body, /<h1>ChinaFlow Publisher Program Terms<\/h1>/);
  assert.match(body, /<h2>English Terms<\/h2>/);
  assert.match(body, /<h2>中文条款<\/h2>/);
  assert.ok(!body.includes("source_note:"));
  assert.ok(!body.includes("Reconstructed authoritative source candidate"));

  const head = await mf.dispatchFetch(LEGAL_URL, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const post = await mf.dispatchFetch(LEGAL_URL, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
});
