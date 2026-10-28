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

  function normalizeText(text) {
    return (text || '').trim().replace(/\s+/g, ' ').replace(/[.!?।।…\u0964\u0965]+$/, '');
  }
  let dispatchedIds = new Set(); // Track dispatched caption IDs for per-cue dedup
  let _dispatchedTexts = new Map(); // text → timestamp — secondary dedup by normalized text
  let pendingCue = null;
  let debounce = null;
  let observer = null;

  // ---- P0-2: Stable caption IDs via hash of timing only (no counter, no text) ----
  // Normalize timestamps to 100ms precision so sub-millisecond YouTube re-renders
  // (e.g., 581.731 vs 581.788) produce the SAME ID for the same caption.
  //
  // NOTE: `text` is deliberately EXCLUDED from the hash. YouTube renders TextTrack
  // cues incrementally ("H" → "He" → "Hello"); if text were part of the ID, each
  // incremental growth would produce a NEW ID and bypass all dedup, dispatching the
  // same caption repeatedly as it grows. With timing-only IDs, the same cue keeps
  // one ID across text growth, and text changes are handled as corrections below.
  // `text` is included in the hash only for untimed DOM captions, where each
  // unique passage needs its own ID. TextTrack cues call this without text so
  // that incremental cue growth ("H" → "He" → "Hello") keeps a stable ID.
  function _hashCaptionKey(startTime, endTime, text = '') {
    const normStart = Math.round(startTime * 10) / 10;  // 100ms precision
    const normEnd = Math.round(endTime * 10) / 10;
    const raw = `${normStart.toFixed(1)}|${normEnd.toFixed(1)}|${text}`;
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  // ---- P0-2 + P0-3: Each cue gets its own stable ID based on its own timing ----
  function makeCaption(cue, source = 'texttrack') {
    const text = (cue.text || '').trim();
    const startTime = cue.startTime;
    const endTime = cue.endTime;
    const key = _hashCaptionKey(startTime, endTime);
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
  // `startTime` is the video's currentTime at capture time (passed by the caller),
  // so the scheduler can schedule playback at the correct video position instead of
  // at TTS-completion time (which would be delayed by network+TTS latency).
  //
  // Unlike TextTrack cues (which grow incrementally and must keep a stable ID),
  // DOM captions are distinct passages — each unique text needs its own ID so
  // they are not mistaken for corrections of one another. Including text in the
  // hash prevents every untimed caption from colliding on dom-untimed-gsm0o8,
  // which previously caused each new caption to invalidate the previous one
  // and cut audio off mid-play.
  function makeUntimedCaption(text, source = 'dom', startTime = null) {
    const key = _hashCaptionKey(0, 0, text);
    return {
      id: `${source}-untimed-${key}`,
      text,
      startTime,
      endTime: startTime != null ? startTime + 3 : null,
      duration: startTime != null ? 3 : null,
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
    const v = document.querySelector('video');
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      const text = Array.from(segs).map((s) => s.textContent.trim()).join(' ').trim();
      if (text) return [makeUntimedCaption(text, 'dom', v ? v.currentTime : null)];
    }
    const win = document.querySelector('.ytp-caption-window-container .caption-visual-line');
    if (win) {
      const text = (win.textContent || '').trim();
      if (text) return [makeUntimedCaption(text, 'dom', v ? v.currentTime : null)];
    }
    return null;
  }

  function readCaption() {
    return readCaptionFromTextTrack() || readCaptionFromDOM();
  }

  // ---- P1-5: Track dispatched cue IDs and caption text stability ----
  // Map<captionId, { text, dispatchTime }> — dispatched captions
  const _dispatchedCues = new Map();
  // Map<captionId, { text, firstSeenTime }> — stability tracking for incremental
  // cue growth ("H" → "He" → "Hello"). Only dispatch when text has been stable
  // for CAPTION_STABILITY_MS so we don't speak incomplete fragments.
  const _captionStability = new Map();
  const MAX_DISPATCHED_CUES = 50;
  const CAPTION_STABILITY_MS = 300;

  function maybeDispatch(captions) {
    if (!captions || !captions.length) return;

    const now = Date.now();

    for (const caption of captions) {
      const text = (caption.text || '').trim();
      if (!text) continue;
      const normalized = normalizeText(text);

      const prev = _dispatchedCues.get(caption.id);

      // Same cue, same text as previously dispatched — nothing to do
      if (prev && normalizeText(prev.text) === normalized) continue;

      // DOM captions (untimed) include text in their ID, so each unique passage
      // already has its own ID — dispatch immediately without stability wait.
      // TextTrack cues share one ID across incremental growth — wait for text
      // stability to avoid speaking incomplete fragments.
      if (!caption.untimed) {
        // Track text stability: when was this (id, text) first observed?
        const stability = _captionStability.get(caption.id);
        if (!stability || stability.text !== normalized) {
          // First time seeing this text for this ID — start stability timer
          _captionStability.set(caption.id, { text: normalized, firstSeenTime: now });
          continue; // Don't dispatch yet — wait for text to stabilize
        }

        // Same text as stability tracker — check if stable long enough
        if (now - stability.firstSeenTime < CAPTION_STABILITY_MS) {
          // Not stable yet — wait for more observations
          continue;
        }
      }

      // Text has been stable long enough — dispatch
      if (prev) {
        // This is a genuine correction — invalidate old segment
        controller.invalidateCaption(caption.id);
        console.log(`[AakashVani] correction detected for ${caption.id}: "${prev.text.slice(0,40)}" → "${text.slice(0,40)}"`);
      }

      dispatchedIds.add(caption.id);
      _dispatchedTexts.set(normalized, now);
      _dispatchedCues.set(caption.id, { text, dispatchTime: now });
      _captionStability.delete(caption.id);

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
      // When the debounce fires, treat all currently-observed captions as
      // stable enough to dispatch. This handles the case where a caption
      // appears once and is already complete (no follow-up observation to
      // confirm stability).
      const debounceNow = Date.now();
      for (const caption of now) {
        const text = (caption.text || '').trim();
        if (!text) continue;
        const normalized = normalizeText(text);
        const stability = _captionStability.get(caption.id);
        if (!stability) {
          _captionStability.set(caption.id, { text: normalized, firstSeenTime: debounceNow - CAPTION_STABILITY_MS });
        }
      }
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
      _captionStability.clear();
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
    _captionStability.clear();
    clearTimeout(debounce);
    _dispatchedCues.clear();
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active (stable IDs, untimed fallback, correction detection)');
})();
