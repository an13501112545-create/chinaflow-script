import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const APP_ORIGIN = "https://publisher.example.test";
const VERIFY_PATH = "/api/onboarding/verify-install";
const TOKEN = "1".repeat(64);
const CLIENT_IP = "203.0.113.44";

const built = await build({
  entryPoints: [
    fileURLToPath(new URL("../app-worker-v0.1.mjs", import.meta.url))
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  minify: false,
  loader: { ".md": "text" }
});

const worker = (
  await import(
    `data:text/javascript;base64,${Buffer.from(
      built.outputFiles[0].text
    ).toString("base64")}`
  )
).default;
function request(path = VERIFY_PATH, init = {}) {
  return new Request(APP_ORIGIN + path, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: `__Host-chinaflow_session=${TOKEN}`,
      "CF-Connecting-IP": CLIENT_IP,
      ...(init.headers ?? {})
    },
    ...(Object.hasOwn(init, "body") ? { body: init.body } : {})
  });
}

function baseEnv(overrides = {}) {
  const env = {
    APP_ORIGIN,
    CHINAFLOW_RUNTIME_ORIGIN: "https://runtime.example.test"
  };

  return Object.defineProperties(
    env,
    Object.getOwnPropertyDescriptors(overrides)
  );
}

test(
  "verify-install rejects query and non-empty body before limiter, D1, or fetch",
  async () => {
    for (const req of [
      request(VERIFY_PATH + "?publisher_id=ignored"),
      request(VERIFY_PATH, {
        headers: { "Content-Type": "application/json" },
        body: "{}"
      })
    ]) {
      let limiterCalls = 0;
      let d1Touched = false;

      const env = baseEnv({
        VERIFY_INSTALL_IP_RATE_LIMITER: {
          async limit() {
            limiterCalls++;
            return { success: true };
          }
        },        VERIFY_INSTALL_SESSION_RATE_LIMITER: {
          async limit() {
            limiterCalls++;
            return { success: true };
          }
        },
        get CHINAFLOW_EVENTS() {
          d1Touched = true;
          throw new Error("D1 must not be touched");
        }
      });

      const response = await worker.fetch(req, env);

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "invalid_input"
      });
      assert.equal(limiterCalls, 0);
      assert.equal(d1Touched, false);
    }
  }
);

test(
  "verify-install limiter denial returns controlled 429 before D1",
  async () => {
    for (const denied of ["ip", "session"]) {
      let ipCalls = 0;
      let sessionCalls = 0;
      let d1Touched = false;

      const env = baseEnv({
        VERIFY_INSTALL_IP_RATE_LIMITER: {
          async limit() {
            ipCalls++;
            return { success: denied !== "ip" };
          }
        },        VERIFY_INSTALL_SESSION_RATE_LIMITER: {
          async limit() {
            sessionCalls++;
            return { success: denied !== "session" };
          }
        },
        get CHINAFLOW_EVENTS() {
          d1Touched = true;
          throw new Error("D1 must not be touched");
        }
      });

      const response = await worker.fetch(request(), env);

      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), {
        error: "rate_limited"
      });
      assert.equal(response.headers.get("Retry-After"), "60");
      assert.equal(ipCalls, 1);
      assert.equal(
        sessionCalls,
        denied === "ip" ? 0 : 1
      );
      assert.equal(d1Touched, false);
    }
  }
);

test(
  "verify-install uses opaque limiter keys then preserves allowed D1 path",
  async () => {
    const keys = [];
    const d1Error = new Error("EXPECTED_D1_PATH");

    const limiter = label => ({
      async limit({ key }) {
        keys.push({ label, key });
        return { success: true };
      }
    });    const env = baseEnv({
      VERIFY_INSTALL_IP_RATE_LIMITER: limiter("ip"),
      VERIFY_INSTALL_SESSION_RATE_LIMITER: limiter("session"),
      get CHINAFLOW_EVENTS() {
        throw d1Error;
      }
    });

    const response =
      await worker.fetch(request(), env);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "internal_error"
    });

    assert.equal(keys.length, 2);
    assert.deepEqual(
      keys.map(entry => entry.label),
      ["ip", "session"]
    );

    for (const entry of keys) {
      assert.match(entry.key, /^[0-9a-f]{64}$/);
      assert.notEqual(entry.key, CLIENT_IP);
      assert.notEqual(entry.key, TOKEN);
      assert.ok(!entry.key.includes(CLIENT_IP));
      assert.ok(!entry.key.includes(TOKEN));
    }

    assert.notEqual(
      keys[0].key,
      keys[1].key,
      "IP and session scopes must not share a limiter key"
    );
  }
);


test(
  "publisher app configs bind verify-install rate limiters",
  () => {
    const configs = [
      "../../wrangler.publisher-app.test.jsonc",
      "../../wrangler.publisher-app.production.jsonc"
    ].map(path =>
      JSON.parse(
        readFileSync(new URL(path, import.meta.url), "utf8")
      )
    );

    const namespaceIds = [];

    for (const config of configs) {
      const byName = new Map(
        (config.ratelimits ?? []).map(item => [item.name, item])
      );

      const ip =
        byName.get("VERIFY_INSTALL_IP_RATE_LIMITER");
      const session =
        byName.get("VERIFY_INSTALL_SESSION_RATE_LIMITER");

      assert.deepEqual(ip?.simple, {
        limit: 30,
        period: 60
      });
      assert.deepEqual(session?.simple, {
        limit: 10,
        period: 60
      });

      for (const item of [ip, session]) {
        assert.match(item?.namespace_id ?? "", /^[0-9]+$/);
        namespaceIds.push(item.namespace_id);
      }
    }

    assert.equal(
      new Set(namespaceIds).size,
      namespaceIds.length,
      "TEST/Production limiter namespace IDs must be unique"
    );
  }
);
