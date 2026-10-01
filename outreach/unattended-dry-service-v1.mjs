import { runDryRunLoop } from "./unattended-runner-v1.mjs";

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
    function done() {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    }
    wakeSleep = done;
    if (stopping) done();
  });
}

const result = await runDryRunLoop({
  sleep: interruptibleSleep,
  shouldStop: () => stopping,
  onCycle: (cycle, number) => {
    console.log(`CYCLE=${number} STATUS=${cycle.status} NEXT=${cycle.prospectId ?? "NONE"} SENDS=${cycle.sends ?? 0} WRITES=${cycle.writes ?? 0}`);
  },
});
console.log(`SERVICE_STATUS=${result.status} CYCLES=${result.cycles} SENDS=${result.sends} WRITES=${result.writes}`);
