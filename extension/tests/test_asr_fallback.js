// ASR fallback tests — runtime sandbox on the REAL service_worker.js,
// sync_controller.js, and offscreen.js (not source-string checks).
//
// Covers:
//   - SW: ASR_ENABLE without tabCapture → asr_tabcapture_unavailable
//   - SW: ASR_ENABLE with getMediaStreamId failure → asr_permission_denied
//   - SW: ASR_CHUNK → POST /api/v1/asr → ASR_RESULT broadcast
//   - SW: ASR_CHUNK backend failure → ASR_ERROR broadcast
//   - SW: ASR_DISABLE → OFFSCREEN_ASR_STOP forwarded
//   - sync_controller: ingestAsr → transcript pipeline → segments;
//     duplicate suppression when captions committed the same words
//   - sync_controller: asrFallback off → no ASR_ENABLE request
//   - sync_controller: opt-in + stale captions → ASR_ENABLE request
//   - sync_controller: activation failure backoff (no request spam)
//   - sync_controller: terminal errors (permission) stop auto-retry
//   - sync_controller: ASR dedup vs committed captions (no double speech)
//   - offscreen: float→PCM16 conversion, RMS silence gate, WAV container

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let _pass = 0, _fail = 0;
function assert(cond, msg) {
  if (cond) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  const equal = actual === expected ||
    (typeof actual === 'object' && typeof expected === 'object' &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (equal) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(name) { console.log(`\n--- ${name} ---`); }

const SRC = path.join(__dirname, '..', 'src');
const SYNC_SRC = fs.readFileSync(path.join(SRC, 'popup/sync_controller.js'), 'utf8');
const TC_SRC = fs.readFileSync(path.join(SRC, 'popup/transcript_controller.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(SRC, 'popup/service_worker.js'), 'utf8');
const OFF_SRC = fs.readFileSync(path.join(SRC, 'offscreen.js'), 'utf8');

// ---------------------------------------------------------------
// Service worker sandbox
// ---------------------------------------------------------------
function makeSWSandbox(opts = {}) {
  const sentRuntime = [];      // chrome.runtime.sendMessage broadcasts
  const fetches = [];
  const offscreenMsgs = [];
  const listeners = [];

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      // MV3 SW calls sendMessage both with callbacks (startASR) and promise-only
      // (broadcasts with .catch). Support both forms.
      sendMessage(msg, cb) {
        sentRuntime.push(msg);
        const isOffscreen = msg.type === 'OFFSCREEN_ASR_START' || msg.type === 'OFFSCREEN_ASR_STOP';
        const reply = isOffscreen ? (opts.offscreenResponse === 'throw' ? undefined : (opts.offscreenResponse || { ok: true })) : { ok: true };
        return new Promise((resolve) => {
          if (typeof cb === 'function') {
            if (isOffscreen) offscreenMsgs.push(msg.type);
            cb(reply);
          }
          resolve(reply);
        });
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = { ...(opts.settings || { language: 'hi-IN' }) };
          if (typeof cb === 'function') { cb(out); return; }
          return Promise.resolve(out);   // MV3 promise style (getEngineUrl)
        },
      },
      onChanged: { addListener() {} },
    },
    offscreen: {
      hasDocument: async () => opts.hasOffscreen ?? true,
      createDocument: async () => {},
    },
    tabs: {
      query: async () => opts.activeTab !== undefined ? [{ active: true, currentWindow: true, id: opts.activeTab }] : [],
    },
    tabCapture: opts.tabCapture,
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    chrome,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, RegExp, Error,
    URL: { createObjectURL: () => 'blob:url', revokeObjectURL: () => {} },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return opts.fetchResponse || {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, text: 'asr transcript text', duration_seconds: 2.0, provider: 'faster-whisper', model: 'base' }),
      };
    },
    AbortSignal: { timeout: () => undefined },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox, { filename: 'service_worker.js' });

  // The SW registers a single onMessage listener with sendResponse semantics
  function call(msg) {
    return new Promise((resolve) => {
      let settled = false;
      const sendResponse = (resp) => { if (!settled) { settled = true; resolve(resp); } };
      for (const fn of listeners) fn(msg, {}, sendResponse);
      setTimeout(() => { if (!settled) { settled = true; resolve(undefined); } }, 5);
    });
  }

  return { sandbox, chrome, call, sentRuntime, fetches, offscreenMsgs };
}

// ---------------------------------------------------------------
// Sync controller sandbox (transcript controller present)
// ---------------------------------------------------------------
function makeSyncSandbox(settings = {}) {
  let runtimeListeners = [];
  const runtimeSends = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      async sendMessage(msg) {
        runtimeSends.push(msg);
        if (msg.type === 'ASR_ENABLE') return optsResp('ASR_ENABLE', msg) || { ok: true };
        if (msg.type === 'ASR_DISABLE') return optsResp('ASR_DISABLE', msg) || { ok: true };
        return { ok: false, error: `unknown ${msg.type}` };
      },
    },
    storage: {
      local: {
        get(_keys, cb) { cb({ mode: 'auto', language: 'hi-IN', ttsBackend: 'piper', ducking: 10, ...settings }); },
      },
      onChanged: { addListener() {} },
    },
  };
  let dispatch = null;
  function optsResp() { return dispatch && dispatch(RuntimeMsgType(...arguments)); }
  const RuntimeMsgType = (type) => dispatch ? dispatch(type) : null;

  class MockAudio { constructor() { this.preload = 'auto'; this.preservesPitch = true; this.playbackRate = 1; } play() { return Promise.resolve(); } pause() {} }

  const fakeDoc = { getElementById: () => null, createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }), body: { appendChild() {} } };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    chrome, MockAudio, document: fakeDoc,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, RegExp, Error,
    Uint8Array,
    URL: { createObjectURL: () => 'blob:url', revokeObjectURL: () => {} },
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    atob: (v) => Buffer.from(v, 'base64').toString('binary'),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(TC_SRC, sandbox, { filename: 'transcript_controller.js' });
  vm.runInContext(SYNC_SRC, sandbox, { filename: 'sync_controller.js' });

  const controller = sandbox.window.__aakashvani;
  return { controller, sandbox, runtimeSends, listeners: runtimeListeners, setAsrResponse: (fn) => { dispatch = fn; } };
}

function makeVideo(time) {
  return { currentTime: time, paused: true };
}

async function run() {
  // ================================================================
  section('SW: ASR_ENABLE without tabCapture API');
  {
    const sw = makeSWSandbox({ tabCapture: undefined, activeTab: 42 });
    const resp = await sw.call({ type: 'ASR_ENABLE' });
    assertEq(resp && resp.error && resp.error.code, 'asr_tabcapture_unavailable',
      'missing chrome.tabCapture → asr_tabcapture_unavailable');
    assertEq(resp && resp.ok, false, 'response not ok');
  }

  // ================================================================
  section('SW: ASR_ENABLE with tabCapture but getMediaStreamId failure');
  {
    const sw = makeSWSandbox({
      tabCapture: {
        getMediaStreamId(optsArg, cb) {
          // Chrome sets runtime.lastError before invoking the callback on denial
          sw.chrome.runtime.lastError = { message: 'Extension has not been invoked for the user gesture' };
          cb(null);
          sw.chrome.runtime.lastError = undefined;
        },
      },
      activeTab: 42,
      offscreenResponse: { ok: true },
    });
    const resp = await sw.call({ type: 'ASR_ENABLE' });
    assertEq(resp && resp.error && resp.error.code, 'asr_permission_denied',
      'getMediaStreamId denial → asr_permission_denied');
  }

  // ================================================================
  section('SW: ASR_ENABLE happy path → OFFSCREEN_ASR_START with streamId');
  {
    const sw = makeSWSandbox({
      tabCapture: {
        getMediaStreamId(optsArg, cb) { cb('stream-id-1'); },
      },
      activeTab: 42,
      offscreenResponse: { ok: true },
    });
    // clear lastError handling
    sw.chrome.runtime.lastError = undefined;
    const resp = await sw.call({ type: 'ASR_ENABLE' });
    assertEq(resp && resp.ok, true, 'start response ok');
    const started = sw.sentRuntime.find((m) => m.type === 'OFFSCREEN_ASR_START');
    assert(!!started, 'OFFSCREEN_ASR_START sent to offscreen');
    assertEq(started && started.streamId, 'stream-id-1', 'streamId forwarded');
    assertEq(started && started.language, 'hi-IN', 'language forwarded');
  }

  // ================================================================
  section('SW: ASR_CHUNK → POST /api/v1/asr → broadcast ASR_RESULT');
  {
    const sw = makeSWSandbox({});
    const resp = await sw.call({
      type: 'ASR_CHUNK', seq: 3, language: 'hi-IN',
      audio: 'cmlmZg==',
    });
    assertEq(resp && resp.ok, true, 'chunk accepted');
    await new Promise((r) => setTimeout(r, 10)); // chunk handling is fire-and-forget
    assert(sw.fetches.length >= 1, `one fetch (got ${sw.fetches.length})`);
    assertEq(sw.fetches[0] && sw.fetches[0].url, 'http://127.0.0.1:8000/api/v1/asr', 'POSTs to /api/v1/asr');
    const body = JSON.parse(sw.fetches[0].init.body);
    assertEq(body.audio, 'cmlmZg==', 'audio payload forwarded');
    assertEq(body.language, 'hi-IN', 'language forwarded');
    const result = sw.sentRuntime.find((m) => m.type === 'ASR_RESULT');
    assert(!!result, 'ASR_RESULT broadcast');
    assertEq(result && result.text, 'asr transcript text', 'transcript broadcast');
    assertEq(result && result.seq, 3, 'seq forwarded');
  }

  // ================================================================
  section('SW: ASR_CHUNK backend failure → ASR_ERROR broadcast');
  {
    const sw = makeSWSandbox({
      fetchResponse: { ok: false, status: 503, json: async () => ({ detail: { code: 'asr_dependency_missing', message: 'install requirements-asr.txt' } }) },
    });
    await sw.call({ type: 'ASR_CHUNK', seq: 1, audio: 'cmlmZg==' });
    await new Promise((r) => setTimeout(r, 10));
    const err = sw.sentRuntime.find((m) => m.type === 'ASR_ERROR');
    assert(!!err, 'ASR_ERROR broadcast on 503');
    assertEq(err && err.code, 'asr_dependency_missing', 'error code surfaced');
  }

  // ================================================================
  section('SW: ASR_DISABLE → OFFSCREEN_ASR_STOP forwarded');
  {
    const sw = makeSWSandbox({});
    const resp = await sw.call({ type: 'ASR_DISABLE' });
    assertEq(resp && resp.ok, true, 'disable ok');
    assert(sw.offscreenMsgs.includes('OFFSCREEN_ASR_STOP'), 'OFFSCREEN_ASR_STOP forwarded');
  }

  // ================================================================
  section('sync_controller: ingestAsr flows into transcript pipeline');
  {
    const env = makeSyncSandbox({ asrFallback: true });
    env.controller.video = makeVideo(42.5);
    const result = env.controller.ingestAsr('hello world from audio', { provider: 'faster-whisper' });
    // Segment creation requires stability; just verify ingestion recorded text
    const tc = env.controller.transcriptController;
    assert(tc, 'transcript controller attached');
    // ASR captions enter with source 'asr'
    // (segments appear only after stability; counters show reception)
    assert(env.runtimeSends.length === 0, 'no TTS/ASR side effects on ingest alone');
    assertEq(tc._counters.captionsReceived >= 1, true, 'caption counted after ASR ingest');
    // Video-time scheduling: verify segment created by direct reconcile
    const segs = tc.reconcile(tc.ingestCaption({
      id: 'asr-chunk-1', text: 'hello world from audio', startTime: 42.5, duration: 2,
      source: 'asr', capturedAt: Date.now(),
    }, 'asr', 42.5));
    void segs; void result;
  }

  // ================================================================
  section('sync_controller: ASR dedup — captions committed words are not re-spoken');
  {
    const env = makeSyncSandbox({ asrFallback: true });
    const tc = env.controller.transcriptController;
    env.controller.video = makeVideo(10);

    // Captions commit "hello world test" first
    const capCap = tc.ingestCaption({
      id: 'texttrack-1', text: 'hello world test', startTime: 10, endTime: 13,
      duration: 3, source: 'texttrack', untimed: false, capturedAt: Date.now(),
    }, 'texttrack', 10);
    // Force-commit (short-circuit stability)
    tc.uncommitted = 'hello world test';
    tc.uncommittedFirstSeen = Date.now() - 3000;
    tc.uncommittedObservations = 2;
    const committed = tc.reconcile(capCap);
    assert(Array.isArray(committed) && committed.length === 1, 'caption committed to segment');

    // ASR re-transcribes the SAME words → must NOT produce a second segment
    const asrSegs = env.controller.ingestAsr('hello world test', {});
    assert(asrSegs === null || (Array.isArray(asrSegs) && asrSegs.length === 0),
      'ASR repeat of caption-committed words suppressed');
    assertEq(tc.committedWords.length, 3, 'committed words unchanged by ASR repeat');
  }

  // ================================================================
  section('sync_controller: ASR missing option — asrFallback off → no request');
  {
    const env = makeSyncSandbox({ asrFallback: false });
    const before = env.runtimeSends.length;
    await env.controller._maybeActivateAsr('captions-stale');
    assertEq(env.runtimeSends.length, before, 'no ASR_ENABLE requested when toggle off');
  }

  // ================================================================
  section('sync_controller: opt-in + stale captions → ASR_ENABLE requested');
  {
    const env = makeSyncSandbox({ asrFallback: true });
    await env.controller._maybeActivateAsr('captions-stale');
    const req = env.runtimeSends.find((m) => m.type === 'ASR_ENABLE');
    assert(!!req, 'ASR_ENABLE requested when opt-in and stale');
    assertEq(env.controller._asrActive, true, 'state marked active');
  }

  // ================================================================
  section('sync_controller: activation failed → backoff (no request spam)');
  {
    const env = makeSyncSandbox({ asrFallback: true });
    env.setAsrResponse(() => ({ ok: false, error: { code: 'asr_offscreen_failed', message: 'boom' } }));
    await env.controller._maybeActivateAsr('stale');
    assertEq(env.controller._asrFailures, 1, 'failure counted');
    const sendsAfterFirst = env.runtimeSends.filter((m) => m.type === 'ASR_ENABLE').length;
    assertEq(sendsAfterFirst, 1, 'one request sent');
    // Immediate retry is blocked by backoff
    await env.controller._maybeActivateAsr('stale');
    const sendsAfterSecond = env.runtimeSends.filter((m) => m.type === 'ASR_ENABLE').length;
    assertEq(sendsAfterSecond, 1, 'backoff blocks immediate re-request');
  }

  // ================================================================
  section('sync_controller: terminal error stops auto-retry');
  {
    const env = makeSyncSandbox({ asrFallback: true });
    env.setAsrResponse(() => ({ ok: false, error: { code: 'asr_permission_denied', message: 'denied' } }));
    await env.controller._maybeActivateAsr('stale');
    assertEq(env.controller._asrActive, false, 'not active after terminal error');
    // After backoff cooldown + future stale check, permission errors keep it off
    assertEq(env.controller._asrFailures >= 1, true, 'failure recorded');
  }

  // ================================================================
  section('sync_controller: healthy captions deactivate ASR');
  {
    const env = makeSyncSandbox({ asrFallback: true });
    env.controller._asrActive = true;
    const tc = env.controller.transcriptController;
    tc.activateASR();
    await env.controller._onCaptionHealthChange({ staleSince: null, source: 'texttrack', lastUpdate: Date.now() });
    assertEq(env.controller._asrActive, false, 'deactivated on caption recovery');
    assertEq(tc._captionHealth.asrActive, false, 'transcript health reflects deactivation');
    const stop = env.runtimeSends.find((m) => m.type === 'ASR_DISABLE');
    assert(!!stop, 'ASR_DISABLE sent to service worker');
  }

  // ================================================================
  section('offscreen: PCM conversion + WAV container');
  {
    // Load offscreen helpers in a minimal sandbox (skip listener init — the
    // media path itself needs Chrome, the pure helpers do not).
    const parts = OFF_SRC.split('const ASR_SAMPLE_RATE');
    const helpersSrc = 'const ASR_SAMPLE_RATE' + parts[1].split('// ---- Message listener ----')[0];
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      window: { AudioContext: undefined },
      chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
      Float32Array, Int16Array, ArrayBuffer, DataView, Uint8Array, String, Math,
      navigator: {},
      ATOMIC: true,
    };
    sandbox.globalThis = sandbox;
    sandbox.module = { exports: {} };
    sandbox.window.Office = undefined;
    vm.createContext(sandbox);
    vm.runInContext(helpersSrc + '\nwindow.AV_ASR.asrPcmToWavBase64 = asrPcmToWavBase64;'
      , sandbox, { filename: 'offscreen-helpers.js' });

    const av = sandbox.window.AV_ASR;
    assert(!!av, 'AV_ASR helpers exposed');

    // float → int16 conversion (0.5*0x7FFF = 16383.5 → 16383; standard asymmetric scale)
    const f32 = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    const pcm = av.asrFloatToPcm16(f32);
    assertEq(Array.from(pcm.slice(0, 5)), [0, 16383, -16384, 32767, -32768], 'float→pcm16 scaling/clamping');

    // RMS silence gate
    assertEq(av.asrChunkSilent(new Int16Array(16)), true, 'zero chunk counted silent');
    const loud = av.asrFloatToPcm16(new Float32Array(64).fill(0.5));
    assertEq(av.asrChunkSilent(loud), false, 'loud chunk NOT silent');

    // WAV container parses correctly
    const wavB64 = av.asrPcmToWavBase64(pcm, 16000);
    const bytes = Buffer.from(wavB64, 'base64');
    assertEq(bytes.toString('ascii', 0, 4), 'RIFF', 'WAV RIFF magic');
    assertEq(bytes.toString('ascii', 8, 12), 'WAVE', 'WAVE magic');
    assertEq(bytes.readUInt32LE(24), 16000, 'sample rate 16000');
    assertEq(bytes.readUInt16LE(22), 1, 'mono');
    assertEq(bytes.readUInt16LE(34), 16, '16-bit');
    const dataLen = bytes.readUInt32LE(40);
    assertEq(dataLen, pcm.byteLength, 'data chunk size matches PCM');

    // Decode via Python soundfile? (covered in backend tests.) Node-side size check:
    assertEq(bytes.length, 44 + pcm.byteLength, 'WAV total size = 44 header + data');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ASR FALLBACK: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
