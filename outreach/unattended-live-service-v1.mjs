import fs from "node:fs";
import { runUnattendedLiveCycle } from "./unattended-live-runner-v1.mjs";
import { sanitizeOperationalError } from "./foundation-v1.mjs";
import { readPersistentHalt, writePersistentHalt } from "./halt-guard-v1.mjs";

const LOCK_PATH = "/run/chinaflow-outreach/unattended-live-service-v1.lock";
const LIVE_ENABLED = process.env.CHINAFLOW_OUTREACH_LIVE === "YES" && process.env.REAL_SEND_ENABLED === "YES" && process.env.ALLOW_SHEET_WRITE === "YES";
let stopping = false;
let wakeSleep = null;

function requestStop(signal) {
  stopping = true;
  if (wakeSleep) wakeSleep();
  console.log(`STOP_SIGNAL=${signal}`);
}
process.once("SIGTERM", () => requestStop("SIGTERM"));
process.once("SIGINT", () => requestStop("SIGINT"));

function interruptibleSleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); wakeSleep = null; resolve(); }
    wakeSleep = done;
    if (stopping) done();
  });
}

const existingHalt = readPersistentHalt();
if (existingHalt.present) {
  const haltReason = (sanitizeOperationalError(existingHalt.reason ?? "UNKNOWN") || "UNKNOWN").replace(/\s+/g, "_");
  console.log(`SERVICE_STATUS=blocked REASON=PERSISTENT_HALT_LOCK HALT_REASON=${haltReason} NEXT=${existingHalt.prospectId ?? "NONE"} LIVE=${LIVE_ENABLED ? "YES" : "NO"}`);
  process.exit(0);
}

let lockFd;
try { lockFd = fs.openSync(LOCK_PATH, "wx", 0o600); }
catch (error) {
  if (error?.code === "EEXIST") { console.log("SERVICE_STATUS=blocked REASON=LOCK_HELD"); process.exit(0); }
  throw error;
}

let cycles = 0;
try {
  while (!stopping) {
    const cycle = await runUnattendedLiveCycle({ liveEnabled: LIVE_ENABLED });
    cycles += 1;
    const reason = (sanitizeOperationalError(cycle.reason ?? "NONE") || "NONE").replace(/\s+/g, "_");
    console.log(`CYCLE=${cycles} STATUS=${cycle.status} NEXT=${cycle.prospectId ?? "NONE"} SENDS=${cycle.sends ?? 0} WRITES=${cycle.writes ?? 0} REASON=${reason} LIVE=${LIVE_ENABLED ? "YES" : "NO"}`);
    if (cycle.status === "halted") {
      const halt = writePersistentHalt({ prospectId: cycle.prospectId ?? null, reason });
      console.log(`HALT_LOCK_WRITTEN=${halt.written ? "YES" : "NO"} NEXT=${cycle.prospectId ?? "NONE"} REASON=${reason}`);
      break;
    }
    if (stopping) break;
    await interruptibleSleep((cycle.schedule?.interval ?? 6) * 60 * 1000);
  }
} finally {
  try { fs.closeSync(lockFd); } finally { fs.unlinkSync(LOCK_PATH); }
}
console.log(`SERVICE_STATUS=stopped CYCLES=${cycles} LIVE=${LIVE_ENABLED ? "YES" : "NO"}`);
