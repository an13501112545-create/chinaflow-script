import { pathToFileURL } from "node:url";
import { clearPersistentHalt, reviewPersistentHalt } from "./halt-recovery-v1.mjs";

export function parseHaltRecoveryArgs(argv) {
  let authorization = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--authorize") {
      authorization = String(argv[++i] ?? "").trim();
      if (!authorization) throw new Error("--authorize requires a token");
      continue;
    }
    throw new Error("unknown argument: " + argv[i]);
  }
  return { authorization };
}

export async function runHaltRecoveryCli({
  argv = process.argv.slice(2),
  reviewer = reviewPersistentHalt,
  clearer = clearPersistentHalt,
} = {}) {
  const { authorization } = parseHaltRecoveryArgs(argv);
  if (!authorization) return reviewer();
  return clearer({ authorization });
}

async function main() {
  const report = await runHaltRecoveryCli();
  console.log("=== CHINAFLOW HALT RECOVERY REPORT ===");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("ERROR=" + (error?.message ?? error));
    process.exitCode = 1;
  });
}
