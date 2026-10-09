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

test("partner home offers independent hotel booking and website setup paths", async () => {
  for (const [route,lang,agent,website] of [
    ["/start","en","/agent-booking","/onboarding"],
    ["/zh/start","zh-CN","/zh/agent-booking","/zh/onboarding"]
  ]) {
    const response = await worker.fetch(new Request(env.APP_ORIGIN+route), env);
    assert.equal(response.status,200);
    const html = await response.text();
    assert.match(html,new RegExp('<html lang="'+lang+'">'));
    assert.ok(html.includes('href="'+agent+'"'));
    assert.ok(html.includes('href="'+website+'"'));
    assert.match(html,/\/api\/auth\/session/);
    assert.match(html,/session\.status === 401/);
    assert.match(html,/choices\.classList|document\.getElementById\("choices"\)/);
    assert.doesNotMatch(html,/data-chinaflow-install=/);
    const wrongMethod = await worker.fetch(new Request(env.APP_ORIGIN+route,{method:"POST"}),env);
    assert.equal(wrongMethod.status,405);
    assert.equal(wrongMethod.headers.get("Allow"),"GET");
  }
});

test("login sends successful and existing sessions to partner home",async ()=>{
  for (const [route,redirect] of [["/login","/start"],["/zh/login","/zh/start"]]){
    const response=await worker.fetch(new Request(env.APP_ORIGIN+route),env);
    assert.equal(response.status,200);
    const html=await response.text();
    assert.ok(html.includes('location.assign(IS_ZH ? "/zh/start" : "/start")'));
    assert.ok(html.includes('"/api/auth/consume"'));
    assert.ok(html.includes('"/api/auth/session"'));
  }
});

test("old website onboarding keeps installation and provides agent booking escape",async ()=>{
  for (const [route,agent] of [["/onboarding","/agent-booking"],["/zh/onboarding","/zh/agent-booking"]]){
    const response=await worker.fetch(new Request(env.APP_ORIGIN+route),env);
    assert.equal(response.status,200);
    const html=await response.text();
    assert.ok(html.includes('href="'+agent+'"'));
    assert.match(html,/data-chinaflow-install/);
    assert.match(html,/\/api\/onboarding\/verify-install/);
    assert.match(html,/\/api\/onboarding\/submit/);
  }
});
