import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { TERMS_VERSION } from "./onboarding-terms-v0.1.mjs";
import { isValidInstallPublicKey } from "./install-public-key-v0.1.mjs";

const failure = (status, error) => ({ status, body: { error } });
const submitted = () => ({ status: 200, body: {
  submission: { account_status: "pending_review", submitted: true }
} });

async function authorize(database, token) {
  const session = await validateSession(database, token);
  if (!session) return failure(401, "unauthenticated");
  const result = await database.prepare(`
    SELECT p.publisher_id, p.account_status, p.install_public_key
    FROM publisher_memberships m
    JOIN publishers p ON p.publisher_id = m.publisher_id
    WHERE m.user_id = ? AND m.role = 'owner' AND m.membership_status = 'active'
      AND EXISTS (
        SELECT 1 FROM publisher_sessions s
        JOIN publisher_users u ON u.user_id = s.user_id
        WHERE s.session_id = ? AND s.user_id = ? AND s.revoked_at IS NULL
          AND julianday(s.expires_at) > julianday('now') AND u.user_status = 'active'
      )
  `).bind(session.userId, session.sessionId, session.userId).all();
  const rows = result?.results ?? [];
  if (!rows.length) return failure(403, "forbidden");
  if (rows.length !== 1) return failure(409, "conflict");
  return { session, publisher: rows[0] };
}

export async function submitOnboarding(database, token) {
  const authorization = await authorize(database, token);
  if (authorization.status) return authorization;
  const { session, publisher } = authorization;
  // A retry acknowledges the existing state without touching timestamps or
  // requiring the installation to be observed again after submission.
  if (publisher.account_status === "pending_review") return submitted();
  if (publisher.account_status !== "draft" ||
      !isValidInstallPublicKey(publisher.install_public_key)) return failure(409, "conflict");

  // Authorization is only a snapshot. All transition invariants, including
  // unambiguous ownership, are evaluated again in this single SQLite UPDATE.
  // The valid key is pinned to the server-stored identity read above.
  const row = await database.prepare(`
    UPDATE publishers
    SET account_status = 'pending_review', updated_at = CURRENT_TIMESTAMP
    WHERE publisher_id = ? AND account_status = 'draft'
      AND terms_version = ? AND terms_accepted_at IS NOT NULL
      AND terms_accepted_by_user_id IS NOT NULL AND install_public_key = ?
      AND (SELECT count(*) FROM publisher_memberships m
        WHERE m.user_id = ? AND m.role = 'owner' AND m.membership_status = 'active') = 1
      AND EXISTS (SELECT 1 FROM publisher_memberships m
        WHERE m.publisher_id = publishers.publisher_id AND m.user_id = ?
          AND m.role = 'owner' AND m.membership_status = 'active')
      AND EXISTS (SELECT 1 FROM publisher_sessions s
        JOIN publisher_users u ON u.user_id = s.user_id
        WHERE s.session_id = ? AND s.user_id = ? AND s.revoked_at IS NULL
          AND julianday(s.expires_at) > julianday('now') AND u.user_status = 'active')
      AND (SELECT count(*) FROM publisher_domains d
        WHERE d.publisher_id = publishers.publisher_id AND d.is_primary = 1) = 1
      AND EXISTS (SELECT 1 FROM publisher_domains d
        WHERE d.publisher_id = publishers.publisher_id AND d.is_primary = 1
          AND d.install_status = 'detected' AND d.verification_status = 'verified'
          AND d.first_seen_at IS NOT NULL AND d.last_seen_at IS NOT NULL
          AND d.verified_at IS NOT NULL)
    RETURNING account_status
  `).bind(publisher.publisher_id, TERMS_VERSION, publisher.install_public_key,
    session.userId, session.userId, session.sessionId, session.userId).first();
  if (row) return submitted();

  // Handle concurrent successful submissions as retries, but never acknowledge
  // a different tenant if ownership changed while the request was in flight.
  const current = await authorize(database, token);
  if (current.status) return current;
  return current.publisher.publisher_id === publisher.publisher_id &&
    current.publisher.account_status === "pending_review"
    ? submitted() : failure(409, "conflict");
}
