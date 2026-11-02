// AakashVani translation mode behavior tests.
// Tests the EXECUTE_TRANSLATE message handler in offscreen.js with mocked Chrome APIs.
// Covers: Auto, Edge (Local), and Cloud mode translation routing and error handling.
// Run: node extension/tests/test_translation_mode.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OFFSCREEN_SRC = fs.readFileSync(path.join(ROOT, 'src/offscreen.js'), 'utf8');

let _pass = 0, _fail = 0;
function assert(cond, msg) {
  if (cond) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(name) { console.log(`\n--- ${name} ---`); }

// Build a sandbox that runs offscreen.js with mocked Chrome APIs.
// Returns an invokeTranslate(payload) helper and inspection handles.
function createSandbox(options = {}) {
  const {
    translatorAvailable = false,
    translatorThrows = false,
    unsupportedLang = false,
    cloudSucceeds = true,
    cloudStatus = 200,
    cloudBody = { translated_text: 'cloud translation result' },
  } = options;

  const fetchCalls = [];
  let translateHandler = null;

  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) { translateHandler = fn; },
      },
      sendMessage: (msg) => Promise.resolve({ ok: true }),
    },
  };

  // Mock window.Translator (Chrome built-in Translator API)
  let windowTranslator = null;
  if (translatorAvailable) {
    // Translator is a constructor function with static methods
    windowTranslator = async function TranslatorMock() {};
    windowTranslator.availability = async () => {
      if (unsupportedLang) throw new Error('No available adapters for this language pair');
      return 'available';
    };
    windowTranslator.create = async (opts) => ({
      translate: async (text) => {
        if (translatorThrows) throw new Error('Chrome translation failed internally');
        return `chrome-translated: ${text}`;
      },
    });
    windowTranslator.createTranslator = async (opts) => ({
      translate: async (text) => {
        if (translatorThrows) throw new Error('Chrome translation failed internally');
        return `chrome-translated: ${text}`;
      },
    });
  }

  // Mock fetch for Sarvam backend calls
  const globalFetch = async (url, opts) => {
    fetchCalls.push({ url, opts: opts || {} });
    if (url.includes('/api/v1/translate')) {
      return new Response(JSON.stringify(cloudBody), {
        status: cloudStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  const sandbox = {
    // window inside the script IS the sandbox (sandbox.window = sandbox below),
    // so put Translator directly on the sandbox
    Translator: windowTranslator,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome,
    ai: windowTranslator ? { translator: windowTranslator } : undefined,
    fetch: globalFetch,
    Response,
    Object, Map, Set, Array, String, Number, Boolean, RegExp, Error, JSON, Math,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Run offscreen.js — this registers the EXECUTE_TRANSLATE listener
  vm.runInContext(OFFSCREEN_SRC, sandbox, { filename: 'offscreen.js' });

  // Helper to invoke the translate handler with a payload
  async function invokeTranslate(payload) {
    return new Promise((resolve) => {
      translateHandler({ type: 'EXECUTE_TRANSLATE', payload }, {}, (response) => {
        resolve(response);
      });
    });
  }

  return {
    invokeTranslate,
    fetchCalls,
    sandbox,
  };
}

async function run() {
  section('Auto mode — preserves local-first/cloud-fallback behavior');

  // Auto mode: Chrome available → Chrome result, no Sarvam call
  {
    const env = createSandbox({ translatorAvailable: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'auto',
      apiKey: '',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === true, 'auto: Chrome success returns ok=true');
    assert(res.source === 'chrome', 'auto: Chrome success source=chrome');
    assert(res.translated === 'chrome-translated: Hello world', 'auto: Chrome success translated text');
    assert(env.fetchCalls.length === 0, 'auto: Chrome success → no Sarvam call');
  }

  // Auto mode: Chrome unavailable → Sarvam fallback
  {
    const env = createSandbox({ translatorAvailable: false, cloudSucceeds: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'auto',
      apiKey: 'test-key',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === true, 'auto: Chrome unavailable + Sarvam success → ok=true');
    assert(res.source === 'sarvam-fallback', 'auto: Chrome unavailable + Sarvam success → source=sarvam-fallback');
    assert(env.fetchCalls.length === 1, 'auto: Chrome unavailable → exactly one Sarvam call');
  }

  // Auto mode: Both fail → error returned
  {
    const env = createSandbox({ translatorAvailable: false, cloudSucceeds: false, cloudStatus: 401 });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'auto',
      apiKey: 'bad-key',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === false, 'auto: Both fail → ok=false');
    assert(res.error.code === 'CLOUD_AUTH_FAILED', 'auto: Both fail → error code CLOUD_AUTH_FAILED (got ' + JSON.stringify(res.error) + ')');
    assert(env.fetchCalls.length === 1, 'auto: Both fail → exactly one Sarvam call (no retry loop)');
  }

  section('Edge (Local) mode — Chrome only, never contacts Sarvam');

  // Edge mode: Chrome available → Chrome result, no Sarvam call
  {
    const env = createSandbox({ translatorAvailable: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'edge',
      apiKey: '',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === true, 'edge: Chrome success → ok=true');
    assert(res.source === 'chrome', 'edge: Chrome success → source=chrome');
    assert(env.fetchCalls.length === 0, 'edge: Chrome success → zero Sarvam calls');
  }

  // Edge mode: Chrome unavailable → structured error, NO Sarvam call
  {
    const env = createSandbox({ translatorAvailable: false });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'edge',
      apiKey: 'test-key',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === false, 'edge: Chrome unavailable → ok=false');
    assert(res.error.code === 'LOCAL_TRANSLATOR_UNAVAILABLE', 'edge: Chrome unavailable → error code LOCAL_TRANSLATOR_UNAVAILABLE (got ' + JSON.stringify(res.error) + ')');
    assert(env.fetchCalls.length === 0, 'edge: Chrome unavailable → zero Sarvam calls (no cloud fallback)');
  }

  // Edge mode: Unsupported language pair → structured error, NO Sarvam call
  {
    const env = createSandbox({ translatorAvailable: true, unsupportedLang: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'edge',
      apiKey: '',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === false, 'edge: Unsupported lang → ok=false');
    assert(res.error.code === 'LOCAL_TRANSLATOR_UNAVAILABLE', 'edge: Unsupported lang → error code LOCAL_TRANSLATOR_UNAVAILABLE (got ' + JSON.stringify(res.error) + ')');
    assert(env.fetchCalls.length === 0, 'edge: Unsupported lang → zero Sarvam calls');
  }

  // Edge mode: Chrome throws internal error → structured error, NO Sarvam call
  {
    const env = createSandbox({ translatorAvailable: true, translatorThrows: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'edge',
      apiKey: '',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === false, 'edge: Chrome internal error → ok=false');
    assert(res.error.code === 'LOCAL_TRANSLATOR_FAILED', 'edge: Chrome internal error → error code LOCAL_TRANSLATOR_FAILED (got ' + JSON.stringify(res.error) + ')');
    assert(env.fetchCalls.length === 0, 'edge: Chrome internal error → zero Sarvam calls');
  }

  section('Cloud mode — Chrome first, Sarvam fallback');

  // Cloud mode: Chrome available → Chrome result, no Sarvam call
  {
    const env = createSandbox({ translatorAvailable: true, cloudSucceeds: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'cloud',
      apiKey: '',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === true, 'cloud: Chrome success → ok=true');
    assert(res.source === 'chrome', 'cloud: Chrome success → source=chrome');
    assert(env.fetchCalls.length === 0, 'cloud: Chrome success → zero Sarvam calls');
  }

  // Cloud mode: Chrome unavailable → Sarvam fallback succeeds
  {
    const env = createSandbox({ translatorAvailable: false, cloudSucceeds: true });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'cloud',
      apiKey: 'test-key',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === true, 'cloud: Chrome fail + Sarvam success → ok=true');
    assert(res.source === 'sarvam', 'cloud: Chrome fail + Sarvam success → source=sarvam');
    assert(env.fetchCalls.length === 1, 'cloud: Chrome fail + Sarvam success → exactly one Sarvam call');
  }

  // Cloud mode: Both fail → structured error
  {
    const env = createSandbox({ translatorAvailable: false, cloudSucceeds: false, cloudStatus: 401 });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'cloud',
      apiKey: 'bad-key',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === false, 'cloud: Both fail → ok=false');
    assert(res.error.code === 'CLOUD_AUTH_FAILED', 'cloud: Both fail → error code CLOUD_AUTH_FAILED (got ' + JSON.stringify(res.error) + ')');
    assert(env.fetchCalls.length === 1, 'cloud: Both fail → exactly one Sarvam call (no retry loop)');
  }

  section('Cloud mode rate limit — classified correctly');

  {
    const env = createSandbox({ translatorAvailable: false, cloudSucceeds: false, cloudStatus: 429 });
    const res = await env.invokeTranslate({
      text: 'Hello world',
      targetLang: 'te-IN',
      mode: 'cloud',
      apiKey: 'test-key',
      engineUrl: 'http://127.0.0.1:8000',
    });
    assert(res.ok === false, 'cloud: Rate limit → ok=false');
    assert(res.error.code === 'CLOUD_RATE_LIMITED', 'cloud: Rate limit → error code CLOUD_RATE_LIMITED (got ' + JSON.stringify(res.error) + ')');
  }

  section('Network error — classified correctly');

  {
    const env = createSandbox({
      translatorAvailable: false,
      cloudSucceeds: false,
      cloudBody: { detail: 'connection refused' },
    });
    // Override fetch to throw a network error
    const fetchCalls2 = [];
    let translateHandler2 = null;
    const chrome2 = {
      runtime: {
        onMessage: { addListener(fn) { translateHandler2 = fn; } },
        sendMessage: () => Promise.resolve({ ok: true }),
      },
    };
    const sandbox2 = {
      Translator: Object.assign(async function TranslatorMock() {}, {
        availability: async () => 'available',
        create: async () => { throw new Error('Translator creation failed'); },
      }),
      console: { log: () => {}, warn: () => {}, error: () => {} },
      chrome: chrome2,
      ai: undefined,
      fetch: async () => { fetchCalls2.push(1); throw new Error('fetch network error'); },
      Response, Object, Map, Set, Array, String, Number, Boolean, RegExp, Error, JSON, Math,
      Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    };
    sandbox2.window = sandbox2;
    sandbox2.globalThis = sandbox2;
    vm.createContext(sandbox2);
    vm.runInContext(OFFSCREEN_SRC, sandbox2, { filename: 'offscreen.js' });

    const res2 = await new Promise((resolve) => {
      translateHandler2({ type: 'EXECUTE_TRANSLATE', payload: { text: 'hi', targetLang: 'te-IN', mode: 'cloud', apiKey: 'k', engineUrl: 'http://127.0.0.1:8000' } }, {}, (r) => resolve(r));
    });
    assert(res2.ok === false, 'network error → ok=false');
    assert(res2.error.code === 'CLOUD_NETWORK_ERROR', 'network error → error code CLOUD_NETWORK_ERROR (got ' + JSON.stringify(res2.error) + ')');
  }

  section('TTS routing unchanged — independent of translation mode');

  // Verify sync_controller still passes ttsBackend correctly
  const fs2 = require('fs');
  const path2 = require('path');
  const SRC2 = path2.join(ROOT, 'src', 'popup');
  const sc = fs2.readFileSync(path2.join(SRC2, 'sync_controller.js'), 'utf8');
  assert(sc.includes("const backend = this.settings.ttsBackend || 'piper'"), 'sync_controller still computes ttsBackend independently of mode');
  assert(sc.includes("`${translated}|${lang}|${backend}`"), 'sync_controller TTS cache key still includes backend');
  const sw = fs2.readFileSync(path2.join(SRC2, 'service_worker.js'), 'utf8');
  assert(sw.includes("const apiKey = msg.apiKey || settings.apiKey || ''"), 'service worker derives apiKey from message or storage');
  assert(sw.includes("synthesizeSpeech(msg.text, msg.language, msg.backend, apiKey)"), 'service worker passes resolved apiKey to TTS');
  assert(sw.includes("provider: tts.provider"), 'service worker still forwards TTS provider metadata');

  section('Edge mode — no duplicate cloud requests on repeated failures');

  {
    const env = createSandbox({ translatorAvailable: false });
    // Three rapid Edge mode translation attempts — all should fail locally, zero Sarvam calls
    const results = await Promise.all([
      env.invokeTranslate({ text: 'a', targetLang: 'te-IN', mode: 'edge', apiKey: '', engineUrl: 'http://127.0.0.1:8000' }),
      env.invokeTranslate({ text: 'b', targetLang: 'te-IN', mode: 'edge', apiKey: '', engineUrl: 'http://127.0.0.1:8000' }),
      env.invokeTranslate({ text: 'c', targetLang: 'te-IN', mode: 'edge', apiKey: '', engineUrl: 'http://127.0.0.1:8000' }),
    ]);
    assert(results.every(r => r.ok === false), 'edge: three failures → all ok=false');
    assert(env.fetchCalls.length === 0, 'edge: three failures → zero total Sarvam calls (no duplicates)');
  }

  section('Cloud mode — no duplicate cloud requests on repeated failures');

  {
    const env = createSandbox({ translatorAvailable: false, cloudSucceeds: false, cloudStatus: 502 });
    const results = await Promise.all([
      env.invokeTranslate({ text: 'a', targetLang: 'te-IN', mode: 'cloud', apiKey: 'k', engineUrl: 'http://127.0.0.1:8000' }),
      env.invokeTranslate({ text: 'b', targetLang: 'te-IN', mode: 'cloud', apiKey: 'k', engineUrl: 'http://127.0.0.1:8000' }),
    ]);
    assert(results.every(r => r.ok === false), 'cloud: two failures → all ok=false');
    assert(env.fetchCalls.length === 2, 'cloud: two failures → exactly two Sarvam calls (one per segment, no retry loop per segment)');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TRANSLATION MODE: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
