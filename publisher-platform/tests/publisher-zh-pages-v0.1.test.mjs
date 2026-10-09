import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../app-worker-v0.1.mjs", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser", minify: false,
  loader: { ".md": "text" }
});
const worker = (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`)).default;
const env = {
  APP_ORIGIN: "https://publisher.example.test",
  APP_ENVIRONMENT: "test",
  CHINAFLOW_AUTH_ORIGIN: "https://auth.example.test",
  CHINAFLOW_RUNTIME_ORIGIN: "https://runtime.example.test"
};

test("GET /zh/login serves Chinese login without changing English login", async () => {
  const zh = await worker.fetch(new Request(env.APP_ORIGIN + "/zh/login"), env);
  assert.equal(zh.status, 200);
  const html = await zh.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /登录 ChinaFlow/);
  assert.match(html, /邮箱地址/);
  assert.match(html, /发送登录链接/);
  assert.match(html, /正在发送登录链接/);
  assert.match(html, /请检查邮箱中的 ChinaFlow 安全登录链接/);
  assert.match(html, /IS_ZH \? "\/zh\/start" : "\/start"/);

  const en = await worker.fetch(new Request(env.APP_ORIGIN + "/login"), env);
  assert.equal(en.status, 200);
  assert.match(await en.text(), /<html lang="en">/);
});

test("GET /zh/onboarding serves Chinese onboarding using shared APIs", async () => {
  const response = await worker.fetch(new Request(env.APP_ORIGIN + "/zh/onboarding"), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /设置 ChinaFlow/);
  assert.match(html, /创建发布商资料/);
  assert.match(html, /接受条款/);
  assert.match(html, /请阅读/);
  assert.match(html, /ChinaFlow 发布商计划条款/);
  assert.doesNotMatch(html, /Review the/);
  assert.match(html, /安装代码/);
  assert.match(html, /验证安装/);
  assert.match(html, /提交审核/);
  assert.match(html, /安装验证成功/);
  assert.match(html, /已提交审核/);
  assert.match(html, /ChinaFlow 已启用/);
  assert.match(html, /\/api\/onboarding\/draft/);
  assert.match(html, /\/api\/onboarding\/terms/);
  assert.match(html, /IS_ZH \? "\/zh\/login" : "\/login"/);
});
