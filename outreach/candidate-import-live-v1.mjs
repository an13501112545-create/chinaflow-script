import { buildStagingRow, finalizePreparedRow, planCandidateImport } from "./candidate-importer-v1.mjs";
import { CONFIG, validateProspect } from "./runner-v2.mjs";

function assertExactRow(actual, expected) {
  if (!Array.isArray(actual)) throw new Error("Sheet readback missing");
  for (let i = 0; i < 31; i += 1) {
    const actualText = String(actual[i] ?? "");
    const expectedText = String(expected[i] ?? "");
    if (i === 7 && actualText !== "" && expectedText !== "") {
      const actualNumber = Number(actualText);
      const expectedNumber = Number(expectedText);
      if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) && actualNumber === expectedNumber) continue;
    }
    if (actualText !== expectedText) {
      throw new Error(`Sheet readback mismatch at column ${i + 1}`);
    }
  }
}

export async function runCandidateImport({ candidate, live = false, env = process.env, dependencies }) {
  if (!dependencies) throw new Error("dependencies are required");
  const values = await dependencies.readPipelineValues();
  const plan = planCandidateImport({ values, candidate, campaign: CONFIG.campaign });
  if (plan.status === "duplicate") return { status:"duplicate", reason:plan.reason, existingProspectId:plan.existingProspectId, sheetRow:plan.sheetRow, writes:0 };
  if (!live) return { status:"dry_run", mode:plan.status, prospectId:plan.prospectId, sheetRow:plan.sheetRow, campaign:CONFIG.campaign, writes:0 };
  if (env.CHINAFLOW_CANDIDATE_IMPORT_LIVE !== "YES") return { status:"blocked", reason:"LIVE_IMPORT_DISABLED", writes:0 };

  let token, stagingRow, sheetRow;
  let writes = 0;
  if (plan.status === "resume") {
    token = plan.token; stagingRow = [...plan.row]; sheetRow = plan.sheetRow;
  } else {
    token = dependencies.generateToken();
    stagingRow = buildStagingRow(plan, token);
    const appended = await dependencies.appendStagingRow(stagingRow);
    writes += 1;
    sheetRow = appended?.sheetRow;
    if (!Number.isInteger(sheetRow) || sheetRow < 2) throw new Error("append row invalid");
    assertExactRow(await dependencies.readSheetRow(sheetRow), stagingRow);
  }

  const tokenHash = await dependencies.hashToken(token);
  await dependencies.ensureAttribution({ prospectId:plan.prospectId, campaign:CONFIG.campaign, tokenHash });
  writes += 1;
  const attribution = await dependencies.readAttribution({ prospectId:plan.prospectId, campaign:CONFIG.campaign });
  if (!attribution || attribution.token_hash !== tokenHash) throw new Error("D1 attribution readback mismatch");

  const prepared = finalizePreparedRow(stagingRow, CONFIG.campaign);
  await dependencies.finalizePreparedRow(sheetRow, prepared);
  writes += 1;
  const finalRow = await dependencies.readSheetRow(sheetRow);
  assertExactRow(finalRow, prepared);
  validateProspect(finalRow, sheetRow);
  return { status:"prepared", prospectId:plan.prospectId, sheetRow, writes, resumed:plan.status === "resume" };
}
