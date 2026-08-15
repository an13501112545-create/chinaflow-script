const MAX_BODY_BYTES = 32 * 1024;

const ALLOWED_ORIGINS = new Set([
  "https://www.flightflex.ca",
  "https://flightflex.ca"
]);

const ALLOWED_EVENT_TYPES = new Set([
  "cta_impression",
  "cta_click"
]);

const REQUIRED_STRING_FIELDS = [
  "event_schema_version",
  "event_id",
  "event_type",
  "timestamp",
  "publisher_id",
  "session_id",
  "page_url",
  "routing_mode",
  "placement",
  "destination_url",
  "engine_version",
  "config_version"
];

const INSERT_EVENT_SQL = `
INSERT OR IGNORE INTO events (
  event_id,
  event_schema_version,
  event_type,
  occurred_at,
  publisher_id,
  session_id,
  page_url,
  page_path,
  page_title,
  referrer,
  routing_mode,
  china_intent,
  china_intent_score,
  product_intent,
  product_score,
  routing_reason,
  rule_id,
  offer_id,
  placement,
  trip_sub1,
  supplier,
  destination_url,
  engine_version,
  config_version,
  viewport_width,
  viewport_height,
  external_attribution_id
)
VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)`;


class PayloadTooLargeError extends Error {}


function isAllowedOrigin(origin) {
  return (
    origin === null ||
    ALLOWED_ORIGINS.has(origin)
  );
}


function createCorsHeaders(
  origin,
  includePreflightHeaders = false
) {
  const headers =
    new Headers();

  headers.set(
    "Vary",
    "Origin"
  );

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    headers.set(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  if (includePreflightHeaders) {
    headers.set(
      "Access-Control-Allow-Methods",
      "POST, OPTIONS"
    );
    headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );
    headers.set(
      "Access-Control-Max-Age",
      "86400"
    );
  }

  return headers;
}


function emptyResponse(
  status,
  origin,
  includePreflightHeaders = false
) {
  return new Response(
    null,
    {
      status:
        status,
      headers:
        createCorsHeaders(
          origin,
          includePreflightHeaders
        )
    }
  );
}


async function readBodyTextWithLimit(
  request
) {
  const contentLength =
    request.headers.get(
      "Content-Length"
    );

  if (contentLength !== null) {
    const declaredBytes =
      Number(contentLength);

    if (
      Number.isFinite(declaredBytes) &&
      declaredBytes > MAX_BODY_BYTES
    ) {
      throw new PayloadTooLargeError();
    }
  }

  if (!request.body) {
    return "";
  }

  const reader =
    request.body.getReader();
  const decoder =
    new TextDecoder();

  let totalBytes = 0;
  let bodyText = "";

  try {
    while (true) {
      const result =
        await reader.read();

      if (result.done) {
        break;
      }

      totalBytes +=
        result.value.byteLength;

      if (totalBytes > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch (error) {
          // Cancellation is best-effort after the limit is exceeded.
        }

        throw new PayloadTooLargeError();
      }

      bodyText +=
        decoder.decode(
          result.value,
          {
            stream: true
          }
        );
    }

    bodyText +=
      decoder.decode();

    return bodyText;

  } finally {
    reader.releaseLock();
  }
}


function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}


function isValidEvent(event) {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    return false;
  }

  const hasRequiredFields =
    REQUIRED_STRING_FIELDS.every(
      field =>
        isNonEmptyString(
          event[field]
        )
    );

  if (!hasRequiredFields) {
    return false;
  }

  if (
    event.event_schema_version !==
      "0.1"
  ) {
    return false;
  }

  if (
    !ALLOWED_EVENT_TYPES.has(
      event.event_type
    )
  ) {
    return false;
  }

  if (
    Number.isNaN(
      Date.parse(event.timestamp)
    )
  ) {
    return false;
  }

  return true;
}


function toNullableString(value) {
  return typeof value === "string"
    ? value
    : null;
}


function toNullableInteger(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  )
    ? Math.trunc(value)
    : null;
}


function toNullableChinaIntent(value) {
  if (value === true) {
    return 1;
  }

  if (value === false) {
    return 0;
  }

  return null;
}


function createEventBindings(event) {
  return [
    event.event_id,
    event.event_schema_version,
    event.event_type,
    event.timestamp,
    event.publisher_id,
    event.session_id,
    event.page_url,
    toNullableString(event.page_path),
    toNullableString(event.page_title),
    toNullableString(event.referrer),
    event.routing_mode,
    toNullableChinaIntent(event.china_intent),
    toNullableInteger(event.china_intent_score),
    toNullableString(event.product_intent),
    toNullableInteger(event.product_score),
    toNullableString(event.routing_reason),
    toNullableString(event.rule_id),
    toNullableString(event.offer_id),
    event.placement,
    toNullableString(event.trip_sub1),
    toNullableString(event.supplier),
    event.destination_url,
    event.engine_version,
    event.config_version,
    toNullableInteger(event.viewport_width),
    toNullableInteger(event.viewport_height),
    toNullableString(event.external_attribution_id)
  ];
}


async function persistEvent(event, env) {
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

  await database
    .prepare(INSERT_EVENT_SQL)
    .bind(...createEventBindings(event))
    .run();
}


async function handleEventPost(
  request,
  origin,
  env
) {
  let bodyText;

  try {
    bodyText =
      await readBodyTextWithLimit(
        request
      );
  } catch (error) {
    if (
      error instanceof
        PayloadTooLargeError
    ) {
      return emptyResponse(
        413,
        origin
      );
    }

    throw error;
  }

  let event;

  try {
    event =
      JSON.parse(bodyText);
  } catch (error) {
    return emptyResponse(
      400,
      origin
    );
  }

  if (!isValidEvent(event)) {
    return emptyResponse(
      400,
      origin
    );
  }

  await persistEvent(
    event,
    env
  );

  console.log(
    "[ChinaFlow Event Collector v0.1]",
    {
      event_id:
        event.event_id,
      event_type:
        event.event_type,
      publisher_id:
        event.publisher_id
    }
  );

  return emptyResponse(
    204,
    origin
  );
}


async function handleRequest(request, env) {
  const url =
    new URL(request.url);
  const origin =
    request.headers.get("Origin");

  if (url.pathname !== "/v1/events") {
    return emptyResponse(
      404,
      origin
    );
  }

  if (!isAllowedOrigin(origin)) {
    return emptyResponse(
      403,
      null
    );
  }

  if (request.method === "OPTIONS") {
    return emptyResponse(
      204,
      origin,
      true
    );
  }

  if (request.method !== "POST") {
    return emptyResponse(
      405,
      origin
    );
  }

  return handleEventPost(
    request,
    origin,
    env
  );
}


export default {
  async fetch(request, env) {
    try {
      return await handleRequest(
        request,
        env
      );
    } catch (error) {
      console.error(
        "[ChinaFlow Event Collector v0.1] Unexpected error"
      );

      const origin =
        request.headers.get("Origin");

      return emptyResponse(
        500,
        isAllowedOrigin(origin)
          ? origin
          : null
      );
    }
  }
};
