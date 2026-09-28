import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

function dbWithMigrations(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|001[0-6])_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 16);
  for (const file of files) db.exec(readFileSync(new URL(file, dir), "utf8"));
  t.after(() => db.close());
  return db;
}

test("0016 stores non-PII prospect attribution before publisher binding", t => {
  const db = dbWithMigrations(t);
  db.exec(`INSERT INTO outreach_attributions
    (attribution_id,token_hash,pipeline_prospect_id,campaign)
    VALUES ('oa1','hash1','prospect-001','round2-zh')`);
  assert.deepEqual({ ...db.prepare(`SELECT pipeline_prospect_id,campaign,click_count,publisher_id,bound_at
    FROM outreach_attributions WHERE attribution_id='oa1'`).get() }, {
    pipeline_prospect_id: "prospect-001", campaign: "round2-zh", click_count: 0,
    publisher_id: null, bound_at: null
  });
});

test("0016 enforces unique token and prospect/campaign", t => {
  const db = dbWithMigrations(t);
  db.exec(`INSERT INTO outreach_attributions
    (attribution_id,token_hash,pipeline_prospect_id,campaign)
    VALUES ('oa1','hash1','prospect-001','round2-zh')`);
  assert.throws(() => db.exec(`INSERT INTO outreach_attributions
    (attribution_id,token_hash,pipeline_prospect_id,campaign)
    VALUES ('oa2','hash1','prospect-002','round2-zh')`), /UNIQUE constraint failed/);
  assert.throws(() => db.exec(`INSERT INTO outreach_attributions
    (attribution_id,token_hash,pipeline_prospect_id,campaign)
    VALUES ('oa3','hash3','prospect-001','round2-zh')`), /UNIQUE constraint failed/);
});

test("0016 binding requires a real publisher and bound_at", t => {
  const db = dbWithMigrations(t);
  db.exec(`INSERT INTO outreach_attributions
    (attribution_id,token_hash,pipeline_prospect_id,campaign)
    VALUES ('oa1','hash1','prospect-001','round2-zh')`);
  assert.throws(() => db.exec(`UPDATE outreach_attributions SET publisher_id='missing',bound_at='2026-09-28T00:00:00Z' WHERE attribution_id='oa1'`), /FOREIGN KEY constraint failed/);
  db.exec(`INSERT INTO publishers(publisher_id,slug,display_name) VALUES ('p1','p-one','P One')`);
  assert.throws(() => db.exec(`UPDATE outreach_attributions SET publisher_id='p1' WHERE attribution_id='oa1'`), /CHECK constraint failed/);
  db.exec(`UPDATE outreach_attributions SET publisher_id='p1',bound_at='2026-09-28T00:00:00Z' WHERE attribution_id='oa1'`);
  assert.equal(db.prepare(`SELECT publisher_id FROM outreach_attributions WHERE attribution_id='oa1'`).get().publisher_id, 'p1');
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
