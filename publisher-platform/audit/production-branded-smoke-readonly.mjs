import assert from "node:assert/strict";

const APP = "https://publishers.getchinaflow.com";
const AUTH = "https://chinaflow-auth-api-v0-1.an13501112545.workers.dev";

async function get(path) {
  return fetch(APP + path, { method: "GET", redirect: "error" });
}

for (const [path, marker] of [
  ["/login", `<html lang="en">`],
  ["/zh/login", `<html lang="zh-CN">`],
  ["/onboarding", `<html lang="en">`],
  ["/zh/onboarding", `<html lang="zh-CN">`]
]) {
  const response = await get(path);
  assert.equal(response.status, 200, `${path} must return 200`);
  const body = await response.text();
  assert.ok(body.includes(marker), `${path} must contain ${marker}`);
  console.log(`${path}=PASS`);
}

const health = await get("/health");
assert.equal(health.status, 200, "/health must return 200");
const healthBody = await health.json();
assert.equal(healthBody.ok, true, "/health must report ok=true");
console.log("APP_HEALTH=PASS");

const canonical = await fetch(AUTH + "/v1/auth/magic-link", {
  method: "OPTIONS",
  headers: {
    Origin: APP,
    "Access-Control-Request-Method": "POST"
  },
  redirect: "error"
});
assert.equal(canonical.status, 204, "canonical auth preflight must return 204");
assert.equal(canonical.headers.get("access-control-allow-origin"), APP);
assert.match(canonical.headers.get("access-control-allow-methods") ?? "", /(?:^|,\s*)POST(?:,|$)/);
console.log("AUTH_CANONICAL_CORS=PASS");

const badOrigin = await fetch(AUTH + "/v1/auth/magic-link", {
  method: "OPTIONS",
  headers: {
    Origin: "https://invalid.example",
    "Access-Control-Request-Method": "POST"
  },
  redirect: "error"
});
assert.equal(badOrigin.status, 403, "bad-origin auth preflight must fail closed");
assert.equal(badOrigin.headers.get("access-control-allow-origin"), null);
console.log("AUTH_BAD_ORIGIN_FAIL_CLOSED=PASS");

const session = await get("/api/auth/session");
assert.equal(session.status, 401, "anonymous session must return 401");
assert.deepEqual(await session.json(), { authenticated: false });
console.log("ANONYMOUS_SESSION=PASS");

console.log("PRODUCTION_BRANDED_SMOKE_READ_ONLY=PASS");
