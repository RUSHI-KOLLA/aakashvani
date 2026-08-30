// AakashVani content script — caption capture via MutationObserver.
// Replaces legacy 500ms polling: reacts instantly to caption DOM changes,
// dedupes lines, and feeds the rolling queue in sync_controller.js.
(() => {
  const controller = window.__aakashvani;
  if (!controller) { console.warn('[AakashVani] sync controller missing'); return; }

  let lastText = '';
  let debounce = null;
  let observer = null;

  const CAPTION_SELECTOR = '.ytp-caption-window-container, .ytp-caption-segment';

  function readCaption() {
    const segs = document.querySelectorAll('.ytp-caption-segment');
    return Array.from(segs).map((s) => s.textContent.trim()).join(' ').trim();
  }

  function onCaptionChange() {
    const text = readCaption();
    if (!text || text === lastText) return;
    lastText = text;
    controller.enqueue(text);
  }

  function observeCaptions() {
    const player = document.querySelector('.html5-video-player') || document.body;
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      // Debounce burst mutations within one caption render frame
      clearTimeout(debounce);
      debounce = setTimeout(onCaptionChange, 60);
    });
    observer.observe(player, { childList: true, subtree: true, characterData: true });
  }

  function bindVideo() {
    const v = document.querySelector('video');
    if (v) {
      controller.attach(v);
      v.addEventListener('seeked', () => { lastText = ''; controller.flush(); });
      v.addEventListener('play', () => controller.tryPlayNext?.());
    }
  }

  // YouTube is an SPA: rebind on navigation (yt-navigate-fire) and player swaps
  document.addEventListener('yt-navigate-finish', () => {
    controller.flush();
    lastText = '';
    bindVideo();
    observeCaptions();
  });

  bindVideo();
  observeCaptions();
  console.log('[AakashVani] caption observer active');
})();
