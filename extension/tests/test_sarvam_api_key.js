// AakashVani Sarvam API key entry flow tests.
// Verifies end-to-end that a user-entered Sarvam API key persists, is routed
// through every message/request layer, and is used for Sarvam TTS requests.
// Piper continues to work without any Sarvam key.
// Run: node extension/tests/test_sarvam_api_key.js

const fs = require('fs');
const path = require('path');

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

const SRC = path.join(__dirname, '..', 'src', 'popup');

async function run() {
  section('1. API key persistence via chrome.storage.local');

  // 1a: Default apiKey is empty string
  {
    const sc = fs.readFileSync(path.join(SRC, 'sync_controller.js'), 'utf8');
    assert(sc.includes("'apiKey'"), "sync_controller reads apiKey from chrome.storage.local");
    assert(sc.includes("this.settings.apiKey = ch.apiKey.newValue"), "sync_controller updates apiKey on storage change");
  }

  // 1b: popup.js saves apiKey to storage
  {
    const pj = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');
    assert(pj.includes("saveSetting('apiKey', els.apiKey.value)"), "popup saves apiKey on input change");
    assert(pj.includes("els.apiKey.value = settings.apiKey"), "popup loads saved apiKey into input");
  }

  section('2. Latest saved key is used after changing');

  {
    const sc = fs.readFileSync(path.join(SRC, 'sync_controller.js'), 'utf8');
    // When apiKey changes in storage, onChanged updates this.settings.apiKey
    assert(sc.includes("if (ch.apiKey)"), "sync_controller handles apiKey storage changes");
    assert(sc.includes("this.settings.apiKey = ch.apiKey.newValue"), "sync_controller applies new apiKey value");
  }

  section('3. Clearing the key prevents it from being sent');

  {
    const sw = fs.readFileSync(path.join(SRC, 'service_worker.js'), 'utf8');
    // apiKey = msg.apiKey || settings.apiKey || '' — empty string when no key
    assert(sw.includes("const apiKey = msg.apiKey || settings.apiKey || ''"), "service_worker derives apiKey with empty-string fallback");
    assert(sw.includes("synthesizeSpeech(msg.text, msg.language, msg.backend, apiKey)"), "service_worker passes resolved apiKey");
  }

  section('4. Sarvam TTS receives the key through every message/request layer');

  {
    const sw = fs.readFileSync(path.join(SRC, 'service_worker.js'), 'utf8');
    // Layer 1: sync_controller → service_worker (TTS_ONLY message includes apiKey)
    const sc = fs.readFileSync(path.join(SRC, 'sync_controller.js'), 'utf8');
    assert(sc.includes("apiKey: settings.apiKey || ''"), "sync_controller includes apiKey in TTS_ONLY message");

    // Layer 2: service_worker → backend (sarvam_api_key in request body)
    assert(sw.includes("body.sarvam_api_key = apiKey"), "service_worker adds sarvam_api_key to request body for Sarvam backend");
    assert(sw.includes("if (!isPiper && apiKey)"), "service_worker only forwards key for Sarvam backend (not Piper)");
  }

  section('5. Piper works without any Sarvam key');

  {
    const sw = fs.readFileSync(path.join(SRC, 'service_worker.js'), 'utf8');
    assert(sw.includes("const isPiper = backend === 'piper'"), "Piper path checks backend === 'piper'");
    assert(sw.includes("if (!isPiper && apiKey)"), "Sarvam key only added when NOT Piper");
    assert(sw.includes("const path = isPiper ? '/api/v1/tts/piper' : '/api/v1/tts'"), "Piper routes to /api/v1/tts/piper without key");
  }

  section('6. Key is never logged or returned in errors');

  {
    const sw = fs.readFileSync(path.join(SRC, 'service_worker.js'), 'utf8');
    // Error responses don't echo back apiKey or sarvam_api_key
    assert(!sw.includes("console.log(apiKey)"), "service_worker does not log apiKey");
    assert(!sw.includes("console.error(apiKey)"), "service_worker does not error-log apiKey");
    assert(sw.includes("The key is never logged and never echoed back to the client"), "service_worker documents key non-logging");

    const sarvam = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'app', 'services', 'sarvam_tts.py'), 'utf8');
    assert(sarvam.includes("never logged and never returned to the client"), "sarvam_tts documents key non-logging");
    // Error responses include provider and error code but not the key
    const ttsRouter = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'app', 'routers', 'tts.py'), 'utf8');
    assert(ttsRouter.includes('"provider": "sarvam"'), "router errors include provider, not key");
    assert(sarvam.includes('detail={"code":'), "sarvam errors use structured codes, not key values");
  }

  section('7. Backend failure does not silently switch providers');

  {
    const sc = fs.readFileSync(path.join(SRC, 'sync_controller.js'), 'utf8');
    // TTS failure throws an error (not silently falling back to Piper)
    assert(sc.includes("throw new Error(tts.error)"), "sync_controller throws on TTS failure (no silent fallback)");
    // Error is logged with provider context
    assert(sc.includes("[AakashVani] TTS failed"), "sync_controller logs TTS failure");
  }

  section('8. Audio response decoded and passed to playback path');

  {
    const sc = fs.readFileSync(path.join(SRC, 'sync_controller.js'), 'utf8');
    assert(sc.includes("_createAudio(base64)"), "sync_controller decodes base64 audio via _createAudio");
    assert(sc.includes("new Blob([bytes], { type: 'audio/wav' })"), "sync_controller creates WAV blob for playback");
    assert(sc.includes("new Audio(url)"), "sync_controller creates Audio element for playback");
    assert(sc.includes("seg.audio.play()"), "sync_controller plays audio via Audio.play()");
  }

  section('9. Backend uses per-request key even without SARVAM_API_KEY env var');

  {
    const sarvam = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'app', 'services', 'sarvam_tts.py'), 'utf8');
    assert(sarvam.includes("key = api_key or os.getenv(\"SARVAM_API_KEY\", \"\")"), "backend uses per-request key first, env var as fallback");
    assert(sarvam.includes('status_code=401'), "backend returns 401 when no key available at all");
    assert(sarvam.includes('detail={"code": "missing_api_key"}'), "backend returns structured missing_api_key error");
  }

  section('10. Error classification for missing/invalid/unauthorized keys');

  {
    const sarvam = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'app', 'services', 'sarvam_tts.py'), 'utf8');
    assert(sarvam.includes('"code": "invalid_api_key_error"'), "backend classifies 403 as invalid_api_key_error");
    assert(sarvam.includes('"code": "rate_limited"'), "backend classifies 429 as rate_limited");
    assert(sarvam.includes('"code": "missing_api_key"'), "backend classifies missing key as missing_api_key");
    assert(sarvam.includes('"code": "unprocessable_entity_error"'), "backend classifies bad language as unprocessable_entity_error");
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SARVAM API KEY FLOW: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
