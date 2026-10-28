// B3: Verify the extension's endpoint-selection routing logic.
// Replicates the pure decision in service_worker.js synthesizeSpeech():
//   isPiper = (backend === 'piper')
//   path = isPiper ? '/api/v1/tts/piper' : '/api/v1/tts'
let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log("  PASS:", msg); }
  else { fail++; console.error("  FAIL:", msg); }
}

function ttsPath(backend) {
  const isPiper = backend === 'piper';
  return isPiper ? '/api/v1/tts/piper' : '/api/v1/tts';
}

function preparePath(backend) {
  const isPiper = backend === 'piper';
  return `/api/v1/${isPiper ? 'tts/piper' : 'tts'}/prepare`;
}

function prepareStatusPath(backend, lang) {
  const isPiper = backend === 'piper';
  return `/api/v1/${isPiper ? 'tts/piper' : 'tts'}/prepare/status?lang=${encodeURIComponent(lang)}`;
}

console.log("--- Piper routing (backend='piper') ---");
check(ttsPath('piper') === '/api/v1/tts/piper', "piper TTS -> /api/v1/tts/piper");
check(preparePath('piper') === '/api/v1/tts/piper/prepare', "piper prepare -> /api/v1/tts/piper/prepare");
check(prepareStatusPath('piper', 'te-IN') === '/api/v1/tts/piper/prepare/status?lang=te-IN', "piper status -> /api/v1/tts/piper/prepare/status?lang=te-IN");

console.log("--- IITM routing (backend='iitm' and default/undefined) ---");
check(ttsPath('iitm') === '/api/v1/tts', "iitm TTS -> /api/v1/tts");
check(preparePath('iitm') === '/api/v1/tts/prepare', "iitm prepare -> /api/v1/tts/prepare");
check(prepareStatusPath('iitm', 'te-IN') === '/api/v1/tts/prepare/status?lang=te-IN', "iitm status -> /api/v1/tts/prepare/status?lang=te-IN");
check(ttsPath(undefined) === '/api/v1/tts', "default (undefined) -> /api/v1/tts (backward compatible)");
check(ttsPath('') === '/api/v1/tts', "default ('') -> /api/v1/tts (backward compatible)");
check(ttsPath('iitm') !== ttsPath('piper'), "IITM and Piper paths differ (no cross-talk)");

console.log("--- sync_controller passes backend in TTS_ONLY (source check) ---");
const fs = require('fs');
const sc = fs.readFileSync('src/popup/sync_controller.js', 'utf8');
check(sc.includes("backend: this.settings.ttsBackend || 'iitm'"), "sync_controller sends backend = ttsBackend || 'iitm'");
check(sc.includes("this.settings.ttsBackend || 'iitm'"), "sync_controller defaults backend to 'iitm'");
const sw = fs.readFileSync('src/popup/service_worker.js', 'utf8');
check(sw.includes("synthesizeSpeech(msg.text, msg.language, msg.backend)"), "service worker forwards msg.backend to synthesizeSpeech");
check(sw.includes("async function synthesizeSpeech(text, language, backend = 'iitm')"), "service worker synthesizeSpeech defaults backend='iitm'");

console.log(`--- B3 result: ${pass} pass, ${fail} fail ---`);
process.exit(fail ? 1 : 0);
