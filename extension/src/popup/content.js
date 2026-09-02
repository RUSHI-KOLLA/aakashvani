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
  let pendingCue = null;
  let debounce = null;
  let observer = null;

  // ---- P0-2: Stable caption IDs via hash of timing + text (no counter) ----
  function _hashCaptionKey(startTime, endTime, text) {
    const raw = `${startTime.toFixed(6)}|${endTime.toFixed(6)}|${text}`;
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
      const lastNormalized = normalizeText(lastDispatched);

      // Exact duplicate of last dispatched
      if (normalized === lastNormalized) continue;

      // ---- P1-5: Correction detection — same cue ID with different text ----
      const prev = _dispatchedCues.get(caption.id);
      if (prev && normalizeText(prev.text) !== normalized) {
        // Same cue identity, different text → correction. Invalidate old TTS.
        controller.invalidateCaption(caption.id);
        console.log(`[AakashVani] correction detected for ${caption.id}: "${prev.text.slice(0,40)}" → "${text.slice(0,40)}"`);
      }

      // ---- P0-3: Enqueue EACH cue with its own timing and ID ----
      lastDispatched = text;
      _dispatchedCues.set(caption.id, { text, dispatchTime: Date.now() });

      // Bound the map
      if (_dispatchedCues.size > MAX_DISPATCHED_CUES) {
        const oldest = _dispatchedCues.keys().next().value;
        _dispatchedCues.delete(oldest);
      }

      controller.enqueue(caption);
      console.log('[AakashVani] dispatch →', JSON.stringify(text).slice(0, 160), `id=${caption.id}`);
    }
  }

  function onCaptionObserved() {
    const captions = readCaption();
    if (!captions || !captions.length) return;
    pendingCue = captions[captions.length - 1];

    const combinedText = captions.map(c => c.text).join(' ').trim();
    if (PUNCT_RE.test(combinedText)) {
      clearTimeout(debounce);
      maybeDispatch(captions);
      return;
    }

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
    observer.observe(player, { childList: true, subtree: true, characterData: true });

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

    const seekedHandler = () => {
      lastDispatched = '';
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
    clearTimeout(debounce);
    _dispatchedCues.clear();
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active (stable IDs, untimed fallback, correction detection)');
})();
