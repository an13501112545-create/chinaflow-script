import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { normalizeOnboardingHostname } from "./onboarding-draft-v0.1.mjs";

const OWNER_RELEASE_ALLOWED_ACCOUNT_STATUSES = new Set([
  "draft",
  "pending_review",
  "rejected",
  "active"
]);

const OWNER_RELEASE_SESSION_MAX_AGE_MINUTES = 15;

const failure = (status, error) => ({ status, body: { error } });

function validPublisherId(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

async function readJsonObject(request, maxBytes = 4096) {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
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

    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function claimLifecycleMutationsEnabled(env) {
  return env?.CLAIM_LIFECYCLE_MUTATIONS_ENABLED === "true";
}

export function validateOwnerReleaseInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "hostname") return null;
  const hostname = normalizeOnboardingHostname(input.hostname);
  return hostname ? { hostname } : null;
}

export async function readOwnerReleaseInput(request) {
  const input = await readJsonObject(request);
  return validateOwnerReleaseInput(input);
}

export async function readAdminRevokeInput(request) {
  const input = await readJsonObject(request);
  return validateAdminRevokeInput(input);
}

export function validateAdminRevokeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "hostname" || keys[1] !== "publisher_id") {
    return null;
  }
  const hostname = normalizeOnboardingHostname(input.hostname);
  if (!hostname || !validPublisherId(input.publisher_id)) return null;
  return { publisherId: input.publisher_id, hostname };
}

async function ownerReleaseSessionIsFresh(database, session) {
  const row = await database.prepare(`
    SELECT
      CASE
        WHEN julianday(created_at) >= julianday('now', '-15 minutes')
         AND julianday(created_at) <= julianday('now', '+1 minute')
        THEN 1
        ELSE 0
      END AS is_fresh
    FROM publisher_sessions
    WHERE session_id = ?
      AND user_id = ?
      AND revoked_at IS NULL
      AND julianday(expires_at) > julianday('now')
    LIMIT 1
  `).bind(
    session.sessionId,
    session.userId
  ).first();

  return Number(row?.is_fresh ?? 0) === 1;
}

async function readOwnerState(database, session, hostname) {
  const result = await database.prepare(`
    SELECT
      p.publisher_id,
      p.account_status,
      d.domain_id,
      d.hostname,
      d.verification_status,
      d.claim_status,
      d.claim_acquired_at,
      d.claim_ended_at,
      d.claim_end_reason,
      d.monetization_status
    FROM publisher_memberships m
    JOIN publishers p
      ON p.publisher_id = m.publisher_id
    JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    WHERE m.user_id = ?
      AND m.role = 'owner'
      AND m.membership_status = 'active'
      AND d.hostname = ?
      AND EXISTS (
        SELECT 1
        FROM publisher_sessions s
        JOIN publisher_users u
          ON u.user_id = s.user_id
        WHERE s.session_id = ?
          AND s.user_id = ?
          AND s.revoked_at IS NULL
          AND julianday(s.expires_at) > julianday('now')
          AND julianday(s.created_at) >= julianday('now', '-15 minutes')
          AND julianday(s.created_at) <= julianday('now', '+1 minute')
          AND u.user_status = 'active'
      )
    ORDER BY m.created_at, m.membership_id, d.domain_id
  `).bind(
    session.userId,
    hostname,
    session.sessionId,
    session.userId
  ).all();

  const rows = result?.results ?? [];
  if (rows.length === 0) return failure(404, "not_found");
  if (rows.length !== 1) return failure(409, "conflict");
  return { state: rows[0] };
}

function ownerReleaseResponse(state, released) {
  return {
    status: 200,
    body: {
      claim: {
        hostname: state.hostname,
        claim_status: "released",
        monetization_status: state.monetization_status,
        released
      }
    }
  };
}

export async function releasePublisherHostname(database, token, input) {
  const valid = validateOwnerReleaseInput(input);
  if (!valid) return failure(400, "invalid_input");

  const session = await validateSession(database, token);
  if (!session) return failure(401, "unauthenticated");
  if (!await ownerReleaseSessionIsFresh(database, session)) {
    return failure(401, "reauth_required");
  }

  const initialResult = await readOwnerState(database, session, valid.hostname);
  if (initialResult.status) return initialResult;
  const initial = initialResult.state;

  if (!OWNER_RELEASE_ALLOWED_ACCOUNT_STATUSES.has(initial.account_status)) {
    return failure(409, "conflict");
  }
  if (initial.claim_status === "released") {
    return ownerReleaseResponse(initial, false);
  }
  if (initial.claim_status !== "claimed" ||
      initial.verification_status !== "verified" ||
      initial.claim_acquired_at === null) {
    return failure(409, "conflict");
  }

  const updated = await database.prepare(`
    UPDATE publisher_domains
    SET claim_status = 'released',
        claim_ended_at = CURRENT_TIMESTAMP,
        claim_end_reason = 'owner_release',
        monetization_status =
          CASE
            WHEN monetization_status = 'enabled' THEN 'paused'
            ELSE monetization_status
          END,
        updated_at = CURRENT_TIMESTAMP
    WHERE domain_id = ?
      AND publisher_id = ?
      AND hostname = ?
      AND is_primary = 1
      AND verification_status = 'verified'
      AND claim_status = 'claimed'
      AND claim_acquired_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM publisher_memberships m
        JOIN publishers p
          ON p.publisher_id = m.publisher_id
        JOIN publisher_sessions s
          ON s.user_id = m.user_id
        JOIN publisher_users u
          ON u.user_id = s.user_id
        WHERE m.publisher_id = publisher_domains.publisher_id
          AND m.user_id = ?
          AND m.role = 'owner'
          AND m.membership_status = 'active'
          AND p.publisher_id = publisher_domains.publisher_id
          AND p.account_status IN ('draft','pending_review','rejected','active')
          AND s.session_id = ?
          AND s.user_id = ?
          AND s.revoked_at IS NULL
          AND julianday(s.expires_at) > julianday('now')
          AND julianday(s.created_at) >= julianday('now', '-15 minutes')
          AND julianday(s.created_at) <= julianday('now', '+1 minute')
          AND u.user_status = 'active'
      )
    RETURNING hostname,claim_status,monetization_status
  `).bind(
    initial.domain_id,
    initial.publisher_id,
    initial.hostname,
    session.userId,
    session.sessionId,
    session.userId
  ).first();

  if (updated) return ownerReleaseResponse(updated, true);

  const currentSession = await validateSession(database, token);
  if (!currentSession) return failure(401, "unauthenticated");
  const currentResult = await readOwnerState(
    database,
    currentSession,
    valid.hostname
  );
  if (currentResult.status) return currentResult;
  const current = currentResult.state;
  if (current.claim_status === "released") {
    return ownerReleaseResponse(current, false);
  }
  return failure(409, "conflict");
}

async function readAdminState(database, publisherId, hostname) {
  const row = await database.prepare(`
    SELECT
      p.publisher_id,
      p.account_status,
      d.domain_id,
      d.hostname,
      d.verification_status,
      d.claim_status,
      d.claim_acquired_at,
      d.claim_ended_at,
      d.claim_end_reason,
      d.monetization_status
    FROM publishers p
    JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    WHERE p.publisher_id = ?
      AND d.hostname = ?
    LIMIT 1
  `).bind(publisherId, hostname).first();
  return row ?? null;
}

function adminRevokeResponse(state, revoked) {
  return {
    status: 200,
    body: {
      claim: {
        publisher_id: state.publisher_id,
        hostname: state.hostname,
        claim_status: "revoked",
        monetization_status: state.monetization_status,
        revoked
      }
    }
  };
}

export async function revokePublisherHostname(database, input) {
  const valid = validateAdminRevokeInput(input);
  if (!valid) return failure(400, "invalid_input");

  const initial = await readAdminState(
    database,
    valid.publisherId,
    valid.hostname
  );
  if (!initial) return failure(404, "not_found");
  if (initial.claim_status === "revoked") {
    return adminRevokeResponse(initial, false);
  }
  if (initial.claim_status !== "claimed" ||
      initial.verification_status !== "verified" ||
      initial.claim_acquired_at === null) {
    return failure(409, "conflict");
  }

  const updated = await database.prepare(`
    UPDATE publisher_domains
    SET claim_status = 'revoked',
        claim_ended_at = CURRENT_TIMESTAMP,
        claim_end_reason = 'admin_revoke',
        monetization_status =
          CASE
            WHEN monetization_status = 'enabled' THEN 'paused'
            ELSE monetization_status
          END,
        updated_at = CURRENT_TIMESTAMP
    WHERE domain_id = ?
      AND publisher_id = ?
      AND hostname = ?
      AND is_primary = 1
      AND verification_status = 'verified'
      AND claim_status = 'claimed'
      AND claim_acquired_at IS NOT NULL
    RETURNING publisher_id,hostname,claim_status,monetization_status
  `).bind(
    initial.domain_id,
    initial.publisher_id,
    initial.hostname
  ).first();

  if (updated) return adminRevokeResponse(updated, true);

  const current = await readAdminState(
    database,
    valid.publisherId,
    valid.hostname
  );
  if (!current) return failure(404, "not_found");
  if (current.claim_status === "revoked") {
    return adminRevokeResponse(current, false);
  }
  return failure(409, "conflict");
}
