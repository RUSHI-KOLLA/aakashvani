// AakashVani popup logic
const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  warning: $('warning'),
  warningText: $('warning-text'),
  videoStatus: $('video-status'),
  mode: $('mode'),
  language: $('language'),
  apiKey: $('api-key'),
  cloudFallback: $('cloud-fallback'),
  ducking: $('ducking'),
  volVal: $('vol-val'),
  engineUrl: $('engine-url'),
};

const DEFAULTS = {
  mode: 'auto',
  language: 'te-IN',
  apiKey: '',
  cloudFallback: false,
  ducking: 10,
  engineUrl: 'http://127.0.0.1:8000',
};

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.statusDot.className = `dot ${kind === 'ok' ? 'green' : kind === 'err' ? 'red' : 'yellow'}`;
  els.statusText.textContent = text;
}

function setVideoStatus(kind, text) {
  els.videoStatus.className = `video-badge ${kind}`;
  els.videoStatus.textContent = text;
}

function showWarning(text) {
  if (!text) { els.warning.style.display = 'none'; return; }
  els.warningText.textContent = text;
  els.warning.style.display = 'flex';
}

async function checkServer() {
  setStatus('loading', 'Checking server...');
  showWarning('');
  const engine = els.engineUrl.value || DEFAULTS.engineUrl;
  try {
    const res = await fetch(`${engine}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      setStatus('ok', 'Engine running');
      return true;
    }
  } catch (_) { /* fallthrough */ }
  try {
    const res = await fetch(`${engine}/`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) { setStatus('ok', 'Engine running'); return true; }
  } catch (_) {}
  setStatus('err', 'Engine not reachable');
  showWarning('Start the backend: cd backend && ./venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000');
  return false;
}

async function checkVideo() {
  els.videoStatus.textContent = 'Checking video...';
  els.videoStatus.className = 'video-badge missing';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
      setVideoStatus('missing', 'No video page');
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const v = document.querySelector('video');
        return v ? { found: true, paused: v.paused, src: !!v.src || !!v.currentSrc } : { found: false };
      },
    });
    const info = results && results[0] && results[0].result;
    if (info && info.found) {
      setVideoStatus('found', info.paused ? 'Video found (paused)' : 'Video found — dubbing ready');
    } else {
      setVideoStatus('warning', 'No video on this tab (open a YouTube video)');
    }
  } catch (e) {
    setVideoStatus('warning', 'Cannot inspect this tab (browser pages are restricted)');
  }
}

async function loadSettings() {
  const saved = await chrome.storage.local.get([...Object.keys(DEFAULTS), 'authError']);
  const settings = { ...DEFAULTS, ...saved };
  els.mode.value = settings.mode;
  els.language.value = settings.language;
  els.apiKey.value = settings.apiKey;
  els.cloudFallback.checked = settings.cloudFallback;
  els.ducking.value = settings.ducking;
  els.volVal.textContent = `${settings.ducking}%`;
  els.engineUrl.value = settings.engineUrl;
  if (saved.authError) showWarning(saved.authError);
}

function saveSetting(key, value) {
  chrome.storage.local.set({ [key]: value });
  // clear circuit-breaker on key/mode change
  if (key === 'apiKey' || key === 'mode') chrome.storage.local.remove('authError');
}

function bindEvents() {
  els.mode.addEventListener('change', () => saveSetting('mode', els.mode.value));
  els.language.addEventListener('change', () => saveSetting('language', els.language.value));
  els.apiKey.addEventListener('change', () => saveSetting('apiKey', els.apiKey.value));
  els.cloudFallback.addEventListener('change', () => saveSetting('cloudFallback', els.cloudFallback.checked));
  els.ducking.addEventListener('input', () => {
    els.volVal.textContent = `${els.ducking.value}%`;
    saveSetting('ducking', Number(els.ducking.value));
  });
  function isValidEngineUrl(v) {
    try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
  }
  els.engineUrl.addEventListener('change', () => {
    const v = els.engineUrl.value.trim();
    if (v && !isValidEngineUrl(v)) {
      showWarning('Engine URL must be http(s)://host:port — e.g. http://127.0.0.1:8000');
      return;
    }
    saveSetting('engineUrl', v || DEFAULTS.engineUrl);
    checkServer();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CHECKPOINT_PROGRESS') {
      if (msg.status === 'downloading') {
        setVideoStatus('warning', `Downloading ${msg.lang} voice... ${msg.progress ?? 0}%`);
      } else if (msg.status === 'ready') {
        setVideoStatus('found', `${msg.lang} voice ready — dubbing enabled`);
      } else if (msg.status === 'error') {
        setVideoStatus('missing', `Voice download failed: ${msg.error}`);
      }
    }
    if (msg.type === 'AUTH_ERROR') {
      showWarning(msg.error);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
  checkServer().then(ok => { if (ok) checkVideo(); });
});
