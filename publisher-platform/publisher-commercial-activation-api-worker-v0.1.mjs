import {
  activatePublisherCommercially,
  validateCommercialActivationInput
} from "./publisher-commercial-activation-v0.1.mjs";

const ROUTE = "/api/internal/commercial-activation";

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

function requireActivationToken(env) {
  const token = env?.ACTIVATION_API_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512 ||
    /[\x00-\x20\x7f]/u.test(token)
  ) {
    throw new Error("ACTIVATION_API_TOKEN binding unavailable or invalid");
  }
  return token;
}

async function digest(value) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    )
  );
}

async function authorized(request, expectedToken) {
  const header = request.headers.get("Authorization");
  if (typeof header !== "string") return false;
  const match = header.match(/^Bearer ([^\s,]{32,512})$/i);
  if (!match) return false;

  const [actualDigest, expectedDigest] = await Promise.all([
    digest(match[1]),
    digest(expectedToken)
  ]);

  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= actualDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
}

async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled.
    }
  }
}

export async function handleActivationApiRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      return json(
        405,
        { error: "method_not_allowed" },
        { Allow: "GET" }
      );
    }

    return json(200, {
      ok: true,
      service: "chinaflow-publisher-activation-api",
      environment: env?.APP_ENVIRONMENT ?? "unknown"
    });
  }

  if (url.pathname !== ROUTE) {
    return json(404, { error: "not_found" });
  }

  if (request.method !== "POST") {
    return json(
      405,
      { error: "method_not_allowed" },
      { Allow: "POST" }
    );
  }

  const expectedToken = requireActivationToken(env);
  if (!await authorized(request, expectedToken)) {
    return json(401, { error: "unauthorized" });
  }

  if (url.search) {
    return json(400, { error: "invalid_input" });
  }

  const input = await readInput(request);
  if (!validateCommercialActivationInput(input)) {
    return json(400, { error: "invalid_input" });
  }

  const database = env?.CHINAFLOW_EVENTS;
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.batch !== "function"
  ) {
    throw new Error("D1 binding unavailable");
  }

  const result = await activatePublisherCommercially(database, input);
  return json(result.status, result.body);
}

export default {
  async fetch(request, env) {
    try {
      return await handleActivationApiRequest(request, env);
    } catch (error) {
      console.error(
        "[ChinaFlow Publisher Activation API v0.1] Unexpected error",
        error
      );
      return json(500, { error: "internal_error" });
    }
  }
};
