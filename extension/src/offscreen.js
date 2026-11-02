// AakashVani offscreen document — Chrome Translator API lives here (page context, not worker).
// Flow: service worker → EXECUTE_TRANSLATE → offscreen → Chrome Translator OR Sarvam backend → response.

const CHROME_LANG = {
  'te-IN': 'te', 'hi-IN': 'hi', 'kn-IN': 'kn', 'ta-IN': 'ta',
  'ml-IN': 'ml', 'mr-IN': 'mr', 'bn-IN': 'bn', 'gu-IN': 'gu', 'pa-IN': 'pa', 'en-IN': 'en',
};

// Structured translation error codes for reliable error classification
const ERR_LOCAL_UNAVAILABLE = 'LOCAL_TRANSLATOR_UNAVAILABLE';
const ERR_LOCAL_UNSUPPORTED = 'LOCAL_TRANSLATOR_UNSUPPORTED_LANGUAGE';
const ERR_LOCAL_INIT_FAILED = 'LOCAL_TRANSLATOR_INIT_FAILED';
const ERR_LOCAL_FAILED = 'LOCAL_TRANSLATOR_FAILED';
const ERR_CLOUD_AUTH = 'CLOUD_AUTH_FAILED';
const ERR_CLOUD_RATE = 'CLOUD_RATE_LIMITED';
const ERR_CLOUD_NETWORK = 'CLOUD_NETWORK_ERROR';
const ERR_CLOUD_SERVER = 'CLOUD_SERVER_ERROR';

function makeError(code, message) {
  return { code, message };
}

function classifyCloudError(err) {
  const msg = String(err.message || err);
  if (msg.includes('401') || msg.includes('403')) {
    return makeError(ERR_CLOUD_AUTH, 'Sarvam authentication failed — check your API key');
  }
  if (msg.includes('429')) {
    return makeError(ERR_CLOUD_RATE, 'Sarvam rate limit exceeded — try again later');
  }
  if (msg.includes('502') || msg.includes('unreachable') || msg.includes('network')) {
    return makeError(ERR_CLOUD_NETWORK, 'Sarvam service is temporarily unavailable');
  }
  return makeError(ERR_CLOUD_SERVER, `Translation service error: ${msg}`);
}

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
  if (!code) throw makeError(ERR_LOCAL_UNSUPPORTED, `Unsupported target language: ${targetLang}`);
  if (_translator && _translatorLang === code) return _translator;

  const TranslatorAPI = _getTranslatorAPI();
  if (!TranslatorAPI) throw makeError(ERR_LOCAL_UNAVAILABLE, 'CHROME_TRANSLATOR_MISSING');

  let availability;
  try {
    availability = await TranslatorAPI.availability({ sourceLanguage: 'en', targetLanguage: code });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('No available adapters') || msg.includes('unavailable')) {
      throw makeError(ERR_LOCAL_UNAVAILABLE, msg);
    }
    throw makeError(ERR_LOCAL_INIT_FAILED, msg);
  }
  console.log(`[AakashVani:offscreen] availability (en→${code}): ${availability}`);

  if (availability === 'unavailable' || availability === 'no') {
    throw makeError(ERR_LOCAL_UNAVAILABLE, 'No available adapters');
  }

  try {
    if (typeof TranslatorAPI.create === 'function') {
      _translator = await TranslatorAPI.create({ sourceLanguage: 'en', targetLanguage: code });
    } else if (typeof TranslatorAPI.createTranslator === 'function') {
      _translator = await TranslatorAPI.createTranslator({ sourceLanguage: 'en', targetLanguage: code });
    } else {
      throw makeError(ERR_LOCAL_INIT_FAILED, 'Translator API has no create() factory');
    }
  } catch (e) {
    if (e.code) throw e;
    throw makeError(ERR_LOCAL_INIT_FAILED, `Translator initialization failed: ${e.message || e}`);
  }
  _translatorLang = code;
  return _translator;
}

async function translateWithChrome(text, targetLang) {
  if (!_detectTranslatorAPI()) throw makeError(ERR_LOCAL_UNAVAILABLE, 'Chrome Translator API is not available in this browser');
  try {
    const translator = await _getTranslator(targetLang);
    return await translator.translate(text);
  } catch (e) {
    if (e.code) throw e;
    const msg = String(e.message || e);
    if (msg.includes('Unsupported target language') || msg.includes('unsupported')) {
      throw makeError(ERR_LOCAL_UNSUPPORTED, `Chrome Translator does not support this language pair (en → ${targetLang})`);
    }
    if (msg.includes('No available adapters') || msg.includes('unavailable')) {
      throw makeError(ERR_LOCAL_UNAVAILABLE, 'Chrome Translator adapter is not available for this language pair');
    }
    if (msg.includes('CHROME_TRANSLATOR_MISSING') || msg.includes('no create() factory')) {
      throw makeError(ERR_LOCAL_INIT_FAILED, 'Chrome Translator could not be initialized');
    }
    throw makeError(ERR_LOCAL_FAILED, `Chrome translation failed: ${msg}`);
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
    throw classifyCloudError(new Error(`Sarvam ${res.status}: ${txt.slice(0, 160)}`));
  }
  const data = await res.json();
  if (data.detail && !data.translated_text) throw classifyCloudError(new Error(data.detail));
  return data.translated_text || data.translation || data.text || '';
}

// Backward-compat alias
const translateWithSarvam = fetchCloudTranslation;

// ---- Message listener ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ASR lifecycle (tab capture) — handles its own types, falls through otherwise
  const asrHandled = handleOffscreenMessage(msg, sendResponse);
  if (asrHandled !== null) return asrHandled;

  if (msg.type !== 'EXECUTE_TRANSLATE') return false;

  (async () => {
    const { text, targetLang, mode, apiKey, engineUrl } = msg.payload;
    const fallbackApiUrl = engineUrl || 'http://127.0.0.1:8000';

    // Edge / Local mode: Chrome Translator only — never fall back to Sarvam or any cloud provider
    if (mode === 'edge') {
      try {
        const translated = await translateWithChrome(text, targetLang);
        sendResponse({ ok: true, translated, source: 'chrome' });
      } catch (e) {
        const err = e.code ? e : makeError(ERR_LOCAL_FAILED, String(e.message || e));
        sendResponse({ ok: false, error: err });
      }
      return;
    }

    // Cloud mode: Chrome first, Sarvam fallback only when Chrome fails
    if (mode === 'cloud') {
      try {
        const translated = await translateWithChrome(text, targetLang);
        sendResponse({ ok: true, translated, source: 'chrome' });
      } catch (chromeErr) {
        try {
          const translated = await fetchCloudTranslation(text, targetLang, apiKey, fallbackApiUrl);
          sendResponse({ ok: true, translated, source: 'sarvam' });
        } catch (fallbackErr) {
          const err = fallbackErr.code ? fallbackErr : classifyCloudError(fallbackErr);
          sendResponse({ ok: false, error: err });
        }
      }
      return;
    }

    // Auto mode: Chrome first, Sarvam fallback (existing behavior preserved exactly)
    try {
      const translated = await translateWithChrome(text, targetLang);
      sendResponse({ ok: true, translated, source: 'chrome' });
    } catch (chromeErr) {
      try {
        const translated = await fetchCloudTranslation(text, targetLang, apiKey, fallbackApiUrl);
        console.log('[AakashVani:offscreen] Cloud fallback succeeded');
        sendResponse({ ok: true, translated, source: 'sarvam-fallback' });
      } catch (fallbackErr) {
        const err = fallbackErr.code ? fallbackErr : classifyCloudError(fallbackErr);
        sendResponse({ ok: false, error: err });
      }
    }
  })();

  return true; // keep channel open for async response
});

// ================================================================
// ASR fallback — tab-audio capture (Chrome MediaStream), 16 kHz mono PCM
// chunks forwarded to the service worker for local Whisper transcription.
//
// The streamId comes from chrome.tabCapture.getMediaStreamId in the service
// worker (user-gesture initiated from the popup). Offscreen documents can
// consume tab-audio streams; this document already exists for translation.
// ================================================================

const ASR_SAMPLE_RATE = 16000;
const ASR_CHUNK_SECONDS = 2.0;       // chunk length forwarded for transcription
const ASR_CHUNK_SILENCE_SKIP = 0.25; // skip chunks quieter than this RMS

// ---- Capture state (single concurrent capture) ----
const _asr = {
  active: false,
  stream: null,
  context: null,
  processor: null,
  source: null,
  buffer: [],            // Float32 samples pending in current chunk
  samplesInChunk: 0,
  seq: 0,
  engineUrl: null,
  language: '',
};

// Pure helpers (unit-testable without WebAudio):
function asrFloatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function asrRMS(pcm16) {
  let sum = 0;
  for (let i = 0; i < pcm16.length; i++) {
    const v = pcm16[i] / 32768;
    sum += v * v;
  }
  return pcm16.length ? Math.sqrt(sum / pcm16.length) : 0;
}

function asrChunkSilent(pcm16) {
  return asrRMS(pcm16) < ASR_CHUNK_SILENCE_SKIP / 10;
}

function asrPcmToBase64(pcm16) {
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// Wrap raw 16-bit PCM into a minimal WAV container (16 kHz mono, 16-bit).
function asrPcmToWavBase64(pcm16, sampleRate) {
  const lr = 1, br = 2, sr = sampleRate || ASR_SAMPLE_RATE;
  const dataLen = pcm16.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, lr, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * lr * br, true); v.setUint16(32, lr * br, true);
  v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, dataLen, true);
  const bytes = new Uint8Array(buf, 44).set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
  const out = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < out.length; i += CH) {
    bin += String.fromCharCode.apply(null, out.subarray(i, i + CH));
  }
  return btoa(bin);
}

async function startAsrCapture(streamId, engineUrl, language) {
  if (_asr.active) return { ok: true, alreadyActive: true };
  if (!streamId) {
    return { ok: false, error: { code: 'asr_invalid_stream', message: 'missing streamId' } };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'ASR_ERROR',
      code: 'asr_capture_failed',
      message: String(e.message || e),
    }).catch(() => {});
    return { ok: false, error: { code: 'asr_capture_failed', message: String(e.message || e) } };
  }

  const ctx = new AudioContext({ sampleRate: ASR_SAMPLE_RATE, channelCountMode: 'explicit', channelInterpretation: 'speech' });
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but the only node that works everywhere
  // in an offscreen document without a blob worklet module.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    _asr.buffer.push(new Float32Array(input));
    _asr.samplesInChunk += input.length;
    if (_asr.samplesInChunk >= ASR_SAMPLE_RATE * ASR_CHUNK_SECONDS) {
      const flat = new Float32Array(_asr.samplesInChunk);
      let off = 0;
      for (const seg of _asr.buffer) { flat.set(seg, off); off += seg.length; }
      const pcm = asrFloatToPcm16(flat);
      _asr.buffer = [];
      _asr.samplesInChunk = 0;
      if (asrChunkSilent(pcm)) return; // skip silence — saves backend churn
      const seq = ++_asr.seq;
      chrome.runtime.sendMessage({
        type: 'ASR_CHUNK',
        seq,
        audio: asrPcmToWavBase64(pcm, ASR_SAMPLE_RATE),
        language: _asr.language,
      }).catch(() => {});
    }
  };
  src.connect(proc);
  // ScriptProcessor requires a downstream connection to run; connect to a
  // zero-gain sink that never plays (mute).
  const sink = ctx.createGain();
  sink.gain.value = 0;
  proc.connect(sink);
  sink.connect(ctx.destination);
  await ctx.resume().catch(() => {});

  _asr.active = true;
  _asr.stream = stream;
  _asr.context = ctx;
  _asr.processor = proc;
  _asr.source = src;
  _asr.engineUrl = engineUrl || null;
  _asr.language = language || '';
  _asr.seq = 0;
  return { ok: true };
}

function stopAsrCapture() {
  let stopped = false;
  if (_asr.active || _asr.stream) stopped = true;
  try { if (_asr.processor) _asr.processor.disconnect(); } catch (_) {}
  try { if (_asr.source) _asr.source.disconnect(); } catch (_) {}
  try { if (_asr.context) _asr.context.close().catch(() => {}); } catch (_) {}
  try { if (_asr.stream) for (const t of _asr.stream.getTracks()) t.stop(); } catch (_) {}
  _asr.active = false;
  _asr.stream = null;
  _asr.context = null;
  _asr.processor = null;
  _asr.source = null;
  _asr.buffer = [];
  _asr.samplesInChunk = 0;
  return { ok: true, stopped };
}

// Expose pure helpers for tests
window.AV_ASR = {
  asrFloatToPcm16, asrRMS, asrChunkSilent, asrPcmToBase64, asrPcmToWavBase64,
  ASR_SAMPLE_RATE, ASR_CHUNK_SECONDS,
};

// ---- Async handlers used by the message listener below (single registrar so
// extension-page test harnesses capturing one listener keep working).
// NOTE: must stay synchronous — `async` would wrap the null fall-through in a
// Promise and break EXECUTE_TRANSLATE routing.
function handleOffscreenMessage(msg, sendResponse) {
  if (msg.type === 'OFFSCREEN_ASR_START') {
    startAsrCapture(msg.streamId, msg.engineUrl, msg.language)
      .then(sendResponse)
      .catch((e) => sendResponse({
        ok: false,
        error: { code: 'asr_capture_failed', message: String(e.message || e) },
      }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_ASR_STOP') {
    sendResponse(stopAsrCapture());
    return false;
  }
  return null; // not an ASR message
}

console.log('[AakashVani:offscreen] ready — Translator API probe:', typeof window.Translator);
