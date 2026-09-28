const COOKIE_NAME = "cf_outreach";

export function readOutreachCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE_NAME) continue;
    const token = rest.join("=");
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  }
  return null;
}

export { COOKIE_NAME };
