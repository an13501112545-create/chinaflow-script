import { hashToken } from "./auth-token-v0.1.mjs";

export async function consumeMagicLink(database, token, now = new Date()) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    return null;
  }

  const tokenHash = await hashToken(token);
  const consumedAt = now.toISOString();

  const row = await database.prepare(
    "UPDATE publisher_magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM publisher_users u WHERE u.user_id = publisher_magic_links.user_id AND u.user_status = 'active') RETURNING user_id"
  ).bind(
    consumedAt,
    tokenHash,
    consumedAt
  ).first();

  if (!row?.user_id) {
    return null;
  }

  return {
    userId: row.user_id,
    consumedAt
  };
}
