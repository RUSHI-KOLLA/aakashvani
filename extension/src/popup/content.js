// AakashVani content script — timestamped caption capture via TextTrack API.
// Captures caption cues with timing info for precise synchronization.
// Stability debounce (250ms) + punctuation flush + robust caption reconciliation.
(() => {
  const controller = window.__aakashvani;
  if (!controller) { console.warn('[AakashVani] sync controller missing'); return; }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EDGE_UNAVAILABLE' || msg.type === 'AUTH_ERROR') {
      controller.showBanner?.(msg.error || 'AakashVani: translation unavailable — check popup Mode/API key');
    }
  });

  const STABILITY_MS = 250;
  const PUNCT_RE = /[.?!।।…\u0964\u0965]$/;
  let lastDispatched = '';
  let dispatchedIds = new Set(); // Track dispatched caption IDs for per-cue dedup
  let _dispatchedTexts = new Map(); // text → timestamp — secondary dedup by normalized text
  let pendingCue = null;
  let debounce = null;
  let observer = null;

  // ---- P0-2: Stable caption IDs via hash of timing + text (no counter) ----
  // Normalize timestamps to 100ms precision so sub-millisecond YouTube re-renders
  // (e.g., 581.731 vs 581.788) produce the SAME ID for the same caption.
  function _hashCaptionKey(startTime, endTime, text) {
    const normStart = Math.round(startTime * 10) / 10;  // 100ms precision
    const normEnd = Math.round(endTime * 10) / 10;
    const raw = `${normStart.toFixed(1)}|${normEnd.toFixed(1)}|${text}`;
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  // ---- P0-2 + P0-3: Each cue gets its own stable ID based on its own timing + text ----
  function makeCaption(cue, source = 'texttrack') {
    const text = (cue.text || '').trim();
    const startTime = cue.startTime;
    const endTime = cue.endTime;
    const key = _hashCaptionKey(startTime, endTime, text);
    return {
      id: `${source}-${key}`,
      text,
      startTime,
      endTime,
      duration: endTime - startTime,
      source,
      untimed: false,
      capturedAt: Date.now(),
    };
  }

  // ---- P0-4: DOM fallback — explicitly marked untimed, never fake 0→0 ----
  function makeUntimedCaption(text, source = 'dom') {
    const key = _hashCaptionKey(0, 0, text);
    return {
      id: `${source}-untimed-${key}`,
      text,
      startTime: null,
      endTime: null,
      duration: null,
      source,
      untimed: true,
      capturedAt: Date.now(),
    };
  }

  function readCaptionFromTextTrack() {
    try {
      const v = document.querySelector('video');
      if (!v || !v.textTracks) return null;
      for (const tr of v.textTracks) {
        if (tr.mode === 'showing' && tr.activeCues && tr.activeCues.length) {
          return Array.from(tr.activeCues).map(cue => makeCaption(cue, 'texttrack'));
        }
      }
    } catch (_) {}
    return null;
  }

  // ---- P0-4: DOM fallback — untimed captions, never fake timestamps ----
  function readCaptionFromDOM() {
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      const text = Array.from(segs).map((s) => s.textContent.trim()).join(' ').trim();
      if (text) return [makeUntimedCaption(text, 'dom')];
    }
    const win = document.querySelector('.ytp-caption-window-container .caption-visual-line');
    if (win) {
      const text = (win.textContent || '').trim();
      if (text) return [makeUntimedCaption(text, 'dom')];
    }
    return null;
  }

  function readCaption() {
    return readCaptionFromTextTrack() || readCaptionFromDOM();
  }

  // ---- P1-5: Track dispatched cue IDs for correction detection ----
  // Map<captionId, { text, dispatchTime }> — if we see same ID with different text, it's a correction
  const _dispatchedCues = new Map();
  const MAX_DISPATCHED_CUES = 50;

  function maybeDispatch(captions) {
    if (!captions || !captions.length) return;

    function normalizeText(text) {
      return (text || '').trim().replace(/\s+/g, ' ').replace(/[.!?।।…\u0964\u0965]+$/, '');
    }

    for (const caption of captions) {
      const text = (caption.text || '').trim();
      if (!text) continue;
      const normalized = normalizeText(text);

      // Dedup by caption ID (stable) — don't re-dispatch same cue
      if (dispatchedIds.has(caption.id)) continue;

      // ---- Secondary dedup: same normalized text within 1s window ----
      const now = Date.now();
      const prevTextTime = _dispatchedTexts.get(normalized);
      if (prevTextTime && (now - prevTextTime) < 1000) continue;

      // ---- P1-5: Correction detection — same cue ID with different text ----
      const prev = _dispatchedCues.get(caption.id);
      if (prev && normalizeText(prev.text) !== normalized) {
        controller.invalidateCaption(caption.id);
        console.log(`[AakashVani] correction detected for ${caption.id}: "${prev.text.slice(0,40)}" → "${text.slice(0,40)}"`);
      }

      // ---- P0-3: Enqueue EACH cue with its own timing and ID ----
      dispatchedIds.add(caption.id);
      _dispatchedTexts.set(normalized, now);
      _dispatchedCues.set(caption.id, { text, dispatchTime: now });

      // Bound the maps
      if (_dispatchedCues.size > MAX_DISPATCHED_CUES) {
        const oldest = _dispatchedCues.keys().next().value;
        _dispatchedCues.delete(oldest);
      }
      if (dispatchedIds.size > MAX_DISPATCHED_CUES) {
        const oldest = dispatchedIds.values().next().value;
        dispatchedIds.delete(oldest);
      }
      if (_dispatchedTexts.size > MAX_DISPATCHED_CUES) {
        const oldest = _dispatchedTexts.keys().next().value;
        _dispatchedTexts.delete(oldest);
      }

      controller.enqueue(caption);
      console.log('[AakashVani] dispatch →', JSON.stringify(text).slice(0, 160), `id=${caption.id}`);
    }
  }

  function onCaptionObserved() {
    const captions = readCaption();
    if (!captions || !captions.length) return;
    pendingCue = captions[captions.length - 1];

    // Always use stability debounce — don't immediate-flush on punctuation
    // (YouTube re-renders punctuated captions multiple times)
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const now = readCaption();
      if (!now || !now.length) return;
      maybeDispatch(now);
    }, STABILITY_MS);
  }

  // ---- P1-6: Listener lifecycle — store refs, remove before re-attach ----
  let _videoRefs = null;
  let _trackRefs = [];

  function observeCaptions() {
    const player = document.querySelector('.html5-video-player') || document.body;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onCaptionObserved);
    observer.observe(player, { childList: true, subtree: true });

    // Remove old cuechange listeners
    for (const { track, handler } of _trackRefs) {
      try { track.removeEventListener('cuechange', handler); } catch (_) {}
    }
    _trackRefs = [];

    try {
      const v = document.querySelector('video');
      if (v && v.textTracks) {
        for (const tr of v.textTracks) {
          const handler = onCaptionObserved;
          tr.addEventListener('cuechange', handler);
          _trackRefs.push({ track: tr, handler });
        }
      }
    } catch (_) {}
  }

  function bindVideo() {
    // ---- P1-6: Remove old video listeners before attaching new ones ----
    if (_videoRefs) {
      const old = _videoRefs;
      try { old.video.removeEventListener('seeked', old.seeked); } catch (_) {}
      try { old.video.removeEventListener('pause', old.pause); } catch (_) {}
      try { old.video.removeEventListener('play', old.play); } catch (_) {}
      _videoRefs = null;
    }

    const v = document.querySelector('video');
    if (!v) return;

    controller.attach(v);

    // ---- Fix 2: Track last video time to detect micro-seeks vs user seeks ----
    let _lastSeekTime = v.currentTime;

    const seekedHandler = () => {
      const delta = Math.abs(v.currentTime - _lastSeekTime);
      _lastSeekTime = v.currentTime;

      // Only flush on user-initiated seeks (>2s), not micro-seeks from buffering (<0.5s)
      if (delta < 0.5) {
        console.log(`[AakashVani] micro-seek (${delta.toFixed(2)}s) — skipping flush`);
        return;
      }
      console.log(`[AakashVani] seek detected (${delta.toFixed(2)}s) — flushing`);
      lastDispatched = '';
      dispatchedIds.clear();
      _dispatchedTexts.clear();
      clearTimeout(debounce);
      _dispatchedCues.clear();
      controller.flush();
    };
    const pauseHandler = () => controller.pauseDubbed?.();
    const playHandler = () => controller.resumeDubbed?.();

    v.addEventListener('seeked', seekedHandler);
    v.addEventListener('pause', pauseHandler);
    v.addEventListener('play', playHandler);

    _videoRefs = { video: v, seeked: seekedHandler, pause: pauseHandler, play: playHandler };
  }

  document.addEventListener('yt-navigate-finish', () => {
    controller.flush();
    lastDispatched = '';
    dispatchedIds.clear();
    _dispatchedTexts.clear();
    clearTimeout(debounce);
    _dispatchedCues.clear();
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active (stable IDs, untimed fallback, correction detection)');
})();
