// AakashVani popup logic
const ENGINE = 'http://127.0.0.1:8000';

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
};

const DEFAULTS = {
  mode: 'auto',
  language: 'te-IN',
  apiKey: '',
  cloudFallback: false,
  ducking: 10,
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

async function checkServer() {
  setStatus('loading', 'Checking server...');
  try {
    const res = await fetch(`${ENGINE}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      setStatus('ok', 'Engine running');
      return true;
    }
  } catch (_) { /* fallthrough */ }
  // Fallback: try root
  try {
    const res = await fetch(`${ENGINE}/`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) { setStatus('ok', 'Engine running'); return true; }
  } catch (_) {}
  setStatus('err', 'Engine not reachable');
  showWarning('Start the backend: run backend/dist/AakashVaniEngine, then reopen this popup.');
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
      setVideoStatus('found', info.paused ? 'Video found (paused)' : 'Video found \u2014 dubbing ready');
    } else {
      setVideoStatus('warning', 'No video on this tab (open a YouTube video)');
    }
  } catch (e) {
    setVideoStatus('warning', 'Cannot inspect this tab (browser pages are restricted)');
  }
}

async function loadSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...saved };
  els.mode.value = settings.mode;
  els.language.value = settings.language;
  els.apiKey.value = settings.apiKey;
  els.cloudFallback.checked = settings.cloudFallback;
  els.ducking.value = settings.ducking;
  els.volVal.textContent = `${settings.ducking}%`;
}

function saveSetting(key, value) {
  chrome.storage.local.set({ [key]: value });
}

function bindEvents() {
  els.mode.addEventListener('change', () => saveSetting('mode', els.mode.value));
  els.language.addEventListener('change', () => saveSetting('language', els.language.value));
  els.apiKey.addEventListener('input', () => saveSetting('apiKey', els.apiKey.value));
  els.cloudFallback.addEventListener('change', () => saveSetting('cloudFallback', els.cloudFallback.checked));
  els.ducking.addEventListener('input', () => {
    els.volVal.textContent = `${els.ducking.value}%`;
    saveSetting('ducking', Number(els.ducking.value));
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
  checkServer().then(ok => { if (ok) checkVideo(); });
});
