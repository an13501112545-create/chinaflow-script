import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createOutreachAttribution, recordOutreachClick, bindOutreachPublisher } from "../outreach-attribution-service-v0.1.mjs";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir).filter(n => /^(?:000[1-9]|001[0-6])_.*\.sql$/.test(n)).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  t.after(() => sqlite.close());
  const db = { prepare(sql) { return { bind(...v) { const s=sqlite.prepare(sql); return {
    async run(){ return { meta:s.run(...v) }; }, async all(){ return { results:s.all(...v) }; }
  }; } }; } };
  return { sqlite, db };
}

test("create stores only token hash and rejects duplicate prospect campaign", async t => {
  const f=fixture(t);
  const made=await createOutreachAttribution(f.db, "prospect-001", "round2-zh");
  assert.match(made.token, /^[0-9a-f]{64}$/);
  const row=f.sqlite.prepare("SELECT * FROM outreach_attributions").get();
  assert.notEqual(row.token_hash, made.token);
  assert.equal(JSON.stringify(row).includes(made.token), false);
  await assert.rejects(createOutreachAttribution(f.db, "prospect-001", "round2-zh"), /UNIQUE constraint failed/);
});

test("click is fail-closed and increments one attribution row", async t => {
  const f=fixture(t);
  const made=await createOutreachAttribution(f.db, "prospect-002", "round2-zh");
  assert.equal(await recordOutreachClick(f.db, "bad"), null);
  assert.equal(await recordOutreachClick(f.db, "0".repeat(64)), null);
  const one=await recordOutreachClick(f.db, made.token);
  const two=await recordOutreachClick(f.db, made.token);
  assert.equal(one.click_count, 1); assert.equal(two.click_count, 2);
  const row=f.sqlite.prepare("SELECT click_count,first_click_at,last_click_at FROM outreach_attributions").get();
  assert.equal(row.click_count, 2); assert.ok(row.first_click_at); assert.ok(row.last_click_at);
});

test("binding requires real publisher and cannot be rebound", async t => {
  const f=fixture(t);
  const made=await createOutreachAttribution(f.db, "prospect-003", "round2-zh");
  assert.equal(await bindOutreachPublisher(f.db, made.token, "missing"), null);
  const insertPublisher=f.sqlite.prepare("INSERT INTO publishers(publisher_id,slug,display_name) VALUES (?,?,?)");
  insertPublisher.run("p1","p-one","P One"); insertPublisher.run("p2","p-two","P Two");
  const bound=await bindOutreachPublisher(f.db, made.token, "p1");
  assert.equal(bound.publisher_id, "p1"); assert.ok(bound.bound_at);
  assert.equal(await bindOutreachPublisher(f.db, made.token, "p2"), null);
  assert.equal(f.sqlite.prepare("SELECT publisher_id FROM outreach_attributions").get().publisher_id, "p1");
});
