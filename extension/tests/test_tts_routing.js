// B3: Verify the extension's endpoint-selection routing logic.
// Piper ONNX is the only active TTS backend.
// Replicates the pure decision in service_worker.js synthesizeSpeech():
//   isPiper = (backend === 'piper')
//   path = isPiper ? '/api/v1/tts/piper' : '/api/v1/tts'
let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log("  PASS:", msg); }
  else { fail++; console.error("  FAIL:", msg); }
}

function ttsPath(backend = 'piper') {
  const isPiper = backend === 'piper';
  return isPiper ? '/api/v1/tts/piper' : '/api/v1/tts';
}

function preparePath(backend = 'piper') {
  const isPiper = backend === 'piper';
  return `/api/v1/${isPiper ? 'tts/piper' : 'tts'}/prepare`;
}

function prepareStatusPath(backend = 'piper', lang) {
  const isPiper = backend === 'piper';
  return `/api/v1/${isPiper ? 'tts/piper' : 'tts'}/prepare/status?lang=${encodeURIComponent(lang)}`;
}

console.log("--- Piper routing (backend='piper' and default) ---");
check(ttsPath('piper') === '/api/v1/tts/piper', "piper TTS -> /api/v1/tts/piper");
check(preparePath('piper') === '/api/v1/tts/piper/prepare', "piper prepare -> /api/v1/tts/piper/prepare");
check(prepareStatusPath('piper', 'te-IN') === '/api/v1/tts/piper/prepare/status?lang=te-IN', "piper status -> /api/v1/tts/piper/prepare/status?lang=te-IN");

// Default (no arg / undefined) now routes to Piper (the active backend).
check(ttsPath() === '/api/v1/tts/piper', "default routes to /api/v1/tts/piper (Piper active)");
check(ttsPath(undefined) === '/api/v1/tts/piper', "undefined backend -> /api/v1/tts/piper (Piper active)");

console.log("--- sync_controller passes backend in TTS_ONLY (source check) ---");
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src', 'popup');
const sc = fs.readFileSync(path.join(SRC, 'sync_controller.js'), 'utf8');
// Backend is extracted into a local const, defaults to 'piper', included in TTS cache key.
check(sc.includes("const backend = this.settings.ttsBackend || 'piper'"), "sync_controller computes backend = ttsBackend || 'piper'");
check(sc.includes("this.settings.ttsBackend || 'piper'"), "sync_controller defaults backend to 'piper'");
check(sc.includes("`${translated}|${lang}|${backend}`"), "sync_controller TTS cache key includes backend/provider");
check(sc.includes("apiKey: settings.apiKey || ''"), "sync_controller forwards apiKey in TTS_ONLY message");
const sw = fs.readFileSync(path.join(SRC, 'service_worker.js'), 'utf8');
check(sw.includes("const apiKey = msg.apiKey || settings.apiKey || ''"), "service worker derives apiKey from message or storage");
check(sw.includes("synthesizeSpeech(msg.text, msg.language, msg.backend, apiKey)"), "service worker passes resolved apiKey to synthesizeSpeech");
check(sw.includes("async function synthesizeSpeech(text, language, backend = 'piper', apiKey = '')"), "service worker synthesizeSpeech defaults backend='piper', apiKey=''");
check(sw.includes("body.sarvam_api_key = apiKey"), "service worker forwards sarvam_api_key in request body for Sarvam backend");
check(sw.includes("provider: tts.provider"), "service worker forwards provider metadata in TTS response");

console.log("--- Sarvam routing (backend='sarvam') ---");
check(ttsPath('sarvam') === '/api/v1/tts', "sarvam TTS -> /api/v1/tts");
check(preparePath('sarvam') === '/api/v1/tts/prepare', "sarvam prepare -> /api/v1/tts/prepare");
check(prepareStatusPath('sarvam', 'te-IN') === '/api/v1/tts/prepare/status?lang=te-IN', "sarvam status -> /api/v1/tts/prepare/status?lang=te-IN");
check(ttsPath('sarvam') !== ttsPath('piper'), "sarvam and piper use different endpoints");

console.log(`--- B3 result: ${pass} pass, ${fail} fail ---`);
process.exit(fail ? 1 : 0);
