import { submitOnboarding } from "./onboarding-submit-v0.1.mjs";
import { readTermsInput, getOnboardingTerms, acceptOnboardingTerms } from "./onboarding-terms-v0.1.mjs";
import { readDraftInput, getOnboardingDraft, createOnboardingDraft } from "./onboarding-draft-v0.1.mjs";
import { completeMagicLinkLogin } from "./auth-login-service-v0.1.mjs";
import { serializeSessionCookie, readSessionCookie, clearSessionCookie } from "./auth-session-cookie-v0.1.mjs";
import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { revokeSessionByToken } from "./auth-session-store-v0.1.mjs";
import { renderLegalMarkdown } from "./legal-document-v0.1.mjs";
import { verifyPublisherInstallation } from "./onboarding-install-verification-v0.1.mjs";

function requireAppOrigin(env) {
  const value = env?.APP_ORIGIN;

  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("APP_ORIGIN binding unavailable or invalid");
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN binding unavailable or invalid");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error("APP_ORIGIN binding unavailable or invalid");
  }

  return value;
}

function requireAuthOrigin(env) {
  const value = env?.CHINAFLOW_AUTH_ORIGIN;

  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("CHINAFLOW_AUTH_ORIGIN binding unavailable or invalid");
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CHINAFLOW_AUTH_ORIGIN binding unavailable or invalid");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error("CHINAFLOW_AUTH_ORIGIN binding unavailable or invalid");
  }

  return value;
}

function requireRuntimeOrigin(env) {
  const value = env?.CHINAFLOW_RUNTIME_ORIGIN;

  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("CHINAFLOW_RUNTIME_ORIGIN binding unavailable or invalid");
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CHINAFLOW_RUNTIME_ORIGIN binding unavailable or invalid");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error("CHINAFLOW_RUNTIME_ORIGIN binding unavailable or invalid");
  }

  return value;
}
const CONSUME_ROUTE = "/api/auth/consume";
const SESSION_ROUTE = "/api/auth/session";
const LOGIN_ROUTE = "/login";
const LOGOUT_ROUTE = "/api/auth/logout";
const PUBLISHER_TERMS_ROUTE = "/legal/chinaflow-publisher-terms-v1";
const ONBOARDING_ROUTE = "/onboarding";
const VERIFY_INSTALL_ROUTE = "/api/onboarding/verify-install";

function json(status, body, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });

  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function html(status, body, connectOrigin = null) {
  let connectSrc = "'self'";

  if (connectOrigin !== null) {
    let parsed;

    try {
      parsed = new URL(connectOrigin);
    } catch {
      throw new Error("HTML connect origin is invalid");
    }

    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== connectOrigin
    ) {
      throw new Error("HTML connect origin is invalid");
    }

    connectSrc += " " + connectOrigin;
  }

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src " + connectSrc + "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

function legalHtml(status, body) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

async function hasNonEmptyRequestBody(request) {
  if (request.body === null) return false;

  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value?.byteLength > 0) return true;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or consumed.
    }
  }
}

export async function handleAppRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === PUBLISHER_TERMS_ROUTE) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        405,
        { error: "method_not_allowed" },
        { "Allow": "GET, HEAD" }
      );
    }

    const source = await import(
      "./legal/chinaflow-publisher-terms-v1.md",
      { with: { type: "text" } }
    );

    const content = renderLegalMarkdown(source.default);

    const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChinaFlow Publisher Program Terms</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#15202b;background:#fff;margin:0}
main{max-width:900px;margin:48px auto;padding:0 24px 72px}
h1{font-size:34px;line-height:1.2;margin:0 0 28px}
h2{font-size:26px;margin:42px 0 20px;padding-top:8px;border-top:1px solid #d9e2ec}
h3{font-size:20px;margin:30px 0 12px}
p,li,blockquote{font-size:16px;line-height:1.7}
ul{padding-left:24px}
blockquote{margin:18px 0;padding:12px 18px;border-left:4px solid #0b7285;background:#f6f9fb;color:#52606d}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f1f3f5;padding:2px 5px;border-radius:4px}
</style>
</head>
<body>
<main>
${content}
</main>
</body>
</html>`;

    return legalHtml(200, request.method === "HEAD" ? null : document);
  }

  if (url.pathname === ONBOARDING_ROUTE) {
    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" }, { "Allow": "GET" });
    }

    const runtimeOrigin = requireRuntimeOrigin(env);

    return html(200, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChinaFlow Publisher Onboarding</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f9fb;color:#15202b;margin:0}
main{max-width:720px;margin:48px auto;padding:0 20px 64px}
.card{background:#fff;border:1px solid #d9e2ec;border-radius:12px;padding:24px;margin:18px 0}
h1{font-size:30px;margin:0 0 8px}
h2{font-size:20px;margin:0 0 14px}
p{line-height:1.55;color:#52606d}
label{display:block;font-weight:600;margin:14px 0 6px}
input{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #bcccdc;border-radius:8px;font-size:16px}
button{padding:11px 16px;border:0;border-radius:8px;background:#0b7285;color:#fff;font-size:15px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
pre{white-space:pre-wrap;word-break:break-all;background:#102a43;color:#f0f4f8;padding:16px;border-radius:8px;line-height:1.5}
.hidden{display:none}
.status{margin-top:12px}
a{color:#0b7285}
</style>
</head>
<body>
<main>
<h1>Set up ChinaFlow</h1>
<p>Connect your approved website to ChinaFlow.</p>

<section id="loading" class="card">
  <p>Checking your account…</p>
</section>

<section id="create" class="card hidden">
  <h2>Create your publisher profile</h2>
  <form id="draft-form">
    <label for="display_name">Publisher name</label>
    <input id="display_name" name="display_name" maxlength="200" required>

    <label for="hostname">Primary website hostname</label>
    <input id="hostname" name="hostname" placeholder="example.com" required>

    <button id="create-button" type="submit">Create publisher</button>
    <p id="create-status" class="status"></p>
  </form>
</section>

<section id="terms" class="card hidden">
  <h2>Publisher Program Terms</h2>
  <p>
    Review the
    <a href="/legal/chinaflow-publisher-terms-v1" target="_blank" rel="noopener">
      ChinaFlow Publisher Program Terms
    </a>.
  </p>
  <button id="accept-button" type="button">I accept the terms</button>
  <p id="terms-status" class="status"></p>
</section>

<section id="install" class="card hidden">
  <h2>Installation code</h2>
  <p>Add this script to your approved website.</p>
  <pre id="snippet"></pre>
  <button id="copy-button" type="button">Copy installation code</button>
  <p id="copy-status" class="status"></p>
  <button id="verify-button" type="button">Verify installation</button>
  <p id="verify-status" class="status" role="status"></p>
  <button id="submit-button" class="hidden" type="button">Submit for review</button>
  <p id="submit-status" class="status" role="status"></p>
</section>

<section id="submitted" class="card hidden">
  <h2 id="submission-heading">Submitted for review</h2>
  <p id="submission-status" role="status"></p>
</section>

<p id="fatal" class="status"></p>

<script>
(() => {
  const TERMS_VERSION = "chinaflow-publisher-terms-v1";
  const RUNTIME_ORIGIN = ${JSON.stringify(runtimeOrigin)};

  const loading = document.getElementById("loading");
  const create = document.getElementById("create");
  const terms = document.getElementById("terms");
  const install = document.getElementById("install");
  const fatal = document.getElementById("fatal");

  const draftForm = document.getElementById("draft-form");
  const createButton = document.getElementById("create-button");
  const createStatus = document.getElementById("create-status");

  const acceptButton = document.getElementById("accept-button");
  const termsStatus = document.getElementById("terms-status");

  const snippet = document.getElementById("snippet");
  const copyButton = document.getElementById("copy-button");
  const copyStatus = document.getElementById("copy-status");

  const verifyButton = document.getElementById("verify-button");
  const verifyStatus = document.getElementById("verify-status");
  const submitButton = document.getElementById("submit-button");
  const submitStatus = document.getElementById("submit-status");
  const submitted = document.getElementById("submitted");
  const submissionHeading = document.getElementById("submission-heading");
  const submissionStatus = document.getElementById("submission-status");

  let currentDraft = null;

  function showReviewState() {
    hide(create);
    hide(terms);
    hide(install);

    const accountStatus = currentDraft?.publisher?.account_status;
    const reviewStatus = currentDraft?.primary_domain?.review_status;

    if (
      accountStatus === "active" &&
      currentDraft?.primary_domain?.monetization_status === "enabled" &&
      currentDraft?.supplier_site?.provisioning_status === "active"
    ) {
      submissionHeading.textContent = "ChinaFlow is active";
      submissionStatus.textContent =
        "Your publisher account is active and monetization is enabled.";
      show(submitted);
      return;
    }

    if (accountStatus === "rejected" || reviewStatus === "rejected") {
      submissionHeading.textContent = "Application not approved";
      submissionStatus.textContent =
        "Your publisher application was not approved. Contact ChinaFlow if you need clarification.";
      show(submitted);
      return;
    }

    if (accountStatus === "pending_review" && reviewStatus === "approved") {
      const provisioningStatus =
        currentDraft?.supplier_site?.provisioning_status ?? null;

      if (provisioningStatus === "active") {
        submissionHeading.textContent = "Supplier provisioning complete";
        submissionStatus.textContent =
          "Your supplier connection is ready. Account activation is the next step.";
        show(submitted);
        return;
      }

      if (provisioningStatus === "pending") {
        submissionHeading.textContent = "Supplier provisioning";
        submissionStatus.textContent =
          "Your publisher profile has been approved. Supplier provisioning is in progress.";
        show(submitted);
        return;
      }

      if (provisioningStatus === "failed" ||
          provisioningStatus === "disabled") {
        submissionHeading.textContent = "Supplier provisioning needs attention";
        submissionStatus.textContent =
          "Your publisher profile is approved, but supplier provisioning needs review by ChinaFlow.";
        show(submitted);
        return;
      }

      submissionHeading.textContent = "Review approved";
      submissionStatus.textContent =
        "Your publisher profile has been approved. Supplier provisioning will begin next.";
      show(submitted);
      return;
    }

    submissionHeading.textContent = "Submitted for review";
    submissionStatus.textContent =
      "Your publisher profile is submitted and pending review.";
    show(submitted);
  }

  function showInstallState(state) {
    hide(submitButton);
    if (state?.install_status === "detected" && state?.verification_status === "verified") {
      verifyStatus.textContent = "Installation verified.";
      show(submitButton);
    }
  }

  function show(element) {
    element.classList.remove("hidden");
  }

  function hide(element) {
    element.classList.add("hidden");
  }

  function installCode(key) {
    return '<script async src="' +
      RUNTIME_ORIGIN +
      '/runtime/loader.js" data-chinaflow-install="' +
      key +
      '"><' + '/script>';
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  async function loadTerms() {
    const response = await fetch("/api/onboarding/terms");

    if (!response.ok) {
      throw new Error("Unable to load publisher terms.");
    }

    const body = await readJson(response);
    const state = body.terms;

    if (!state || state.terms_version !== TERMS_VERSION) {
      throw new Error("Unexpected publisher terms version.");
    }

    if (state.accepted === true) {
      hide(terms);

      const key = currentDraft?.publisher?.install_public_key;
      if (!key) {
        throw new Error("Installation key is unavailable.");
      }

      snippet.textContent = installCode(key);
      show(install);
      showInstallState(currentDraft?.primary_domain);
      return;
    }

    hide(install);
    show(terms);
  }

  async function loadDraft() {
    const response = await fetch("/api/onboarding/draft");

    if (response.status === 404) {
      currentDraft = null;
      hide(terms);
      hide(install);
      show(create);
      return;
    }

    if (!response.ok) {
      throw new Error("Unable to load publisher profile.");
    }

    const body = await readJson(response);
    currentDraft = body.draft;

    if (currentDraft?.publisher?.account_status === "pending_review" ||
        currentDraft?.publisher?.account_status === "rejected" ||
        currentDraft?.publisher?.account_status === "active") {
      showReviewState();
      return;
    }

    if (!currentDraft?.publisher?.install_public_key) {
      throw new Error("Publisher profile is incomplete.");
    }

    hide(create);
    await loadTerms();
  }

  async function boot() {
    try {
      const session = await fetch("/api/auth/session");

      if (!session.ok) {
        location.assign("/login");
        return;
      }

      hide(loading);
      await loadDraft();
    } catch {
      hide(loading);
      fatal.textContent = "Unable to load onboarding. Please try again.";
    }
  }

  draftForm.addEventListener("submit", async event => {
    event.preventDefault();
    createButton.disabled = true;
    createStatus.textContent = "Creating publisher…";

    try {
      const response = await fetch("/api/onboarding/draft", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          display_name: draftForm.elements.display_name.value,
          hostname: draftForm.elements.hostname.value
        })
      });

      const body = await readJson(response);

      if (!response.ok || !body.draft) {
        createStatus.textContent =
          response.status === 409
            ? "That website is already registered or conflicts with an existing publisher."
            : "Unable to create publisher. Check the information and try again.";
        return;
      }

      currentDraft = body.draft;
      createStatus.textContent = "";
      hide(create);
      await loadTerms();
    } catch {
      createStatus.textContent = "Unable to create publisher. Please try again.";
    } finally {
      createButton.disabled = false;
    }
  });

  acceptButton.addEventListener("click", async () => {
    acceptButton.disabled = true;
    termsStatus.textContent = "Saving acceptance…";

    try {
      const response = await fetch("/api/onboarding/terms", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          terms_version: TERMS_VERSION,
          accepted: true
        })
      });

      const body = await readJson(response);

      if (!response.ok || body?.terms?.terms_version !== TERMS_VERSION) {
        termsStatus.textContent = "Unable to accept the terms. Please try again.";
        return;
      }

      termsStatus.textContent = "";
      await loadTerms();
    } catch {
      termsStatus.textContent = "Unable to accept the terms. Please try again.";
    } finally {
      acceptButton.disabled = false;
    }
  });

  verifyButton.addEventListener("click", async () => {
    verifyButton.disabled = true;
    submitButton.disabled = true;
    hide(submitButton);
    verifyStatus.textContent = "Checking installation...";
    try {
      const response = await fetch("/api/onboarding/verify-install", { method: "POST" });
      const body = await readJson(response);
      if (!response.ok || !body.verification) {
        throw new Error("Verification unavailable");
      }
      currentDraft.primary_domain = body.verification;
      verifyStatus.textContent = "Installation not detected. Check your website and try again.";
      showInstallState(body.verification);
    } catch {
      verifyStatus.textContent = "Unable to verify installation. Please try again.";
    } finally {
      verifyButton.disabled = false;
      submitButton.disabled = false;
    }
  });

  submitButton.addEventListener("click", async () => {
    submitButton.disabled = true;
    verifyButton.disabled = true;
    submitStatus.textContent = "Submitting...";
    try {
      const response = await fetch("/api/onboarding/submit", { method: "POST" });
      const body = await readJson(response);
      if (!response.ok || body.submission?.account_status !== "pending_review" ||
          body.submission?.submitted !== true) {
        throw new Error("Submission unavailable");
      }
      currentDraft.publisher.account_status = "pending_review";
      currentDraft.primary_domain.review_status = "pending";
      showReviewState();
    } catch {
      submitStatus.textContent = "Unable to submit. Refresh your profile, verify installation, and try again.";
    } finally {
      submitButton.disabled = false;
      verifyButton.disabled = false;
    }
  });

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(snippet.textContent);
      copyStatus.textContent = "Installation code copied.";
    } catch {
      copyStatus.textContent = "Copy failed. Select the code above and copy it manually.";
    }
  });

  boot();
})();
</script>
</main>
</body>
</html>`);
  }

  if (url.pathname === "/api/onboarding/submit") {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" }, { "Allow": "POST" });
    }
    if (request.headers.get("Origin") !== requireAppOrigin(env)) {
      return json(403, { error: "forbidden" });
    }
    const token = readSessionCookie(request.headers.get("Cookie"));
    if (!token) return json(401, { error: "unauthenticated" });
    // Submission has no client-selected tenant or other input.
    if (url.search || await hasNonEmptyRequestBody(request)) return json(400, { error: "invalid_input" });
    const result = await submitOnboarding(env?.CHINAFLOW_EVENTS, token);
    return json(result.status, result.body);
  }

  if (url.pathname === VERIFY_INSTALL_ROUTE) {
    if (request.method !== "POST") {
      return json(
        405,
        { error: "method_not_allowed" },
        { "Allow": "POST" }
      );
    }

    /*
     * Reject cross-origin requests before session or D1
     * processing.
     */
    if (
      request.headers.get("Origin") !==
      requireAppOrigin(env)
    ) {
      return json(
        403,
        { error: "forbidden" }
      );
    }

    const token =
      readSessionCookie(
        request.headers.get("Cookie")
      );

    if (!token) {
      return json(
        401,
        { error: "unauthenticated" }
      );
    }

    const result =
      await verifyPublisherInstallation({
        database: env?.CHINAFLOW_EVENTS,
        token,
        runtimeOrigin:
          requireRuntimeOrigin(env)
      });

    return json(
      result.status,
      result.body
    );
  }

  if (url.pathname === "/api/onboarding/terms") {
    if (request.method !== "GET" && request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const token = readSessionCookie(request.headers.get("Cookie"));
    if (!token) return json(401, { error: "unauthenticated" });

    if (request.method === "GET") {
      if (url.search) return json(400, { error: "invalid_input" });
      const result = await getOnboardingTerms(env?.CHINAFLOW_EVENTS, token);
      return json(result.status, result.body);
    }

    if (request.headers.get("Origin") !== requireAppOrigin(env)) {
      return json(403, { error: "forbidden" });
    }

    const inputError = await readTermsInput(request);
    if (inputError) return json(inputError.status, inputError.body);

    const result = await acceptOnboardingTerms(env?.CHINAFLOW_EVENTS, token);
    return json(result.status, result.body);
  }

  if (url.pathname === "/api/onboarding/draft") {
    if (request.method !== "GET" && request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }
    if (request.method === "POST" && request.headers.get("Origin") !== requireAppOrigin(env)) {
      return json(403, { error: "forbidden" });
    }
    const token = readSessionCookie(request.headers.get("Cookie"));
    const db = env?.CHINAFLOW_EVENTS;
    if (!token) return json(401, { error: "unauthenticated" });
    if (request.method === "GET") {
      const result = await getOnboardingDraft(db, token);
      return json(result.status, result.body);
    }
    const input = await readDraftInput(request);
    if (!input) return json(400, { error: "invalid_input" });
    const result = await createOnboardingDraft(db, token, input);
    return json(result.status, result.body);
  }

  if (url.pathname === LOGIN_ROUTE) {
    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }

    const authOrigin = requireAuthOrigin(env);

    return html(200, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ChinaFlow</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#15202b}
h1{font-size:28px;margin-bottom:12px}
p{line-height:1.5;color:#52606d}
button{margin-top:18px;padding:12px 18px;border:0;border-radius:8px;background:#0b7285;color:white;font-size:16px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
form{margin-top:18px}
input{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px}
#status{margin-top:18px}
</style>
</head>
<body>
<h1>Sign in to ChinaFlow</h1>
<p id="message">Checking your sign-in link…</p>
<form id="request-link" hidden>
  <label for="email">Email address</label>
  <input id="email" type="email" autocomplete="email" required>
  <button id="send-link" type="submit">Email me a sign-in link</button>
</form>
<button id="continue" hidden>Continue sign in</button>
<p id="status"></p>
<script>
(() => {
  const authOrigin = ${JSON.stringify(authOrigin)};
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const button = document.getElementById("continue");
  const form = document.getElementById("request-link");
  const email = document.getElementById("email");
  const sendLink = document.getElementById("send-link");
  const message = document.getElementById("message");
  const status = document.getElementById("status");

  form.addEventListener("submit", async event => {
    event.preventDefault();
    sendLink.disabled = true;
    status.textContent = "Sending sign-in link…";

    try {
      const response = await fetch(authOrigin + "/v1/auth/magic-link", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: email.value})
      });

      if (!response.ok) {
        status.textContent = "Unable to send a sign-in link. Please check your email address.";
        return;
      }

      status.textContent = "Check your email for a secure ChinaFlow sign-in link.";
    } catch {
      status.textContent = "Unable to send a sign-in link. Please try again.";
    } finally {
      sendLink.disabled = false;
    }
  });

  if (token) {
    history.replaceState({}, "", "/login");
    message.textContent = "Your secure sign-in link is ready.";
    button.hidden = false;

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Signing you in…";

      try {
        const response = await fetch("/api/auth/consume", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({token})
        });

        if (!response.ok) {
          status.textContent = "This sign-in link is invalid or has expired.";
          return;
        }

        const session = await fetch("/api/auth/session");

        if (!session.ok) {
          status.textContent = "Sign-in succeeded, but the session could not be verified.";
          return;
        }

        location.assign("/onboarding");
        return;
      } catch {
        status.textContent = "Unable to sign in. Please try again.";
      } finally {
        button.disabled = false;
      }
    });

    return;
  }

  fetch("/api/auth/session")
    .then(async response => {
      if (response.ok) {
        message.textContent = "You are already signed in to ChinaFlow.";
      } else {
        message.textContent = "Enter your email to receive a secure sign-in link.";
        form.hidden = false;
      }
    })
    .catch(() => {
      message.textContent = "Enter your email to receive a secure sign-in link.";
      form.hidden = false;
    });
})();
</script>
</body>
</html>`, authOrigin);
  }

  if (url.pathname === CONSUME_ROUTE) {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    if (request.headers.get("Origin") !== requireAppOrigin(env)) {
      return json(403, { error: "forbidden" });
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const db = env?.CHINAFLOW_EVENTS;

    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new Error("D1 binding unavailable");
    }

    const login = await completeMagicLinkLogin(db, body?.token);

    if (!login) {
      return json(401, { error: "invalid_or_expired_link" });
    }

    return json(
      200,
      { ok: true },
      { "Set-Cookie": serializeSessionCookie(login.token) }
    );
  }

  if (url.pathname === LOGOUT_ROUTE) {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    if (request.headers.get("Origin") !== requireAppOrigin(env)) {
      return json(403, { error: "forbidden" });
    }

    const token = readSessionCookie(request.headers.get("Cookie"));

    if (token) {
      const db = env?.CHINAFLOW_EVENTS;

      if (!db || typeof db.prepare !== "function") {
        throw new Error("D1 binding unavailable");
      }

      await revokeSessionByToken(db, token);
    }

    return json(
      200,
      { ok: true },
      { "Set-Cookie": clearSessionCookie() }
    );
  }

  if (url.pathname === SESSION_ROUTE) {
    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }

    const token = readSessionCookie(request.headers.get("Cookie"));

    if (!token) {
      return json(401, { authenticated: false });
    }

    const db = env?.CHINAFLOW_EVENTS;

    if (!db || typeof db.prepare !== "function") {
      throw new Error("D1 binding unavailable");
    }

    const session = await validateSession(db, token);

    if (!session) {
      return json(
        401,
        { authenticated: false },
        { "Set-Cookie": clearSessionCookie() }
      );
    }

    return json(200, {
      authenticated: true,
      userId: session.userId
    });
  }

  if (url.pathname === "/health") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });

    return json(200, {
      ok: true,
      service: "chinaflow-publisher-app",
      environment: env?.APP_ENVIRONMENT ?? "unknown"
    });
  }

  return json(404, { error: "not_found" });
}

export default {
  async fetch(request, env) {
    try {
      return await handleAppRequest(request, env);
    } catch (error) {
      console.error("[ChinaFlow Publisher App v0.1] Unexpected error", error);
      return json(500, { error: "internal_error" });
    }
  }
};
