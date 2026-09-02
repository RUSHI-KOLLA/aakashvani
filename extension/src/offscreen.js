// AakashVani offscreen document — Chrome Translator API lives here (page context, not worker).
// Flow: service worker → EXECUTE_TRANSLATE → offscreen → Chrome Translator OR Sarvam backend → response.

const CHROME_LANG = {
  'te-IN': 'te', 'hi-IN': 'hi', 'kn-IN': 'kn', 'ta-IN': 'ta',
  'ml-IN': 'ml', 'mr-IN': 'mr', 'bn-IN': 'bn', 'gu-IN': 'gu', 'pa-IN': 'pa', 'en-IN': 'en',
};

let _translator = null;
let _translatorLang = null;
let _apiChecked = false;
let _apiAvailable = false;

function _detectTranslatorAPI() {
  if (_apiChecked) return _apiAvailable;
  _apiChecked = true;
  const hasTranslator = typeof window.Translator === 'function';
  const hasLegacy = window.translation && typeof window.translation.Translator === 'function';
  const hasAI = window.ai && typeof window.ai.translator === 'object';
  if (hasTranslator || hasLegacy || hasAI) {
    _apiAvailable = true;
    console.log('[AakashVani:offscreen] Translator API found');
    return true;
  }
  console.warn('[AakashVani:offscreen] Translator API not available in this context');
  return false;
}

function _getTranslatorAPI() {
  return window.Translator || (window.translation && window.translation.Translator) || (window.ai && window.ai.translator) || null;
}

async function _getTranslator(targetLang) {
  const code = CHROME_LANG[targetLang];
  if (!code) throw new Error(`Unsupported target language: ${targetLang}`);
  if (_translator && _translatorLang === code) return _translator;

  const TranslatorAPI = _getTranslatorAPI();
  if (!TranslatorAPI) throw new Error('CHROME_TRANSLATOR_MISSING');

  let availability;
  try {
    availability = await TranslatorAPI.availability({ sourceLanguage: 'en', targetLanguage: code });
  } catch (e) {
    // availability() may throw "No available adapters" synchronously
    throw new Error(String(e.message || e));
  }
  console.log(`[AakashVani:offscreen] availability (en→${code}): ${availability}`);

  if (availability === 'unavailable' || availability === 'no') {
    throw new Error('No available adapters');
  }

  const opts = { sourceLanguage: 'en', targetLanguage: code };
  if (typeof TranslatorAPI.create === 'function') {
    _translator = await TranslatorAPI.create(opts);
  } else if (typeof TranslatorAPI.createTranslator === 'function') {
    _translator = await TranslatorAPI.createTranslator(opts);
  } else {
    throw new Error('Translator API has no create() factory');
  }
  _translatorLang = code;
  return _translator;
}

async function translateWithChrome(text, targetLang) {
  if (!_detectTranslatorAPI()) throw new Error('CHROME_TRANSLATOR_MISSING');
  const translator = await _getTranslator(targetLang);
  try {
    return await translator.translate(text);
  } catch (e) {
    // translate() itself can throw "No available adapters" for unsupported pairs like te/hi
    throw new Error(String(e.message || e));
  }
}

async function fetchCloudTranslation(text, targetLang, apiKey, engineUrl) {
  const fallbackApiUrl = engineUrl || 'http://127.0.0.1:8000';
  const body = { text, target_lang: targetLang || 'te-IN', source_lang: 'en-IN', mode: 'cloud' };
  if (apiKey) body.sarvam_api_key = apiKey;
  const res = await fetch(`${fallbackApiUrl}/api/v1/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Sarvam ${res.status}: ${txt.slice(0, 160)}`);
  }
  const data = await res.json();
  if (data.detail && !data.translated_text) throw new Error(data.detail);
  return data.translated_text || data.translation || data.text || '';
}

// Backward-compat alias
const translateWithSarvam = fetchCloudTranslation;

// ---- Message listener ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'EXECUTE_TRANSLATE') return false;

  (async () => {
    const { text, targetLang, mode, apiKey, engineUrl } = msg.payload;
    const fallbackApiUrl = engineUrl || 'http://127.0.0.1:8000';

    // Cloud mode: direct Sarvam path (no Chrome check needed)
    if (mode === 'cloud') {
      try {
        const translated = await fetchCloudTranslation(text, targetLang, apiKey, fallbackApiUrl);
        sendResponse({ ok: true, translated, source: 'sarvam' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }

    // Edge / Auto: try Chrome first, seamlessly fallback to backend on ANY failure
    try {
      const translated = await translateWithChrome(text, targetLang);
      sendResponse({ ok: true, translated, source: 'chrome' });
    } catch (chromeErr) {
      const errMsg = String(chromeErr.message || chromeErr);
      const isAdapterMissing =
        errMsg.includes('No available adapters') ||
        errMsg.includes('CHROME_TRANSLATOR_MISSING') ||
        errMsg.includes('unavailable') ||
        errMsg.includes('Translator API not found') ||
        errMsg.includes('no') ||
        errMsg.includes('unsupported');

      if (isAdapterMissing) {
        console.log('[AakashVani:offscreen] Local adapter missing. Falling back to backend cloud NMT...');
        try {
          const translated = await fetchCloudTranslation(text, targetLang, apiKey, fallbackApiUrl);
          console.log('[AakashVani:offscreen] Cloud fallback succeeded');
          sendResponse({ ok: true, translated, source: 'sarvam-fallback' });
        } catch (fallbackErr) {
          sendResponse({ ok: false, error: String(fallbackErr.message || fallbackErr) });
        }
      } else {
        // Non-adapter error (e.g. Sarvam key invalid) — try fallback once, then surface error
        try {
          console.log('[AakashVani:offscreen] Chrome error, trying backend fallback:', errMsg);
          const translated = await fetchCloudTranslation(text, targetLang, apiKey, fallbackApiUrl);
          sendResponse({ ok: true, translated, source: 'sarvam-fallback' });
        } catch (_) {
          sendResponse({ ok: false, error: errMsg });
        }
      }
    }
  })();

  return true; // keep channel open for async response
});

console.log('[AakashVani:offscreen] ready — Translator API probe:', typeof window.Translator);
