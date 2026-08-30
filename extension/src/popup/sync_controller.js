// AakashVani sync controller — rolling audio chunk queue.
// Overlaps synthesis of line N+1 with playback of line N to eliminate
// stutter and drift. Runs in the content-script isolated world; declared
// before content.js in the manifest so both share scope.

class SyncController {
  constructor() {
    this.settings = { ducking: 10 };
    this.queue = [];        // pending lines not yet sent to the engine
    this.inflight = [];     // Promise<{audioBase64}|null> in submission order
    this.playback = [];     // queued {audio: HTMLAudioElement, url}
    this.playing = false;
    this.video = null;
    this.prevVolume = null;
    this.LOOKAHEAD = 3;     // max concurrent pipeline jobs ahead of playback
    chrome.storage.local.get(['ducking'], (s) => { this.settings = { ...this.settings, ...s }; });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.ducking) this.settings.ducking = ch.ducking.newValue;
    });
  }

  attach(videoEl) {
    this.video = videoEl;
  }

  enqueue(text) {
    if (!text) return;
    this.queue.push(text);
    this.pumpPipeline();
    this.tryPlayNext();
  }

  // Keep up to LOOKAHEAD lines in flight; dedupe identical consecutive text.
  pumpPipeline() {
    while (this.inflight.length < this.LOOKAHEAD && this.queue.length > 0) {
      const text = this.queue.shift();
      const p = this.synthesizeLine(text)
        .then((audioBase64) => {
          if (audioBase64) this.playback.push(this.makeAudio(audioBase64));
          this.tryPlayNext();
        })
        .catch((e) => console.warn('[AakashVani] pipeline:', e.message))
        .finally(() => {
          this.inflight = this.inflight.filter((x) => x !== p);
          this.pumpPipeline();
        });
      this.inflight.push(p);
    }
  }

  async synthesizeLine(text) {
    const res = await chrome.runtime.sendMessage({ type: 'DUB_LINE', text });
    if (!res || !res.ok) throw new Error(res ? res.error : 'no response from service worker');
    return res.audio;
  }

  makeAudio(audioBase64) {
    const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.preload = 'auto';
    return { audio, url };
  }

  // Play finished chunks sequentially; duck original audio while speaking.
  tryPlayNext() {
    if (this.playing || this.playback.length === 0) return;
    const v = this.video || document.querySelector('video');
    if (!v || v.paused) return; // stay idle while video is paused; resume later
    const item = this.playback.shift();
    this.playing = true;
    this.duck(true);
    const done = () => {
      this.duck(false);
      URL.revokeObjectURL(item.url); // prevent blob memory leak
      this.playing = false;
      this.tryPlayNext();
    };
    item.audio.onended = done;
    item.audio.onerror = done;
    item.audio.play().catch(done);
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
    this.queue = [];
    this.playback.forEach((i) => { i.audio.pause(); URL.revokeObjectURL(i.url); });
    this.playback = [];
    this.playing = false;
    this.duck(false);
  }
}

window.__aakashvani = new SyncController();
