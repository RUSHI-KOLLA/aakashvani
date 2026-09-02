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
  const PUNCT_RE = /[.?!।।…\u0964\u0965]$/; // latin + devanagari/urdu danda
  let lastDispatched = ''; // last text actually pushed to the queue
  let pendingCue = null;    // last observed caption cue (may be partial)
  let debounce = null;
  let observer = null;
  let cueIdCounter = 0;

  // Create a canonical caption object with timing info
  function makeCaption(cue, source = 'texttrack') {
    return {
      id: `${source}-${cueIdCounter++}-${cue.startTime.toFixed(3)}`,
      text: (cue.text || '').trim(),
      startTime: cue.startTime,
      endTime: cue.endTime,
      duration: cue.endTime - cue.startTime,
      source,
      capturedAt: Date.now(),
    };
  }

  function readCaptionFromTextTrack() {
    try {
      const v = document.querySelector('video');
      if (!v || !v.textTracks) return null;
      
      for (const tr of v.textTracks) {
        if (tr.mode === 'showing' && tr.activeCues && tr.activeCues.length) {
          // Return all active cues as caption objects
          return Array.from(tr.activeCues).map(cue => makeCaption(cue, 'texttrack'));
        }
      }
    } catch (_) {}
    return null;
  }

  function readCaptionFromDOM() {
    // Fallback: DOM-based caption reading (legacy)
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (segs.length) {
      const text = Array.from(segs).map((s) => s.textContent.trim()).join(' ').trim();
      if (text) return [{ text, startTime: 0, endTime: 0, duration: 0, source: 'dom', id: `dom-${cueIdCounter++}`, capturedAt: Date.now() }];
    }
    const win = document.querySelector('.ytp-caption-window-container .caption-visual-line');
    if (win) {
      const text = (win.textContent || '').trim();
      if (text) return [{ text, startTime: 0, endTime: 0, duration: 0, source: 'dom', id: `dom-${cueIdCounter++}`, capturedAt: Date.now() }];
    }
    return null;
  }

  function readCaption() {
    // Try TextTrack first (has timing), fall back to DOM
    return readCaptionFromTextTrack() || readCaptionFromDOM();
  }

  function maybeDispatch(captions) {
    if (!captions || !captions.length) return;
    
    function normalizeText(text) {
      return (text || '').trim().replace(/\s+/g, ' ').replace(/[.!?।।…\u0964\u0965]+$/, '');
    }
    
    function cuesMatch(cue1, cue2) {
      if (!cue1 || !cue2) return false;
      if (Math.abs(cue1.startTime - cue2.startTime) < 0.1 && Math.abs(cue1.endTime - cue2.endTime) < 0.1) return true;
      const t1 = (cue1.text || '').trim().replace(/\s+/g, ' ').replace(/[.!?।।…\u0964\u0965]+$/, '');
      const t2 = (cue2.text || '').trim().replace(/\s+/g, ' ').replace(/[.!?।।…\u0964\u0965]+$/, '');
      if (t1 === t2 && Math.abs(cue1.startTime - cue2.startTime) < 0.5) return true;
      return false;
    }
    
    // Combine all caption texts
    const combinedText = captions.map(c => c.text).join(' ').trim();
    if (!combinedText) return;
    
    const normalized = normalizeText(combinedText);
    const lastNormalized = normalizeText(lastDispatched);
    
    // Exact duplicate check (normalized)
    if (normalized === lastNormalized) return;
    
    // Check if this is a correction of the last dispatched cue
    const lastCue = captions[captions.length - 1];
    // Use a module-level variable for last dispatched cue
    if (window.__aakashvani_lastDispatchedCue === undefined) {
      window.__aakashvani_lastDispatchedCue = null;
    }
    let lastDispatchedCue = window.__aakashvani_lastDispatchedCue;
    
    if (lastDispatchedCue && cuesMatch(lastDispatchedCue, captions[captions.length - 1])) {
      // This is a correction of the last cue - dispatch delta
      const normalizedNew = normalizeText(combinedText);
      const normalizedOld = normalizeText(lastDispatched);
      if (normalizedNew !== normalizedOld && normalizedNew.startsWith(normalizeText(lastDispatched))) {
        const delta = combinedText.slice(lastDispatched.length).trim();
        if (delta) {
          lastDispatched = combinedText;
          window.__aakashvani_lastDispatchedCue = captions[captions.length - 1];
          const deltaCaption = { ...captions[captions.length - 1], text: delta, isDelta: true, originalText: combinedText, isCorrection: true };
          controller.enqueue(deltaCaption);
          console.log('[AakashVani] dispatch (correction delta) →', JSON.stringify(deltaCaption.text).slice(0, 160));
          return true;
        }
      }
    
    // Prefix / superstring dedup — new text extends previous
    if (normalizeText(combinedText).startsWith(normalizeText(lastDispatched))) {
      const delta = combinedText.slice(lastDispatched.length).trim();
      if (!delta) return;
      lastDispatched = combinedText;
      window.__aakashvani_lastDispatchedCue = captions[captions.length - 1];
      const deltaCaption = { ...captions[captions.length - 1], text: delta, isDelta: true, originalText: combinedText };
      controller.enqueue(deltaCaption);
      console.log('[AakashVani] dispatch (superstring delta) →', JSON.stringify(delta).slice(0, 160), 'from full:', JSON.stringify(combinedText).slice(0, 120));
      return true;
    }
    
    // New caption (not a continuation)
    lastDispatched = combinedText;
    window.__aakashvani_lastDispatchedCue = captions[captions.length - 1];
    controller.enqueue(captions[captions.length - 1]);
    console.log('[AakashVani] dispatch →', JSON.stringify(combinedText).slice(0, 160));
    return true;
  }

    }
function onCaptionObserved() {
    const captions = readCaption();
    if (!captions || !captions.length) return;
    
    // Use the last (most complete) caption for pending state
    pendingCue = captions[captions.length - 1];
    
    // Immediate flush on punctuation — completed sentence, dispatch now
    const combinedText = captions.map(c => c.text).join(' ').trim();
    if (PUNCT_RE.test(combinedText)) {
      clearTimeout(debounce);
      maybeDispatch(captions);
      return;
    }
    
    // Otherwise hold until the DOM stabilizes for STABILITY_MS
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const now = readCaption();
      if (!now || !now.length) return;
      maybeDispatch(now);
    }, STABILITY_MS);
  }

  function observeCaptions() {
    const player = document.querySelector('.html5-video-player') || document.body;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onCaptionObserved);
    observer.observe(player, { childList: true, subtree: true, characterData: true });
    
    // Also listen for TextTrack cue changes
    try {
      const v = document.querySelector('video');
      if (v && v.textTracks) {
        for (const tr of v.textTracks) {
          tr.addEventListener('cuechange', onCaptionObserved);
        }
      }
    } catch (_) {}
  }

  function bindVideo() {
    const v = document.querySelector('video');
    if (v) {
      controller.attach(v);
      v.addEventListener('seeked', () => {
        lastDispatched = '';
        cueIdCounter = 0;
        clearTimeout(debounce);
        controller.flush();
      });
      v.addEventListener('pause', () => controller.pauseDubbed?.());
      v.addEventListener('play', () => controller.resumeDubbed?.());
    }
  }

  // YouTube is an SPA: rebind on navigation (yt-navigate-finish) and player swaps
  document.addEventListener('yt-navigate-finish', () => {
    controller.flush();
    lastDispatched = '';
    cueIdCounter = 0;
    clearTimeout(debounce);
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active (timestamped cues, stability 250ms + punct dedup)');
})();