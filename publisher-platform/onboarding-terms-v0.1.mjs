import { validateSession } from "./auth-session-validate-v0.1.mjs";

// Identifies one immutable legal document artifact. Changed text requires a new ID.
export const TERMS_VERSION = "chinaflow-publisher-terms-v1";
const failure = (status, error) => ({ status, body: { error } });
const success = row => ({ status: 200, body: { terms: {
  terms_version: row.terms_version, terms_accepted_at: row.terms_accepted_at
} } });

export async function readTermsInput(request) {
  if (new URL(request.url).search) return failure(400, "invalid_input");
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
    request.headers.get("Content-Type") ?? "")) return failure(415, "unsupported_media_type");
  const reader = request.body?.getReader();
  if (!reader) return failure(400, "invalid_input");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        // Cancellation must not delay the rejection on a streaming producer.
        void reader.cancel().catch(() => {});
        return failure(413, "payload_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, "terms_version") || !Object.hasOwn(body, "accepted") ||
        typeof body.terms_version !== "string" || body.accepted !== true) {
      return failure(400, "invalid_input");
    }
    if (body.terms_version !== TERMS_VERSION) return failure(409, "conflict");
    return null;
  } catch { return failure(400, "invalid_input"); }
  finally { reader.releaseLock(); }
}

const SESSION = `SELECT 1 FROM publisher_sessions s JOIN publisher_users u ON u.user_id = s.user_id
  WHERE s.session_id = ? AND s.user_id = ? AND s.revoked_at IS NULL
    AND julianday(s.expires_at) > julianday('now') AND u.user_status = 'active'`;
const OWNERS = `SELECT publisher_id FROM publisher_memberships
  WHERE user_id = ? AND membership_status = 'active' AND role = 'owner'`;

export async function acceptOnboardingTerms(database, token) {
  const session = await validateSession(database, token);
  if (!session) return failure(401, "unauthenticated");
  const owners = (await database.prepare(OWNERS).bind(session.userId).all()).results;
  if (owners.length > 1) return failure(409, "conflict");
  if (owners.length !== 1) return failure(403, "forbidden");
  const publisherId = owners[0].publisher_id;
  const row = await database.prepare(`UPDATE publishers
    SET terms_version = ?, terms_accepted_at = CURRENT_TIMESTAMP,
        terms_accepted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE publisher_id = ? AND account_status = 'draft'
      AND terms_version IS NULL AND terms_accepted_at IS NULL AND terms_accepted_by_user_id IS NULL
      AND EXISTS (${SESSION})
      AND publisher_id IN (${OWNERS})
      AND (SELECT count(*) FROM (${OWNERS})) = 1
      AND EXISTS (SELECT 1 FROM publisher_domains d WHERE d.publisher_id = publishers.publisher_id AND d.is_primary = 1)
    RETURNING terms_version, terms_accepted_at
  `).bind(TERMS_VERSION, session.userId, publisherId, session.sessionId, session.userId,
    session.userId, session.userId).first();
  if (row) return success(row);

  // One read snapshot, pinned to the original publisher: never resolve a new tenant.
  const current = await database.prepare(`SELECT
    EXISTS (${SESSION}) AS session_valid,
    (SELECT count(*) FROM (${OWNERS})) AS owner_count,
    EXISTS (SELECT 1 FROM (${OWNERS}) WHERE publisher_id = ?) AS authorized,
    p.account_status, p.terms_version, p.terms_accepted_at, p.terms_accepted_by_user_id,
    EXISTS (SELECT 1 FROM publisher_domains d WHERE d.publisher_id = p.publisher_id AND d.is_primary = 1) AS primary_domain
    FROM (SELECT 1) LEFT JOIN publishers p ON p.publisher_id = ?
  `).bind(session.sessionId, session.userId, session.userId, session.userId, publisherId, publisherId).first();
  if (!current.session_valid) return failure(401, "unauthenticated");
  if (current.owner_count > 1) return failure(409, "conflict");
  if (!current.authorized) return failure(403, "forbidden");
  if (current.account_status !== "draft") return failure(409, "conflict");
  if (!current.primary_domain) return failure(409, "conflict");
  if (current.terms_version === TERMS_VERSION && current.terms_accepted_at !== null &&
      current.terms_accepted_by_user_id !== null) return success(current);
  return failure(409, "conflict");
}
