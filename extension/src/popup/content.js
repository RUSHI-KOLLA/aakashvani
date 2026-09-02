// AakashVani content script — caption capture via MutationObserver.
// Stability debounce (250ms) + punctuation flush + prefix/superstring dedup.
// Only completes lines are dispatched to the pipelined queue — subframe DOM
// partials are held until the text either stabilizes or hits terminal punctuation.
(() => {
  const controller = window.__aakashvani;
  if (!controller) { console.warn('[AakashVani] sync controller missing'); return; }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EDGE_UNAVAILABLE' || msg.type === 'AUTH_ERROR') {
      controller.showBanner?.(msg.error || 'AakashVani: translation unavailable — check popup Mode/API key');
    }
  });

  const STABILITY_MS = 250;
  const PUNCT_RE = /[.?!।۔\u0964\u0965]$/; // latin + devanagari/urdu danda
  let lastDispatched = ''; // last text actually pushed to the queue
  let pendingText = '';    // last observed caption (may be partial)
  let debounce = null;
  let observer = null;

  function readCaptionRaw() {
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (segs.length) return Array.from(segs).map((s) => s.textContent.trim()).join(' ').trim();
    // Fallback: YouTube sometimes renders a single window without segments
    const win = document.querySelector('.ytp-caption-window-container .caption-visual-line');
    if (win) return (win.textContent || '').trim();
    return '';
  }

  function maybeDispatch(text) {
    const t = (text || '').trim();
    if (!t) return;
    if (t === lastDispatched) return; // exact duplicate — never requeue

    // Prefix / superstring dedup — root cause of word repetition:
    // YouTube captions emit word-by-word cumulative superstrings:
    // "Hello" → "Hello world" → "Hello world, how are you?"
    // With 250ms debounce, if word interval >250ms the timer fires early
    // and dispatches the partial "Hello" before " world" arrives. The next
    // superstring "Hello world" would then enqueue a SECOND TTS request with
    // repeated prefix, causing stutter. Fix: if new text is a superstring of
    // what we already sent, dispatch ONLY the delta suffix, not the full line.
    if (lastDispatched && t.startsWith(lastDispatched)) {
      const delta = t.slice(lastDispatched.length).trim();
      if (!delta) return; // superstring with no new words (e.g. trailing space) — ignore
      lastDispatched = t; // advance buffer to full superstring for next comparison
      controller.enqueue(delta);
      console.log('[AakashVani] dispatch (superstring delta) →', JSON.stringify(delta).slice(0, 160), 'from full:', JSON.stringify(t).slice(0, 120));
      return true;
    }

    lastDispatched = t;
    controller.enqueue(t);
    console.log('[AakashVani] dispatch →', JSON.stringify(t).slice(0, 160));
    return true;
  }

  function onCaptionObserved() {
    const raw = readCaptionRaw();
    if (!raw) return;
    pendingText = raw;

    // Immediate flush on punctuation — completed sentence, dispatch now
    if (PUNCT_RE.test(raw)) {
      clearTimeout(debounce);
      maybeDispatch(raw);
      return;
    }

    // Otherwise hold until the DOM stabilizes for STABILITY_MS
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      // Re-read at dispatch time — the DOM may have expanded further during debounce
      const now = readCaptionRaw() || pendingText;
      if (!now) return;
      maybeDispatch(now);
    }, STABILITY_MS);
  }

  function observeCaptions() {
    const player = document.querySelector('.html5-video-player') || document.body;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onCaptionObserved);
    observer.observe(player, { childList: true, subtree: true, characterData: true });
  }

  function bindVideo() {
    const v = document.querySelector('video');
    if (v) {
      controller.attach(v);
      v.addEventListener('seeked', () => {
        lastDispatched = '';
        pendingText = '';
        clearTimeout(debounce);
        controller.flush();
      });
      v.addEventListener('play', () => controller.tryPlayNext?.());
    }
  }

  // YouTube is an SPA: rebind on navigation (yt-navigate-finish) and player swaps
  document.addEventListener('yt-navigate-finish', () => {
    controller.flush();
    lastDispatched = '';
    pendingText = '';
    clearTimeout(debounce);
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active (stability 250ms + punct dedup)');
})();
