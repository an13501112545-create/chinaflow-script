import { completeMagicLinkLogin } from "./auth-login-service-v0.1.mjs";
import { serializeSessionCookie } from "./auth-session-cookie-v0.1.mjs";

const APP_ORIGIN = "https://app.getchinaflow.com";
const CONSUME_ROUTE = "/api/auth/consume";

function json(status, body, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });

  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleAppRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === CONSUME_ROUTE) {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    if (request.headers.get("Origin") !== APP_ORIGIN) {
      return json(403, { error: "forbidden" });
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const db = env?.CHINAFLOW_EVENTS;

    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new Error("D1 binding unavailable");
    }

    const login = await completeMagicLinkLogin(db, body?.token);

    if (!login) {
      return json(401, { error: "invalid_or_expired_link" });
    }

    return json(
      200,
      { ok: true },
      { "Set-Cookie": serializeSessionCookie(login.token) }
    );
  }

  if (url.pathname === "/health") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });

    return json(200, {
      ok: true,
      service: "chinaflow-publisher-app",
      environment: env?.APP_ENVIRONMENT ?? "unknown"
    });
  }

  return json(404, { error: "not_found" });
}

export default {
  async fetch(request, env) {
    try {
      return await handleAppRequest(request, env);
    } catch (error) {
      console.error("[ChinaFlow Publisher App v0.1] Unexpected error", error);
      return json(500, { error: "internal_error" });
    }
  }
};
