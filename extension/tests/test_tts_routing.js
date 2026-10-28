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
const sc = fs.readFileSync('src/popup/sync_controller.js', 'utf8');
check(sc.includes("backend: this.settings.ttsBackend || 'piper'"), "sync_controller sends backend = ttsBackend || 'piper'");
check(sc.includes("this.settings.ttsBackend || 'piper'"), "sync_controller defaults backend to 'piper'");
const sw = fs.readFileSync('src/popup/service_worker.js', 'utf8');
check(sw.includes("synthesizeSpeech(msg.text, msg.language, msg.backend)"), "service worker forwards msg.backend to synthesizeSpeech");
check(sw.includes("async function synthesizeSpeech(text, language, backend = 'piper')"), "service worker synthesizeSpeech defaults backend='piper'");

console.log(`--- B3 result: ${pass} pass, ${fail} fail ---`);
process.exit(fail ? 1 : 0);
