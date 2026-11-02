// AakashVani content script — caption capture via TextTrack API with DOM fallback.
// Captures caption cues with timing info for precise synchronization.
// Captions are observed continuously. Each caption stream keeps an independent
// stability timer and dispatches only the new (not-yet-spoken) portion once the
// text has been stable for CAPTION_STABILITY_MS. This handles progressive cue
// growth, YouTube's sliding-window DOM captions, and captions that appear once
// and never mutate again.
(() => {
  const controller = window.__aakashvani;
  if (!controller) { console.warn('[AakashVani] sync controller missing'); return; }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EDGE_UNAVAILABLE' || msg.type === 'AUTH_ERROR') {
      controller.showBanner?.(msg.error || 'AakashVani: translation unavailable — check popup Mode/API key');
    }
  });

  const CAPTION_STABILITY_MS = 300;
  const DEFAULT_CAPTION_DURATION = 3;
  const MAX_TEXTTRACK_STATES = 20;
  const MAX_RECENT_IDS = 100;

  // ---- Text normalization / non-speech filtering ----
  // Comparison form: trim, collapse whitespace, drop trailing sentence punctuation.
  function normalizeText(text) {
    return (text || '').trim().replace(/\s+/g, ' ').replace(/[.!?।।…\u0964\u0965]+$/, '');
  }

  function collapseWhitespace(text) {
    return (text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // YouTube includes non-speech annotations such as [Music], (applause), and
  // musical-note glyphs in caption text. Strip them so TTS never speaks them.
  const NON_SPEECH_ANNOTATION = /\[[^\]]*(?:music|applause|laughter|inaudible|silence|sound effect|foreign|speaking foreign language)[^\]]*\]|\([^)]*(?:music|applause|laughter|inaudible|silence|sound effect|foreign|speaking foreign language)[^)]*\)/gi;
  function cleanCaptionText(text) {
    return collapseWhitespace(
      (text || '')
        .replace(NON_SPEECH_ANNOTATION, ' ')
        .replace(/[♪♫♬♩]+/g, ' ')
    );
  }

  function isSpokenCaption(text) {
    const t = cleanCaptionText(text);
    if (!t) return false;
    // Must contain at least one letter or digit (ignore "...", "—", etc.).
    if (!/[\p{L}\p{N}]/u.test(t)) return false;
    // Caption-player interface strings are not spoken content.
    if (/^(?:subtitles?|captions?|cc|auto-generated|english \(auto-generated\))$/i.test(t)) return false;
    return true;
  }

  // ---- Stable caption IDs ----
  // TextTrack IDs use only the cue start time: cue end times and text grow as
  // ASR refines a live cue, so including either would change the ID mid-cue.
  // DOM caption IDs include the pending start time and text because each DOM
  // passage is independent (there is no native cue identity).
  function _hashCaptionKey(startTime, endTime, text = '') {
    const normStart = Math.round((Number(startTime) || 0) * 2) / 2;  // 500ms precision
    const normEnd = Math.round((Number(endTime) || 0) * 2) / 2;
    const raw = `${normStart.toFixed(1)}|${normEnd.toFixed(1)}|${text}`;
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  function makeCaption(cue, source = 'texttrack') {
    const text = cleanCaptionText(cue.text || '');
    const startTime = Number.isFinite(Number(cue.startTime)) ? Number(cue.startTime) : 0;
    const endTime = Number.isFinite(Number(cue.endTime)) ? Number(cue.endTime) : startTime;
    const key = _hashCaptionKey(startTime, 0);
    return {
      id: `${source}-${key}`,
      text,
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      source,
      untimed: false,
      capturedAt: Date.now(),
    };
  }

  // ---- DOM fallback — untimed captions, never fake 0→0 ----
  // `startTime` is the video's currentTime at capture time, so the scheduler can
  // schedule playback at the correct video position instead of at TTS-completion
  // time (which would be delayed by network + TTS latency).
  function makeUntimedCaption(text, source = 'dom', startTime = null) {
    const clean = cleanCaptionText(text);
    const start = startTime != null && Number.isFinite(Number(startTime)) ? Number(startTime) : null;
    const end = start != null ? start + DEFAULT_CAPTION_DURATION : null;
    const key = _hashCaptionKey(start ?? 0, end ?? 0, normalizeText(clean));
    return {
      id: `${source}-untimed-${key}`,
      text: clean,
      startTime: start,
      endTime: end,
      duration: start != null ? DEFAULT_CAPTION_DURATION : null,
      source,
      untimed: true,
      capturedAt: Date.now(),
    };
  }

  function readCaptionFromTextTrack() {
    try {
      const v = document.querySelector('video');
      if (!v || !v.textTracks) return null;
      let idx = 0;
      for (const tr of v.textTracks) {
        if (tr.mode === 'showing' && tr.activeCues && tr.activeCues.length) {
          const source = idx === 0 ? 'texttrack' : `texttrack-${idx}`;
          const cues = Array.from(tr.activeCues)
            .map((cue) => makeCaption(cue, source))
            .filter((caption) => isSpokenCaption(caption.text));
          if (cues.length) return cues;
        }
        idx++;
      }
    } catch (_) {}
    return null;
  }

  function readCaptionFromDOM() {
    const v = document.querySelector('video');
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      const parts = [];
      for (const seg of Array.from(segs)) {
        const part = (seg.textContent || '').trim();
        // YouTube can briefly render the same line twice during a re-render.
        if (part && !parts.includes(part)) parts.push(part);
      }
      const text = cleanCaptionText(parts.join(' '));
      if (isSpokenCaption(text)) return [makeUntimedCaption(text, 'dom', v ? v.currentTime : null)];
    }
    const win = document.querySelector('.ytp-caption-window-container .caption-visual-line');
    if (win) {
      const text = cleanCaptionText(win.textContent || '');
      if (isSpokenCaption(text)) return [makeUntimedCaption(text, 'dom', v ? v.currentTime : null)];
    }
    return null;
  }

  function readCaption() {
    return readCaptionFromTextTrack() || readCaptionFromDOM();
  }

  // ---- Caption diffing ----
  // Returns only the genuinely new portion of `next` relative to `prev`.
  // - growth: YouTube appended words to the same cue/window
  // - slide:  YouTube rolled the window forward, so `next` starts with the tail
  //           of `prev`; the overlapping tail must not be spoken again
  // - replace/truncation: ASR correction or a completely new passage
  function _tokens(text) {
    return (text.match(/\S+/g) || []);
  }

  function _normalizedWord(word) {
    return (word || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function _wordOverlap(prev, next) {
    const prevWords = _tokens(prev);
    const nextWords = _tokens(next);
    const max = Math.min(prevWords.length, nextWords.length);
    // Require at least two words and 15 characters of overlap. Short common
    // phrases ("the government", "a tax cut") must not swallow genuinely new
    // speech that happens to reuse them; real sliding windows overlap far more.
    for (let k = max; k >= 2; k--) {
      let matches = true;
      for (let i = 0; i < k; i++) {
        if (_normalizedWord(prevWords[prevWords.length - k + i]) !== _normalizedWord(nextWords[i])) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      let idx = 0;
      for (let i = 0; i < k; i++) {
        const pos = next.indexOf(nextWords[i], idx);
        if (pos < 0) { matches = false; break; }
        idx = pos + nextWords[i].length;
      }
      if (matches && idx >= 15) return { words: k, added: next.slice(idx) };
    }
    return { words: 0, added: '' };
  }

  function diffDisplay(prev, next) {
    if (!prev) return { relation: 'new', added: next };
    if (prev === next) return { relation: 'same', added: '' };
    // Preserve the raw suffix: it may begin mid-word ("W" → "Wel") or with a
    // separator ("Hello" → "Hello world").
    if (next.startsWith(prev)) return { relation: 'growth', added: next.slice(prev.length) };
    // Only a prefix or suffix means the caption was shortened in place. A
    // phrase reused in the middle of a new passage is genuinely new speech.
    if (prev.startsWith(next) || prev.endsWith(next)) return { relation: 'truncation', added: '' };
    const overlap = _wordOverlap(prev, next);
    if (overlap.words >= 2) return { relation: 'slide', added: overlap.added };
    return { relation: 'replace', added: next };
  }

  // Derive the unspoken portion of `display` from the last display that was
  // actually dispatched. Recomputing (instead of appending deltas) means an ASR
  // correction replaces the pending text rather than speaking both variants,
  // and a caption replaced before it stabilized is never spoken as a fragment.
  function pendingFromDisplay(lastSpoken, display) {
    if (!lastSpoken) return { text: display, relation: 'new' };
    const diff = diffDisplay(lastSpoken, display);
    if (diff.relation === 'same' || diff.relation === 'truncation') {
      return { text: '', relation: diff.relation };
    }
    if (diff.relation === 'replace') return { text: display, relation: 'replace' };
    let added = diff.added || '';
    if (!added) return { text: '', relation: diff.relation };
    // Progressive ASR can grow a word after it was already dispatched ("W" →
    // "Welcome"). Re-attach the trailing partial word so TTS receives a real
    // word instead of a bare suffix ("elcome").
    if (diff.relation === 'growth' && !/^\s/.test(added) && /^[\p{L}\p{N}]/u.test(added)) {
      const trailing = lastSpoken.match(/[\p{L}\p{N}]+$/u);
      if (trailing) added = trailing[0] + added;
    }
    return { text: collapseWhitespace(added), relation: diff.relation };
  }

  // ---- Caption stream state ----
  // One state per TextTrack cue plus one state for the DOM fallback. Pending
  // text is the unspoken portion of the current display since the last
  // dispatch. A timer fires independently of future mutations, so a static
  // caption is never swallowed.
  function createCaptionState(source) {
    return {
      source,
      displayText: '',
      pendingText: '',
      pendingRelation: '',
      pendingStart: null,
      pendingEnd: null,
      lastChangeAt: 0,
      lastSpokenDisplay: '',
      lastDispatchedId: '',
      timer: null,
    };
  }

  const _textTrackStates = new Map();
  let _domState = createCaptionState('dom');
  let _activeSource = null;
  let _textTrackCarry = '';
  let _lastDispatchedDisplay = '';
  const _recentIds = new Set();

  function getVideoTime() {
    const v = document.querySelector('video');
    return v && Number.isFinite(v.currentTime) ? v.currentTime : Date.now() / 1000;
  }

  function clearStateTimer(state) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function rememberId(id) {
    _recentIds.add(id);
    if (_recentIds.size > MAX_RECENT_IDS) {
      const oldest = _recentIds.values().next().value;
      _recentIds.delete(oldest);
    }
  }

  function dispatchState(state, reason) {
    const pendingText = (state.pendingText || '').trim();
    const fullText = (state.displayText || '').trim();
    if (!pendingText && !fullText) {
      state.pendingText = '';
      state.pendingRelation = '';
      state.pendingStart = null;
      state.pendingEnd = null;
      clearStateTimer(state);
      return;
    }

    const startTime = state.pendingStart != null ? state.pendingStart : getVideoTime();
    const endTime = state.pendingEnd != null && state.pendingEnd > startTime
      ? state.pendingEnd
      : startTime + DEFAULT_CAPTION_DURATION;

    // When the revision-aware transcript pipeline is available, send the FULL
    // display text so TranscriptController.reconcile() can diff against its
    // committed prefix and extract only the new residual words. Sending delta
    // fragments would overwrite accumulated uncommitted text and drop confirmed
    // words (the missing-word bug). Otherwise (enqueue fallback) send the delta
    // fragment as a self-contained segment.
    const usePipeline = typeof controller.ingestCaption === 'function';
    const text = usePipeline ? fullText : pendingText;
    const relation = usePipeline
      ? diffDisplay(state.lastSpokenDisplay || '', fullText).relation
      : state.pendingRelation;

    if (!text || !isSpokenCaption(text)) {
      state.pendingText = '';
      state.pendingRelation = '';
      state.pendingStart = null;
      state.pendingEnd = null;
      clearStateTimer(state);
      return;
    }

    const prevId = state.lastDispatchedId;
    const id = `${state.source}-${_hashCaptionKey(startTime, endTime, normalizeText(text))}`;
    const caption = {
      id,
      text,
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      source: state.source,
      untimed: state.source === 'dom',
      capturedAt: Date.now(),
    };

    // The full display text at dispatch time is the reference for the next
    // diff. This prevents re-speaking the overlapping tail of a sliding window.
    _lastDispatchedDisplay = state.displayText || text;
    state.lastSpokenDisplay = _lastDispatchedDisplay;
    state.pendingText = '';
    state.pendingRelation = '';
    state.pendingStart = null;
    state.pendingEnd = null;
    clearStateTimer(state);

    if (_recentIds.has(id)) return;
    rememberId(id);
    state.lastDispatchedId = id;

    // A TextTrack cue that is replaced (not grown/slid) is an ASR correction of
    // the same cue. Discard any queued-but-unplayed audio for the old text so
    // the stale version is never spoken before the corrected one.
    if (prevId && relation === 'replace' && state.source !== 'dom') {
      try { controller.invalidateCaption?.(prevId); } catch (_) {}
      // The previous version was discarded, not spoken. Allow the same text to
      // be enqueued again if ASR later reverts to it.
      _recentIds.delete(prevId);
    }

    // Phase 2: Route through revision-aware transcript pipeline (stability,
    // reconciliation, phrase segmentation). Falls back to direct enqueue if
    // the transcript controller is not available.
    if (controller.ingestCaption) {
      controller.ingestCaption(caption);
    } else {
      controller.enqueue(caption);
    }
    console.log(
      `[AakashVani] dispatch → ${JSON.stringify(text).slice(0, 160)} ` +
      `id=${caption.id} (${reason})`
    );
  }

  function scheduleDispatch(state) {
    if (!state.pendingText) {
      clearStateTimer(state);
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!state.pendingText) return;
      // A change may have arrived at the same time the timer fired.
      if (Date.now() - state.lastChangeAt < CAPTION_STABILITY_MS - 20) {
        scheduleDispatch(state);
        return;
      }
      dispatchState(state, 'stable');
    }, CAPTION_STABILITY_MS);
  }

  function observeCaption(state, caption, now) {
    const text = cleanCaptionText(caption.text || '');
    if (!isSpokenCaption(text)) return;

    const display = collapseWhitespace(text);
    if (display === state.displayText) {
      // Do not reset lastChangeAt on repeated observations of the same text:
      // YouTube re-renders static captions frequently, and resetting here would
      // prevent the stability timer from ever firing.
      if (state.pendingText && !state.timer) scheduleDispatch(state);
      return;
    }

    const videoTime = getVideoTime();
    const timingStart = caption.startTime != null ? caption.startTime : videoTime;
    const timingEnd = caption.endTime != null && caption.endTime > timingStart
      ? caption.endTime
      : timingStart + DEFAULT_CAPTION_DURATION;
    const hasSpoken = !!state.lastSpokenDisplay;
    const hadPending = !!state.pendingText;
    const derived = pendingFromDisplay(state.lastSpokenDisplay, display);
    const pending = derived.text;

    state.displayText = display;
    state.pendingText = pending;
    state.pendingRelation = derived.relation;

    if (!pending) {
      state.pendingStart = null;
      state.pendingEnd = null;
      clearStateTimer(state);
      return;
    }

    // Keep the start of the passage across progressive growth/correction, but
    // give a new passage its own capture time once the previous one was spoken.
    if (!hadPending) {
      state.pendingStart = hasSpoken ? videoTime : timingStart;
      state.pendingEnd = hasSpoken ? state.pendingStart + DEFAULT_CAPTION_DURATION : timingEnd;
    } else if (timingEnd > state.pendingEnd) {
      state.pendingEnd = timingEnd;
    }

    state.lastChangeAt = now;
    scheduleDispatch(state);
  }

  function flushAllPending(reason) {
    const states = [..._textTrackStates.values(), _domState];
    for (const state of states) {
      if (state.pendingText) dispatchState(state, reason);
    }
  }

  function resetCaptionState(dispatchPending = false) {
    if (dispatchPending) flushAllPending('reset');
    for (const state of _textTrackStates.values()) clearStateTimer(state);
    _textTrackStates.clear();
    clearStateTimer(_domState);
    _domState = createCaptionState('dom');
    _activeSource = null;
    _textTrackCarry = '';
    _lastDispatchedDisplay = '';
    _recentIds.clear();
  }

  function processCaptions(captions) {
    const now = Date.now();
    const source = captions[0].source;

    if (_activeSource && _activeSource !== source) {
      // Flush anything still pending from the old source, then reset the state
      // for the new source. Carry the last spoken display so the same text is
      // not dispatched twice when YouTube switches between TextTrack and DOM.
      flushAllPending('source-change');
      if (source === 'dom') {
        clearStateTimer(_domState);
        _domState = createCaptionState('dom');
        if (_lastDispatchedDisplay) {
          _domState.displayText = _lastDispatchedDisplay;
          _domState.lastSpokenDisplay = _lastDispatchedDisplay;
        }
      } else {
        for (const state of _textTrackStates.values()) clearStateTimer(state);
        _textTrackStates.clear();
        _textTrackCarry = _lastDispatchedDisplay;
      }
    }
    _activeSource = source;

    for (const caption of captions) {
      if (caption.source === 'dom') {
        observeCaption(_domState, caption, now);
        continue;
      }
      let state = _textTrackStates.get(caption.id);
      if (!state) {
        state = createCaptionState(caption.source || 'texttrack');
        if (_textTrackCarry) {
          state.displayText = _textTrackCarry;
          state.lastSpokenDisplay = _textTrackCarry;
          _textTrackCarry = '';
        }
        _textTrackStates.set(caption.id, state);
      }
      observeCaption(state, caption, now);
    }

    // Bound the TextTrack state map. Never evict a state with pending speech.
    while (_textTrackStates.size > MAX_TEXTTRACK_STATES) {
      let evicted = false;
      for (const [id, state] of _textTrackStates) {
        if (!state.pendingText && !state.timer) {
          _textTrackStates.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }

  function onCaptionObserved() {
    const captions = readCaption();
    if (!captions || !captions.length) return;
    processCaptions(captions);
  }

  // ---- Listener lifecycle — store refs, remove before re-attach ----
  let observer = null;
  let _videoRefs = null;
  let _trackRefs = [];
  let _trackListRef = null;

  function attachTrackListener(track) {
    if (!track) return;
    if (_trackRefs.some((ref) => ref.track === track)) return;
    const handler = onCaptionObserved;
    try {
      track.addEventListener('cuechange', handler);
      _trackRefs.push({ track, handler });
    } catch (_) {}
  }

  function observeCaptions() {
    const player = document.querySelector('.html5-video-player') || document.body;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onCaptionObserved);
    // characterData is needed because YouTube sometimes updates a text node in
    // place instead of replacing the caption segment element.
    observer.observe(player, { childList: true, subtree: true, characterData: true });

    // Remove old cuechange listeners.
    for (const { track, handler } of _trackRefs) {
      try { track.removeEventListener('cuechange', handler); } catch (_) {}
    }
    _trackRefs = [];
    if (_trackListRef) {
      try { _trackListRef.list.removeEventListener('addtrack', _trackListRef.add); } catch (_) {}
      _trackListRef = null;
    }

    try {
      const v = document.querySelector('video');
      if (v && v.textTracks) {
        for (const tr of v.textTracks) attachTrackListener(tr);
        // YouTube may create its TextTrack after this script starts.
        if (typeof v.textTracks.addEventListener === 'function') {
          const add = () => {
            for (const tr of v.textTracks) attachTrackListener(tr);
          };
          v.textTracks.addEventListener('addtrack', add);
          _trackListRef = { list: v.textTracks, add };
        }
      }
    } catch (_) {}
  }

  function bindVideo() {
    // ---- Remove old video listeners before attaching new ones ----
    if (_videoRefs) {
      const old = _videoRefs;
      try { old.video.removeEventListener('seeked', old.seeked); } catch (_) {}
      try { old.video.removeEventListener('pause', old.pause); } catch (_) {}
      try { old.video.removeEventListener('play', old.play); } catch (_) {}
      try { old.video.removeEventListener('timeupdate', old.timeupdate); } catch (_) {}
      _videoRefs = null;
    }

    const v = document.querySelector('video');
    if (!v) return;

    controller.attach(v);

    // Track last video time to distinguish micro-seeks/buffering from user seeks.
    let _lastSeekTime = v.currentTime;

    const timeupdateHandler = () => {
      // Do not update during an in-progress seek; the seeked handler needs the
      // pre-seek time to measure the jump.
      if (!v.seeking) _lastSeekTime = v.currentTime;
    };

    const seekedHandler = () => {
      const delta = Math.abs(v.currentTime - _lastSeekTime);
      _lastSeekTime = v.currentTime;

      if (delta < 0.5) {
        console.log(`[AakashVani] micro-seek (${delta.toFixed(2)}s) — skipping flush`);
        return;
      }
      console.log(`[AakashVani] seek detected (${delta.toFixed(2)}s) — flushing`);
      resetCaptionState(false);
      controller.flush();
    };
    const pauseHandler = () => controller.pauseDubbed?.();
    const playHandler = () => controller.resumeDubbed?.();

    v.addEventListener('seeked', seekedHandler);
    v.addEventListener('pause', pauseHandler);
    v.addEventListener('play', playHandler);
    v.addEventListener('timeupdate', timeupdateHandler);

    _videoRefs = { video: v, seeked: seekedHandler, pause: pauseHandler, play: playHandler, timeupdate: timeupdateHandler };
  }

  document.addEventListener('yt-navigate-finish', () => {
    resetCaptionState(false);
    controller.flush();
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active (stable timers, delta dispatch, DOM fallback)');
})();
