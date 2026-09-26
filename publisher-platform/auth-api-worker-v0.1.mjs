import { findOrCreateLoginUser } from "./auth-user-store-v0.1.mjs";
import { createMagicLink } from "./auth-magic-link-store-v0.1.mjs";
import { sendMagicLinkEmail } from "./auth-email-resend-v0.1.mjs";
import { completeMagicLinkLogin } from "./auth-login-service-v0.1.mjs";

const MAGIC_LINK_ROUTE = "/v1/auth/magic-link";
const CONSUME_ROUTE = "/v1/auth/consume";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "publisher_magic_link";
function requireAppOrigin(env) {
  const value = env?.APP_ORIGIN;

  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("APP_ORIGIN binding unavailable or invalid");
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN binding unavailable or invalid");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error("APP_ORIGIN binding unavailable or invalid");
  }

  return value;
}

function response(status, body = null, origin = null) {
  const headers = new Headers({
    "Cache-Control": "no-store"
  });

  if (body !== null) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Vary", "Origin");
  }

  return new Response(
    body === null ? null : JSON.stringify(body),
    { status, headers }
  );
}

function normalizeTurnstileToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\s\x00-\x1f\x7f]/u.test(value)
  ) {
    return null;
  }

  return value;
}

function requireTurnstileSecret(env) {
  const value = env?.TURNSTILE_SECRET_KEY;

  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\x00-\x20\x7f]/u.test(value)
  ) {
    throw new Error(
      "TURNSTILE_SECRET_KEY binding unavailable or invalid"
    );
  }

  return value;
}

async function verifyTurnstile({
  secret,
  token,
  remoteIp,
  appOrigin,
  allowTestingKey = false
}) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);

  if (
    typeof remoteIp === "string" &&
    remoteIp !== "unknown" &&
    remoteIp.length <= 64 &&
    !/[\s\x00-\x1f\x7f]/u.test(remoteIp)
  ) {
    body.set("remoteip", remoteIp);
  }

  const response = await fetch(
    TURNSTILE_VERIFY_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body,
      signal: AbortSignal.timeout(5000)
    }
  );

  if (!response.ok) {
    throw new Error("Turnstile Siteverify unavailable");
  }

  const result = await response.json();

  if (result?.success !== true) {
    return false;
  }

  if (
    result?.metadata?.result_with_testing_key === true
  ) {
    return allowTestingKey === true;
  }

  const expectedHostname =
    new URL(appOrigin).hostname.toLowerCase();

  return (
    result?.hostname?.toLowerCase() === expectedHostname &&
    result?.action === TURNSTILE_ACTION
  );
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;

  const email = value.trim().toLowerCase();

  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}

async function rateLimitKey(scope, value) {
  const input = new TextEncoder().encode(`${scope}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", input);

  return Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, "0")
  ).join("");
}

async function checkRateLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== "function") {
    throw new Error("Rate limit binding unavailable");
  }

  const result = await limiter.limit({ key });

  return result?.success === true;
}

export async function handleAuthRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== MAGIC_LINK_ROUTE && url.pathname !== CONSUME_ROUTE) return response(404);

  const appOrigin = requireAppOrigin(env);
  const origin = request.headers.get("Origin");
  const allowedOrigin = origin === appOrigin ? origin : null;

  if (request.method === "OPTIONS") {
    return allowedOrigin
      ? response(204, null, allowedOrigin)
      : response(403);
  }

  if (request.method !== "POST") return response(405);
  if (!allowedOrigin) return response(403);

  let body;

  try {
    body = await request.json();
  } catch {
    return response(400, { error: "invalid_json" }, allowedOrigin);
  }

  if (url.pathname === CONSUME_ROUTE) {
    const db = env?.CHINAFLOW_EVENTS;

    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new Error("D1 binding unavailable");
    }

    const login = await completeMagicLinkLogin(db, body?.token);

    return login
      ? response(200, { ok: true }, allowedOrigin)
      : response(401, { error: "invalid_or_expired_link" }, allowedOrigin);
  }

  const email = normalizeEmail(body?.email);

  if (!email) {
    return response(400, { error: "invalid_email" }, allowedOrigin);
  }

  const turnstileRequired =
    env?.AUTH_ENVIRONMENT === "production" ||
    env?.TURNSTILE_REQUIRED === "true";

  const turnstileToken =
    turnstileRequired
      ? normalizeTurnstileToken(body?.turnstile_token)
      : null;

  if (turnstileRequired && !turnstileToken) {
    return response(
      400,
      { error: "turnstile_required" },
      allowedOrigin
    );
  }

  if (env?.AUTH_ENVIRONMENT !== "production") {
    const testEmail = normalizeEmail(env?.AUTH_TEST_EMAIL);

    if (!testEmail || email !== testEmail) {
      return response(202, { ok: true }, allowedOrigin);
    }
  }

  const clientIp = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";

  const ipAllowed = await checkRateLimit(
    env?.MAGIC_LINK_IP_RATE_LIMITER,
    await rateLimitKey("ip", clientIp)
  );

  if (!ipAllowed) {
    return response(202, { ok: true }, allowedOrigin);
  }

  const emailAllowed = await checkRateLimit(
    env?.MAGIC_LINK_EMAIL_RATE_LIMITER,
    await rateLimitKey("email", email)
  );

  if (!emailAllowed) {
    return response(202, { ok: true }, allowedOrigin);
  }

  if (turnstileRequired) {
    const turnstilePassed =
      await verifyTurnstile({
        secret: requireTurnstileSecret(env),
        token: turnstileToken,
        remoteIp: clientIp,
        appOrigin,
        allowTestingKey:
          env?.AUTH_ENVIRONMENT === "test" &&
          env?.TURNSTILE_REQUIRED === "true"
      });

    if (!turnstilePassed) {
      return response(
        403,
        { error: "turnstile_failed" },
        allowedOrigin
      );
    }
  }

  const db = env?.CHINAFLOW_EVENTS;

  if (!db || typeof db.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  const user = await findOrCreateLoginUser(db, email);

  if (user.active) {
    const magicLink = await createMagicLink(db, user.userId);

    if (magicLink) {
      try {
        await sendMagicLinkEmail({
          apiKey: env.RESEND_API_KEY,
          to: email,
          token: magicLink.token,
          magicLinkId: magicLink.magicLinkId,
          appOrigin
        });
      } catch (error) {
        console.error("[ChinaFlow Auth API v0.1] Magic-link email delivery failed", error);
      }
    }
  }

  /* Active, disabled, existing and newly-created users all receive the same response. */
  return response(202, { ok: true }, allowedOrigin);
}

export default {
  async fetch(request, env) {
    try {
      return await handleAuthRequest(request, env);
    } catch (error) {
      console.error("[ChinaFlow Auth API v0.1] Unexpected error", error);
      return response(500, { error: "internal_error" });
    }
  }
};
