// AakashVani sync controller — timeline-based audio synchronization.
// Translation + TTS for segment N+1 overlap while segment N is playing.
// Timeline scheduler synchronizes audio segments to YouTube video timeline.

class TimelineScheduler {
  constructor() {
    this.segments = []; // { caption, audio, targetStart, targetEnd, state: 'pending'|'ready'|'playing'|'completed'|'discarded' }
    this.currentIndex = 0;
    this.video = null;
    this._monitorTimer = null;
  }

  setVideo(video) { this.video = video; }

  // Add a new segment with target timing from caption
  addSegment(caption, audioBase64) {
    const targetStart = caption.startTime || 0;
    const targetEnd = caption.endTime || (caption.startTime + caption.duration) || 0;
    const audio = this._createAudio(audioBase64);
    this.segments.push({
      caption,
      audio,
      targetStart,
      targetEnd,
      state: 'ready',
      scheduledAt: null,
    });
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

  // Main scheduler tick - called periodically to advance timeline
  tick() {
    if (!this.video || this.video.paused) return;
    const now = this.video.currentTime;

    // Advance currentIndex past completed segments
    while (this.currentIndex < this.segments.length) {
      const seg = this.segments[this.currentIndex];
      if (seg.state === 'completed') {
        this.currentIndex++;
        continue;
      }
      // If segment is ready and we've reached its start time, play it
      if (seg.state === 'ready' && now >= seg.targetStart - 0.1) { // small lead-in
        this._playSegment(this.currentIndex);
      }
      break;
    }

    // Discard stale segments that are far behind
    while (this.currentIndex < this.segments.length) {
      const seg = this.segments[this.currentIndex];
      if (seg.state === 'ready' && now > seg.targetEnd + 2.0) { // 2s grace period after end
        console.log(`[AakashVani] discarding stale segment: ${seg.caption.text.slice(0,40)}`);
        seg.state = 'discarded';
        this._cleanupSegment(seg);
        this.currentIndex++;
      } else if (seg.state === 'playing' && now > seg.targetEnd + 1.0) {
        // Segment playing but past its end - let it finish naturally or force stop
        if (seg.audio.currentTime >= seg.audio.duration - 0.1) {
          seg.state = 'completed';
          this._cleanupSegment(seg);
          this.currentIndex++;
        }
      } else {
        break;
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
      seg.state = 'completed';
      try { URL.revokeObjectURL(seg.audio._blobUrl); } catch(_) {}
      this.tick(); // check for next segment
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
    } catch(_) {}
  }

  // Check if we should adjust playback rate for drift
  checkDrift() {
    if (!this.video || this.currentIndex >= this.segments.length) return;
    const seg = this.segments[this.currentIndex];
    if (seg.state !== 'playing' || !this.video || this.video.paused) return;
    
    const now = this.video.currentTime;
    const audioProgress = seg.audio.currentTime;
    const expectedProgress = now - seg.targetStart;
    const drift = expectedProgress - audioProgress; // positive = audio behind
    
    let targetRate = 1.0;
    if (drift > 0.9) targetRate = 1.25;
    else if (drift > 0.65) targetRate = 1.15;
    else if (drift > 0.4) targetRate = 1.05;
    else if (drift < -0.5) targetRate = 0.95; // audio ahead - slow down slightly
    
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

// AakashVani sync controller — timeline-based audio synchronization.
// Translation + TTS for segment N+1 overlap while segment N is playing.
// Timeline scheduler synchronizes audio segments to YouTube video timeline.

class SyncController {
  constructor() {
    this.settings = { ducking: 10, mode: 'auto' };
    this.queue = [];
    this.inflight = [];
    this.playback = []; // legacy, kept for compatibility
    this.playing = false;
    this.video = null;
    this.prevVolume = null;
    this.LOOKAHEAD = 3;
    this._lastBanner = 0;
    this._lastErr = null;
    this._generation = 0; // increments on seek/flush — stale inflight results are discarded
    
    // New timeline-based scheduler
    this.scheduler = new TimelineScheduler();

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
    // Handle both old string format and new caption object
    const text = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
    if (!text) return;
    
    // Bounded queue: if video paused, queue could grow unbounded → cap at 8
    const MAX_QUEUE = 8;
    if (this.queue.length >= MAX_QUEUE) {
      console.warn(`[AakashVani] queue full (8) — dropping oldest:`, this.queue[0]?.text?.slice(0,40) || this.queue[0]?.slice(0,40));
      this.queue.shift();
    }
    // Queue-level dedup: prevent same sentence enqueued multiple times while
    // still pending/inflight/playing (YouTube re-renders same caption on style changes)
    const isDuplicate = this.queue.some(q => (typeof q === 'string' ? q : q.text) === text) ||
                       this.inflight.some(p => p._aakashText === text) ||
                       this.scheduler.segments.some(s => s.state === 'ready' && s.caption.text === text);
    if (isDuplicate) return;
    
    // Store the full caption object in queue for timing info
    this.queue.push(caption);
    this.pumpPipeline();
    this.scheduler.tick();
  }

  pumpPipeline() {
    while (this.inflight.length < this.LOOKAHEAD && this.queue.length > 0) {
      const caption = this.queue.shift();
      const text = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
      const originalText = text; // for skip logging
      const gen = this._generation;
      const p = this.processLine(caption, gen)
        .then((audioBase64) => {
          if (gen !== this._generation) {
            console.log(`[AakashVani] stale segment discarded (seek/navigation): ${JSON.stringify(originalText).slice(0, 60)}`);
            if (audioBase64) { try { const tmp = this.makeAudio(audioBase64); URL.revokeObjectURL(tmp.url); } catch(_){} }
            return;
          }
          if (audioBase64) {
            this.scheduler.addSegment(caption, audioBase64);
            this.scheduler.tick();
          } else console.log(`[AakashVani] segment skipped (no audio): ${JSON.stringify(originalText).slice(0, 80)}`);
        })
        .catch((e) => {
          if (gen !== this._generation) return null; // stale — already flushed, no log
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

  async processLine(caption, genAtStart) {
    // Stale check: if generation changed while we were queued, abort early
    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
    // Background/offscreen pipeline always returns translated text (Chrome or cloud fallback).
    const settings = this.settings;
    // Extract text from caption object or string
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
      // chrome.runtime.lastError or port closed — don't freeze queue
      console.warn(`[AakashVani] TRANSLATE transport error for ${JSON.stringify(rawText).slice(0, 60)}:`, e.message);
      return null;
    }
    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
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
    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
    let tts;
    try {
      tts = await chrome.runtime.sendMessage({ type: 'TTS_ONLY', text: translated, language: settings.language || 'te-IN' });
    } catch (e) {
      if (genAtStart !== undefined && genAtStart !== this._generation) return null;
      console.warn(`[AakashVani] TTS transport error for ${JSON.stringify(translated).slice(0, 60)}:`, e.message);
      return null;
    }
    if (!tts) {
      console.warn(`[AakashVani] TTS no response — skipping: ${JSON.stringify(translated).slice(0, 60)}`);
      return null;
    }
    if (!tts.ok) {
      // Exact TTS server error (500→503 mapping) — log and skip cleanly
      const errMsg = tts.error || '';
      if (errMsg.startsWith('checkpoint_preparing:')) {
        const missingLang = errMsg.split(':')[1];
        console.warn(`[AakashVani] TTS checkpoint preparing for ${missingLang} — skipping segment`);
        this.showBanner(`Voice for ${missingLang} is preparing — skipping this segment`);
        return null; // Skip this segment, don't retry
      }
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
    audio._blobUrl = url;
    return { audio, url };
  }

  // Legacy method - now delegates to scheduler
  tryPlayNext() {
    this.scheduler.tick();
    this.scheduler.checkDrift();
  }

  _startDriftMonitor(audio) {
    this.scheduler._monitorTimer = setInterval(() => {
      this.scheduler.checkDrift();
    }, 300);
  }

  _stopDriftMonitor() {
    if (this.scheduler._monitorTimer) { clearInterval(this.scheduler._monitorTimer); this.scheduler._monitorTimer = null; }
  }

  pauseDubbed() {
    if (this.scheduler.segments[this.scheduler.currentIndex]?.audio && !this.scheduler.segments[this.scheduler.currentIndex]?.audio.paused) {
      try { this.scheduler.segments[this.scheduler.currentIndex].audio.pause(); } catch(_) {}
      this.scheduler._stopDriftMonitor();
      console.log('[AakashVani] dub paused (video paused)');
    }
  }

  resumeDubbed() {
    const seg = this.scheduler.segments[this.scheduler.currentIndex];
    if (!seg || seg.audio.paused && !seg.video.paused) {
      seg.audio.play().catch(()=>{});
      // Recalculate timing
      this.scheduler._playStartWallMs = Date.now() - (seg.audio.currentTime * 1000);
      this.scheduler._playStartVideoTime = this.video.currentTime - seg.audio.currentTime;
      this._startDriftMonitor(seg.audio);
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
    // Stop active dubbed audio immediately — never let stale audio survive seek/navigation/pause
    if (this.scheduler._activeAudio) {
      try { this.scheduler._activeAudio.pause(); this.scheduler._activeAudio.src = ''; } catch(_) {}
      try { if (this.scheduler._activeItem && this.scheduler._activeItem.url) URL.revokeObjectURL(this.scheduler._activeItem.url); else if (this.scheduler._activeAudio._blobUrl) URL.revokeObjectURL(this.scheduler._activeAudio._blobUrl); } catch(_) {}
    }
    this.scheduler._activeAudio = null;
    this.scheduler._activeItem = null;
    this.queue = [];
    // Cancel any buffered audio
    this.scheduler.segments.forEach((i) => {
      try { i.audio.pause(); i.audio.src = ''; URL.revokeObjectURL(i.url); } catch (_) {}
    });
    this.scheduler.segments = [];
    this.scheduler.currentIndex = 0;
    this.playing = false;
    this.duck(false);
  }
}

window.__aakashvani = new SyncController();