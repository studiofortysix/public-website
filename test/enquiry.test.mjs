import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import enquiryForm from "../data/enquiry_form.json" with { type: "json" };
import { createEnquiryHandler, createRedemptionStore, config } from "../netlify/functions/enquiry.mjs";

// Exercise the installed SDK with injected HTTP only. Its test setting reduces
// retry delays; no Netlify credentials, network or live stores are used.
process.env.NODE_ENV = "test";
const { getStore } = await import("@netlify/blobs");

const NOW = 1_800_000_000_000;
const ORIGIN = "https://studio46.co.nz";
const FORM_ID = "536a1f62-34c4-4738-a34f-41f8fbca6806";
const CONTEXT = { deploy: { context: "production", published: true }, ip: "192.0.2.10" };
// Contact data and secret are synthetic. The public receiver and consent mapping
// are confirmed Studio46 settings; offline tests do not prove live acceptance.
const LEGAL = { legitimateInterest: { value: true, subscriptionTypeId: 708833434,
  legalBasis: "LEAD", text: `${enquiryForm.privacy_notice} Privacy Policy.` } };
const ENV = {
  ENQUIRY_ENABLED: "true", HUBSPOT_PORTAL_ID: "242183160", HUBSPOT_FORM_ID: FORM_ID,
  TURNSTILE_SECRET: "synthetic-test-secret", TURNSTILE_HOSTNAMES: "studio46.co.nz",
  ENQUIRY_ALLOWED_ORIGINS: ORIGIN, HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify(LEGAL),
};
const BODY = { firstname: "Test", lastname: "Person", email: "test@example.invalid",
  enquiry: "A synthetic measurement question.", turnstileToken: "synthetic-token", website: "", startedAt: NOW - 5000 };
const VERIFIED = { success: true, action: "contact", hostname: "studio46.co.nz", challenge_ts: new Date(NOW - 5000).toISOString() };

function request(body = BODY, { method = "POST", headers = {}, url = `${ORIGIN}/api/enquiry`, raw } = {}) {
  return new Request(url, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: raw ?? JSON.stringify(body) }),
  });
}

function memoryRedemptions() {
  const entries = new Map();
  const writes = [];
  return {
    entries, writes,
    async set(key, value, options) {
      writes.push({ key, value, options });
      assert.deepEqual(options, { onlyIfNew: true });
      if (entries.has(key)) return { modified: false };
      entries.set(key, value);
      return { modified: true, etag: "offline-memory-etag" };
    },
  };
}

function fixture({ env = {}, fetchImpl, timeoutMs = 100, context = CONTEXT, redemptionStoreFactory } = {}) {
  const calls = [];
  const storage = memoryRedemptions();
  const storageOpens = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    if (fetchImpl) return fetchImpl(url, options, calls.length);
    return Response.json(url.includes("siteverify") ? VERIFIED : { inlineMessage: "Accepted" });
  };
  const handler = createEnquiryHandler({ env: { ...ENV, ...env }, fetchImpl: fetchStub, now: () => NOW, timeoutMs,
    redemptionStoreFactory: () => {
      storageOpens.push(true);
      return redemptionStoreFactory ? redemptionStoreFactory() : storage;
    },
  });
  return { calls, storage, storageOpens, run: (req = request(), ctx = context) => handler(req, ctx) };
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
    assert.equal(f.storageOpens.length, 0);
  });
});

test("unsafe or incomplete server configuration fails closed", async t => {
  for (const [name, env] of [
    ["existing live form forbidden", { HUBSPOT_FORM_ID: "bcadce91-e864-465a-b098-ed0207be334c" }],
    ["existing live form uppercase forbidden", { HUBSPOT_FORM_ID: "BCADCE91-E864-465A-B098-ED0207BE334C" }],
    ["different portal", { HUBSPOT_PORTAL_ID: "123" }],
    ["another valid receiver GUID cannot receive this consent mapping", { HUBSPOT_FORM_ID: "11111111-2222-4333-8444-555555555555" }],
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
    assert.equal(f.storageOpens.length, 0);
    assert.match(f.calls[0].url, /siteverify$/);
  });
  const malformed = fixture({ fetchImpl: async () => new Response("not JSON") });
  assert.equal((await malformed.run()).status, 403); assert.equal(malformed.calls.length, 1);
  const offline = fixture({ fetchImpl: async () => { throw new Error("network unavailable"); } });
  assert.equal((await offline.run()).status, 403); assert.equal(offline.calls.length, 1);
});

test("missing, malformed, stale and excessive-future challenge timestamps cannot claim or forward", async t => {
  for (const [name, challenge_ts] of [
    ["missing timestamp", undefined],
    ["null timestamp", null],
    ["numeric timestamp", NOW - 5000],
    ["unparseable timestamp", "not-a-timestamp"],
    ["date without UTC time", new Date(NOW).toISOString().slice(0, 10)],
    ["calendar-invalid timestamp", "2027-02-30T12:00:00Z"],
    ["expired by one millisecond", new Date(NOW - 300_001).toISOString()],
    ["future beyond clock skew", new Date(NOW + 30_001).toISOString()],
  ]) await t.test(name, async () => {
    const f = fixture({ fetchImpl: async () => Response.json({ ...VERIFIED, challenge_ts }) });
    const result = await f.run();
    assert.equal(result.status, 403);
    assert.equal((await result.json()).code, "verification_failed");
    assert.equal(f.storageOpens.length, 0);
    assert.equal(f.calls.length, 1);
  });
});

test("challenge timestamp permits the five-minute boundary and bounded clock skew", async t => {
  for (const age of [300_000, 0, -30_000]) await t.test(String(age), async () => {
    const f = fixture({ fetchImpl: async url => Response.json(url.includes("siteverify")
      ? { ...VERIFIED, challenge_ts: new Date(NOW - age).toISOString() } : {}) });
    assert.equal((await f.run()).status, 200);
    assert.equal(f.storage.writes.length, 1);
    assert.equal(f.calls.length, 2);
  });
});

test("valid UTC challenge timestamps allow absent or higher-precision fractional seconds", async t => {
  for (const challenge_ts of [
    VERIFIED.challenge_ts.replace(".000Z", "Z"),
    VERIFIED.challenge_ts.replace(".000Z", ".123456789Z"),
  ]) await t.test(challenge_ts, async () => {
    const f = fixture({ fetchImpl: async url => Response.json(url.includes("siteverify")
      ? { ...VERIFIED, challenge_ts } : {}) });
    assert.equal((await f.run()).status, 200);
    assert.equal(f.storage.writes.length, 1);
  });
});

test("redemption claims only the SHA-256 token key with a constant non-PII value", async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 200);
  assert.deepEqual(f.storage.writes, [{
    key: createHash("sha256").update(BODY.turnstileToken).digest("hex"),
    value: "redeemed",
    options: { onlyIfNew: true },
  }]);
  const stored = JSON.stringify(f.storage.writes);
  for (const sensitive of [BODY.turnstileToken, BODY.firstname, BODY.lastname, BODY.email,
    BODY.enquiry, ENV.TURNSTILE_SECRET, CONTEXT.ip]) assert.equal(stored.includes(sensitive), false);
});

test("a replay is rejected even when Siteverify reports success for the same token twice", async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 200);
  const replay = await f.run();
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).code, "verification_failed");
  assert.equal(f.storage.writes.length, 2);
  assert.equal(f.calls.filter(call => call.url.includes("siteverify")).length, 2);
  assert.equal(f.calls.filter(call => call.url.includes("api.hsforms.com")).length, 1);
});

test("concurrent handler instances with the same verified token forward at most once", async () => {
  const shared = memoryRedemptions();
  const first = fixture({ redemptionStoreFactory: () => shared });
  const second = fixture({ redemptionStoreFactory: () => shared });
  const results = await Promise.all([first.run(), second.run()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
  const calls = [...first.calls, ...second.calls];
  assert.equal(calls.filter(call => call.url.includes("siteverify")).length, 2);
  assert.equal(calls.filter(call => call.url.includes("api.hsforms.com")).length, 1);
  assert.equal(shared.entries.size, 1);
  assert.equal(shared.writes.length, 2);
});

test("storage creation, write failures and non-boolean claim results fail closed", async t => {
  const cases = [
    ["store cannot open", () => { throw new Error("unavailable"); }],
    ["store write rejects", () => ({ set: async () => { throw new Error("write failed"); } })],
    ...[undefined, null, {}, { modified: "true" }, { modified: 1 },
      { modified: true }, { modified: true, etag: "" }, { modified: true, etag: " " },
      { modified: true, etag: 123 }]
      .map(value => [`invalid result ${JSON.stringify(value)}`, () => ({ set: async () => value })]),
  ];
  for (const [name, redemptionStoreFactory] of cases) await t.test(name, async () => {
    const f = fixture({ redemptionStoreFactory });
    const result = await f.run();
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.code, "unavailable");
    assert.equal(body.accepted, false);
    assert.equal(f.calls.length, 1);
  });
});

function sdkRedemptionStore(status, etag) {
  const requests = [];
  const store = createRedemptionStore((name, options) => {
    assert.equal(name, "studio46-enquiry-redemptions-v1");
    assert.equal(options.region, "us-east-2");
    return getStore({
      name, ...options, siteID: "offline-site", token: "offline-placeholder",
      edgeURL: "https://offline.invalid",
    });
  }, async (input, init) => {
    // All actual SDK HTTP requests terminate in this stub, including retries.
    assert.equal(new URL(input).origin, "https://offline.invalid");
    requests.push({ input, init });
    return new Response("", { status, headers: etag === undefined ? {} : { etag } });
  });
  return { store, requests };
}

test("actual Blobs SDK rejects failed conditional HTTP writes even with an ETag", async t => {
  for (const status of [403, 500, 503]) {
    for (const etag of [undefined, "misleading-error-etag"]) {
      await t.test(`${status}, ETag ${etag ?? "missing"}`, async () => {
        const sdk = sdkRedemptionStore(status, etag);
        const f = fixture({ timeoutMs: 500, redemptionStoreFactory: () => sdk.store });
        const response = await f.run();
        assert.equal(response.status, 503);
        assert.equal((await response.json()).accepted, false);
        assert.equal(f.calls.filter(call => call.url.includes("api.hsforms.com")).length, 0);
        assert.ok(sdk.requests.length > 0);
        for (const { init } of sdk.requests) {
          assert.equal(init.headers["if-none-match"], "*");
          assert.equal(init.body, "redeemed");
        }
      });
    }
  }
});

test("actual Blobs SDK forwards only a successful conditional write with an ETag", async t => {
  for (const [name, status, etag, expected] of [
    ["confirmed claim", 200, "offline-success-etag", 200],
    ["HTTP success without ETag", 200, undefined, 503],
    ["HTTP success with empty ETag", 200, "", 503],
    ["already claimed", 412, undefined, 403],
    ["already claimed with ETag", 412, "existing-etag", 403],
  ]) await t.test(name, async () => {
    const sdk = sdkRedemptionStore(status, etag);
    const f = fixture({ timeoutMs: 500, redemptionStoreFactory: () => sdk.store });
    const response = await f.run();
    assert.equal(response.status, expected);
    assert.equal((await response.json()).accepted, expected === 200);
    assert.equal(f.calls.filter(call => call.url.includes("api.hsforms.com")).length, expected === 200 ? 1 : 0);
    assert.equal(sdk.requests.length, 1);
    const { input, init } = sdk.requests[0];
    assert.equal(new URL(input).pathname,
      `/region:us-east-2/offline-site/site:studio46-enquiry-redemptions-v1/${createHash("sha256").update(BODY.turnstileToken).digest("hex")}`);
    assert.equal(init.method, "put");
    assert.equal(init.headers["if-none-match"], "*");
    assert.equal(init.body, "redeemed");
  });
});

test("a storage claim has a deadline and never forwards while pending or after a late result", async () => {
  let finishClaim;
  const f = fixture({ timeoutMs: 5, redemptionStoreFactory: () => ({
    set: () => new Promise(resolve => { finishClaim = resolve; }),
  }) });
  const pending = f.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  const result = await pending;
  assert.equal(result.status, 503);
  finishClaim({ modified: true, etag: "offline-late-etag" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
});

test("claims are retained after an uncertain HubSpot attempt so the token cannot retry delivery", async () => {
  const f = fixture({ fetchImpl: async url => {
    if (url.includes("siteverify")) return Response.json(VERIFIED);
    throw new Error("connection lost after the request was sent");
  } });
  const first = await f.run();
  assert.equal((await first.json()).code, "delivery_unconfirmed");
  const replay = await f.run();
  assert.equal(replay.status, 403);
  assert.equal(f.storage.entries.size, 1);
  assert.equal(f.calls.filter(call => call.url.includes("api.hsforms.com")).length, 1);
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

test("tracked consent and environment example pin One to One with the unchanged complete notice", () => {
  assert.equal(enquiryForm.hubspot_consent.subscriptionTypeId, 708833434);
  assert.equal(enquiryForm.hubspot_consent.legalBasis, "LEAD");
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const value = example.split("\n").find(line => line.startsWith("HUBSPOT_LEGAL_CONSENT_JSON=")).split("=", 2)[1];
  assert.deepEqual(JSON.parse(value.slice(1, -1)), LEGAL);
  assert.match(example, /^HUGO_ENQUIRY_ENABLED=false$/m);
  assert.match(example, /^ENQUIRY_ENABLED=false$/m);
});

test("unreviewed subscription, basis and notice drift fail before either upstream request", async t => {
  const expected = LEGAL.legitimateInterest;
  const invalid = [
    ["marketing subscription is excluded", { ...expected, subscriptionTypeId: 708833433 }],
    ["other positive ID is not the reviewed mapping", { ...expected, subscriptionTypeId: 999 }],
    ["subscription ID must retain its numeric type", { ...expected, subscriptionTypeId: "708833434" }],
    ["multiple subscription IDs are not this API schema", { ...expected, subscriptionTypeId: [708833434, 708833433] }],
    ["CUSTOMER is documented but not the reviewed LEAD basis", { ...expected, legalBasis: "CUSTOMER" }],
    ["lowercase form-definition basis is not accepted", { ...expected, legalBasis: "lead" }],
    ["changed notice cannot imply a different permission", { ...expected, text: "Please subscribe me to marketing." }],
    ["missing privacy link label is notice drift", { ...expected, text: enquiryForm.privacy_notice }],
    ["notice whitespace drift must be reviewed", { ...expected, text: expected.text + " " }],
    ["legitimate interest must be explicitly true", { ...expected, value: false }],
    ["extra communications permission is rejected", { ...expected, communications: [{ value: true }] }],
  ];
  for (const [name, interest] of invalid) await t.test(name, async () => {
    const f = fixture({ env: { HUBSPOT_LEGAL_CONSENT_JSON: JSON.stringify({ legitimateInterest: interest }) } });
    const result = await f.run();
    assert.equal(result.status, 503);
    assert.equal((await result.json()).accepted, false);
    assert.equal(f.calls.length, 0);
  });
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
