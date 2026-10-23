import test from "node:test";
import assert from "node:assert/strict";
import { createEnquiryHandler, config } from "../netlify/functions/enquiry.mjs";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://studio46.co.nz";
const FORM_ID = "11111111-2222-4333-8444-555555555555";
const CONTEXT = { deploy: { context: "production", published: true }, ip: "192.0.2.10" };
// Synthetic configuration only. This fixture does not establish approved consent
// wording, subscription mapping, or acceptance by a real HubSpot form.
const LEGAL = { legitimateInterest: { value: true, subscriptionTypeId: 999,
  legalBasis: "LEAD", text: "Synthetic test notice for a requested service enquiry." } };
const ENV = {
  ENQUIRY_ENABLED: "true", HUBSPOT_PORTAL_ID: "242183160", HUBSPOT_FORM_ID: FORM_ID,
  TURNSTILE_SECRET: "synthetic-test-secret", TURNSTILE_HOSTNAMES: "studio46.co.nz",
  ENQUIRY_ALLOWED_ORIGINS: ORIGIN, HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify(LEGAL),
};
const BODY = { firstname: "Test", lastname: "Person", email: "test@example.invalid",
  enquiry: "A synthetic measurement question.", turnstileToken: "synthetic-token", website: "", startedAt: NOW - 5000 };
const VERIFIED = { success: true, action: "contact", hostname: "studio46.co.nz" };

function request(body = BODY, { method = "POST", headers = {}, url = `${ORIGIN}/api/enquiry`, raw } = {}) {
  return new Request(url, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: raw ?? JSON.stringify(body) }),
  });
}

function fixture({ env = {}, fetchImpl, timeoutMs = 100, context = CONTEXT } = {}) {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    if (fetchImpl) return fetchImpl(url, options, calls.length);
    return Response.json(url.includes("siteverify") ? VERIFIED : { inlineMessage: "Accepted" });
  };
  const handler = createEnquiryHandler({ env: { ...ENV, ...env }, fetchImpl: fetchStub, now: () => NOW, timeoutMs });
  return { calls, run: (req = request(), ctx = context) => handler(req, ctx) };
}

test("Netlify exports a path-specific, per-IP/domain rate limit", () => {
  assert.deepEqual(config, { path: "/api/enquiry", rateLimit: {
    windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"],
  } });
});

test("default-off activation and non-published/non-production context never make upstream calls", async t => {
  for (const [name, options] of [
    ["missing activation", { env: { ENQUIRY_ENABLED: undefined } }],
    ["explicitly disabled", { env: { ENQUIRY_ENABLED: "false" } }],
    ["branch deploy", { context: { deploy: { context: "branch-deploy", published: true } } }],
    ["deploy preview", { context: { deploy: { context: "deploy-preview", published: false } } }],
    ["unpublished production deploy", { context: { deploy: { context: "production", published: false } } }],
    ["local/missing trusted context", { context: {} }],
  ]) await t.test(name, async () => {
    const f = fixture(options); assert.equal((await f.run()).status, 503); assert.equal(f.calls.length, 0);
  });
});

test("unsafe or incomplete server configuration fails closed", async t => {
  for (const [name, env] of [
    ["existing live form forbidden", { HUBSPOT_FORM_ID: "bcadce91-e864-465a-b098-ed0207be334c" }],
    ["existing live form uppercase forbidden", { HUBSPOT_FORM_ID: "BCADCE91-E864-465A-B098-ED0207BE334C" }],
    ["different portal", { HUBSPOT_PORTAL_ID: "123" }],
    ["missing form", { HUBSPOT_FORM_ID: "" }],
    ["malformed form UUID", { HUBSPOT_FORM_ID: "-".repeat(36) }],
    ["missing secret", { TURNSTILE_SECRET: "" }],
    ...["1x", "2x", "3x"].map(prefix => [`Cloudflare dummy secret ${prefix}`, { TURNSTILE_SECRET: `${prefix}0000000000000000000000000000000AA` }]),
    ["whitespace around a dummy secret", { TURNSTILE_SECRET: " 1x0000000000000000000000000000000AA " }],
    ["missing origins", { ENQUIRY_ALLOWED_ORIGINS: "" }],
    ["HTTP origin", { ENQUIRY_ALLOWED_ORIGINS: "http://studio46.co.nz" }],
    ["localhost production configuration", { ENQUIRY_ALLOWED_ORIGINS: "https://localhost", TURNSTILE_HOSTNAMES: "localhost" }],
    ["loopback production configuration", { ENQUIRY_ALLOWED_ORIGINS: "https://127.0.0.1", TURNSTILE_HOSTNAMES: "127.0.0.1" }],
    ["wildcard hostname", { TURNSTILE_HOSTNAMES: "*.studio46.co.nz" }],
    ["origin/hostname mismatch", { TURNSTILE_HOSTNAMES: "www.studio46.co.nz" }],
    ["unreviewed consent missing", { HUBSPOT_LEGAL_CONSENT_JSON: "" }],
    ["automatic communications branch prohibited", { HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify({ consent: { communications: [{ value: true }] } }) }],
    ["form-definition legal basis is not the submission enum", { HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify({ legitimateInterest: { ...LEGAL.legitimateInterest, legalBasis: "LEGITIMATE_INTEREST_PQL" } }) }],
    ["arbitrary legal basis", { HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify({ legitimateInterest: { ...LEGAL.legitimateInterest, legalBasis: "anything" } }) }],
  ]) await t.test(name, async () => {
    const f = fixture({ env }); assert.equal((await f.run()).status, 503); assert.equal(f.calls.length, 0);
  });
});

test("method and same-origin policy reject before token verification", async t => {
  const f = fixture();
  const get = await f.run(request(undefined, { method: "GET" }));
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST");
  for (const headers of [
    { Origin: "https://attacker.invalid" }, { Origin: "null" },
    { Origin: "https://studio46.co.nz.attacker.invalid" },
    { Origin: `${ORIGIN}:8443` }, { "Sec-Fetch-Site": "cross-site" },
  ]) await t.test(JSON.stringify(headers), async () => {
    assert.equal((await f.run(request(BODY, { headers }))).status, 403);
  });
  const missing = request(); missing.headers.delete("origin");
  assert.equal((await f.run(missing)).status, 403);
  assert.equal((await f.run(request(BODY, { url: "https://preview.example.invalid/api/enquiry" }))).status, 403);
  assert.equal(f.calls.length, 0);
});

test("JSON content type, malformed input and both declared/streamed body caps are enforced", async () => {
  const f = fixture();
  assert.equal((await f.run(request(BODY, { headers: { "Content-Type": "text/plain" } }))).status, 415);
  assert.equal((await f.run(request(BODY, { headers: { "Content-Encoding": "gzip" } }))).status, 415);
  assert.equal((await f.run(request(BODY, { raw: "{" }))).status, 400);
  assert.equal((await f.run(request(BODY, { headers: { "Content-Length": "20000" } }))).status, 413);
  assert.equal((await f.run(request(BODY, { headers: { "Content-Length": "invalid" } }))).status, 400);
  assert.equal((await f.run(request(BODY, { raw: " ".repeat(16_385) }))).status, 413);
  assert.equal(f.calls.length, 0);
});

test("invalid field types, lengths, honeypot and timing fail before any upstream request", async t => {
  const invalidBodies = [null, [], { ...BODY, unknown: "not forwarded" },
    { ...BODY, firstname: {} }, { ...BODY, lastname: null }, { ...BODY, email: "" },
    { ...BODY, email: "no-at-sign" }, { ...BODY, email: "test@example.invalid\r\nBcc:test" },
    { ...BODY, enquiry: ["unexpected"] }, { ...BODY, enquiry: "x".repeat(4001) },
    { ...BODY, enquiry: "nul\u0000" }, { ...BODY, firstname: "x".repeat(121) },
    { ...BODY, turnstileToken: "" }, { ...BODY, turnstileToken: "x".repeat(2049) },
    { ...BODY, website: "spam" }, { ...BODY, startedAt: String(NOW - 5000) },
    { ...BODY, startedAt: NOW + 1000 }, { ...BODY, startedAt: NOW - 100 },
    { ...BODY, startedAt: NOW - 86_400_001 },
  ];
  for (const [index, body] of invalidBodies.entries()) await t.test(String(index), async () => {
    const f = fixture(); assert.equal((await f.run(request(body))).status, 400); assert.equal(f.calls.length, 0);
  });
});

test("failed/mismatched/malformed Siteverify responses never reach HubSpot", async t => {
  for (const [name, result, status] of [
    ["failed token", { success: false }, 200],
    ["replayed token", { success: false, "error-codes": ["timeout-or-duplicate"] }, 200],
    ["wrong hostname", { ...VERIFIED, hostname: "attacker.invalid" }, 200],
    ["wrong action", { ...VERIFIED, action: "signup" }, 200],
    ["success must be boolean", { ...VERIFIED, success: "true" }, 200],
    ["missing action", { success: true, hostname: VERIFIED.hostname }, 200],
    ["wrong HTTP status", VERIFIED, 500],
    ["unexpected body", null, 200],
  ]) await t.test(name, async () => {
    const f = fixture({ fetchImpl: async () => Response.json(result, { status }) });
    assert.equal((await f.run()).status, 403); assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /siteverify$/);
  });
  const malformed = fixture({ fetchImpl: async () => new Response("not JSON") });
  assert.equal((await malformed.run()).status, 403); assert.equal(malformed.calls.length, 1);
  const offline = fixture({ fetchImpl: async () => { throw new Error("network unavailable"); } });
  assert.equal((await offline.run()).status, 403); assert.equal(offline.calls.length, 1);
});

test("Siteverify has a fail-closed deadline and abort signal", async () => {
  let signal;
  const f = fixture({ timeoutMs: 5, fetchImpl: async (_url, options) => {
    signal = options.signal; return new Promise(() => {});
  } });
  assert.equal((await f.run()).status, 403); assert.equal(signal.aborted, true); assert.equal(f.calls.length, 1);
});

test("HubSpot cannot be called while verification is still pending", async () => {
  let resolveVerification;
  const f = fixture({ fetchImpl: async url => url.includes("siteverify")
    ? new Promise(resolve => { resolveVerification = resolve; }) : Response.json({}) });
  const pending = f.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  resolveVerification(Response.json(VERIFIED));
  assert.equal((await pending).status, 200); assert.equal(f.calls.length, 2);
});

test("accepted submission forwards only verified fields and explicit server consent to the dedicated form", async () => {
  const f = fixture();
  const response = await f.run();
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.ok, true); assert.equal(result.accepted, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.equal(f.calls.length, 2);
  const check = new URLSearchParams(f.calls[0].options.body);
  assert.equal(check.get("secret"), ENV.TURNSTILE_SECRET);
  assert.equal(check.get("response"), BODY.turnstileToken);
  assert.equal(check.get("remoteip"), CONTEXT.ip);
  const submission = f.calls[1];
  assert.equal(submission.url, `https://api.hsforms.com/submissions/v3/integration/submit/242183160/${FORM_ID}`);
  const payload = JSON.parse(submission.options.body);
  assert.deepEqual(payload.fields, ["firstname", "lastname", "email", "enquiry"].map(name => ({ objectTypeId: "0-1", name, value: BODY[name] })));
  assert.deepEqual(payload.legalConsentOptions, LEGAL);
  assert.equal(payload.context.pageUri, `${ORIGIN}/contact/`);
  assert.equal("communications" in payload.legalConsentOptions, false);
  for (const field of ["turnstileToken", "website", "startedAt"]) assert.equal(submission.options.body.includes(field), false);
});

test("email stays required; blank optional names/enquiry do not overwrite existing CRM values", async () => {
  const f = fixture();
  const response = await f.run(request({ email: BODY.email, turnstileToken: BODY.turnstileToken, startedAt: BODY.startedAt }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(f.calls[1].options.body).fields, [{ objectTypeId: "0-1", name: "email", value: BODY.email }]);
});

test("the other documented legitimate-interest submission enum is accepted explicitly", async () => {
  const f = fixture({ env: { HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify({ legitimateInterest: { ...LEGAL.legitimateInterest, legalBasis: "CUSTOMER" } }) } });
  assert.equal((await f.run()).status, 200);
  assert.equal(JSON.parse(f.calls[1].options.body).legalConsentOptions.legitimateInterest.legalBasis, "CUSTOMER");
});

test("HubSpot errors, malformed responses and non-200 statuses never produce success", async t => {
  for (const status of [201, 202, 400, 429, 500]) await t.test(String(status), async () => {
    const f = fixture({ fetchImpl: async url => Response.json(url.includes("siteverify") ? VERIFIED : { message: "upstream detail" }, { status: url.includes("siteverify") ? 200 : status }) });
    const response = await f.run(); assert.equal(response.status, status === 429 ? 429 : 502);
    const result = await response.json(); assert.equal(result.ok, false); assert.equal(result.accepted, false);
    assert.equal(result.code, status === 429 ? "rate_limited" : status === 400 ? "delivery_failed" : "delivery_unconfirmed");
    assert.equal(f.calls.length, 2);
  });
  for (const body of [null, [], { status: "error" }, { errors: [{ message: "rejected" }] }, { errors: "rejected" }]) {
    const f = fixture({ fetchImpl: async url => Response.json(url.includes("siteverify") ? VERIFIED : body) });
    const response = await f.run(); assert.equal(response.status, 502);
    const result = await response.json(); assert.equal(result.accepted, false);
    assert.equal(result.code, body && !Array.isArray(body) ? "delivery_failed" : "delivery_unconfirmed");
  }
  const invalidJSON = fixture({ fetchImpl: async url => url.includes("siteverify") ? Response.json(VERIFIED) : new Response("not JSON") });
  assert.equal((await invalidJSON.run()).status, 502);
});

test("a non-JSON HubSpot 429 stays retryable without a false delivery claim", async () => {
  const f = fixture({ fetchImpl: async url => url.includes("siteverify") ? Response.json(VERIFIED) : new Response("rate limited", { status: 429 }) });
  const response = await f.run(); assert.equal(response.status, 429);
  const body = await response.json(); assert.equal(body.code, "rate_limited"); assert.equal(body.accepted, false);
  assert.equal(response.headers.get("retry-after"), "60"); assert.equal(f.calls.length, 2);
});

test("confirmed HTTP rejection is retryable, while a network failure remains unconfirmed", async () => {
  const rejected = fixture({ fetchImpl: async url => url.includes("siteverify") ? Response.json(VERIFIED) : new Response("bad request", { status: 400 }) });
  const failed = await rejected.run(); assert.equal((await failed.json()).code, "delivery_failed");
  const interrupted = fixture({ fetchImpl: async url => {
    if (url.includes("siteverify")) return Response.json(VERIFIED);
    throw new Error("connection lost after sending request");
  } });
  const unknown = await interrupted.run(); assert.equal(unknown.status, 502);
  assert.equal((await unknown.json()).code, "delivery_unconfirmed"); assert.equal(interrupted.calls.length, 2);
});

test("HubSpot timeout aborts, gives an unconfirmed result and never retries", async () => {
  let signal;
  const f = fixture({ timeoutMs: 5, fetchImpl: async (url, options) => {
    if (url.includes("siteverify")) return Response.json(VERIFIED);
    signal = options.signal; return new Promise(() => {});
  } });
  const response = await f.run(); assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "delivery_unconfirmed");
  assert.equal(signal.aborted, true); assert.equal(f.calls.length, 2);
});

test("the upstream deadline also covers a response body that never completes", async () => {
  const f = fixture({ timeoutMs: 5, fetchImpl: async url => {
    if (url.includes("siteverify")) return Response.json(VERIFIED);
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  } });
  assert.equal((await f.run()).status, 504); assert.equal(f.calls.length, 2);
});

test("a replay rejected by Siteverify cannot create a second HubSpot submission", async () => {
  let verifications = 0;
  const f = fixture({ fetchImpl: async url => {
    if (!url.includes("siteverify")) return Response.json({});
    return Response.json(++verifications === 1 ? VERIFIED : { success: false, "error-codes": ["timeout-or-duplicate"] });
  } });
  assert.equal((await f.run()).status, 200);
  assert.equal((await f.run()).status, 403);
  assert.equal(f.calls.filter(call => call.url.includes("api.hsforms.com")).length, 1);
});
