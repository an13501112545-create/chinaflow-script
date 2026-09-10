const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "ChinaFlow <login@auth.getchinaflow.com>";
const APP_LOGIN_URL = "https://app.getchinaflow.com/login";

export async function sendMagicLinkEmail({ fetchFn = fetch, apiKey, to, token }) {
  if (typeof fetchFn !== "function") throw new Error("Fetch unavailable");
  if (typeof apiKey !== "string" || !apiKey) throw new Error("Resend API key unavailable");
  if (typeof to !== "string" || !to) throw new Error("Invalid recipient");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("Invalid magic-link token");
  }

  const loginUrl = new URL(APP_LOGIN_URL);
  loginUrl.searchParams.set("token", token);

  const result = await fetchFn(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: "Sign in to ChinaFlow",
      html: `<p>Use the link below to sign in to ChinaFlow.</p><p><a href="${loginUrl.href}">Sign in to ChinaFlow</a></p><p>This link expires in 15 minutes.</p>`,
      text: `Sign in to ChinaFlow: ${loginUrl.href}\n\nThis link expires in 15 minutes.`
    })
  });

  if (!result.ok) {
    throw new Error(`Resend request failed with status ${result.status}`);
  }

  const body = await result.json();

  if (!body || typeof body.id !== "string" || !body.id) {
    throw new Error("Resend response missing email id");
  }

  return { emailId: body.id };
}
