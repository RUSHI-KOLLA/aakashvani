// AakashVani background orchestrator (MV3 service worker).
// Owns ALL backend API calls; content script never fetches directly so
// host permissions, settings, and retries live in one place.

const ENGINE = 'http://127.0.0.1:8000';
let sarvamBlocked = false;

// Reset the circuit breaker whenever the user changes the API key or mode
chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiKey || changes.mode) {
    sarvamBlocked = false;
    chrome.storage.local.remove('authError');
  }
});

async function getSettings() {
  return chrome.storage.local.get(['mode', 'language', 'apiKey', 'cloudFallback', 'ducking']);
}

async function translateText(text, settings) {
  if (sarvamBlocked && !settings.apiKey) {
    throw new Error('Sarvam auth failed earlier — paste a valid API key in the popup to retry.');
  }
  const body = {
    text,
    target_lang: settings.language || 'te-IN',
    source_lang: 'en-IN',
    mode: settings.mode === 'off' ? 'edge' : (settings.mode || 'auto'),
  };
  if (settings.apiKey) body.sarvam_api_key = settings.apiKey;
  const res = await fetch(`${ENGINE}/api/v1/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Circuit breaker: repeated 401/403 means the key is dead; stop hammering
    // the API on every caption line until a new key is set.
    if (res.status === 401 || res.status === 403) {
      sarvamBlocked = true;
      chrome.storage.local.set({ authError: 'Sarvam rejected the API key (403). Paste a valid key in the popup.' });
      chrome.runtime.sendMessage({ type: 'AUTH_ERROR', error: 'Sarvam rejected the API key (403 invalid_api_key_error).' }).catch(() => {});
    }
    throw new Error(`translate ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
  const data = await res.json();
  if (data.detail) throw new Error(data.detail);
  return data.translated_text || data.translation || data.text || '';
}

async function synthesizeSpeech(text, settings) {
  const body = {
    text,
    target_lang: settings.language || 'te-IN',
    mode: settings.mode === 'off' ? 'edge' : (settings.mode || 'auto'),
    speaker_id: null,
  };
  if (settings.apiKey) body.sarvam_api_key = settings.apiKey;
  const res = await fetch(`${ENGINE}/api/v1/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  if (!data.audio_base64) throw new Error(data.detail || 'no audio_base64 in TTS response');
  return data; // {status, mode, language_code, duration_seconds, audio_base64}
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      if (msg.type === 'PING_ENGINE') {
        const res = await fetch(`${ENGINE}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
        sendResponse({ ok: res.ok });
      } else if (msg.type === 'DUB_LINE') {
        // Full pipeline for one caption line: translate -> TTS -> base64 audio
        const translated = await translateText(msg.text, settings);
        if (!translated) return sendResponse({ ok: true, audio: null, reason: 'empty translation' });
        const tts = await synthesizeSpeech(translated, settings);
        sendResponse({ ok: true, audio: tts.audio_base64, duration: tts.duration_seconds });
      } else {
        sendResponse({ ok: false, error: `unknown message type ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

console.log('[AakashVani] service worker ready');
