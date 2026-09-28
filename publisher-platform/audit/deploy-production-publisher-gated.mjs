import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

const targets = {
  app: "wrangler.publisher-app.production.jsonc",
  auth: "wrangler.publisher-auth-api.production.jsonc"
};

const target = process.argv[2];
assert.ok(target === "app" || target === "auth", "Usage: node publisher-platform/audit/deploy-production-publisher-gated.mjs <app|auth>");
const config = targets[target];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
    env: process.env
  });
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

assert.equal(run("git", ["branch", "--show-current"]).trim(), "main", "Production deploy requires main branch");
assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "Production deploy requires clean worktree");
run("git", ["fetch", "origin", "main"]);
const head = run("git", ["rev-parse", "HEAD"]).trim();
const remote = run("git", ["rev-parse", "origin/main"]).trim();
assert.equal(head, remote, "Production deploy requires HEAD == origin/main");

console.log(`TARGET=${target}`);
console.log(`CONFIG=${config}`);
console.log(`HEAD=${head}`);
console.log("PREFLIGHT_GIT=PASS");

run(npx, ["--no-install", "wrangler", "deploy", "--dry-run", "--config", config], { stdio: "inherit" });
console.log("WRANGLER_DRY_RUN=PASS");

run(npx, ["--no-install", "wrangler", "deploy", "--config", config], { stdio: "inherit" });
console.log("WORKER_DEPLOY=PASS");

run(process.execPath, ["publisher-platform/audit/production-branded-smoke-readonly.mjs"], { stdio: "inherit" });
console.log("POST_DEPLOY_BRANDED_SMOKE=PASS");
console.log("PRODUCTION_PUBLISHER_DEPLOY_GATE=PASS");
