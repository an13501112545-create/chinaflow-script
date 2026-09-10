import { generateToken, hashToken } from "./auth-token-v0.1.mjs";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export async function createMagicLink(database, userId, now = new Date()) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  if (typeof userId !== "string" || !userId) {
    throw new Error("Invalid user id");
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const magicLinkId = `ml_${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS).toISOString();

  await database.prepare(
    "INSERT INTO publisher_magic_links (magic_link_id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, 'login', ?, ?, ?)"
  ).bind(
    magicLinkId,
    userId,
    tokenHash,
    expiresAt,
    createdAt
  ).run();

  return {
    magicLinkId,
    token,
    expiresAt
  };
}
