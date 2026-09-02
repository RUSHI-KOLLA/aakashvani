// AakashVani background orchestrator (MV3 service worker).
// Architecture:
//   - Translation: offscreen document (has page context → window.Translator) or Sarvam backend
//   - TTS: local IITM FastSpeech2 via POST /api/v1/tts
//   - Service worker coordinates everything but never touches Translator API directly

const DEFAULT_ENGINE = 'http://127.0.0.1:8000';
const OFFSCREEN_PATH = 'offscreen.html';

let sarvamBlocked = false;

chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiKey || changes.mode) {
    sarvamBlocked = false;
    chrome.storage.local.remove('authError');
  }
});

async function getSettings() {
  return chrome.storage.local.get(['mode', 'language', 'apiKey', 'cloudFallback', 'ducking', 'engineUrl']);
}

async function getEngineUrl() {
  const { engineUrl } = await chrome.storage.local.get('engineUrl');
  return engineUrl || DEFAULT_ENGINE;
}

// ---- Offscreen document lifecycle ----
async function ensureOffscreenDocument() {
  // chrome.offscreen.hasDocument() is async in MV3
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Chrome Translator API requires page context (not available in service workers)',
  });
  // Small delay for the document to initialize
  await new Promise((r) => setTimeout(r, 200));
}

// ---- Route translation to offscreen document ----
async function translateViaOffscreen(payload) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('offscreen translate timeout (15s)')), 15000);
    chrome.runtime.sendMessage({ type: 'EXECUTE_TRANSLATE', payload }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// ---- TTS (IITM FastSpeech2) ----
async function synthesizeSpeech(text, language) {
  const engine = await getEngineUrl();
  const body = { text, target_lang: language || 'te-IN' };
  const res = await fetch(`${engine}/api/v1/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 503) {
    const err = await res.json().catch(() => ({}));
    const detail = err.detail || {};
    if (detail.checkpoint_missing) {
      const prepared = await prepareCheckpoint(detail.checkpoint_missing);
      if (!prepared.ok) throw new Error(prepared.error || 'checkpoint download failed');
      const retry = await fetch(`${engine}/api/v1/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!retry.ok) throw new Error(`tts after prepare ${retry.status}`);
      const data = await retry.json();
      if (!data.audio_base64) throw new Error(data.detail || 'no audio after prepare');
      return data;
    }
    throw new Error(`tts 503: ${JSON.stringify(detail).slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  if (!data.audio_base64) throw new Error(data.detail || 'no audio_base64 in TTS response');
  return data;
}

async function prepareCheckpoint(lang) {
  const engine = await getEngineUrl();
  const start = await fetch(`${engine}/api/v1/tts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
  const startData = await start.json().catch(() => ({}));
  if (!start.ok) return { ok: false, error: startData.detail || `prepare ${start.status}` };
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await fetch(`${engine}/api/v1/tts/prepare/status`).then((r) => r.json()).catch(() => null);
    if (!st) continue;
    chrome.runtime.sendMessage({ type: 'CHECKPOINT_PROGRESS', lang, status: st.status, progress: st.progress, error: st.error }).catch(() => {});
    if (st.status === 'ready') return { ok: true };
    if (st.status === 'error') return { ok: false, error: st.error };
  }
  return { ok: false, error: 'checkpoint download timed out' };
}

// ---- Message router ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const engine = await getEngineUrl();

      if (msg.type === 'PING_ENGINE') {
        const res = await fetch(`${engine}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, tts_loaded: !!data.tts_loaded });

      } else if (msg.type === 'TRANSLATE') {
        // All translation goes through offscreen document
        const settings = await getSettings();
        const result = await translateViaOffscreen({
          text: msg.text,
          targetLang: msg.language || settings.language || 'te-IN',
          mode: msg.mode || settings.mode || 'auto',
          apiKey: msg.apiKey || settings.apiKey || '',
          engineUrl: engine,
        });
        sendResponse(result);

      } else if (msg.type === 'TTS_ONLY') {
        const tts = await synthesizeSpeech(msg.text, msg.language);
        sendResponse({ ok: true, audio: tts.audio_base64, duration: tts.duration_seconds });

      } else {
        sendResponse({ ok: false, error: `unknown message type ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

console.log('[AakashVani] service worker ready (offscreen translation + IITM TTS)');
