// AakashVani background orchestrator (MV3 service worker).
// Architecture:
//   - Translation: offscreen document (has page context → window.Translator) or Sarvam backend
//   - TTS: local Piper ONNX via POST /api/v1/tts/piper
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
  const url = (engineUrl || DEFAULT_ENGINE).trim();
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    return url;
  } catch {
    console.warn('[AakashVani] invalid engineUrl, falling back to', DEFAULT_ENGINE);
    return DEFAULT_ENGINE;
  }
}

// ---- Offscreen document lifecycle (race-safe) ----
let _offscreenCreating = null;
async function ensureOffscreenDocument(reasons = ['DOM_PARSER']) {
  if (await chrome.offscreen.hasDocument().catch(() => false)) return;
  if (_offscreenCreating) { await _offscreenCreating.catch(()=>{}); return; }
  _offscreenCreating = (async () => {
    if (await chrome.offscreen.hasDocument().catch(() => false)) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons,
        justification: reasons.includes('USER_MEDIA')
          ? 'Capturing active-tab audio for ASR fallback when video captions are unavailable, plus translation orchestrator'
          : 'Chrome Translator API requires page context (not available in service workers)',
      });
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      // "Only a single offscreen document" — another caller won the race, ignore
      if (!String(e.message).includes('single offscreen')) throw e;
    }
  })();
  try { await _offscreenCreating; } finally { _offscreenCreating = null; }
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

// ---- TTS (Piper ONNX + Sarvam AI Bulbul) ----
async function synthesizeSpeech(text, language, backend = 'piper', apiKey = '') {
  const engine = await getEngineUrl();
  const isPiper = backend === 'piper';
  const path = isPiper ? '/api/v1/tts/piper' : '/api/v1/tts';
  const body = { text, target_lang: language || 'te-IN' };
  // Forward the Sarvam API key only when calling the Sarvam TTS endpoint.
  // The key is never logged and never echoed back to the client.
  if (!isPiper && apiKey) {
    body.sarvam_api_key = apiKey;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${engine}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status === 503) {
      const err = await res.json().catch(() => ({}));
      const detail = err.detail || {};
      // checkpoint_missing = voice downloadable (Piper); piper_voice_missing = no voice exists (permanent)
      if (detail.checkpoint_missing) {
        prepareCheckpoint(detail.checkpoint_missing, backend).catch(() => {});
        throw new Error(`checkpoint_preparing:${detail.checkpoint_missing}`);
      }
      throw new Error(`tts 503: ${JSON.stringify(detail).slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    if (!data.audio_base64) throw new Error(data.detail || 'no audio_base64 in TTS response');
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('tts timeout (10s)');
    throw e;
  }
}

async function prepareCheckpoint(lang, backend = 'piper') {
  const engine = await getEngineUrl();
  const isPiper = backend === 'piper';
  const start = await fetch(`${engine}/api/v1/${isPiper ? 'tts/piper' : 'tts'}/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
  const startData = await start.json().catch(() => ({}));
  if (!start.ok) return { ok: false, error: startData.detail || `prepare ${start.status}` };
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await fetch(`${engine}/api/v1/${isPiper ? 'tts/piper' : 'tts'}/prepare/status?lang=${encodeURIComponent(lang)}`).then((r) => r.json()).catch(() => null);
    if (!st) continue;
    chrome.runtime.sendMessage({ type: 'CHECKPOINT_PROGRESS', lang, backend, status: st.status, progress: st.progress, error: st.error }).catch(() => {});
    if (st.status === 'ready') return { ok: true };
    if (st.status === 'error') return { ok: false, error: st.error };
  }
  return { ok: false, error: 'checkpoint download timed out' };
}

// ---- ASR fallback: capture active-tab audio → local Whisper transcription ----
// Flow (user gesture required):
//   popup toggle (ASR_ENABLE) → tabCapture.getMediaStreamId → offscreen document
//   → getUserMedia(tab stream) → AudioContext 16 kHz → PCM chunks (~2 s)
//   → ASR_CHUNK → POST {engine}/api/v1/asr → ASR_RESULT broadcast → dub pipeline.
// Every failure mode surfaces as ASR_ERROR with a stable code.

function asrError(code, message) {
  return { ok: false, error: { code, message: String(message || code) } };
}

async function startASR(tabId) {
  if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
    return asrError('asr_tabcapture_unavailable',
      'chrome.tabCapture is unavailable — check manifest permission "tabCapture"');
  }
  await ensureOffscreenDocument(['USER_MEDIA', 'DOM_PARSER']);

  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
  } catch (e) {
    // Permission denied / no media in tab / not a user gesture
    return asrError('asr_permission_denied', e.message || 'tabCapture denied');
  }
  if (!streamId) {
    return asrError('asr_permission_denied', 'tabCapture returned no stream id');
  }

  const engine = await getEngineUrl();
  const settings = await getSettings();
  const started = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ASR_START',
      streamId,
      engineUrl: engine,
      language: settings.language || '',
    }, (resp) => {
      if (chrome.runtime.lastError) resolve(asrError('asr_offscreen_failed', chrome.runtime.lastError.message));
      else resolve(resp || asrError('asr_offscreen_failed', 'no response from offscreen document'));
    });
  });
  return started && started.ok ? { ok: true } : (started || asrError('asr_offscreen_failed', 'start failed'));
}

async function stopASR() {
  await ensureOffscreenDocument(['USER_MEDIA', 'DOM_PARSER']);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ASR_STOP' }, (resp) => {
      if (chrome.runtime.lastError) resolve(asrError('asr_offscreen_failed', chrome.runtime.lastError.message));
      else resolve(resp || { ok: true, stopped: false });
    });
  });
}

// Transcribe one PCM chunk and broadcast the result into content pages.
async function handleASRChunk(msg) {
  const engine = await getEngineUrl();
  try {
    const res = await fetch(`${engine}/api/v1/asr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: msg.audio, language: msg.language || '' }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const detail = data.detail || {};
      chrome.runtime.sendMessage({
        type: 'ASR_ERROR',
        code: detail.code || `asr_http_${res.status}`,
        message: detail.message || `ASR request failed (${res.status})`,
      }).catch(() => {});
      return;
    }
    // Empty transcripts (pure music / silence / VAD) are legitimately skipped.
    if (!data.text || !String(data.text).trim()) return;
    chrome.runtime.sendMessage({
      type: 'ASR_RESULT',
      text: data.text,
      seq: msg.seq,
      duration: data.duration_seconds,
      provider: data.provider,
      model: data.model,
    }).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'ASR_ERROR',
      code: 'asr_transport_error',
      message: String(e.message || e),
    }).catch(() => {});
  }
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
        // Broadcast translation errors to UI so the popup can display them
        if (!result.ok) {
          chrome.runtime.sendMessage({ type: 'TRANSLATION_ERROR', error: result.error }).catch(() => {});
        }
        sendResponse(result);

      } else if (msg.type === 'TTS_ONLY') {
        const settings = await getSettings();
        // Prefer the message-passed key (from sync_controller, which reads
        // chrome.storage.local), falling back to the storage read here.
        const apiKey = msg.apiKey || settings.apiKey || '';
        const tts = await synthesizeSpeech(msg.text, msg.language, msg.backend, apiKey);
        // Forward provider metadata so the extension can verify which engine
        // generated each audio segment (no silent provider substitution).
        sendResponse({
          ok: true,
          audio: tts.audio_base64,
          duration: tts.duration_seconds,
          provider: tts.provider || (tts.mode === 'sarvam' ? 'sarvam' : 'piper'),
          request_id: tts.request_id || null,
          language_code: tts.language_code || null,
        });

      } else if (msg.type === 'ASR_ENABLE') {
        // Requires a user-gesture invocation (popup click) — activeTab gets
        // granted, and the tab shows the capture indicator.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
          sendResponse(asrError('asr_no_tab', 'no active tab'));
        } else {
          sendResponse(await startASR(tab.id));
        }

      } else if (msg.type === 'ASR_DISABLE') {
        sendResponse(await stopASR());

      } else if (msg.type === 'ASR_CHUNK') {
        // Fire-and-forget: offscreen capture continues while transcription runs.
        handleASRChunk(msg).catch(() => {});
        sendResponse({ ok: true, accepted: true });

      } else {
        sendResponse({ ok: false, error: `unknown message type ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

console.log('[AakashVani] service worker ready (offscreen translation + Piper TTS)');
