// AakashVani sync controller — timeline-based audio synchronization.
// Translation + TTS for segment N+1 overlap while segment N is playing.
// Timeline scheduler synchronizes audio segments to YouTube video timeline.

class TimelineScheduler {
  constructor() {
    this.segments = [];
    this.currentIndex = 0;
    this.video = null;
    this._monitorTimer = null;
  }

  setVideo(video) { this.video = video; }

  // ---- P0-1: Insert sorted by targetStart — completion order never affects playback order ----
  addSegment(caption, audioBase64) {
    const seg = this._makeSegment(caption, audioBase64);
    let insertIdx = this.segments.length;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].targetStart > seg.targetStart) {
        insertIdx = i;
        break;
      }
    }
    this.segments.splice(insertIdx, 0, seg);
    // If we inserted before currentIndex, bump it so we don't skip
    if (insertIdx <= this.currentIndex) this.currentIndex = insertIdx;
  }

  _makeSegment(caption, audioBase64) {
    const audio = this._createAudio(audioBase64);
    // ---- P0-4: Untimed captions use video.currentTime as start ----
    let targetStart, targetEnd;
    if (caption.untimed || caption.startTime == null) {
      targetStart = this.video ? this.video.currentTime : 0;
      targetEnd = targetStart + (caption.duration || 3);
    } else {
      targetStart = caption.startTime;
      targetEnd = caption.endTime || (caption.startTime + (caption.duration || 3));
    }
    return {
      caption,
      audio,
      targetStart,
      targetEnd,
      state: 'ready',
      scheduledAt: null,
    };
  }

  _createAudio(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true;
    audio._blobUrl = url;
    return audio;
  }

  // ---- P1-5: Invalidate segments whose captionId matches (correction arrived) ----
  invalidateSegmentsByCaptionId(captionId) {
    for (const seg of this.segments) {
      if (seg.caption.id === captionId && (seg.state === 'ready' || seg.state === 'pending')) {
        seg.state = 'discarded';
        this._cleanupSegment(seg);
        console.log(`[AakashVani] invalidated stale segment: ${seg.caption.id} "${seg.caption.text.slice(0,40)}"`);
      }
    }
  }

  tick() {
    if (!this.video || this.video.paused) return;
    const now = this.video.currentTime;

    while (this.currentIndex < this.segments.length) {
      const seg = this.segments[this.currentIndex];
      if (seg.state === 'completed' || seg.state === 'discarded') {
        this.currentIndex++;
        continue;
      }
      if (seg.state === 'ready' && now >= seg.targetStart - 0.1) {
        this._playSegment(this.currentIndex);
      }
      break;
    }

    // Discard stale segments far behind
    let advanced = true;
    while (advanced) {
      advanced = false;
      if (this.currentIndex >= this.segments.length) break;
      const seg = this.segments[this.currentIndex];
      if (seg.state === 'ready' && now > seg.targetEnd + 2.0) {
        console.log(`[AakashVani] discarding stale segment: ${seg.caption.text.slice(0,40)}`);
        seg.state = 'discarded';
        this._cleanupSegment(seg);
        this.currentIndex++;
        advanced = true;
      } else if (seg.state === 'playing' && now > seg.targetEnd + 1.0) {
        if (seg.audio.currentTime >= seg.audio.duration - 0.1) {
          seg.state = 'completed';
          this._cleanupSegment(seg);
          this.currentIndex++;
          advanced = true;
        }
      }
    }
  }

  _playSegment(index) {
    const seg = this.segments[index];
    if (seg.state !== 'ready') return;
    seg.state = 'playing';
    seg.scheduledAt = Date.now();
    seg.audio.playbackRate = 1.0;
    seg.audio.preservesPitch = true;
    const done = () => {
      if (seg.state !== 'playing') return;
      seg.state = 'completed';
      try { URL.revokeObjectURL(seg.audio._blobUrl); } catch (_) {}
      this.tick();
    };
    seg.audio.onended = done;
    seg.audio.onerror = done;
    seg.audio.play().catch(done);
    console.log(`[AakashVani] playing segment @ ${seg.targetStart.toFixed(2)}s: ${seg.caption.text.slice(0,40)}`);
  }

  _cleanupSegment(seg) {
    try {
      seg.audio.pause();
      seg.audio.src = '';
      URL.revokeObjectURL(seg.audio._blobUrl);
    } catch (_) {}
  }

  checkDrift() {
    if (!this.video || this.currentIndex >= this.segments.length) return;
    const seg = this.segments[this.currentIndex];
    if (seg.state !== 'playing' || this.video.paused) return;
    const now = this.video.currentTime;
    const audioProgress = seg.audio.currentTime;
    const expectedProgress = now - seg.targetStart;
    const drift = expectedProgress - audioProgress;
    let targetRate = 1.0;
    if (drift > 0.9) targetRate = 1.25;
    else if (drift > 0.65) targetRate = 1.15;
    else if (drift > 0.4) targetRate = 1.05;
    else if (drift < -0.5) targetRate = 0.95;
    if (Math.abs(seg.audio.playbackRate - targetRate) > 0.02) {
      seg.audio.playbackRate = targetRate;
      if (targetRate !== 1.0) console.log(`[AakashVani] drift ${drift.toFixed(2)}s → ${targetRate}x`);
    }
  }

  clear() {
    if (this._monitorTimer) { clearInterval(this._monitorTimer); this._monitorTimer = null; }
    this.segments.forEach(s => this._cleanupSegment(s));
    this.segments = [];
    this.currentIndex = 0;
  }
}

class SyncController {
  constructor() {
    this.settings = { ducking: 10, mode: 'auto' };
    this.queue = [];
    this.inflight = [];
    this.playing = false;
    this.video = null;
    this.prevVolume = null;
    this.LOOKAHEAD = 3;
    this._lastBanner = 0;
    this._lastErr = null;
    this._generation = 0;
    this.scheduler = new TimelineScheduler();
    this._checkpointBuffer = [];
    this._checkpointBufferMax = 10;

    chrome.storage.local.get(['ducking', 'mode'], (s) => { this.settings = { ...this.settings, ...s }; });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.ducking) this.settings.ducking = ch.ducking.newValue;
      if (ch.mode) {
        this.settings.mode = ch.mode.newValue;
        if (ch.mode.newValue === 'off') this.flush();
      }
    });
  }

  attach(videoEl) {
    this.video = videoEl;
    this.scheduler.setVideo(videoEl);
  }

  enqueue(caption) {
    if (!caption) return;
    if (this.settings.mode === 'off') return;
    const text = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
    if (!text) return;
    const MAX_QUEUE = 8;
    if (this.queue.length >= MAX_QUEUE) {
      console.warn(`[AakashVani] queue full (8) — dropping oldest`);
      this.queue.shift();
    }
    // Dedup by caption ID (stable) not by text
    const cid = caption.id || '';
    const isDuplicate = this.queue.some(q => (q.id || '') === cid) ||
      this.inflight.some(p => p._aakashCid === cid) ||
      this.scheduler.segments.some(s => (s.caption.id || '') === cid && (s.state === 'ready' || s.state === 'playing' || s.state === 'pending'));
    if (isDuplicate) return;
    this.queue.push(caption);
    this.pumpPipeline();
    this.scheduler.tick();
  }

  pumpPipeline() {
    while (this.inflight.length < this.LOOKAHEAD && this.queue.length > 0) {
      const caption = this.queue.shift();
      const text = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
      const gen = this._generation;
      const p = this.processLine(caption, gen)
        .then((audioBase64) => {
          if (gen !== this._generation) {
            if (audioBase64) { try { const tmp = this.makeAudio(audioBase64); URL.revokeObjectURL(tmp.url); } catch (_) {} }
            return;
          }
          if (audioBase64) {
            this.scheduler.addSegment(caption, audioBase64);
            this.scheduler.tick();
          }
        })
        .catch((e) => {
          if (gen !== this._generation) return null;
          const now = Date.now();
          if (!this._lastErr || this._lastErr.msg !== e.message || now - this._lastErr.t > 30000) {
            console.warn(`[AakashVani] segment failed | text=${JSON.stringify(text).slice(0, 80)} | error:`, e.message);
            this._lastErr = { msg: e.message, t: now };
          }
          return null;
        })
        .finally(() => {
          this.inflight = this.inflight.filter((x) => x !== p);
          this.pumpPipeline();
        });
      p._aakashCid = caption.id || '';
      this.inflight.push(p);
    }
  }

  async processLine(caption, genAtStart) {
    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
    const settings = this.settings;
    const rawText = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
    if (!rawText) return null;

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
      if (genAtStart !== undefined && genAtStart !== this._generation) return null;
      console.warn(`[AakashVani] TRANSLATE transport error:`, e.message);
      return null;
    }
    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
    if (!res) return null;
    if (!res.ok) {
      console.warn(`[AakashVani] TRANSLATE failed | text=${JSON.stringify(rawText).slice(0, 80)} | server: ${res.error}`);
      throw new Error(res.error || 'translation failed');
    }
    const translated = res.translated;
    if (!translated) return null;

    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
    let tts;
    try {
      tts = await chrome.runtime.sendMessage({ type: 'TTS_ONLY', text: translated, language: settings.language || 'te-IN' });
    } catch (e) {
      if (genAtStart !== undefined && genAtStart !== this._generation) return null;
      console.warn(`[AakashVani] TTS transport error:`, e.message);
      return null;
    }
    if (!tts) return null;
    if (!tts.ok) {
      const errMsg = tts.error || '';
      if (errMsg.startsWith('checkpoint_preparing:')) {
        const missingLang = errMsg.split(':')[1];
        console.warn(`[AakashVani] TTS checkpoint preparing for ${missingLang} — buffering segment`);
        if (this._checkpointBuffer.length < this._checkpointBufferMax) {
          this._checkpointBuffer.push({ caption, genAtStart, translated });
        }
        return null;
      }
      console.warn(`[AakashVani] TTS failed (${tts.error?.slice(0, 120)}) | text=${JSON.stringify(translated).slice(0, 80)}`);
      throw new Error(tts.error);
    }
    return tts.audio;
  }

  // ---- P1-7: Retry buffered captions when checkpoint becomes ready ----
  async retryCheckpointBuffer() {
    if (!this._checkpointBuffer.length) return;
    const buffer = this._checkpointBuffer.splice(0, this._checkpointBufferMax);
    for (const item of buffer) {
      if (item.genAtStart !== this._generation) continue;
      try {
        const tts = await chrome.runtime.sendMessage({ type: 'TTS_ONLY', text: item.translated, language: this.settings.language || 'te-IN' });
        if (tts && tts.ok && item.genAtStart === this._generation) {
          this.scheduler.addSegment(item.caption, tts.audio);
          this.scheduler.tick();
        }
      } catch (e) {
        console.warn(`[AakashVani] checkpoint buffer retry failed:`, e.message);
      }
    }
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
    audio.preservesPitch = true;
    audio._blobUrl = url;
    return { audio, url };
  }

  // ---- P1-5: Invalidate stale TTS for a caption ID (correction arrived) ----
  invalidateCaption(captionId) {
    this._generation++;
    this.scheduler.invalidateSegmentsByCaptionId(captionId);
    this.queue = this.queue.filter(q => (q.id || '') !== captionId);
    this._checkpointBuffer = this._checkpointBuffer.filter(b => (b.caption.id || '') !== captionId);
  }

  tryPlayNext() {
    this.scheduler.tick();
    this.scheduler.checkDrift();
  }

  _startDriftMonitor() {
    this._stopDriftMonitor();
    this.scheduler._monitorTimer = setInterval(() => {
      this.scheduler.checkDrift();
    }, 300);
  }

  _stopDriftMonitor() {
    if (this.scheduler._monitorTimer) { clearInterval(this.scheduler._monitorTimer); this.scheduler._monitorTimer = null; }
  }

  pauseDubbed() {
    const seg = this.scheduler.segments[this.scheduler.currentIndex];
    if (seg && seg.state === 'playing' && !seg.audio.paused) {
      try { seg.audio.pause(); } catch (_) {}
      this._stopDriftMonitor();
      console.log('[AakashVani] dub paused (video paused)');
    }
  }

  resumeDubbed() {
    const seg = this.scheduler.segments[this.scheduler.currentIndex];
    if (seg && seg.state === 'playing' && seg.audio.paused) {
      seg.audio.play().catch(() => {});
      this._startDriftMonitor();
      console.log('[AakashVani] dub resumed');
    } else {
      this.scheduler.tick();
    }
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
    this._generation++;
    this._stopDriftMonitor();
    this.scheduler.clear();
    this.queue = [];
    this._checkpointBuffer = [];
    this.playing = false;
    this.duck(false);
  }
}

window.__aakashvani = new SyncController();
