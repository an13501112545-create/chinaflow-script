import { completeMagicLinkLogin } from "./auth-login-service-v0.1.mjs";
import { serializeSessionCookie, readSessionCookie, clearSessionCookie } from "./auth-session-cookie-v0.1.mjs";
import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { revokeSessionByToken } from "./auth-session-store-v0.1.mjs";

const APP_ORIGIN = "https://app.getchinaflow.com";
const CONSUME_ROUTE = "/api/auth/consume";
const SESSION_ROUTE = "/api/auth/session";
const LOGIN_ROUTE = "/login";
const LOGOUT_ROUTE = "/api/auth/logout";

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

function html(status, body) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

export async function handleAppRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === LOGIN_ROUTE) {
    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }

    return html(200, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ChinaFlow</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#15202b}
h1{font-size:28px;margin-bottom:12px}
p{line-height:1.5;color:#52606d}
button{margin-top:18px;padding:12px 18px;border:0;border-radius:8px;background:#0b7285;color:white;font-size:16px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
#status{margin-top:18px}
</style>
</head>
<body>
<h1>Sign in to ChinaFlow</h1>
<p id="message">Checking your sign-in link…</p>
<button id="continue" hidden>Continue sign in</button>
<p id="status"></p>
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const button = document.getElementById("continue");
  const message = document.getElementById("message");
  const status = document.getElementById("status");

  if (token) {
    history.replaceState({}, "", "/login");
    message.textContent = "Your secure sign-in link is ready.";
    button.hidden = false;

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Signing you in…";

      try {
        const response = await fetch("/api/auth/consume", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({token})
        });

        if (!response.ok) {
          status.textContent = "This sign-in link is invalid or has expired.";
          return;
        }

        const session = await fetch("/api/auth/session");

        if (!session.ok) {
          status.textContent = "Sign-in succeeded, but the session could not be verified.";
          return;
        }

        status.textContent = "You are signed in to ChinaFlow.";
        button.hidden = true;
        message.textContent = "Authentication complete.";
      } catch {
        status.textContent = "Unable to sign in. Please try again.";
      } finally {
        button.disabled = false;
      }
    });

    return;
  }

  fetch("/api/auth/session")
    .then(async response => {
      if (response.ok) {
        message.textContent = "You are already signed in to ChinaFlow.";
      } else {
        message.textContent = "No active sign-in link was found.";
      }
    })
    .catch(() => {
      message.textContent = "Unable to check your session.";
    });
})();
</script>
</body>
</html>`);
  }

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

  if (url.pathname === LOGOUT_ROUTE) {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    if (request.headers.get("Origin") !== APP_ORIGIN) {
      return json(403, { error: "forbidden" });
    }

    const token = readSessionCookie(request.headers.get("Cookie"));

    if (token) {
      const db = env?.CHINAFLOW_EVENTS;

      if (!db || typeof db.prepare !== "function") {
        throw new Error("D1 binding unavailable");
      }

      await revokeSessionByToken(db, token);
    }

    return json(
      200,
      { ok: true },
      { "Set-Cookie": clearSessionCookie() }
    );
  }

  if (url.pathname === SESSION_ROUTE) {
    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }

    const token = readSessionCookie(request.headers.get("Cookie"));

    if (!token) {
      return json(401, { authenticated: false });
    }

    const db = env?.CHINAFLOW_EVENTS;

    if (!db || typeof db.prepare !== "function") {
      throw new Error("D1 binding unavailable");
    }

    const session = await validateSession(db, token);

    if (!session) {
      return json(
        401,
        { authenticated: false },
        { "Set-Cookie": clearSessionCookie() }
      );
    }

    return json(200, {
      authenticated: true,
      userId: session.userId
    });
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
