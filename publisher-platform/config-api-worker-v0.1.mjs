import { handleRuntimeAssetRequest } from "./runtime-assets-v0.1.mjs";
import { isValidInstallPublicKey } from "./install-public-key-v0.1.mjs";
import {
  buildInstallConfigFromD1,
  buildPublisherConfigFromD1
} from "./config-reader-d1-v0.1.mjs";

const CONFIG_PATH = "/v1/config";

function jsonHeaders(origin = null) {
  const headers = new Headers();

  headers.set(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  headers.set(
    "Cache-Control",
    "no-store"
  );

  headers.set(
    "Vary",
    "Origin"
  );

  if (origin) {
    headers.set(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  return headers;
}

function jsonResponse(
  status,
  body,
  origin = null
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: jsonHeaders(origin)
    }
  );
}

function emptyResponse(
  status,
  origin = null
) {
  const headers = new Headers();

  headers.set(
    "Cache-Control",
    "no-store"
  );

  headers.set(
    "Vary",
    "Origin"
  );

  if (origin) {
    headers.set(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  return new Response(
    null,
    {
      status,
      headers
    }
  );
}

function parsePublisherId(url) {
  const value =
    url.searchParams.get(
      "publisher_id"
    );

  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{2,64}$/.test(value)
  ) {
    return null;
  }

  return value;
}

function parseRequestOrigin(request) {
  const raw =
    request.headers.get("Origin");

  if (!raw) {
    return null;
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  /*
   * Publisher production pages must be HTTPS.
   * Origin is used as the domain ownership boundary.
   */
  if (url.protocol !== "https:") {
    return null;
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return {
    origin: url.origin,
    hostname:
      url.hostname
        .toLowerCase()
        .replace(/\.$/, "")
  };
}

// Strict serialized HTTPS origin; URL parsing supplies ASCII/IDNA normalization.
export function parseInstallRequestOrigin(request) {
  const raw = request.headers.get("Origin");
  if (typeof raw !== "string" || raw.length > 2048 ||
      /[\s\x00-\x1f\x7f\\%]/u.test(raw) ||
      !/^https:\/\/[^/:@?#]+(?::443)?$/i.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  if (url.protocol !== "https:" || url.port || hostname.length > 253 ||
      labels.length < 2 || /^[0-9.]+$/.test(hostname) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return { origin: raw, hostname, boundOrigin: `https://${hostname}` };
}

export async function handleConfigRequest(
  request,
  env
) {
  const url =
    new URL(request.url);

  if (url.pathname !== CONFIG_PATH) {
    return emptyResponse(404);
  }

  if (request.method !== "GET") {
    return emptyResponse(405);
  }

  const hasPublisher = url.searchParams.has("publisher_id");
  const hasInstall = url.searchParams.has("install_key");
  if (hasPublisher === hasInstall) {
    return jsonResponse(400, { error: "invalid_request" });
  }
  if (hasInstall) {
    const keys = url.searchParams.getAll("install_key");
    if (keys.length !== 1 || !isValidInstallPublicKey(keys[0])) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    const origin = parseInstallRequestOrigin(request);
    if (!origin) return emptyResponse(403);
    const config = await buildInstallConfigFromD1(
      env?.CHINAFLOW_EVENTS, keys[0], origin.hostname, origin.boundOrigin
    );
    return config === null ? emptyResponse(403) : jsonResponse(200, config, origin.origin);
  }

  const publisherId =
    parsePublisherId(url);

  if (!publisherId) {
    return jsonResponse(
      400,
      {
        error: "invalid_publisher_id"
      }
    );
  }

  const requestOrigin =
    parseRequestOrigin(request);

  /*
   * Do not trust a caller-supplied hostname query parameter.
   * The browser Origin is the domain identity.
   */
  if (!requestOrigin) {
    return emptyResponse(403);
  }

  const database =
    env && env.CHINAFLOW_EVENTS;

  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new Error(
      "D1 binding unavailable"
    );
  }

  const config =
    await buildPublisherConfigFromD1(
      database,
      publisherId,
      requestOrigin.hostname
    );

  /*
   * Unknown publisher/domain combinations deliberately
   * return 403 and no CORS grant.
   */
  if (config === null) {
    return emptyResponse(403);
  }

  return jsonResponse(
    200,
    config,
    requestOrigin.origin
  );
}

export default {
  async fetch(request, env) {
    try {
      const runtime = await handleRuntimeAssetRequest(request);
      if (runtime) return runtime;
      return await handleConfigRequest(
        request,
        env
      );
    } catch (error) {
      console.error(
        "[ChinaFlow Config API v0.1] Unexpected error",
        error
      );

      return jsonResponse(
        500,
        {
          error: "internal_error"
        }
      );
    }
  }
};
