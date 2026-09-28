import { recordOutreachClick } from "./outreach-attribution-service-v0.1.mjs";

const TOKEN_RE = /^[0-9a-f]{64}$/;
const PREFIX = "/r/";
const ZH_HOME = "https://getchinaflow.com/zh/";

function redirect(cookie) {
  const headers = new Headers({
    Location: ZH_HOME,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow"
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export async function handleOutreachClickRoute(request, database) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return redirect(null);
  if (url.search || url.hash) return redirect(null);
  const token = url.pathname.slice(PREFIX.length);
  if (!TOKEN_RE.test(token)) return redirect(null);
  const attribution = await recordOutreachClick(database, token);
  if (!attribution) return redirect(null);
  const cookie = `cf_outreach=${token}; Max-Age=2592000; Path=/; Domain=.getchinaflow.com; Secure; HttpOnly; SameSite=Lax`;
  return redirect(cookie);
}
