import { runControlledLiveSend } from "./controlled-live-v1.mjs";
import { createProductionAdapters } from "./production-adapters-v1.mjs";
import { CONFIG, canSend, selectFirstEligible } from "./runner-v2.mjs";

export function liveGuards(env = process.env) {
  return Object.freeze({
    liveEnabled: env.CHINAFLOW_OUTREACH_LIVE === "YES",
    providerEnabled: env.REAL_SEND_ENABLED === "YES",
    sheetWriteEnabled: env.ALLOW_SHEET_WRITE === "YES",
  });
}

export async function runLiveCycle({
  env = process.env,
  discoveryDependencies,
  dependencyFactory,
  controlledSend = runControlledLiveSend,
  now = new Date(),
} = {}) {
  const guards = liveGuards(env);
  if (!guards.liveEnabled || !guards.providerEnabled || !guards.sheetWriteEnabled) {
    return { status: "blocked", reason: "LIVE_GUARD_DISABLED", sendAttempts: 0, sheetWrites: 0, retry: false };
  }

  const discovery = discoveryDependencies ?? createProductionAdapters({
    env: { ...env, REAL_SEND_ENABLED: "NO", AUTHORIZED_PROSPECT_ID: "" },
  });
  const values = await discovery.readPipelineValues();
  const selection = selectFirstEligible(values);
  if (!selection.prospect) {
    return { status: "idle", reason: "NO_ELIGIBLE_PROSPECT", sendAttempts: 0, sheetWrites: 0, retry: false };
  }

  const ledger = await discovery.readLedger();
  const rate = canSend(ledger.records, now);
  if (!rate.allowed) {
    return { status: "rate_blocked", reason: "RATE_CAP", rate, prospectId: selection.prospect.id, sendAttempts: 0, sheetWrites: 0, retry: false };
  }

  const prospectId = String(selection.prospect.id);
  const makeDependencies = dependencyFactory ?? ((id) => createProductionAdapters({
    env: { ...env, REAL_SEND_ENABLED: "YES", AUTHORIZED_PROSPECT_ID: String(id) },
  }));
  const dependencies = makeDependencies(prospectId);

  return controlledSend({
    campaign: CONFIG.campaign,
    prospectId,
    allowLiveSend: "YES",
    authorizedProspectId: prospectId,
    allowSheetWrite: "YES",
    dependencies,
  });
}

export async function runLiveLoop({
  runCycle = runLiveCycle,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  randomInt,
  shouldStop = () => false,
  maxCycles = Infinity,
  onCycle = () => {},
} = {}) {
  let cycles = 0;
  while (!shouldStop() && cycles < maxCycles) {
    const cycle = await runCycle();
    cycles += 1;
    await onCycle(cycle, cycles);
    if (shouldStop() || cycles >= maxCycles) break;
    if (["blocked", "failed", "ambiguous"].includes(cycle.status)) {
      return { status: "fail_closed", cycles, terminalStatus: cycle.status, reason: cycle.reason ?? null };
    }
    const minutes = randomInt ? randomInt(CONFIG.minIntervalMinutes, CONFIG.maxIntervalMinutes + 1) : CONFIG.minIntervalMinutes;
    await sleep(minutes * 60 * 1000);
  }
  return { status: "stopped", cycles };
}
