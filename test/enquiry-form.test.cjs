const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  path.join(__dirname, '../assets/js/enquiry-form.js'),
  'utf8',
);
const fixedTime = 1792713600000;

class Element {
  constructor(values = {}) {
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.focusCount = 0;
    Object.assign(this, values);
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focusCount += 1; }
  async dispatch(type) {
    const event = { preventDefault() { event.prevented = true; }, prevented: false };
    await Promise.all((this.listeners.get(type) || []).map(callback => callback(event)));
    return event;
  }
}

function setup({
  review = true,
  enabled = false,
  sitekey = '',
  protocol = 'https:',
  dark = false,
  fetchHandler = async () => { throw new Error('Unexpected mocked request'); },
} = {}) {
  const button = new Element({ disabled: true });
  const buttonText = new Element({ textContent: 'Send enquiry' });
  const result = new Element({ hidden: true });
  const emailError = new Element({ hidden: true });
  const spamCheck = new Element();
  const elements = {
    firstname: new Element({ value: '  Jane  ' }),
    lastname: new Element({ value: '  Example  ' }),
    email: new Element({ value: '  jane@example.test  ', validity: { valid: true } }),
    enquiry: new Element({ value: '  Please review our reporting.  ' }),
    website: new Element(),
  };
  const selectors = {
    '[data-submit-enquiry]': button,
    '[data-button-text]': buttonText,
    '[data-form-result]': result,
    '#enquiry-email-error': emailError,
    '[data-spam-check]': spamCheck,
  };
  const form = new Element({
    dataset: { review: String(review), enabled: String(enabled), sitekey },
    elements,
    action: 'https://studio46.co.nz/api/enquiry',
    querySelector: selector => selectors[selector] || null,
  });
  const scripts = [];
  const requests = [];
  const renders = [];
  const resets = [];
  const timeouts = [];
  form.appendChild = child => scripts.push(child);
  const widgetId = 0; // A valid falsy ID must still be passed to reset().
  const window = {
    turnstile: {
      render(target, options) { renders.push({ target, options }); return widgetId; },
      reset(id) { resets.push(id); },
    },
  };
  const context = vm.createContext({
    document: {
      querySelector: selector => selector === '[data-s46-enquiry]' ? form : null,
      documentElement: { classList: { contains: name => dark && name === 'dark' } },
      createElement: tagName => new Element({ tagName }),
    },
    window,
    location: { protocol },
    Date: { now: () => fixedTime },
    AbortSignal: { timeout(ms) { timeouts.push(ms); return { mockedTimeout: ms }; } },
    fetch(url, options) {
      requests.push({ url, options });
      return fetchHandler(url, options);
    },
  });
  vm.runInContext(source, context, { filename: 'enquiry-form.js' });
  return {
    form, button, buttonText, result, emailError, elements, scripts,
    requests, renders, resets, timeouts, widgetId, spamCheck,
    submit: () => form.dispatch('submit'),
    input: () => elements.email.dispatch('input'),
    ready() { window.studio46TurnstileReady(); },
    token(value = 'one-use-token') { renders.at(-1).options.callback(value); },
    expire() { renders.at(-1).options['expired-callback'](); },
    widgetError() { renders.at(-1).options['error-callback'](); },
    rerun() { vm.runInContext(source, context, { filename: 'enquiry-form.js' }); },
  };
}

function configured(options = {}) {
  const harness = setup({ review: false, enabled: true, sitekey: 'public-test-site-key', ...options });
  harness.ready();
  harness.token();
  return harness;
}
function values(harness) {
  return Object.fromEntries(Object.entries(harness.elements).map(([name, field]) => [name, field.value]));
}
function response(ok, body, status = ok ? 200 : 400) { return { ok, status, json: async () => body }; }
function assertNoDeliveryClaim(harness) {
  assert.notEqual(harness.result.dataset.state, 'success');
  assert.doesNotMatch(harness.result.textContent, /thank you|has been received/i);
  assert.notEqual(harness.buttonText.textContent, 'Enquiry sent');
}

test('review validates locally, retains entered values and never loads or sends externally', async () => {
  const h = setup();
  const original = values(h);
  assert.equal(h.button.disabled, false);
  assert.equal(h.scripts.length, 0);
  assert.equal(h.requests.length, 0);
  const event = await h.submit();
  assert.equal(event.prevented, true);
  assert.equal(h.result.textContent, 'Preview checked. No enquiry has been sent.');
  assert.equal(h.result.hidden, false);
  assert.equal(h.result.dataset.state, 'info');
  assert.equal(h.result.focusCount, 1);
  assert.equal(h.button.disabled, false);
  assert.deepEqual(values(h), original);
  assertNoDeliveryClaim(h);
  assert.equal(h.scripts.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.renders.length, 0);
});

test('required email blocks empty/invalid input and exposes a clear accessible error', async () => {
  const h = setup();
  h.elements.email.value = '   ';
  await h.submit();
  assert.equal(h.elements.email.getAttribute('aria-invalid'), 'true');
  assert.equal(h.emailError.hidden, false);
  assert.equal(h.emailError.textContent, 'Please enter a valid email address.');
  assert.equal(h.elements.email.focusCount, 1);
  assert.equal(h.result.hidden, true);
  h.elements.email.value = 'not-an-email';
  h.elements.email.validity.valid = false;
  await h.submit();
  assert.equal(h.elements.email.focusCount, 2);
  assert.equal(h.emailError.hidden, false);
  h.elements.email.value = 'jane@example.test';
  h.elements.email.validity.valid = true;
  await h.input();
  assert.equal(h.elements.email.getAttribute('aria-invalid'), 'false');
  assert.equal(h.emailError.hidden, true);
  assert.equal(h.emailError.textContent, '');
  assert.equal(h.requests.length, 0);
  assert.equal(h.scripts.length, 0);
});

test('inactive production and missing site key never load the widget or send', async t => {
  for (const options of [
    { enabled: false, sitekey: 'public-test-site-key' },
    { enabled: true, sitekey: '' },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const h = setup({ review: false, ...options });
      assert.equal(h.button.disabled, true);
      assert.match(h.result.textContent, /currently unavailable/);
      await h.submit();
      assert.match(h.result.textContent, /not ready/);
      assert.equal(h.scripts.length, 0);
      assert.equal(h.requests.length, 0);
      assertNoDeliveryClaim(h);
    });
  }
});

test('configured production loads only the explicit widget and waits for a token', async () => {
  const h = setup({ review: false, enabled: true, sitekey: 'public-test-site-key', dark: true });
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].tagName, 'script');
  assert.equal(h.scripts[0].src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=studio46TurnstileReady');
  assert.equal(h.scripts[0].async, true);
  assert.equal(h.button.disabled, true);
  assert.equal(h.requests.length, 0);
  h.ready();
  assert.equal(h.renders.length, 1);
  assert.equal(h.renders[0].target, h.spamCheck);
  assert.equal(h.renders[0].options.sitekey, 'public-test-site-key');
  assert.equal(h.renders[0].options.action, 'contact');
  assert.equal(h.renders[0].options.theme, 'dark');
  assert.equal(h.button.disabled, true);
  await h.submit();
  assert.equal(h.requests.length, 0);
  h.token();
  assert.equal(h.button.disabled, false);
  assert.equal(h.requests.length, 0);
});

test('non-HTTPS production cannot initialize a widget or send a request', async () => {
  const h = setup({ review: false, enabled: true, sitekey: 'public-test-site-key', protocol: 'http:' });
  assert.equal(h.button.disabled, true);
  assert.equal(h.scripts.length, 0);
  await h.submit();
  assert.equal(h.requests.length, 0);
  assertNoDeliveryClaim(h);
});

test('in-flight and completed submissions cannot duplicate a delivery, and values stay visible', async () => {
  let resolveRequest;
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const h = configured({ fetchHandler: () => pending });
  const original = values(h);
  const first = h.submit();
  assert.equal(h.requests.length, 1);
  assert.equal(h.button.disabled, true);
  assert.equal(h.buttonText.textContent, 'Sending…');
  assert.equal(h.form.getAttribute('aria-busy'), 'true');
  await h.submit();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, 'https://studio46.co.nz/api/enquiry');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), {
    firstname: 'Jane', lastname: 'Example', email: 'jane@example.test',
    enquiry: 'Please review our reporting.', website: '',
    turnstileToken: 'one-use-token', startedAt: fixedTime,
  });
  assert.deepEqual(h.timeouts, [25000]);
  resolveRequest(response(true, { accepted: true }));
  await first;
  assert.equal(h.form.getAttribute('aria-busy'), 'false');
  assert.equal(h.result.dataset.state, 'success');
  assert.equal(h.result.textContent, 'Thank you. Your enquiry has been received.');
  assert.equal(h.buttonText.textContent, 'Enquiry sent');
  assert.equal(h.button.disabled, true);
  assert.deepEqual(h.resets, [h.widgetId]);
  assert.deepEqual(values(h), original);
  await h.submit();
  assert.equal(h.requests.length, 1);
});

test('success requires both an HTTP success and the literal accepted:true', async t => {
  for (const [name, ok, accepted, success] of [
    ['accepted boolean and successful HTTP', true, true, true],
    ['accepted string is not confirmation', true, 'true', false],
    ['accepted false is not confirmation', true, false, false],
    ['missing accepted is not confirmation', true, undefined, false],
    ['failed HTTP cannot claim delivery', false, true, false],
  ]) {
    await t.test(name, async () => {
      const h = configured({ fetchHandler: async () => response(ok, { accepted }) });
      await h.submit();
      assert.equal(h.result.dataset.state === 'success', success);
      if (!success) assertNoDeliveryClaim(h);
      assert.deepEqual(h.resets, [h.widgetId]);
      assert.equal(h.button.disabled, true);
      h.token('replacement-token');
      if (ok && !success) {
        assert.equal(h.buttonText.textContent, 'Please email to confirm');
        assert.equal(h.button.disabled, true);
        await h.submit();
        assert.equal(h.requests.length, 1);
      } else if (!ok) {
        assert.equal(h.button.disabled, false);
      } else {
        assert.equal(h.button.disabled, true);
      }
    });
  }
});


test('ambiguous successful HTTP bodies lock repeats without a delivery claim', async t => {
  for (const [name, body] of [
    ['empty object', {}],
    ['empty array', []],
    ['explicit accepted false', { accepted: false }],
  ]) {
    await t.test(name, async () => {
      const h = configured({ fetchHandler: async () => response(true, body) });
      const original = values(h);
      await h.submit();
      assert.equal(h.result.textContent, 'We could not confirm delivery. Please email Warrick before trying again.');
      assert.equal(h.result.dataset.state, 'error');
      assert.equal(h.buttonText.textContent, 'Please email to confirm');
      assert.equal(h.button.disabled, true);
      assert.equal(h.form.getAttribute('aria-busy'), 'false');
      assert.deepEqual(h.resets, [h.widgetId]);
      assert.deepEqual(values(h), original);
      assertNoDeliveryClaim(h);
      h.token('new-token-after-ambiguous-response');
      await h.submit();
      await h.submit();
      assert.equal(h.button.disabled, true);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.resets, [h.widgetId]);
      assertNoDeliveryClaim(h);
    });
  }
});

test('known failures explain the issue, retain values and require a fresh token before retry', async t => {
  for (const [code, expected] of [
    ['rate_limited', /Too many attempts/],
    ['invalid_request', /check your details/],
    ['verification_failed', /spam check could not be completed/],
    ['delivery_failed', /could not be sent/],
  ]) {
    await t.test(code, async () => {
      const h = configured({ fetchHandler: async () => response(false, { code }) });
      const original = values(h);
      await h.submit();
      assert.match(h.result.textContent, expected);
      assert.equal(h.result.dataset.state, 'error');
      assert.equal(h.result.focusCount, 1);
      assert.equal(h.button.disabled, true);
      assert.deepEqual(values(h), original);
      assert.deepEqual(h.resets, [h.widgetId]);
      assertNoDeliveryClaim(h);
      await h.submit();
      assert.equal(h.requests.length, 1);
      h.token('fresh-token');
      assert.equal(h.button.disabled, false);
      await h.submit();
      assert.equal(h.requests.length, 2);
      assert.equal(JSON.parse(h.requests[1].options.body).turnstileToken, 'fresh-token');
      assert.deepEqual(h.resets, [h.widgetId, h.widgetId]);
    });
  }
});


test('HTTP 429 handles a platform HTML response without attempting JSON or claiming uncertain delivery', async () => {
  let jsonReads = 0;
  const h = configured({ fetchHandler: async () => ({
    ok: false,
    status: 429,
    json: async () => { jsonReads += 1; throw new SyntaxError('Platform HTML response'); },
  }) });
  await h.submit();
  assert.equal(jsonReads, 0);
  assert.match(h.result.textContent, /Too many attempts/);
  assert.equal(h.result.dataset.state, 'error');
  assert.deepEqual(h.resets, [h.widgetId]);
  assertNoDeliveryClaim(h);
  h.token('fresh-after-rate-limit');
  assert.equal(h.button.disabled, false);
});

test('uncertain delivery locks retries without calling the enquiry sent', async t => {
  for (const [name, fetchHandler] of [
    ['explicit uncertain response', async () => response(false, { ok: false, accepted: false, code: 'delivery_unconfirmed' })],
    ['network failure', async () => { throw new Error('Offline test failure'); }],
    ['invalid JSON response', async () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } })],
  ]) {
    await t.test(name, async () => {
      const h = configured({ fetchHandler });
      const original = values(h);
      await h.submit();
      assert.equal(h.result.textContent, 'We could not confirm delivery. Please email Warrick before trying again.');
      assert.equal(h.result.dataset.state, 'error');
      assert.equal(h.buttonText.textContent, 'Please email to confirm');
      assert.equal(h.button.disabled, true);
      assert.equal(h.form.getAttribute('aria-busy'), 'false');
      assert.deepEqual(h.resets, [h.widgetId]);
      assert.deepEqual(values(h), original);
      assertNoDeliveryClaim(h);
      h.token('fresh-but-locked');
      assert.equal(h.button.disabled, true);
      await h.submit();
      assert.equal(h.requests.length, 1);
    });
  }
});

test('token expiry and widget errors disable submission until a new valid token', async () => {
  const h = configured();
  assert.equal(h.button.disabled, false);
  h.expire();
  assert.equal(h.button.disabled, true);
  await h.submit();
  assert.equal(h.requests.length, 0);
  h.token('renewed-token');
  assert.equal(h.button.disabled, false);
  h.widgetError();
  assert.equal(h.button.disabled, true);
  assert.match(h.result.textContent, /spam check could not load/);
  assert.equal(h.result.dataset.state, 'error');
  await h.submit();
  assert.equal(h.requests.length, 0);
  assertNoDeliveryClaim(h);
});

test('widget script loading failure shows an error and cannot send', async () => {
  const h = setup({ review: false, enabled: true, sitekey: 'public-test-site-key' });
  h.scripts[0].onerror();
  assert.match(h.result.textContent, /spam check could not load/);
  assert.equal(h.result.dataset.state, 'error');
  assert.equal(h.button.disabled, true);
  await h.submit();
  assert.equal(h.requests.length, 0);
  assertNoDeliveryClaim(h);
});

test('running the script twice does not register duplicate handlers or widget loaders', async () => {
  const h = setup();
  h.rerun();
  assert.equal(h.form.listeners.get('submit').length, 1);
  await h.submit();
  assert.equal(h.result.focusCount, 1);
  const production = setup({ review: false, enabled: true, sitekey: 'public-test-site-key' });
  production.rerun();
  assert.equal(production.scripts.length, 1);
  assert.equal(production.form.listeners.get('submit').length, 1);
});
