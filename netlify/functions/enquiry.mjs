// Netlify Request/Response function. Configuration and all credentials stay server-side.
// Runtime context: https://docs.netlify.com/build/functions/api/
// Rate-limit rules must be confirmed in the deploy log; enforcement can lag 10s.
export const config = {
  path: "/api/enquiry",
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};

const ORIGINAL_FORM_ID = "bcadce91-e864-465a-b098-ed0207be334c";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);
const MAX_BODY_BYTES = 16_384;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_FIELDS = new Set([
  "firstname", "lastname", "email", "enquiry", "turnstileToken", "website", "startedAt",
]);

function reply(status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: status === 200, accepted: status === 200, code, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function localHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "[::1]" || hostname === "0.0.0.0" || /^127\./.test(hostname);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settings(env) {
  const portalId = env.HUBSPOT_PORTAL_ID;
  const formId = env.HUBSPOT_FORM_ID?.toLowerCase();
  // A dedicated, reviewed API form is mandatory. Never forward to the current live form.
  if (portalId !== "242183160" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(formId ?? "") ||
      formId === ORIGINAL_FORM_ID || !env.TURNSTILE_SECRET?.trim() ||
      TEST_SECRETS.has(env.TURNSTILE_SECRET.trim())) return null;

  try {
    const origins = new Set((env.ENQUIRY_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean));
    const hostnames = new Set((env.TURNSTILE_HOSTNAMES ?? "").split(",").map(value => value.trim()).filter(Boolean));
    if (!origins.size || !hostnames.size) return null;
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || localHostname(url.hostname) ||
          !hostnames.has(url.hostname)) return null;
    }
    for (const hostname of hostnames) {
      if (localHostname(hostname) || !/^[a-z0-9.-]+$/.test(hostname) ||
          ![...origins].some(origin => new URL(origin).hostname === hostname)) return null;
    }

    // Form-definition consent settings are not the Forms submission API payload.
    // Configure only a reviewed payload for the dedicated form. No guessed defaults,
    // communications[] opt-ins, or subscription IDs are added by this handler.
    const legalConsentOptions = JSON.parse(env.HUBSPOT_LEGAL_CONSENT_JSON ?? "");
    if (!record(legalConsentOptions) || Object.keys(legalConsentOptions).length !== 1 ||
        !record(legalConsentOptions.legitimateInterest)) return null;
    const interest = legalConsentOptions.legitimateInterest;
    const keys = ["value", "subscriptionTypeId", "legalBasis", "text"];
    if (Object.keys(interest).some(key => !keys.includes(key)) || interest.value !== true ||
        !Number.isSafeInteger(interest.subscriptionTypeId) || interest.subscriptionTypeId < 1 ||
        !["LEAD", "CUSTOMER"].includes(interest.legalBasis) ||
        typeof interest.text !== "string" || !interest.text.trim() || interest.text.length > 4000) return null;
    return { portalId, formId, origins, hostnames, legalConsentOptions, secret: env.TURNSTILE_SECRET };
  } catch {
    return null;
  }
}

async function readBody(request) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw Object.assign(new Error("body size"), { status: /^\d+$/.test(length) ? 413 : 400 });
  }
  if (!request.body) throw Object.assign(new Error("missing body"), { status: 400 });
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw Object.assign(new Error("body size"), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function cleanFields(body, now) {
  if (!record(body) || Object.keys(body).some(key => !ALLOWED_FIELDS.has(key))) return null;
  const result = {};
  for (const [name, limit] of Object.entries({ firstname: 120, lastname: 120, email: 254, enquiry: 4000, website: 120, turnstileToken: 2048 })) {
    const value = body[name] ?? (body[name] === undefined ? "" : null);
    if (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
    if (name !== "enquiry" && /[\r\n\t]/u.test(value)) return null;
    result[name] = value.trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result.email) || !result.turnstileToken || result.website) return null;
  if (!Number.isSafeInteger(body.startedAt) || body.startedAt > now - 1000 || body.startedAt < now - MAX_FORM_AGE_MS) return null;
  return result;
}

async function fetchJSON(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("upstream timeout"), { timedOut: true });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: "error" });
        // A rejected HTTP response does not need a parseable JSON body. This also
        // preserves a 429 when an upstream proxy supplies an HTML error page.
        if (!response.ok) return { response, body: null };
        return { response, body: await response.json() };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Dependency injection is used only by offline tests. The deployed default uses
// Netlify's trusted context, process.env, the platform fetch, and a 10s deadline.
export function createEnquiryHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  return async (request, context = {}) => {
    if (request.method !== "POST") return reply(405, "method_not_allowed", "Use POST for enquiries.", { Allow: "POST" });
    // CONTEXT is a build variable, not a guaranteed function runtime variable.
    // Branch previews and unpublished deploys cannot forward even if env is inherited.
    if (env.ENQUIRY_ENABLED !== "true" || context.deploy?.context !== "production" || context.deploy?.published !== true) {
      return reply(503, "unavailable", "The enquiry form is unavailable. Please email warrick@studio46.co.nz.");
    }
    const options = settings(env);
    if (!options) return reply(503, "unavailable", "The enquiry form is unavailable. Please email warrick@studio46.co.nz.");

    const origin = request.headers.get("origin");
    let sameOrigin = false;
    try { sameOrigin = options.origins.has(origin) && new URL(request.url).origin === origin; } catch { /* rejected below */ }
    if (!sameOrigin || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) {
      return reply(403, "forbidden", "The enquiry could not be submitted from this page.");
    }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
        (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity")) {
      return reply(415, "unsupported_media_type", "Send the enquiry as JSON.");
    }
    let body;
    try { body = await readBody(request); } catch (error) {
      return reply(error.status === 413 ? 413 : 400, "invalid_request", "Please check the enquiry and try again.");
    }
    const fields = cleanFields(body, now());
    if (!fields) return reply(400, "invalid_request", "Please check your email and enquiry, then try again.");

    let verification;
    try {
      const form = new URLSearchParams({ secret: options.secret, response: fields.turnstileToken });
      if (context.ip) form.set("remoteip", context.ip);
      verification = await fetchJSON(fetchImpl, SITEVERIFY_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
      }, timeoutMs);
    } catch {
      return reply(403, "verification_failed", "Please complete the security check again.");
    }
    const verified = verification.body;
    if (!verification.response.ok || !record(verified) || verified.success !== true ||
        verified.action !== "contact" || !options.hostnames.has(verified.hostname) || verified.hostname !== new URL(origin).hostname) {
      return reply(403, "verification_failed", "Please complete the security check again.");
    }

    const payload = {
      fields: ["firstname", "lastname", "email", "enquiry"]
        .filter(name => fields[name] !== "")
        .map(name => ({ objectTypeId: "0-1", name, value: fields[name] })),
      context: { pageUri: `${origin}/contact/`, pageName: "Discuss Your Measurement Project | Studio 46" },
      legalConsentOptions: options.legalConsentOptions,
    };
    try {
      // Never retry automatically: the token is single-use and delivery may have
      // succeeded even if the upstream response was interrupted.
      const submitted = await fetchJSON(fetchImpl,
        `https://api.hsforms.com/submissions/v3/integration/submit/${options.portalId}/${options.formId}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        }, timeoutMs);
      if (submitted.response.status === 429) {
        return reply(429, "rate_limited", "Too many attempts. Please wait a minute before trying again.", { "Retry-After": "60" });
      }
      if ((submitted.response.status >= 400 && submitted.response.status < 500) ||
          (record(submitted.body) && (submitted.body.status === "error" || Object.hasOwn(submitted.body, "errors")))) {
        return reply(502, "delivery_failed", "The enquiry was not accepted. Please check your details and try again, or email warrick@studio46.co.nz.");
      }
      if (submitted.response.status !== 200 || !record(submitted.body)) {
        return reply(502, "delivery_unconfirmed", "We could not confirm the enquiry was sent. Please email warrick@studio46.co.nz.");
      }
    } catch (error) {
      return reply(error.timedOut ? 504 : 502, "delivery_unconfirmed", "We could not confirm the enquiry was sent. Please email warrick@studio46.co.nz.");
    }
    return reply(200, "accepted", "Your enquiry has been sent to Studio 46.");
  };
}

export default createEnquiryHandler();
