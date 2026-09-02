// AakashVani sync controller — pipelined audio queue with playback drift compensation.
// Translation + TTS for segment N+1 overlap while segment N is playing.
// If audio lags behind the video (>400 ms), playbackRate is raised to 1.05–1.25×
// (uniform time-stretch, browser keeps pitch-correction) so the dub catches up.

class SyncController {
  constructor() {
    this.settings = { ducking: 10, mode: 'auto' };
    this.queue = [];
    this.inflight = [];
    this.playback = [];
    this.playing = false;
    this.video = null;
    this.prevVolume = null;
    this.LOOKAHEAD = 3;
    this._lastBanner = 0;
    this._lastErr = null;
    // Drift bookkeeping — set when the current chunk starts
    this._playStartVideoTime = 0;
    this._playStartWallMs = 0;
    this._driftTimer = null;
    this._activeAudio = null;

    chrome.storage.local.get(['ducking', 'mode'], (s) => { this.settings = { ...this.settings, ...s }; });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.ducking) this.settings.ducking = ch.ducking.newValue;
      if (ch.mode) {
        this.settings.mode = ch.mode.newValue;
        if (ch.mode.newValue === 'off') this.flush();
      }
    });
  }

  attach(videoEl) { this.video = videoEl; }

  enqueue(text) {
    if (!text) return;
    if (this.settings.mode === 'off') return;
    const t = text.trim();
    if (!t) return;
    // Queue-level dedup: prevent same sentence enqueued multiple times while
    // still pending/inflight/playing (YouTube re-renders same caption on style changes)
    if (this.queue.includes(t)) return;
    if (this.inflight.some(p => p._aakashText === t)) return;
    if (this.playback.some(p => p._origText === t)) return;
    // Superstring in queue would repeat words — if t is superstring of something
    // already queued, replace the queued entry's text with t's delta? For now,
    // just skip exact, prefix logic lives in content.js pendingText buffer.
    this.queue.push(t);
    this.pumpPipeline();
    this.tryPlayNext();
  }

  pumpPipeline() {
    while (this.inflight.length < this.LOOKAHEAD && this.queue.length > 0) {
      const text = this.queue.shift();
      const originalText = text; // for skip logging
      const p = this.processLine(text)
        .then((audioBase64) => {
          if (audioBase64) {
            const item = this.makeAudio(audioBase64);
            item._origText = originalText;
            this.playback.push(item);
          } else console.log(`[AakashVani] segment skipped (no audio): ${JSON.stringify(originalText).slice(0, 80)}`);
          // Segment N+1 is now ready while N may still be playing — overlaps
          this.tryPlayNext();
        })
        .catch((e) => {
          // Non-blocking: log exact server message, mark segment failed, never stall the pipeline
          const now = Date.now();
          if (!this._lastErr || this._lastErr.msg !== e.message || now - this._lastErr.t > 30000) {
            console.warn(`[AakashVani] segment failed, skipping to N+1 | text=${JSON.stringify(originalText).slice(0, 80)} | error:`, e.message);
            this._lastErr = { msg: e.message, t: now };
          } else {
            console.log(`[AakashVani] segment failed (throttled) → skip: ${JSON.stringify(originalText).slice(0, 60)}`);
          }
          // Swallow — queue keeps flowing to N+1
          return null;
        })
        .finally(() => {
          this.inflight = this.inflight.filter((x) => x !== p);
          this.pumpPipeline();
        });
      p._aakashText = text;
      this.inflight.push(p);
    }
  }

  async processLine(rawText) {
    // Background/offscreen pipeline always returns translated text (Chrome or cloud fallback).
    const settings = this.settings;
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE',
        text: rawText,
        language: settings.language || 'te-IN',
        mode: settings.mode || 'auto',
        apiKey: settings.apiKey || '',
      });
    } catch (e) {
      // chrome.runtime.lastError or port closed — don't freeze queue
      console.warn(`[AakashVani] TRANSLATE transport error for ${JSON.stringify(rawText).slice(0, 60)}:`, e.message);
      return null;
    }
    if (!res) {
      console.warn(`[AakashVani] TRANSLATE no response (reload extension) — skipping: ${JSON.stringify(rawText).slice(0, 60)}`);
      return null;
    }
    if (!res.ok) {
      // Exact server error — log and let caller mark as failed without throwing uncaught
      console.warn(`[AakashVani] TRANSLATE failed | text=${JSON.stringify(rawText).slice(0, 80)} | server: ${res.error}`);
      throw new Error(res.error || 'translation failed');
    }
    const translated = res.translated;
    if (!translated) return null;

    // 2) TTS via service worker (IITM FastSpeech2) — pipelined ahead of playback
    let tts;
    try {
      tts = await chrome.runtime.sendMessage({ type: 'TTS_ONLY', text: translated, language: settings.language || 'te-IN' });
    } catch (e) {
      console.warn(`[AakashVani] TTS transport error for ${JSON.stringify(translated).slice(0, 60)}:`, e.message);
      return null;
    }
    if (!tts) {
      console.warn(`[AakashVani] TTS no response — skipping: ${JSON.stringify(translated).slice(0, 60)}`);
      return null;
    }
    if (!tts.ok) {
      // Exact TTS server error (500→503 mapping) — log and skip cleanly
      console.warn(`[AakashVani] TTS failed (server ${tts.error?.slice(0, 200)}) | text=${JSON.stringify(translated).slice(0, 80)} — skipping to next segment`);
      throw new Error(tts.error);
    }
    return tts.audio;
  }

  showBanner(msg) {
    let b = document.getElementById('__aakashvani_banner');
    if (!b) {
      b = document.createElement('div');
      b.id = '__aakashvani_banner';
      b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:#1e293b;color:#e2e8f0;border:1px solid #f59e0b;padding:12px 16px;border-radius:8px;font:13px/1.4 system-ui;max-width:560px;box-shadow:0 4px 16px rgba(0,0,0,.5);cursor:pointer;';
      b.innerHTML = '<b style="color:#f59e0b">AakashVani:</b> ';
      const span = document.createElement('span');
      b.appendChild(span);
      document.body.appendChild(b);
      b.addEventListener('click', () => b.remove());
    }
    b.querySelector('span').textContent = msg + ' (click to dismiss)';
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => b.remove(), 20000);
  }

  makeAudio(audioBase64) {
    const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true; // keep pitch when we speed up for drift
    return { audio, url };
  }

  tryPlayNext() {
    if (this.playing || this.playback.length === 0) return;
    const v = this.video || document.querySelector('video');
    if (!v || v.paused) return;
    const item = this.playback.shift();
    this.playing = true;
    this._activeAudio = item.audio;
    this._playStartVideoTime = v.currentTime;
    this._playStartWallMs = Date.now();
    // Reset rate for each new chunk
    item.audio.playbackRate = 1.0;
    item.audio.preservesPitch = true;
    this.duck(true);
    this._startDriftMonitor(item.audio);

    const done = () => {
      this._stopDriftMonitor();
      this._activeAudio = null;
      this.duck(false);
      // Guaranteed URL revoke — prevents blob memory leak
      try { URL.revokeObjectURL(item.url); } catch (_) {}
      this.playing = false;
      this.tryPlayNext();
    };
    item.audio.onended = done;
    item.audio.onerror = done;
    item.audio.play().catch(done);
  }

  _startDriftMonitor(audio) {
    this._stopDriftMonitor();
    // Check every 300 ms whether the audio has fallen behind the video
    this._driftTimer = setInterval(() => {
      const v = this.video || document.querySelector('video');
      if (!v || v.paused || !this.playing || !audio) return;
      const wallElapsedMs = Date.now() - this._playStartWallMs;
      // How far the video has actually advanced since we started this chunk
      const videoElapsedMs = (v.currentTime - this._playStartVideoTime) * 1000;
      // Audio progress (seconds → ms) already played for this chunk
      const audioElapsedMs = audio.currentTime * 1000;
      // Positive drift → audio is behind video
      const driftMs = videoElapsedMs - audioElapsedMs;

      let targetRate = 1.0;
      if (driftMs > 900) targetRate = 1.25;
      else if (driftMs > 650) targetRate = 1.15;
      else if (driftMs > 400) targetRate = 1.05;

      if (audio.playbackRate !== targetRate) {
        audio.playbackRate = targetRate;
        if (targetRate > 1.0) console.log(`[AakashVani] drift ${driftMs.toFixed(0)}ms → ${targetRate}x (wall ${wallElapsedMs.toFixed(0)}ms)`);
      }
    }, 300);
  }

  _stopDriftMonitor() {
    if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
  }

  duck(on) {
    const v = this.video || document.querySelector('video');
    if (!v) return;
    if (on) {
      if (this.prevVolume === null) this.prevVolume = v.volume;
      v.volume = Math.max(0, Math.min(1, (this.settings.ducking ?? 10) / 100));
    } else if (this.prevVolume !== null) {
      v.volume = this.prevVolume;
      this.prevVolume = null;
    }
  }

  flush() {
    this._stopDriftMonitor();
    this._activeAudio = null;
    // Stop any currently playing chunk and revoke its blob
    if (this.playing && this.playback.length >= 0) {
      // playing item URL is held by _activeAudio — already handled by done()
    }
    this.queue = [];
    this.playback.forEach((i) => {
      try { i.audio.pause(); i.audio.src = ''; URL.revokeObjectURL(i.url); } catch (_) {}
    });
    this.playback = [];
    this.playing = false;
    this.duck(false);
  }
}

window.__aakashvani = new SyncController();
