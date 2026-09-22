import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import appWorker from "../app-worker-v0.1.mjs";
import { handleAuthRequest } from "../auth-api-worker-v0.1.mjs";

const APP_ORIGIN = "https://app.getchinaflow.com";
const AUTH_ORIGIN = "https://auth.getchinaflow.com";
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const SITE_KEY = "test-site-key";
const SECRET_KEY = "test-secret-key";
const ACTION = "publisher_magic_link";

function authFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());

  sqlite.exec(
    readFileSync(
      new URL(
        "../../collector/migrations/0005_publisher_accounts_v1.sql",
        import.meta.url
      ),
      "utf8"
    )
  );

  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            async first() {
              return statement.get(...values) ?? null;
            },
            async all() {
              return { results: statement.all(...values) };
            },
            async run() {
              return { meta: statement.run(...values) };
            },
            execute() {
              const results = statement.all(...values);
              return {
                results,
                meta: {
                  changes:
                    sqlite.prepare("SELECT changes() AS n").get().n
                }
              };
            }
          };
        }
      };
    },

    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.execute());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };

  const env = {
    CHINAFLOW_EVENTS: db,
    APP_ORIGIN,
    AUTH_ENVIRONMENT: "production",
    RESEND_API_KEY: "mock-resend-key",
    TURNSTILE_SECRET_KEY: SECRET_KEY,

    MAGIC_LINK_IP_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },

    MAGIC_LINK_EMAIL_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    }
  };

  return { sqlite, db, env };
}

test("Production configs declare Turnstile public and secret bindings", () => {
  const app = JSON.parse(
    readFileSync(
      new URL("../../wrangler.publisher-app.production.jsonc", import.meta.url),
      "utf8"
    )
  );

  const auth = JSON.parse(
    readFileSync(
      new URL("../../wrangler.publisher-auth-api.production.jsonc", import.meta.url),
      "utf8"
    )
  );

  assert.equal(
    typeof app.vars.TURNSTILE_SITE_KEY,
    "string",
    "Publisher App must expose a public Turnstile site key binding"
  );

  assert.ok(
    app.vars.TURNSTILE_SITE_KEY.length > 0,
    "Turnstile site key must not be empty"
  );

  assert.ok(
    auth.secrets.required.includes("TURNSTILE_SECRET_KEY"),
    "Auth API must require TURNSTILE_SECRET_KEY as a Worker secret"
  );

  assert.equal(
    Object.hasOwn(auth.vars ?? {}, "TURNSTILE_SECRET_KEY"),
    false,
    "Turnstile secret must never be stored as a plaintext var"
  );
});

test("login page renders Managed Turnstile and restrictive CSP", async () => {
  const response = await appWorker.fetch(
    new Request(`${APP_ORIGIN}/login`),
    {
      APP_ORIGIN,
      CHINAFLOW_AUTH_ORIGIN: AUTH_ORIGIN,
      CHINAFLOW_RUNTIME_ORIGIN: "https://runtime.getchinaflow.com",
      TURNSTILE_SITE_KEY: SITE_KEY
    }
  );

  assert.equal(response.status, 200);

  const html = await response.text();
  const csp = response.headers.get("Content-Security-Policy");

  assert.ok(csp);

  assert.match(
    csp,
    /script-src[^;]*https:\/\/challenges\.cloudflare\.com/
  );

  assert.match(
    csp,
    /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/
  );

  assert.match(
    html,
    /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/
  );

  assert.match(
    html,
    /class="cf-turnstile"/
  );

  assert.match(
    html,
    new RegExp(`data-sitekey="${SITE_KEY}"`)
  );

  assert.match(
    html,
    new RegExp(`data-action="${ACTION}"`)
  );

  assert.match(
    html,
    /turnstile_token/
  );
});

test("magic-link request without Turnstile token fails before account creation", async t => {
  const { sqlite, env } = authFixture(t);

  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    outboundCalls++;
    return Response.json({ id: "unexpected" });
  };

  const response = await handleAuthRequest(
    new Request("https://auth.example/v1/auth/magic-link", {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10"
      },
      body: JSON.stringify({
        email: "new@example.com"
      })
    }),
    env
  );

  assert.equal(response.status, 400);
  assert.deepEqual(
    await response.json(),
    { error: "turnstile_required" }
  );

  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM publisher_users").get().n,
    0
  );

  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM publisher_magic_links").get().n,
    0
  );

  assert.equal(
    outboundCalls,
    0,
    "Missing Turnstile token must fail before Siteverify or Resend"
  );
});

test("valid Turnstile token is server-verified before account creation and email", async t => {
  const { sqlite, env } = authFixture(t);

  const originalFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    calls.push({
      url: target,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body
    });

    if (
      target ===
      "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    ) {
      return Response.json({
        success: true,
        hostname: "app.getchinaflow.com",
        action: ACTION,
        "error-codes": []
      });
    }

    if (target === "https://api.resend.com/emails") {
      return Response.json({ id: "mock-email" });
    }

    throw new Error("Unexpected outbound URL: " + target);
  };

  const response = await handleAuthRequest(
    new Request("https://auth.example/v1/auth/magic-link", {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10"
      },
      body: JSON.stringify({
        email: "new@example.com",
        turnstile_token: "valid-turnstile-token"
      })
    }),
    env
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });

  assert.equal(calls.length, 2);

  assert.equal(
    calls[0].url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  );

  assert.equal(calls[0].method, "POST");

  const verifyBody =
    calls[0].body instanceof URLSearchParams
      ? calls[0].body
      : new URLSearchParams(String(calls[0].body));

  assert.equal(
    verifyBody.get("secret"),
    SECRET_KEY
  );

  assert.equal(
    verifyBody.get("response"),
    "valid-turnstile-token"
  );

  assert.equal(
    verifyBody.get("remoteip"),
    "203.0.113.10"
  );

  assert.equal(
    calls[1].url,
    "https://api.resend.com/emails"
  );

  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM publisher_users").get().n,
    1
  );

  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM publisher_magic_links").get().n,
    1
  );
});

test("failed, wrong-hostname or wrong-action Turnstile never mutates D1", async t => {
  for (const result of [
    {
      success: false,
      hostname: "app.getchinaflow.com",
      action: ACTION,
      "error-codes": ["invalid-input-response"]
    },
    {
      success: true,
      hostname: "example.com",
      "error-codes": [],
      metadata: {
        result_with_testing_key: true
      }
    },
    {
      success: true,
      hostname: "evil.example",
      action: ACTION,
      "error-codes": []
    },
    {
      success: true,
      hostname: "app.getchinaflow.com",
      action: "wrong_action",
      "error-codes": []
    }
  ]) {
    const { sqlite, env } = authFixture(t);

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async url => {
      assert.equal(
        String(url),
        "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      );
      return Response.json(result);
    };

    const response = await handleAuthRequest(
      new Request("https://auth.example/v1/auth/magic-link", {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10"
        },
        body: JSON.stringify({
          email: "blocked@example.com",
          turnstile_token: "bad-token"
        })
      }),
      env
    );

    globalThis.fetch = originalFetch;

    assert.equal(response.status, 403);
    assert.deepEqual(
      await response.json(),
      { error: "turnstile_failed" }
    );

    assert.equal(
      sqlite.prepare("SELECT count(*) AS n FROM publisher_users").get().n,
      0
    );

    assert.equal(
      sqlite.prepare("SELECT count(*) AS n FROM publisher_magic_links").get().n,
      0
    );
  }
});


test("TEST accepts official Turnstile testing-key result", async t => {
  const { sqlite, env } = authFixture(t);

  env.AUTH_ENVIRONMENT = "test";
  env.AUTH_TEST_EMAIL = "test@example.com";
  env.TURNSTILE_REQUIRED = "true";

  const originalFetch = globalThis.fetch;
  let siteverifyCalls = 0;
  let resendCalls = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async url => {
    const target = String(url);

    if (
      target ===
      "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    ) {
      siteverifyCalls++;

      return Response.json({
        challenge_ts: "2026-09-22T10:34:18.377Z",
        success: true,
        hostname: "example.com",
        "error-codes": [],
        metadata: {
          result_with_testing_key: true
        }
      });
    }

    if (target === "https://api.resend.com/emails") {
      resendCalls++;
      return Response.json({
        id: "mock-email"
      });
    }

    throw new Error(
      "Unexpected outbound URL: " + target
    );
  };

  const response = await handleAuthRequest(
    new Request(
      "https://auth.example/v1/auth/magic-link",
      {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10"
        },
        body: JSON.stringify({
          email: "test@example.com",
          turnstile_token: "dummy-browser-token"
        })
      }
    ),
    env
  );

  assert.equal(response.status, 202);
  assert.deepEqual(
    await response.json(),
    { ok: true }
  );

  assert.equal(siteverifyCalls, 1);
  assert.equal(resendCalls, 1);

  assert.equal(
    sqlite.prepare(
      "SELECT count(*) AS n FROM publisher_users"
    ).get().n,
    1
  );

  assert.equal(
    sqlite.prepare(
      "SELECT count(*) AS n FROM publisher_magic_links"
    ).get().n,
    1
  );
});
