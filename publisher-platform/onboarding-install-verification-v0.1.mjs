import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { TERMS_VERSION } from "./onboarding-terms-v0.1.mjs";
import { isValidInstallPublicKey } from "./install-public-key-v0.1.mjs";

const failure = (status, error) => ({
  status,
  body: { error }
});

export async function authorizeInstallVerification(
  database,
  token
) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new Error("D1 binding unavailable");
  }

  const session =
    await validateSession(database, token);

  if (!session) {
    return failure(401, "unauthenticated");
  }

  /*
   * Authorization is derived exclusively from the
   * authenticated user's active owner membership.
   *
   * No publisher_id, hostname, install key or URL is
   * accepted from the client.
   */
  const result = await database.prepare(`
    SELECT
      m.publisher_id,
      p.account_status,
      p.terms_version,
      p.terms_accepted_at,
      p.terms_accepted_by_user_id,
      p.install_public_key,
      d.domain_id,
      d.hostname,
      d.install_status,
      d.verification_status

    FROM publisher_memberships m

    JOIN publishers p
      ON p.publisher_id = m.publisher_id

    LEFT JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1

    WHERE m.user_id = ?
      AND m.membership_status = 'active'
      AND m.role = 'owner'

    ORDER BY m.created_at, m.membership_id
  `).bind(
    session.userId
  ).all();

  const rows =
    Array.isArray(result?.results)
      ? result.results
      : [];

  if (rows.length === 0) {
    return failure(403, "forbidden");
  }

  /*
   * Verification v1 deliberately refuses ambiguous
   * tenant selection.
   */
  if (rows.length !== 1) {
    return failure(409, "conflict");
  }

  const row = rows[0];

  if (row.account_status !== "draft") {
    return failure(409, "conflict");
  }

  const termsAccepted =
    row.terms_version === TERMS_VERSION &&
    row.terms_accepted_at !== null &&
    row.terms_accepted_by_user_id !== null;

  if (!termsAccepted) {
    return failure(409, "conflict");
  }

  /*
   * A draft eligible for website verification must
   * already have the server-issued install identity
   * and exactly one primary domain.
   */
  if (
    !isValidInstallPublicKey(row.install_public_key) ||
    typeof row.domain_id !== "string" ||
    !row.domain_id ||
    typeof row.hostname !== "string" ||
    !row.hostname
  ) {
    return failure(409, "conflict");
  }

  return {
    status: 200,
    body: {
      authorized: true
    },

    context: {
      userId: session.userId,
      sessionId: session.sessionId,
      publisherId: row.publisher_id,
      domainId: row.domain_id,
      hostname: row.hostname,
      installPublicKey: row.install_public_key,
      installStatus: row.install_status,
      verificationStatus: row.verification_status
    }
  };
}


const INSTALL_VERIFICATION_MAX_BYTES = 256 * 1024;
const INSTALL_VERIFICATION_MAX_REDIRECTS = 3;
const INSTALL_VERIFICATION_TIMEOUT_MS = 8000;

function canonicalRuntimeOrigin(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048
  ) {
    return null;
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    return null;
  }

  return value;
}

function canonicalVerificationHostname(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 253 ||
    /[\s\x00-\x1f\x7f/:@?#\\%]/u.test(value)
  ) {
    return null;
  }

  const hostname =
    value.toLowerCase().replace(/\.$/, "");

  const labels = hostname.split(".");

  if (
    labels.length < 2 ||
    /^[0-9.]+$/.test(hostname) ||
    labels.some(
      label =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          label
        )
    )
  ) {
    return null;
  }

  return hostname;
}

function findTagEnd(source, start) {
  let quote = null;

  for (
    let index = start;
    index < source.length;
    index++
  ) {
    const char = source[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ">") {
      return index;
    }
  }

  return -1;
}

function parseHtmlAttributes(source) {
  const attributes = new Map();

  const pattern =
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  let match;

  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();

    /*
     * HTML parsing keeps the first duplicate attribute.
     * Mirroring that behavior avoids ambiguity.
     */
    if (attributes.has(name)) {
      continue;
    }

    const value =
      match[2] ??
      match[3] ??
      match[4] ??
      "";

    attributes.set(name, value);
  }

  return attributes;
}

function htmlContainsInstallation(
  html,
  expectedLoader,
  installPublicKey
) {
  let position = 0;

  while (position < html.length) {
    const open = html.indexOf("<", position);

    if (open === -1) {
      return false;
    }

    /*
     * Skip HTML comments entirely so strings inside them
     * cannot become installation evidence.
     */
    if (html.startsWith("<!--", open)) {
      const endComment =
        html.indexOf("-->", open + 4);

      if (endComment === -1) {
        return false;
      }

      position = endComment + 3;
      continue;
    }

    const nameMatch =
      /^<\s*([A-Za-z][A-Za-z0-9:-]*)\b/.exec(
        html.slice(open)
      );

    if (!nameMatch) {
      position = open + 1;
      continue;
    }

    const tagName =
      nameMatch[1].toLowerCase();

    const tagEnd =
      findTagEnd(
        html,
        open + nameMatch[0].length
      );

    if (tagEnd === -1) {
      return false;
    }

    if (tagName !== "script") {
      position = tagEnd + 1;
      continue;
    }

    const attributeStart =
      open + nameMatch[0].length;

    const attributeSource =
      html.slice(
        attributeStart,
        tagEnd
      );

    const attributes =
      parseHtmlAttributes(attributeSource);

    if (
      attributes.get("src") === expectedLoader &&
      attributes.get("data-chinaflow-install") ===
        installPublicKey
    ) {
      return true;
    }

    /*
     * Script content is a raw-text HTML element.
     * Skip to its closing tag so a literal "<script ..."
     * inside JavaScript cannot create false evidence.
     */
    const lowerTail =
      html.toLowerCase();

    const close =
      lowerTail.indexOf(
        "</script",
        tagEnd + 1
      );

    if (close === -1) {
      return false;
    }

    const closeEnd =
      findTagEnd(
        html,
        close + "</script".length
      );

    if (closeEnd === -1) {
      return false;
    }

    position = closeEnd + 1;
  }

  return false;
}

async function readHtmlWithLimit(
  response,
  limit = INSTALL_VERIFICATION_MAX_BYTES
) {
  if (!response.body) {
    return {
      ok: true,
      text: ""
    };
  }

  const reader =
    response.body.getReader();

  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const {
        done,
        value
      } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > limit) {
        void reader.cancel().catch(() => {});

        return {
          ok: false,
          reason: "response_too_large"
        };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes =
    new Uint8Array(size);

  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    text: new TextDecoder("utf-8").decode(bytes)
  };
}

function redirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

export async function inspectPublisherInstallation({
  hostname,
  installPublicKey,
  runtimeOrigin,
  fetchFn = fetch
}) {
  const normalizedHostname =
    canonicalVerificationHostname(hostname);

  const normalizedRuntimeOrigin =
    canonicalRuntimeOrigin(runtimeOrigin);

  if (
    !normalizedHostname ||
    !normalizedRuntimeOrigin ||
    !isValidInstallPublicKey(installPublicKey) ||
    typeof fetchFn !== "function"
  ) {
    throw new Error(
      "Invalid installation verification input"
    );
  }

  const expectedOrigin =
    `https://${normalizedHostname}`;

  const expectedLoader =
    normalizedRuntimeOrigin +
    "/runtime/loader.js";

  let currentUrl =
    expectedOrigin + "/";

  for (
    let redirectCount = 0;
    redirectCount <= INSTALL_VERIFICATION_MAX_REDIRECTS;
    redirectCount++
  ) {
    let response;

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        INSTALL_VERIFICATION_TIMEOUT_MS
      );

    try {
      response =
        await fetchFn(
          currentUrl,
          {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "text/html"
            }
          }
        );
    } catch {
      return {
        detected: false,
        reason: "fetch_failed"
      };
    } finally {
      clearTimeout(timeout);
    }

    if (redirectStatus(response.status)) {
      const location =
        response.headers.get("Location");

      if (!location) {
        return {
          detected: false,
          reason: "unsafe_redirect"
        };
      }

      if (
        redirectCount >=
        INSTALL_VERIFICATION_MAX_REDIRECTS
      ) {
        return {
          detected: false,
          reason: "redirect_limit"
        };
      }

      let next;

      try {
        next =
          new URL(
            location,
            currentUrl
          );
      } catch {
        return {
          detected: false,
          reason: "unsafe_redirect"
        };
      }

      /*
       * Redirects may change path/query only.
       * Scheme, hostname and port remain pinned to the
       * registered HTTPS origin.
       */
      if (
        next.origin !== expectedOrigin ||
        next.username ||
        next.password
      ) {
        return {
          detected: false,
          reason: "unsafe_redirect"
        };
      }

      currentUrl = next.href;
      continue;
    }

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      return {
        detected: false,
        reason: "http_status"
      };
    }

    const contentType =
      response.headers.get("Content-Type") ?? "";

    if (
      !/^text\/html(?:\s*;|$)/i.test(
        contentType
      )
    ) {
      return {
        detected: false,
        reason: "not_html"
      };
    }

    const body =
      await readHtmlWithLimit(response);

    if (!body.ok) {
      return {
        detected: false,
        reason: body.reason
      };
    }

    return htmlContainsInstallation(
      body.text,
      expectedLoader,
      installPublicKey
    )
      ? {
          detected: true
        }
      : {
          detected: false,
          reason: "loader_not_found"
        };
  }

  return {
    detected: false,
    reason: "redirect_limit"
  };
}


function validVerificationContext(context) {
  return (
    context &&
    typeof context === "object" &&
    typeof context.userId === "string" &&
    context.userId &&
    typeof context.sessionId === "string" &&
    context.sessionId &&
    typeof context.publisherId === "string" &&
    context.publisherId &&
    typeof context.domainId === "string" &&
    context.domainId &&
    typeof context.hostname === "string" &&
    context.hostname &&
    isValidInstallPublicKey(
      context.installPublicKey
    )
  );
}

const VERIFICATION_FAILURE_REASONS =
  new Set([
    "loader_not_found",
    "not_html",
    "unsafe_redirect",
    "http_status",
    "fetch_failed",
    "response_too_large",
    "redirect_limit"
  ]);

function validateVerificationResult(result) {
  if (
    result &&
    typeof result === "object" &&
    result.detected === true &&
    Object.keys(result).length === 1
  ) {
    return {
      detected: true
    };
  }

  if (
    result &&
    typeof result === "object" &&
    result.detected === false &&
    typeof result.reason === "string" &&
    VERIFICATION_FAILURE_REASONS.has(
      result.reason
    ) &&
    Object.keys(result).length === 2
  ) {
    return {
      detected: false,
      reason: result.reason
    };
  }

  return null;
}

function verificationEligibilitySql() {
  return `
    publisher_domains.domain_id = ?
    AND publisher_domains.publisher_id = ?
    AND publisher_domains.hostname = ?
    AND publisher_domains.is_primary = 1

    AND EXISTS (
      SELECT 1
      FROM publishers p
      WHERE p.publisher_id =
        publisher_domains.publisher_id
        AND p.account_status = 'draft'
        AND p.terms_version = ?
        AND p.terms_accepted_at IS NOT NULL
        AND p.terms_accepted_by_user_id
          IS NOT NULL
        AND p.install_public_key = ?
    )

    AND EXISTS (
      SELECT 1
      FROM publisher_memberships m
      WHERE m.publisher_id =
        publisher_domains.publisher_id
        AND m.user_id = ?
        AND m.role = 'owner'
        AND m.membership_status = 'active'
    )

    AND EXISTS (
      SELECT 1
      FROM publisher_sessions s
      JOIN publisher_users u
        ON u.user_id = s.user_id
      WHERE s.session_id = ?
        AND s.user_id = ?
        AND s.revoked_at IS NULL
        AND julianday(s.expires_at) >
            julianday('now')
        AND u.user_status = 'active'
    )
  `;
}

function verificationBindings(context) {
  return [
    context.domainId,
    context.publisherId,
    context.hostname,
    TERMS_VERSION,
    context.installPublicKey,
    context.userId,
    context.sessionId,
    context.userId
  ];
}

export async function recordInstallVerificationResult(
  database,
  context,
  result
) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new Error("D1 binding unavailable");
  }

  if (!validVerificationContext(context)) {
    throw new Error(
      "Invalid installation verification context"
    );
  }

  const verifiedResult =
    validateVerificationResult(result);

  if (!verifiedResult) {
    throw new Error(
      "Invalid installation verification result"
    );
  }

  /*
   * The persistence boundary repeats every eligibility
   * check that matters. Authorization context is only
   * a snapshot and is never trusted by itself.
   *
   * Each outcome is one conditional UPDATE statement,
   * so eligibility and state mutation share one SQLite
   * write boundary.
   */
  if (verifiedResult.detected) {
    let row;
    try {
      row =
        await database.prepare(`
          UPDATE publisher_domains
          SET
            install_status = 'detected',
            verification_status = 'verified',
            claim_status = 'claimed',
            claim_acquired_at =
              CASE
                WHEN claim_status = 'claimed'
                  THEN claim_acquired_at
                ELSE CURRENT_TIMESTAMP
              END,
            claim_ended_at = NULL,
            claim_end_reason = NULL,
            first_seen_at =
              COALESCE(
                first_seen_at,
                CURRENT_TIMESTAMP
              ),
            last_seen_at = CURRENT_TIMESTAMP,
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP

          WHERE ${verificationEligibilitySql()}

          RETURNING
            install_status,
            verification_status
        `).bind(
          ...verificationBindings(context)
        ).first();
    } catch (error) {
      // Only this exact single-column UNIQUE violation is a hostname claim conflict.
      const messages = [error?.message, error?.cause?.message];
      if (messages.some(message =>
        typeof message === "string" &&
        /(?:^|: )UNIQUE constraint failed: publisher_domains\.hostname(?=$|: SQLITE_CONSTRAINT(?:_UNIQUE| \(extended: SQLITE_CONSTRAINT_UNIQUE\))?$)/.test(message)
      )) {
        return failure(409, "conflict");
      }
      throw error;
    }

    if (!row) {
      return failure(
        409,
        "conflict"
      );
    }

    return {
      status: 200,
      body: {
        verification: {
          detected: true,
          install_status:
            row.install_status,
          verification_status:
            row.verification_status
        }
      }
    };
  }

  /*
   * A failed observation is retryable.
   *
   * Do not write verification_status='failed' and do
   * not fabricate first_seen / last_seen / verified_at.
   * If a prior successful verification exists, its
   * verification evidence is preserved; only the
   * current installation observation becomes
   * not_detected.
   */
  const row =
    await database.prepare(`
      UPDATE publisher_domains
      SET
        install_status = 'not_detected',
        updated_at = CURRENT_TIMESTAMP

      WHERE ${verificationEligibilitySql()}

      RETURNING
        install_status,
        verification_status
    `).bind(
      ...verificationBindings(context)
    ).first();

  if (!row) {
    return failure(
      409,
      "conflict"
    );
  }

  return {
    status: 200,
    body: {
      verification: {
        detected: false,
        reason: verifiedResult.reason,
        install_status:
          row.install_status,
        verification_status:
          row.verification_status
      }
    }
  };
}


export async function verifyPublisherInstallation({
  database,
  token,
  runtimeOrigin,
  fetchFn = fetch
}) {
  /*
   * Authorization must complete before any outbound
   * request. This prevents unauthenticated or
   * unauthorized callers from turning ChinaFlow into
   * a network-fetch primitive.
   */
  const authorization =
    await authorizeInstallVerification(
      database,
      token
    );

  if (authorization.status !== 200) {
    return {
      status: authorization.status,
      body: authorization.body
    };
  }

  const context =
    authorization.context;

  /*
   * Hostname and install identity come only from the
   * server-derived authorization context.
   * The caller supplies neither value.
   */
  const inspection =
    await inspectPublisherInstallation({
      hostname: context.hostname,
      installPublicKey:
        context.installPublicKey,
      runtimeOrigin,
      fetchFn
    });

  /*
   * Persistence re-checks all authorization and tenant
   * invariants at the SQLite write boundary, protecting
   * against state changes during the network request.
   */
  return recordInstallVerificationResult(
    database,
    context,
    inspection
  );
}
