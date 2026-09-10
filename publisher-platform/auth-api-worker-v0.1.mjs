const ROUTE = "/v1/auth/magic-link";
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

export async function handleAuthRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== ROUTE) return response(404);

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

  const email = normalizeEmail(body?.email);

  if (!email) {
    return response(400, { error: "invalid_email" }, allowedOrigin);
  }

  const db = env?.CHINAFLOW_EVENTS;

  if (!db || typeof db.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  /*
   * Deliberately do not reveal whether this email exists.
   * Existing and unknown accounts receive the same response.
   */
  await db.prepare(
    "SELECT user_id FROM publisher_users WHERE email_normalized = ? AND user_status = 'active' LIMIT 1"
  ).bind(email).first();

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
