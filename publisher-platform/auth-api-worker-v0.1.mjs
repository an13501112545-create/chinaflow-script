import { findOrCreateLoginUser } from "./auth-user-store-v0.1.mjs";
import { createMagicLink } from "./auth-magic-link-store-v0.1.mjs";
import { sendMagicLinkEmail } from "./auth-email-resend-v0.1.mjs";
import { completeMagicLinkLogin } from "./auth-login-service-v0.1.mjs";

const MAGIC_LINK_ROUTE = "/v1/auth/magic-link";
const CONSUME_ROUTE = "/v1/auth/consume";
const APP_ORIGIN = "https://app.getchinaflow.com";

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

  const origin = request.headers.get("Origin");
  const allowedOrigin = origin === APP_ORIGIN ? origin : null;

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

  const db = env?.CHINAFLOW_EVENTS;

  if (!db || typeof db.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  const user = await findOrCreateLoginUser(db, email);

  if (user.active) {
    const magicLink = await createMagicLink(db, user.userId);

    try {
      await sendMagicLinkEmail({
        apiKey: env.RESEND_API_KEY,
        to: email,
        token: magicLink.token
      });
    } catch (error) {
      console.error("[ChinaFlow Auth API v0.1] Magic-link email delivery failed", error);
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
