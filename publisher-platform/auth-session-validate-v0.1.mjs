import { hashToken } from "./auth-token-v0.1.mjs";

export async function validateSession(database, token, now = new Date()) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  if (
    typeof token !== "string" ||
    !/^[0-9a-f]{64}$/.test(token)
  ) {
    return null;
  }

  const tokenHash = await hashToken(token);
  const timestamp = now.toISOString();

  const row = await database.prepare(
    "SELECT s.session_id, s.user_id, s.expires_at FROM publisher_sessions s JOIN publisher_users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.user_status = 'active' LIMIT 1"
  ).bind(
    tokenHash,
    timestamp
  ).first();

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    expiresAt: row.expires_at
  };
}
