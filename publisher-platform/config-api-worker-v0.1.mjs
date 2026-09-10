import {
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
