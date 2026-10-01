import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStagingRow, finalizePreparedRow, planCandidateImport, trackingTokenFromUrl } from "../candidate-importer-v1.mjs";

const header = ["ID","Batch","Priority","Publisher / Website","Website URL","Primary Market","Publisher Type","Strategic Value Score","China Content / Traffic Strength","Commercial Intent Strength","Current Monetization","Contact","Title","Email","LinkedIn / Phone","Owner","Status","First Contact Date","Last Contact Date","Next Follow-up Date","Channel","Reply Summary","Next Action","Pitch / Materials","Notes","Research Source","Outreach Campaign","Tracking URL","Round 2 Status","Round 2 Sent Date","Round 2 Language"];
const token = "a".repeat(64);
const candidate = { publisher:"Example China Travel", websiteUrl:"https://example-china.test/", email:"BD@example-china.test", language:"EN", researchSource:"official website" };

function existing(overrides={}) {
  const row = Array(31).fill("");
  Object.assign(row, { 0:"196", 3:"Existing", 4:"https://existing.test/", 13:"team@existing.test",
    26:"round2-zh-20260928", 27:`https://publishers.getchinaflow.com/r/${"b".repeat(64)}`,
    28:"Prepared", 29:"", 30:"EN" }, overrides);
  return row;
}

test("new candidate gets next ID and unsendable staging row", () => {
  const plan = planCandidateImport({ values:[header, existing()], candidate });
  assert.equal(plan.status, "new");
  assert.equal(plan.prospectId, "197");
  const row = buildStagingRow(plan, token);
  assert.equal(row[13], "bd@example-china.test");
  assert.equal(row[26], "");
  assert.equal(row[28], "Staging");
  assert.equal(row[29], "");
  assert.equal(row[30], "EN");
  assert.equal(trackingTokenFromUrl(row[27]), token);
});

test("duplicate email and hostname fail closed", () => {
  const byEmail = planCandidateImport({ values:[header, existing({13:"bd@example-china.test"})], candidate });
  assert.equal(byEmail.status, "duplicate");
  assert.equal(byEmail.reason, "email");
  const byHost = planCandidateImport({ values:[header, existing({4:"https://www.example-china.test/path"})], candidate });
  assert.equal(byHost.status, "duplicate");
  assert.equal(byHost.reason, "website");
});

test("valid staging row is resumable with same token", () => {
  const row = existing({ 0:"197", 3:candidate.publisher, 4:candidate.websiteUrl, 13:candidate.email.toLowerCase(),
    26:"", 27:`https://publishers.getchinaflow.com/r/${token}`, 28:"Staging", 30:"EN" });
  const plan = planCandidateImport({ values:[header, row], candidate });
  assert.equal(plan.status, "resume");
  assert.equal(plan.prospectId, "197");
  assert.equal(plan.token, token);
});

test("only valid staging row can be promoted to Prepared", () => {
  const plan = planCandidateImport({ values:[header, existing()], candidate });
  const staging = buildStagingRow(plan, token);
  const prepared = finalizePreparedRow(staging);
  assert.equal(prepared[26], "round2-zh-20260928");
  assert.equal(prepared[28], "Prepared");
  assert.equal(prepared[29], "");
  assert.throws(() => finalizePreparedRow(prepared), /not Staging/);
});

test("invalid candidate data fails before any write planning", () => {
  assert.throws(() => planCandidateImport({ values:[header], candidate:{...candidate,email:"bad"} }), /email is invalid/);
  assert.throws(() => planCandidateImport({ values:[header], candidate:{...candidate,language:"FR"} }), /language must be ZH or EN/);
  assert.throws(() => planCandidateImport({ values:[header], candidate:{...candidate,websiteUrl:"javascript:bad"} }), /websiteUrl is invalid/);
});
