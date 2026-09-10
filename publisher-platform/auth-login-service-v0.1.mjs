import { generateToken, hashToken } from "./auth-token-v0.1.mjs";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function changesOf(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export async function completeMagicLinkLogin(database, magicToken, now = new Date()) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.batch !== "function"
  ) {
    throw new Error("D1 binding unavailable");
  }

  if (
    typeof magicToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(magicToken)
  ) {
    return null;
  }

  const magicTokenHash = await hashToken(magicToken);
  const sessionToken = generateToken();
  const sessionTokenHash = await hashToken(sessionToken);
  const sessionId = `sess_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  const statements = [
    database.prepare(
      "INSERT INTO publisher_sessions (session_id, user_id, token_hash, expires_at, created_at) SELECT ?, ml.user_id, ?, ?, ? FROM publisher_magic_links ml JOIN publisher_users u ON u.user_id = ml.user_id WHERE ml.token_hash = ? AND ml.purpose = 'login' AND ml.consumed_at IS NULL AND ml.expires_at > ? AND u.user_status = 'active'"
    ).bind(
      sessionId,
      sessionTokenHash,
      expiresAt,
      timestamp,
      magicTokenHash,
      timestamp
    ),
    database.prepare(
      "UPDATE publisher_magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM publisher_sessions s WHERE s.session_id = ? AND s.user_id = publisher_magic_links.user_id)"
    ).bind(
      timestamp,
      magicTokenHash,
      timestamp,
      sessionId
    ),
    database.prepare(
      "UPDATE publisher_users SET email_verified_at = COALESCE(email_verified_at, ?), last_login_at = ?, updated_at = ? WHERE user_id = (SELECT user_id FROM publisher_sessions WHERE session_id = ?) AND user_status = 'active' RETURNING user_id"
    ).bind(
      timestamp,
      timestamp,
      timestamp,
      sessionId
    )
  ];

  const results = await database.batch(statements);
  const sessionChanges = changesOf(results?.[0]);
  const consumeChanges = changesOf(results?.[1]);
  const userChanges = changesOf(results?.[2]);
  const userId = results?.[2]?.results?.[0]?.user_id ?? null;

  if (
    sessionChanges === 0 &&
    consumeChanges === 0 &&
    userChanges === 0 &&
    !userId
  ) {
    return null;
  }

  if (
    sessionChanges !== 1 ||
    consumeChanges !== 1 ||
    userChanges !== 1 ||
    !userId
  ) {
    throw new Error("Atomic login transaction invariant failed");
  }

  return {
    userId,
    sessionId,
    token: sessionToken,
    expiresAt
  };
}
