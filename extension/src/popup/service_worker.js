// AakashVani background orchestrator (MV3 service worker).
//
// NEW architecture:
//   * NMT/translation happens ON-DEVICE here via Chrome's built-in Translator
//     API ("GTX" mode) — no NLLB/cloud NMT is used.
//   * The backend is only used for TTS (IITM FastSpeech2) - POST /api/v1/tts
//   * content script never fetches directly; all calls go through here.

const ENGINE = 'http://127.0.0.1:8000';

// Map app BCP-47 lang ids (te-IN) -> 2-letter code used by Chrome Translator API
const CHROME_LANG = {
  'te-IN': 'te', 'hi-IN': 'hi', 'kn-IN': 'kn', 'ta-IN': 'ta',
  'ml-IN': 'ml', 'mr-IN': 'mr', 'bn-IN': 'bn', 'gu-IN': 'gu', 'pa-IN': 'pa', 'en-IN': 'en',
};

async function getSettings() {
  return chrome.storage.local.get(['mode', 'language', 'ducking']);
}

// ---------------------------------------------------------------------------
// Chrome built-in on-device translation (Translator API).
// Availability: latest Chrome with the built-in AI / translator model enabled.
//   @param text      caption line (already the spoken language, often English)
//   @param language  BCP-47 target, e.g. 'te-IN'
// ---------------------------------------------------------------------------
async function translateWithChrome(text, language) {
  if (!self.translation || !self.translation.Translator || !self.translation.create) {
    throw new Error('Chrome built-in Translator API is unavailable. Use a Chrome ' +
      'version with on-device translation enabled (chrome://flags/optimization-guide-on-device-model, ' +
      'TranslatorAPI). This removes the 2.9GB NLLB model entirely.');
  }
  const target = CHROME_LANG[language];
  if (!target) throw new Error(`Chrome Translator has no code for '${language}'`);

  const availability = await self.translation.Translator.availability?.
    ({ sourceLanguage: 'en', targetLanguage: target }).catch?.(() => 'download');
  if (availability === 'unavailable') {
    throw new Error('Chrome Translator: this language pair / device is unavailable.');
  }
  if (availability === 'download') {
    // Chrome downloads the on-device language model on first use.
  }

  const translator = await self.translation.create({ sourceLanguage: 'en', targetLanguage: target });
  return await translator.translate(text);
}

// ---------------------------------------------------------------------------
// Backend TTS only (IITM FastSpeech2 + HiFi-GAN)
// ---------------------------------------------------------------------------
async function synthesizeSpeech(text, settings) {
  const body = {
    text,
    target_lang: settings.language || 'te-IN',
    mode: settings.mode === 'off' ? 'edge' : (settings.mode || 'edge'),
    speaker_id: null,
  };
  const res = await fetch(`${ENGINE}/api/v1/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw res.status === 503
      ? new Error(`TTS unavailable (IITM FastSpeech2 checkpoint missing): ${detail}`)
      : new Error(`tts ${res.status}: ${detail}`);
  }
  const data = await res.json();
  if (!data.audio_base64) throw new Error(data.detail || 'no audio_base64 in TTS response');
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      if (msg.type === 'PING_ENGINE') {
        const res = await fetch(`${ENGINE}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, tts_loaded: !!data.tts_loaded });
      } else if (msg.type === 'DUB_LINE') {
        // 1) translate on-device with Chrome built-in AI
        const translated = await translateWithChrome(msg.text, settings.language || 'te-IN');
        if (!translated) return sendResponse({ ok: true, audio: null, reason: 'empty translation' });
        // 2) synthesize via the local engine
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

console.log('[AakashVani] service worker ready (chrome built-in translator + IITM TTS)');
