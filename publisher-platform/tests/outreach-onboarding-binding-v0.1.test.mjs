import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSession } from "../auth-session-store-v0.1.mjs";
import { createOnboardingDraft } from "../onboarding-draft-v0.1.mjs";
import { createOutreachAttribution } from "../outreach-attribution-service-v0.1.mjs";
import { readOutreachCookie } from "../outreach-cookie-v0.1.mjs";

async function fixture(t) {
  const sqlite=new DatabaseSync(":memory:"); sqlite.exec("PRAGMA foreign_keys=ON");
  const dir=new URL("../../collector/migrations/",import.meta.url);
  for(const f of readdirSync(dir).filter(n=>/^(?:000[1-9]|001[0-6])_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(f,dir),"utf8"));
  t.after(()=>sqlite.close());
  const db={prepare(sql){return{bind(...v){const s=sqlite.prepare(sql);return{async first(){return s.get(...v)??null},async all(){return{results:s.all(...v)}},async run(){return{meta:s.run(...v)}},execute(){const results=s.all(...v);return{results,meta:{changes:sqlite.prepare("SELECT changes() AS n").get().n}}}}}}},async batch(ss){sqlite.exec("BEGIN IMMEDIATE");try{const r=ss.map(s=>s.execute());sqlite.exec("COMMIT");return r}catch(e){sqlite.exec("ROLLBACK");throw e}}};
  sqlite.prepare("INSERT INTO publisher_users(user_id,email,email_normalized) VALUES(?,?,?)").run("u1","one@example.com","one@example.com");
  const session=await createSession(db,"u1"); return {sqlite,db,session};
}
test("valid outreach cookie binds atomically to newly created publisher",async t=>{
  const f=await fixture(t); const a=await createOutreachAttribution(f.db,"prospect-006","round2-zh");
  const token=readOutreachCookie(`other=x; cf_outreach=${a.token}; x=y`); assert.equal(token,a.token);
  const result=await createOnboardingDraft(f.db,f.session.token,{display_name:"Tracked",hostname:"tracked.example.com"},token);
  assert.equal(result.status,201); const row=f.sqlite.prepare("SELECT publisher_id,bound_at FROM outreach_attributions").get();
  assert.equal(row.publisher_id,result.body.draft.publisher.publisher_id); assert.ok(row.bound_at);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(),[]);
});

test("malformed or unknown outreach token never blocks normal publisher creation",async t=>{
  const f=await fixture(t); assert.equal(readOutreachCookie("cf_outreach=bad"),null);
  const unknown="0".repeat(64);
  const result=await createOnboardingDraft(f.db,f.session.token,{display_name:"Untracked",hostname:"untracked.example.com"},unknown);
  assert.equal(result.status,201); assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM publishers").get().n,1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM outreach_attributions").get().n,0);
});
