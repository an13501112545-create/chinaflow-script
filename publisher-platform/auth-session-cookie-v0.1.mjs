const COOKIE_NAME = "__Host-chinaflow_session";
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60;

function validToken(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

export function serializeSessionCookie(token, maxAgeSeconds = DEFAULT_MAX_AGE) {
  if (!validToken(token)) {
    throw new Error("Invalid session token");
  }

  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("Invalid session max age");
  }

  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name !== COOKIE_NAME) continue;

    const token = rest.join("=");
    return validToken(token) ? token : null;
  }

  return null;
}

export { COOKIE_NAME };
