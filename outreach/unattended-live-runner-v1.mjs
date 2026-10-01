import { runControlledLiveSend } from "./controlled-live-v1.mjs";
import { createProductionAdapters } from "./production-adapters-v1.mjs";
import { CONFIG, canSend, scheduleNext, selectFirstEligible } from "./runner-v2.mjs";

export async function runUnattendedLiveCycle({
  liveEnabled = false,
  dependencies,
  controlledSend = runControlledLiveSend,
  randomInt,
  now = new Date(),
  env = process.env,
} = {}) {
  const baseAdapters = dependencies ?? createProductionAdapters({ env });
  const values = await baseAdapters.readPipelineValues();
  const selection = selectFirstEligible(values);
  const ledger = await baseAdapters.readLedger();
  const rate = canSend(ledger.records, now);
  const schedule = scheduleNext(now, randomInt);

  if (!selection.prospect) return { status: "idle", eligibleCount: 0, rate, schedule, sends: 0, writes: 0 };
  const prospect = selection.prospect;
  if (!rate.allowed) return { status: "rate_blocked", eligibleCount: selection.total, prospectId: prospect.id, rate, schedule, sends: 0, writes: 0 };
  if (!liveEnabled) return { status: "live_disabled", eligibleCount: selection.total, prospectId: prospect.id, language: prospect.language, rate, schedule, sends: 0, writes: 0 };

  const adapters = dependencies ?? createProductionAdapters({
    env: { ...env, REAL_SEND_ENABLED: "YES", AUTHORIZED_PROSPECT_ID: String(prospect.id) },
  });
  const controlled = await controlledSend({
    campaign: CONFIG.campaign,
    prospectId: String(prospect.id),
    allowLiveSend: "YES",
    authorizedProspectId: String(prospect.id),
    allowSheetWrite: "YES",
    dependencies: adapters,
  });
  return {
    status: controlled.status === "pass" ? "sent" : "halted",
    eligibleCount: selection.total,
    prospectId: prospect.id,
    language: prospect.language,
    rate,
    schedule,
    sends: controlled.sendAttempts ?? 0,
    writes: controlled.sheetWrites ?? 0,
    controlled,
  };
}
