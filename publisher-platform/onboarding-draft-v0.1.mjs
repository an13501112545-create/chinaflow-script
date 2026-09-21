import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { generateInstallPublicKey } from "./install-public-key-v0.1.mjs";

export function normalizeOnboardingHostname(value) {
  if (typeof value !== "string" || !value || value.length > 1024 ||
      /[\s\x00-\x1f\x7f/:@?#\\%]/u.test(value)) return null;
  let hostname;
  try {
    hostname = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch { return null; }
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^[0-9.]+$/.test(hostname)) return null;
  return hostname;
}

export function validateDraftInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["display_name", "hostname"].includes(key)) ||
      typeof body.display_name !== "string" || body.display_name.length > 200 ||
      !body.display_name.trim() || /[\x00-\x1f\x7f<>]/u.test(body.display_name)) return null;
  const hostname = normalizeOnboardingHostname(body.hostname);
  return hostname ? { display_name: body.display_name.trim(), hostname } : null;
}

// Enforce the byte limit while reading, including chunked requests.
export async function readDraftInput(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return validateDraftInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

const ELIGIBLE_SESSION = `SELECT 1 FROM publisher_sessions s
  JOIN publisher_users u ON u.user_id = s.user_id
  WHERE s.session_id = ? AND s.user_id = ? AND s.revoked_at IS NULL
    AND julianday(s.expires_at) > julianday('now') AND u.user_status = 'active'`;

async function readAuthorizedDraft(database, session, includePendingReview = false) {
  const row = await database.prepare(`
    SELECT p.publisher_id, p.slug, p.display_name, p.account_status, p.install_public_key,
      d.hostname, d.install_status, d.verification_status, d.review_status,
      d.monetization_status, d.reviewed_at
    FROM publisher_memberships m
    JOIN publishers p ON p.publisher_id = m.publisher_id
    JOIN publisher_domains d ON d.publisher_id = p.publisher_id AND d.is_primary = 1
    WHERE m.user_id = ? AND m.membership_status = 'active' AND (p.account_status = 'draft' ${includePendingReview ? "OR p.account_status IN ('pending_review', 'rejected')" : ""})
      AND EXISTS (${ELIGIBLE_SESSION})
    ORDER BY m.created_at, m.membership_id LIMIT 1
  `).bind(session.userId, session.sessionId, session.userId).first();
  if (!row) return null;
  return {
    publisher: { publisher_id: row.publisher_id, slug: row.slug,
      display_name: row.display_name, account_status: row.account_status,
      install_public_key: row.install_public_key },
    primary_domain: { hostname: row.hostname, install_status: row.install_status,
      verification_status: row.verification_status, review_status: row.review_status,
      monetization_status: row.monetization_status, reviewed_at: row.reviewed_at }
  };
}

function uniqueField(error) {
  // D1 wraps SQLite's message. Recognize only these exact single-column failures;
  // other constraints and unexpected errors must never trigger a retry.
  const messages = [error?.message, error?.cause?.message].filter(value => typeof value === "string");
  for (const message of messages) {
    const match = message.match(/(?:^|: )UNIQUE constraint failed: (publishers\.(?:publisher_id|slug|install_public_key)|publisher_domains\.hostname)(?=$|: SQLITE_CONSTRAINT(?:_(UNIQUE|PRIMARYKEY)| \(extended: SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)\))?$)/);
    if (match && ((match[2] || match[3]) !== "PRIMARYKEY" ||
        match[1] === "publishers.publisher_id")) return match[1];
  }
  return null;
}

export async function getOnboardingDraft(database, token) {
  const session = await validateSession(database, token);
  if (!session) return { status: 401, body: { error: "unauthenticated" } };
  const draft = await readAuthorizedDraft(database, session, true);
  return draft ? { status: 200, body: { draft } } : { status: 404, body: { error: "not_found" } };
}

export async function createOnboardingDraft(database, token, input) {
  const session = await validateSession(database, token);
  if (!session) return { status: 401, body: { error: "unauthenticated" } };
  const valid = validateDraftInput(input);
  if (!valid) return { status: 400, body: { error: "invalid_input" } };

  for (let attempt = 0; attempt < 3; attempt++) {
    const publisherId = `pub_${crypto.randomUUID()}`;
    const slug = `pub-${crypto.randomUUID()}`;
    const membershipId = `mem_${crypto.randomUUID()}`;
    const domainId = `dom_${crypto.randomUUID()}`;
    const installPublicKey = generateInstallPublicKey();
    let results;
    try {
      results = await database.batch([
        database.prepare(`INSERT INTO publishers (
          publisher_id, slug, display_name, install_public_key
        )
          SELECT ?, ?, ?, ? WHERE EXISTS (${ELIGIBLE_SESSION})
          AND NOT EXISTS (SELECT 1 FROM publisher_memberships WHERE user_id = ?)
        `).bind(
          publisherId, slug, valid.display_name, installPublicKey,
          session.sessionId, session.userId, session.userId
        ),
        // changes() is the immediately preceding statement's row count in this
        // sequential atomic batch. EXISTS alone is unsafe on generated ID collision
        // when the first INSERT selects zero rows.
        database.prepare(`INSERT INTO publisher_memberships (membership_id, publisher_id, user_id)
          SELECT ?, p.publisher_id, ? FROM publishers p
          WHERE p.publisher_id = ? AND changes() = 1
        `).bind(membershipId, session.userId, publisherId),
        database.prepare(`INSERT INTO publisher_domains (domain_id, publisher_id, hostname, is_primary)
          SELECT ?, m.publisher_id, ?, 1 FROM publisher_memberships m
          WHERE m.membership_id = ? AND m.publisher_id = ? AND m.user_id = ? AND changes() = 1
        `).bind(domainId, valid.hostname, membershipId, publisherId, session.userId)
      ]);
    } catch (error) {
      const field = uniqueField(error);
      if (field === "publishers.publisher_id" ||
          field === "publishers.slug" ||
          field === "publishers.install_public_key") {
        if (attempt < 2) continue;
        return { status: 503, body: { error: "temporarily_unavailable" } };
      }
      if (field === "publisher_domains.hostname") return { status: 409, body: { error: "conflict" } };
      throw error;
    }
    // Read only through membership authorization, including on zero-row retries.
    const current = await validateSession(database, token);
    if (!current) return { status: 401, body: { error: "unauthenticated" } };
    const draft = await readAuthorizedDraft(database, current);
    if (!draft || draft.publisher.display_name !== valid.display_name ||
        draft.primary_domain.hostname !== valid.hostname) {
      return { status: 409, body: { error: "conflict" } };
    }
    const created = Number(results[0]?.meta?.changes) === 1;
    if (created && draft.publisher.install_public_key !== installPublicKey) {
      throw new Error("install key persistence mismatch");
    }
    return { status: created ? 201 : 200, body: { draft } };
  }
}
