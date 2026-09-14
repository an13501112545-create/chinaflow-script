import { generateToken, hashToken } from "./auth-token-v0.1.mjs";

export async function createMagicLink(database, userId) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  if (typeof userId !== "string" || !userId) {
    throw new Error("Invalid user id");
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const magicLinkId = `ml_${crypto.randomUUID()}`;
  // SQLite's 'now' is stable within this statement and evaluated at execution.
  // Parse historical ISO and CURRENT_TIMESTAMP values; allow exactly 60 seconds.
  const result = await database.prepare(
    `INSERT INTO publisher_magic_links
      (magic_link_id, user_id, purpose, token_hash, expires_at, created_at)
    SELECT ?, ?, 'login', ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE NOT EXISTS (
      SELECT 1 FROM publisher_magic_links
      WHERE user_id = ? AND purpose = 'login'
        AND julianday(created_at) > julianday('now', '-60 seconds')
    )
    RETURNING expires_at`
  ).bind(
    magicLinkId,
    userId,
    tokenHash,
    userId
  ).all();

  const row = result.results[0];
  if (!row) {
    return null;
  }

  return {
    magicLinkId,
    token,
    expiresAt: row.expires_at
  };
}
