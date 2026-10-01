import fs from "node:fs";
import { createProductionAdapters } from "./production-adapters-v1.mjs";
import { CONFIG, buildPayload, canSend, scheduleNext, selectFirstEligible } from "./runner-v2.mjs";

const LOCK_PATH = "/var/lib/chinaflow-outreach/unattended-runner-v1.lock";

async function runDryRunCycle({ dependencies, now, randomInt }) {
  const values = await dependencies.readPipelineValues();
  const selection = selectFirstEligible(values);
  const ledger = await dependencies.readLedger();
  const rate = canSend(ledger.records, now);
  const schedule = scheduleNext(now, randomInt);
  if (!selection.prospect) return { status: "idle", eligibleCount: 0, rate, schedule, writes: 0, sends: 0 };
  const payload = buildPayload(selection.prospect);
  return { status: rate.allowed ? "dry_run_ready" : "rate_blocked", eligibleCount: selection.total, prospectId: selection.prospect.id, language: selection.prospect.language, payloadValid: Boolean(payload.subject && payload.body), rate, schedule, sendMode: CONFIG.sendMode, concurrency: CONFIG.concurrency, writes: 0, sends: 0 };
}

export async function runUnattendedDryRun({ dependencies = createProductionAdapters(), now = new Date(), randomInt, manageLock = true } = {}) {
  if (!manageLock) return runDryRunCycle({ dependencies, now, randomInt });
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_PATH, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return { status: "blocked", reason: "LOCK_HELD", writes: 0, sends: 0 };
    throw error;
  }
  try {
    return await runDryRunCycle({ dependencies, now, randomInt });
  } finally {
    try { fs.closeSync(lockFd); } finally { fs.unlinkSync(LOCK_PATH); }
  }
}


if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runUnattendedDryRun();
  console.log("=== UNATTENDED_RUNNER_V1_DRY_RUN ===");
  console.log(`STATUS=${result.status}`);
  console.log(`ELIGIBLE_COUNT=${result.eligibleCount ?? 0}`);
  console.log(`NEXT_PROSPECT_ID=${result.prospectId ?? "NONE"}`);
  console.log(`NEXT_LANGUAGE=${result.language ?? "NONE"}`);
  console.log(`PAYLOAD_VALID=${result.payloadValid ? "YES" : "NO"}`);
  console.log(`RATE_ALLOWED=${result.rate?.allowed ?? false}`);
  console.log(`RATE_LAST_60M=${result.rate?.sentLast60Minutes ?? 0}`);
  console.log(`RATE_TODAY=${result.rate?.sentToday ?? 0}`);
  console.log(`NEXT_INTERVAL_MINUTES=${result.schedule?.interval ?? "NONE"}`);
  console.log(`SEND_MODE=${result.sendMode ?? CONFIG.sendMode}`);
  console.log(`CONCURRENCY=${result.concurrency ?? CONFIG.concurrency}`);
  console.log(`MAILOPOLY_SEND_CALLS=${result.sends ?? 0}`);
  console.log(`WRITE_CALLS=${result.writes ?? 0}`);
}

export async function runDryRunLoop({
  manageLock = true,
  dependencies = createProductionAdapters(),
  randomInt,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  shouldStop = () => false,
  maxCycles = Infinity,
  onCycle = () => {},
} = {}) {
  let serviceLockFd;
  if (manageLock) {
    try { serviceLockFd = fs.openSync(LOCK_PATH, "wx", 0o600); }
    catch (error) {
      if (error?.code === "EEXIST") return { status: "blocked", reason: "LOCK_HELD", cycles: 0, sends: 0, writes: 0 };
      throw error;
    }
  }
  let cycles = 0;
  try {
    while (!shouldStop() && cycles < maxCycles) {
      const cycle = await runUnattendedDryRun({ dependencies, now: new Date(), randomInt, manageLock: false });
      cycles += 1;
      await onCycle(cycle, cycles);
      if (shouldStop() || cycles >= maxCycles || cycle.status === "blocked") break;
      const minutes = cycle.schedule?.interval ?? CONFIG.minIntervalMinutes;
      await sleep(minutes * 60 * 1000);
    }
    return { status: "stopped", cycles, sends: 0, writes: 0 };
  } finally {
    if (manageLock && serviceLockFd !== undefined) {
      try { fs.closeSync(serviceLockFd); } finally { fs.unlinkSync(LOCK_PATH); }
    }
  }
}
