export async function findOrCreateLoginUser(database, email, now = new Date()) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("D1 binding unavailable");
  }

  if (typeof email !== "string" || !email) {
    throw new Error("Invalid email");
  }

  const existing = await database.prepare(
    "SELECT user_id, user_status FROM publisher_users WHERE email_normalized = ? LIMIT 1"
  ).bind(email).first();

  if (existing) {
    return {
      userId: existing.user_id,
      active: existing.user_status === "active",
      created: false
    };
  }

  const userId = `usr_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();

  await database.prepare(
    "INSERT INTO publisher_users (user_id, email, email_normalized, user_status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).bind(
    userId,
    email,
    email,
    timestamp,
    timestamp
  ).run();

  return {
    userId,
    active: true,
    created: true
  };
}
