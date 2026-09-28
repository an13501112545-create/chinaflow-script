import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../audit/deploy-production-publisher-gated.mjs", import.meta.url), "utf8");

test("production publisher deploy gate is restricted to fixed app/auth targets", () => {
  assert.match(source, /app: "wrangler\.publisher-app\.production\.jsonc"/);
  assert.match(source, /auth: "wrangler\.publisher-auth-api\.production\.jsonc"/);
  assert.match(source, /target === "app" \|\| target === "auth"/);
});

test("production publisher deploy gate requires clean synchronized main", () => {
  assert.match(source, /branch", "--show-current/);
  assert.match(source, /status", "--porcelain/);
  assert.match(source, /fetch", "origin", "main/);
  assert.match(source, /assert\.equal\(head, remote/);
});

test("production publisher deploy gate dry-runs before deploy and smokes after deploy", () => {
  const dryRun = source.indexOf('"deploy", "--dry-run"');
  const deployIndex = source.indexOf('"deploy", "--config"');
  const smoke = source.indexOf("production-branded-smoke-readonly.mjs");
  assert.ok(dryRun >= 0, "dry-run missing");
  assert.ok(deployIndex > dryRun, "real deploy must follow dry-run");
  assert.ok(smoke > deployIndex, "branded smoke must follow real deploy");
});
