const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "ChinaFlow <login@auth.getchinaflow.com>";
export async function sendMagicLinkEmail({
  fetchFn = fetch,
  apiKey,
  to,
  token,
  appOrigin,
  requestId
}) {
  if (typeof fetchFn !== "function") throw new Error("Fetch unavailable");
  if (typeof apiKey !== "string" || !apiKey) throw new Error("Resend API key unavailable");
  if (typeof to !== "string" || !to) throw new Error("Invalid recipient");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("Invalid magic-link token");
  }
  if (
    typeof requestId !== "string" ||
    !/^ml_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
  ) {
    throw new Error("Invalid magic-link request id");
  }

  let appUrl;

  try {
    appUrl = new URL(appOrigin);
  } catch {
    throw new Error("Invalid app origin");
  }

  if (
    typeof appOrigin !== "string" ||
    appUrl.protocol !== "https:" ||
    appUrl.username !== "" ||
    appUrl.password !== "" ||
    appUrl.pathname !== "/" ||
    appUrl.search !== "" ||
    appUrl.hash !== "" ||
    appUrl.origin !== appOrigin
  ) {
    throw new Error("Invalid app origin");
  }

  const loginUrl = new URL("/login", appOrigin);
  loginUrl.searchParams.set("token", token);
  const subjectRef = requestId.slice(-8);

  const result = await fetchFn(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: `Sign in to ChinaFlow · ${subjectRef}`,
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
