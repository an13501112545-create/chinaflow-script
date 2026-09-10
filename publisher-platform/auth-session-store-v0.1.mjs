import { generateToken, hashToken } from "./auth-token-v0.1.mjs";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(database, userId, now = new Date()) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  if (typeof userId !== "string" || !userId) {
    throw new Error("Invalid user id");
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const sessionId = `sess_${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  await database.prepare(
    "INSERT INTO publisher_sessions (session_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    sessionId,
    userId,
    tokenHash,
    expiresAt,
    createdAt
  ).run();

  return {
    sessionId,
    token,
    expiresAt
  };
}
