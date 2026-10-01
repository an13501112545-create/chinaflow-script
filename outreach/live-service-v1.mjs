import fs from "node:fs";
import { runLiveLoop } from "./live-runner-v1.mjs";

const LOCK_PATH = "/var/lib/chinaflow-outreach/unattended-runner-v1.lock";
let stopping = false;
let wakeSleep = null;
let lockFd;

function requestStop(signal) {
  stopping = true;
  if (wakeSleep) wakeSleep();
  console.log(`STOP_SIGNAL=${signal}`);
}

function interruptibleSleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    }
    wakeSleep = done;
    if (stopping) done();
  });
}

try {
  lockFd = fs.openSync(LOCK_PATH, "wx", 0o600);
} catch (error) {
  if (error?.code === "EEXIST") {
    console.log("SERVICE_STATUS=blocked REASON=LOCK_HELD SENDS=0 WRITES=0");
    process.exit(0);
  }
  throw error;
}

process.once("SIGTERM", () => requestStop("SIGTERM"));
process.once("SIGINT", () => requestStop("SIGINT"));

try {
  const result = await runLiveLoop({
    sleep: interruptibleSleep,
    shouldStop: () => stopping,
    onCycle: (cycle, number) => {
      console.log(`CYCLE=${number} STATUS=${cycle.status} PROSPECT=${cycle.prospectId ?? "NONE"} SENDS=${cycle.sendAttempts ?? 0} WRITES=${cycle.sheetWrites ?? 0} REASON=${cycle.reason ?? "NONE"}`);
    },
  });
  console.log(`SERVICE_STATUS=${result.status} CYCLES=${result.cycles} TERMINAL=${result.terminalStatus ?? "NONE"} REASON=${result.reason ?? "NONE"}`);
} finally {
  try { fs.closeSync(lockFd); } finally { fs.unlinkSync(LOCK_PATH); }
}
