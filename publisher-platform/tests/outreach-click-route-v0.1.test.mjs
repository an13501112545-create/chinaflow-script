import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createOutreachAttribution } from "../outreach-attribution-service-v0.1.mjs";
import { handleOutreachClickRoute } from "../outreach-click-route-v0.1.mjs";

function fixture(t) {
  const sqlite=new DatabaseSync(":memory:"); sqlite.exec("PRAGMA foreign_keys=ON");
  const dir=new URL("../../collector/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter(n=>/^(?:000[1-9]|001[0-6])_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(f,dir),"utf8"));
  t.after(()=>sqlite.close());
  const db={prepare(sql){return{bind(...v){const s=sqlite.prepare(sql);return{async run(){return{meta:s.run(...v)}},async all(){return{results:s.all(...v)}}}}}}};
  return {sqlite,db};
}

function assertSafeRedirect(r, expectCookie) {
  assert.equal(r.status,302); assert.equal(r.headers.get("Location"),"https://getchinaflow.com/zh/partner/");
  assert.equal(r.headers.get("Cache-Control"),"no-store"); assert.equal(r.headers.get("Referrer-Policy"),"no-referrer");
  assert.equal(r.headers.get("X-Robots-Tag"),"noindex, nofollow");
  assert.equal(Boolean(r.headers.get("Set-Cookie")),expectCookie);
}
test("valid outreach token records click, sets scoped secure cookie, and redirects cleanly", async t=>{
  const f=fixture(t); const made=await createOutreachAttribution(f.db,"prospect-004","round2-zh");
  const r=await handleOutreachClickRoute(new Request(`https://publishers.getchinaflow.com/r/${made.token}`),f.db);
  assertSafeRedirect(r,true); const cookie=r.headers.get("Set-Cookie");
  assert.match(cookie,/^cf_outreach=[0-9a-f]{64};/); assert.match(cookie,/Domain=\.getchinaflow\.com/);
  assert.match(cookie,/Secure/); assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Lax/);
  assert.equal(f.sqlite.prepare("SELECT click_count FROM outreach_attributions").get().click_count,1);
});

test("unknown, malformed, query-bearing, and non-GET routes look identical and do not mutate", async t=>{
  const f=fixture(t); const made=await createOutreachAttribution(f.db,"prospect-005","round2-zh");
  const cases=[
    new Request("https://publishers.getchinaflow.com/r/bad"),
    new Request(`https://publishers.getchinaflow.com/r/${"0".repeat(64)}`),
    new Request(`https://publishers.getchinaflow.com/r/${made.token}?x=1`),
    new Request(`https://publishers.getchinaflow.com/r/${made.token}`,{method:"POST"})
  ];
  for(const req of cases) assertSafeRedirect(await handleOutreachClickRoute(req,f.db),false);
  assert.equal(f.sqlite.prepare("SELECT click_count FROM outreach_attributions").get().click_count,0);
});

test("non outreach path is not claimed", async t=>{
  const f=fixture(t); assert.equal(await handleOutreachClickRoute(new Request("https://publishers.getchinaflow.com/zh/login"),f.db),null);
});
