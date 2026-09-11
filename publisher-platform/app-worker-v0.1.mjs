function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    }
  });
}

export async function handleAppRequest(request, env) {
  const url = new URL(request.url);

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
