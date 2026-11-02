// AakashVani caption pipeline integration tests.
// Executes the REAL content.js and sync_controller.js inside a deterministic
// DOM/TextTrack/chrome/audio harness. No browser required.
// Run: node extension/tests/test_caption_pipeline.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, 'src/popup/content.js'), 'utf8');
const SYNC_SRC = fs.readFileSync(path.join(ROOT, 'src/popup/sync_controller.js'), 'utf8');

let _pass = 0;
let _fail = 0;
function assert(cond, msg) {
  if (cond) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { _pass++; }
  else {
    _fail++;
    console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
function section(name) { console.log(`\n--- ${name} ---`); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function createEnv(options = {}) {
  const withController = options.withController !== false;
  const fakeClock = options.fakeClock === true;
  const logs = [];
  const enqueued = [];
  const played = [];
  const docListeners = {};
  const mutationObservers = [];
  const trackList = [];
  const domSegment = { textContent: '' };

  // Optional deterministic clock for replaying captured YouTube caption
  // sequences without waiting in real time.
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, at: now + (Number(ms) || 0), fn });
    return id;
  };
  const fakeClearTimeout = (id) => {
    const idx = timers.findIndex((t) => t.id === id);
    if (idx >= 0) timers.splice(idx, 1);
  };
  function advance(ms) {
    const target = now + (Number(ms) || 0);
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = target;
  }

  const video = {
    currentTime: 5.7,
    paused: false,
    seeking: false,
    volume: 1,
    _listeners: {},
    textTracks: trackList,
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) {
      this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== fn);
    },
    dispatch(ev) { for (const fn of (this._listeners[ev] || [])) fn(); },
  };

  trackList.addEventListener = (ev, fn) => { (trackList._listeners ||= {}); (trackList._listeners[ev] ||= []).push(fn); };
  trackList.removeEventListener = (ev, fn) => {
    trackList._listeners = trackList._listeners || {};
    trackList._listeners[ev] = (trackList._listeners[ev] || []).filter((f) => f !== fn);
  };
  trackList.dispatch = (ev) => { for (const fn of ((trackList._listeners || {})[ev] || [])) fn(); };

  function makeTrack(cue) {
    const listeners = {};
    const track = {
      mode: 'showing',
      activeCues: cue ? [cue] : [],
      addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
      removeEventListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
      dispatch(ev) { for (const fn of (listeners[ev] || [])) fn(); },
    };
    trackList.push(track);
    trackList.dispatch('addtrack');
    return track;
  }

  const player = { className: 'html5-video-player' };
  const fakeDocument = {
    body: { className: 'body' },
    querySelector(sel) {
      if (sel === 'video') return video;
      if (sel === '.html5-video-player') return player;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.ytp-caption-segment') return [domSegment];
      return [];
    },
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
    dispatch(ev) { for (const fn of (docListeners[ev] || [])) fn(); },
  };

  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; }
    observe() { this.connected = true; mutationObservers.push(this); }
    disconnect() {
      this.connected = false;
      const idx = mutationObservers.indexOf(this);
      if (idx >= 0) mutationObservers.splice(idx, 1);
    }
  }

  function triggerMutations() {
    for (const observer of [...mutationObservers]) {
      if (observer.connected) observer.cb([], observer);
    }
  }

  function setDomText(text) {
    domSegment.textContent = text;
    triggerMutations();
  }

  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg) {
        if (msg.type === 'TRANSLATE') return Promise.resolve({ ok: true, translated: `T:${msg.text}` });
        if (msg.type === 'TTS_ONLY') return Promise.resolve({ ok: true, audio: Buffer.from('RIFF').toString('base64') });
        return Promise.resolve({ ok: false, error: `unknown ${msg.type}` });
      },
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({ mode: 'auto', language: 'te-IN', ttsBackend: 'piper', ducking: 10, ...(options.settings || {}) });
        },
      },
      onChanged: { addListener() {} },
    },
  };

  class MockAudio {
    constructor(url) {
      this._blobUrl = url;
      this.preload = 'auto';
      this.preservesPitch = true;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.duration = 1;
      this.paused = true;
    }
    play() {
      this.paused = false;
      played.push({ url: this._blobUrl, videoTime: video.currentTime });
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }

  const sandbox = {
    console: {
      log: (...args) => logs.push(args.map(String).join(' ')),
      warn: (...args) => logs.push('WARN ' + args.map(String).join(' ')),
      error: (...args) => logs.push('ERROR ' + args.map(String).join(' ')),
    },
    chrome,
    document: fakeDocument,
    MutationObserver: FakeMutationObserver,
    setTimeout: fakeClock ? fakeSetTimeout : setTimeout,
    clearTimeout: fakeClock ? fakeClearTimeout : clearTimeout,
    setInterval,
    clearInterval,
    Date: fakeClock ? { now: () => now } : Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Uint8Array,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Audio: MockAudio,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  if (withController) {
    vm.runInContext(SYNC_SRC, sandbox, { filename: 'sync_controller.js' });
    const controller = sandbox.window.__aakashvani;
    const realEnqueue = controller.enqueue.bind(controller);
    controller.enqueue = (caption) => {
      enqueued.push({ ...caption });
      return realEnqueue(caption);
    };
  } else {
    sandbox.window.__aakashvani = {
      attach() {},
      enqueue(caption) { enqueued.push({ ...caption }); },
      flush() {},
      invalidateCaption() {},
      pauseDubbed() {},
      resumeDubbed() {},
      showBanner() {},
    };
  }

  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });

  return {
    sandbox,
    video,
    trackList,
    makeTrack,
    setDomText,
    triggerMutations,
    enqueued,
    played,
    logs,
    advance,
    getNow: () => now,
    controller: sandbox.window.__aakashvani,
  };
}

// Real DOM caption sequence captured from YouTube during the investigation.
// It is a sliding window: each new caption starts with the tail of the previous
// one. Only the genuinely new tail may be spoken.
const REAL_DOM_SEQUENCE = [
  { text: 'Here in India,', start: 5.7, t: 0 },
  { text: 'Here in India, the government is', start: 6.2, t: 100 },
  { text: 'Here in India, the government is mulling a major tax cut.', start: 6.8, t: 200 },
  { text: "Here in India, the government is mulling a major tax cut. And don't get too excited.", start: 7.3, t: 300 },
  { text: "Here in India, the government is mulling a major tax cut. And don't get too excited.", start: 7.3, t: 650 },
  { text: "a major tax cut. And don't get too excited. It's not your income", start: 9.6, t: 700 },
  { text: "a major tax cut. And don't get too excited. It's not your income tax", start: 10.1, t: 800 },
  { text: "a major tax cut. And don't get too excited. It's not your income tax or GST.", start: 10.6, t: 900 },
  { text: "a major tax cut. And don't get too excited. It's not your income tax or GST.", start: 10.6, t: 1200 },
  { text: "excited. It's not your income tax or GST. It's", start: 11.1, t: 1300 },
  { text: "excited. It's not your income tax or GST. It's the tax", start: 11.6, t: 1400 },
  { text: "excited. It's not your income tax or GST. It's the tax on your stock", start: 12.1, t: 1500 },
  { text: "excited. It's not your income tax or GST. It's the tax on your stock market", start: 12.6, t: 1600 },
  { text: "excited. It's not your income tax or GST. It's the tax on your stock market returns.", start: 13.1, t: 1700 },
  { text: "excited. It's not your income tax or GST. It's the tax on your stock market returns.", start: 13.1, t: 2000 },
  { text: "GST. It's the tax on your stock market returns.", start: 13.6, t: 2100 },
  { text: "GST. It's the tax on your stock market returns. Now, we don't", start: 14.1, t: 2200 },
  { text: "GST. It's the tax on your stock market returns. Now, we don't have an official", start: 14.6, t: 2300 },
  { text: "GST. It's the tax on your stock market returns. Now, we don't have an official confirmation", start: 15.1, t: 2400 },
  { text: "GST. It's the tax on your stock market returns. Now, we don't have an official confirmation", start: 15.1, t: 2700 },
  { text: "returns. Now, we don't have an official confirmation from the government", start: 15.6, t: 2800 },
  { text: "returns. Now, we don't have an official confirmation from the government yet,", start: 16.1, t: 2900 },
  { text: "returns. Now, we don't have an official confirmation from the government yet,", start: 16.1, t: 3200 },
  { text: "confirmation from the government yet, but there are reports", start: 16.6, t: 3300 },
  { text: "but there are reports and they say that discussions are underway.", start: 17.1, t: 3400 },
  { text: "but there are reports and they say that discussions are underway. And if it goes ahead,", start: 17.6, t: 3500 },
  { text: "but there are reports and they say that discussions are underway. And if it goes ahead,", start: 17.6, t: 3800 },
  { text: "discussions are underway. And if it goes ahead,", start: 18.1, t: 3900 },
  { text: "discussions are underway. And if it goes ahead, if the government", start: 18.6, t: 4000 },
  { text: "discussions are underway. And if it goes ahead, if the government", start: 18.6, t: 4100 },
  { text: "ahead, if the government goes ahead with this,", start: 19.1, t: 4200 },
  { text: "if the government goes ahead with this, it could shake up the Indian", start: 19.6, t: 4300 },
  { text: "if the government goes ahead with this, it could shake up the Indian markets.", start: 20.1, t: 4400 },
  { text: "if the government goes ahead with this, it could shake up the Indian markets.", start: 20.1, t: 4700 },
  { text: "it could shake up the Indian markets. So, tonight we're looking", start: 20.6, t: 4800 },
  { text: "it could shake up the Indian markets. So, tonight we're looking at three", start: 21.1, t: 4900 },
  { text: "it could shake up the Indian markets. So, tonight we're looking at three questions.", start: 21.6, t: 5000 },
  { text: "it could shake up the Indian markets. So, tonight we're looking at three questions.", start: 21.6, t: 5300 },
  { text: "So, tonight we're looking at three questions.", start: 22.1, t: 5400 },
  { text: "So, tonight we're looking at three questions. One,", start: 22.6, t: 5500 },
  { text: "So, tonight we're looking at three questions. One, what is the proposal?", start: 23.1, t: 5600 },
  { text: "So, tonight we're looking at three questions. One, what is the proposal? Two,", start: 23.6, t: 5700 },
  { text: "So, tonight we're looking at three questions. One, what is the proposal? Two,", start: 23.6, t: 6000 },
];

async function testDomStatic() {
  section('DOM static caption (the regression)');
  const env = createEnv({ withController: false });
  env.setDomText('Here in India, the government is mulling a major tax cut.');
  await delay(600);
  assertEq(env.enqueued.length, 1, 'one dispatch for a caption that never mutates again');
  if (env.enqueued[0]) {
    assertEq(env.enqueued[0].text, 'Here in India, the government is mulling a major tax cut.', 'full text dispatched');
    assertEq(env.enqueued[0].untimed, true, 'DOM caption marked untimed');
    assertEq(env.enqueued[0].startTime, 5.7, 'capture-time start preserved');
  }
}

async function testDomGrowth() {
  section('DOM progressive growth');
  const env = createEnv({ withController: false });
  env.setDomText('Here in India,');
  await delay(80);
  env.setDomText('Here in India, the government is');
  await delay(80);
  env.setDomText('Here in India, the government is mulling a major tax cut.');
  await delay(600);
  assertEq(env.enqueued.length, 1, 'only the final stable text is dispatched');
  if (env.enqueued[0]) {
    assertEq(env.enqueued[0].text, 'Here in India, the government is mulling a major tax cut.', 'no intermediate fragments');
    assertEq(env.enqueued[0].startTime, 5.7, 'start time from first observation');
  }
}

async function testDomSlidingWindow() {
  section('DOM sliding-window caption');
  const env = createEnv({ withController: false });
  env.setDomText('Here in India, the government is mulling a major tax cut.');
  await delay(500);
  assertEq(env.enqueued.length, 1, 'first window dispatched');

  env.video.currentTime = 8.2;
  env.setDomText("a major tax cut. And don't get too excited.");
  await delay(500);
  assertEq(env.enqueued.length, 2, 'second window dispatched');
  if (env.enqueued[1]) {
    assertEq(env.enqueued[1].text, "And don't get too excited.", 'overlapping tail is not spoken twice');
    assertEq(env.enqueued[1].startTime, 8.2, 'second window uses its own capture time');
  }
}

function testRealDomSequence() {
  section('Captured YouTube DOM caption sequence');
  const env = createEnv({ withController: false, fakeClock: true });
  for (const step of REAL_DOM_SEQUENCE) {
    env.advance(step.t - env.getNow());
    env.video.currentTime = step.start;
    env.setDomText(step.text);
  }
  env.advance(600);

  const expected = [
    "Here in India, the government is mulling a major tax cut. And don't get too excited.",
    "It's not your income tax or GST.",
    "It's the tax on your stock market returns.",
    "Now, we don't have an official confirmation",
    'from the government yet,',
    'but there are reports and they say that discussions are underway. And if it goes ahead,',
    'if the government goes ahead with this, it could shake up the Indian markets.',
    "So, tonight we're looking at three questions.",
    'One, what is the proposal? Two,',
  ];
  assertEq(env.enqueued.length, expected.length, 'every passage dispatched exactly once');
  expected.forEach((text, i) => {
    assertEq(env.enqueued[i]?.text, text, `passage ${i + 1} contains only new speech`);
  });
}

async function testShortOverlapPreservesNewSpeech() {
  section('Short phrase overlap preserves new speech');
  const env = createEnv({ withController: false });
  env.setDomText('The government announced a tax cut.');
  await delay(500);
  assertEq(env.enqueued.length, 1, 'first caption dispatched');
  env.video.currentTime = 8.0;
  env.setDomText('A tax cut is likely.');
  await delay(500);
  assertEq(env.enqueued.length, 2, 'second caption dispatched');
  assertEq(
    env.enqueued[1]?.text,
    'A tax cut is likely.',
    'short reused phrase is not treated as a sliding window'
  );
}

async function testMiddlePhraseReusePreservesNewSpeech() {
  section('Middle-phrase reuse preserves new speech');
  const env = createEnv({ withController: false });
  env.setDomText('The government announced a major tax cut for the middle class.');
  await delay(500);
  assertEq(env.enqueued.length, 1, 'first caption dispatched');
  env.video.currentTime = 8.0;
  env.setDomText('A major tax cut.');
  await delay(500);
  assertEq(env.enqueued.length, 2, 'second caption dispatched');
  assertEq(env.enqueued[1]?.text, 'A major tax cut.', 'new caption reusing a middle phrase is spoken');
}

async function testDomDistinctCaptions() {
  section('DOM replacement captions');
  const env = createEnv({ withController: false });
  env.setDomText('First caption stays on screen for two seconds.');
  await delay(500);
  env.video.currentTime = 7.7;
  env.setDomText('Second caption after the first one.');
  await delay(500);
  assertEq(env.enqueued.length, 2, 'both distinct captions dispatched');
  assertEq(env.enqueued[1]?.text, 'Second caption after the first one.', 'second caption text intact');
}

async function testDomRerenderNoDuplicate() {
  section('DOM re-render dedup');
  const env = createEnv({ withController: false });
  const text = 'Same caption re-rendered by YouTube.';
  env.setDomText(text);
  await delay(500);
  assertEq(env.enqueued.length, 1, 'first dispatch');
  for (let i = 0; i < 5; i++) {
    env.setDomText(text);
    await delay(50);
  }
  env.setDomText('Same caption re-rendered by YouTube.\u200B');
  await delay(500);
  assertEq(env.enqueued.length, 1, 're-rendering the same text does not re-dispatch');
}

async function testDomCorrectionBeforeStability() {
  section('DOM correction before stability');
  const env = createEnv({ withController: false });
  env.setDomText('Here in India, the government is mulling a');
  await delay(120);
  env.setDomText('Here in India, the government is considering a major tax cut.');
  await delay(600);
  assertEq(env.enqueued.length, 1, 'only the corrected text is dispatched');
  assertEq(
    env.enqueued[0]?.text,
    'Here in India, the government is considering a major tax cut.',
    'no unstable pre-correction fragment is spoken'
  );
}

async function testPartialWordGrowth() {
  section('Partial-word growth after a dispatch');
  const env = createEnv({ withController: false });
  env.setDomText('W');
  await delay(450);
  assertEq(env.enqueued.length, 1, 'partial text dispatched after stability');
  env.setDomText('Welcome to Delhi');
  await delay(450);
  assertEq(env.enqueued.length, 2, 'grown text dispatched');
  assertEq(env.enqueued[1]?.text, 'Welcome to Delhi', 'trailing partial word re-attached for TTS');
}

async function testNonSpeechFiltering() {
  section('Non-speech caption filtering');
  const env = createEnv({ withController: false });
  env.setDomText('[Music]');
  await delay(500);
  assertEq(env.enqueued.length, 0, '[Music] is not spoken');

  env.setDomText('Hello [Music] world');
  await delay(500);
  assertEq(env.enqueued.length, 1, 'speech around an annotation is kept');
  assertEq(env.enqueued[0]?.text, 'Hello world', 'annotation stripped from spoken text');

  const env2 = createEnv({ withController: false });
  env2.setDomText('(upbeat music)');
  await delay(500);
  assertEq(env2.enqueued.length, 0, '(upbeat music) is not spoken');
}

async function testTextTrackStatic() {
  section('TextTrack static cue');
  const env = createEnv({ withController: false });
  const cue = { text: 'A complete caption that appears all at once.', startTime: 10, endTime: 13 };
  env.makeTrack(cue);
  env.triggerMutations();
  await delay(500);
  assertEq(env.enqueued.length, 1, 'static cue dispatched');
  if (env.enqueued[0]) {
    assertEq(env.enqueued[0].startTime, 10, 'native cue start preserved');
    assertEq(env.enqueued[0].endTime, 13, 'native cue end preserved');
    assertEq(env.enqueued[0].untimed, false, 'TextTrack caption is timed');
  }
}

async function testTextTrackGrowth() {
  section('TextTrack progressive growth');
  const env = createEnv({ withController: false });
  const cue = { text: 'W', startTime: 10, endTime: 13 };
  env.makeTrack(cue);
  env.triggerMutations();
  await delay(80);
  cue.text = 'Wel';
  env.triggerMutations();
  await delay(80);
  cue.text = 'Welcome to Delhi';
  env.triggerMutations();
  await delay(600);
  assertEq(env.enqueued.length, 1, 'only final cue text dispatched');
  assertEq(env.enqueued[0]?.text, 'Welcome to Delhi', 'final stable text');
}

async function testTextTrackCorrectionInvalidatesStaleAudio() {
  section('TextTrack correction discards stale queued audio');
  const env = createEnv({ withController: true });
  env.video.currentTime = 5.7; // before the cue, so the first segment stays queued
  const cue = { text: 'I went to Delhi', startTime: 10, endTime: 13 };
  env.makeTrack(cue);
  env.triggerMutations();
  await delay(600);
  assertEq(env.enqueued.length, 1, 'original cue dispatched');
  const oldSeg = env.controller.scheduler.segments.find((s) => s.caption.text === 'I went to Delhi');
  assert(!!oldSeg, 'original segment created');

  cue.text = 'I went to Mumbai';
  env.triggerMutations();
  await delay(600);
  assertEq(env.enqueued.length, 2, 'corrected cue dispatched');
  assertEq(oldSeg?.state, 'discarded', 'stale original segment discarded');
  const newSeg = env.controller.scheduler.segments.find((s) => s.caption.text === 'I went to Mumbai');
  assert(!!newSeg, 'corrected segment created');
  assert(newSeg?.state === 'ready' || newSeg?.state === 'playing', 'corrected segment retained');
  env.controller.scheduler.stopTickMonitor();
}

async function testFullPipeline() {
  section('Full pipeline: caption → translate → TTS → scheduler → play');
  const env = createEnv({ withController: true });
  env.video.currentTime = 5.7;
  env.setDomText('Full pipeline caption.');
  await delay(900);

  assertEq(env.enqueued.length, 1, 'caption enqueued');
  assertEq(env.controller.scheduler.segments.length, 1, 'scheduler segment created');
  assertEq(env.played.length, 1, 'audio.play() called');
  const seg = env.controller.scheduler.segments[0];
  if (seg) {
    assertEq(seg.caption.text, 'Full pipeline caption.', 'segment carries caption text');
    assertEq(seg.targetStart, 5.7, 'DOM segment scheduled from capture time, not TTS completion time');
    assertEq(seg.state, 'playing', 'segment is playing');
  }
}

async function testSchedulerDedupWhilePlaying() {
  section('Scheduler: duplicate suppressed, new speech preserved');
  const env = createEnv({ withController: true });
  const sched = env.controller.scheduler;
  sched.setVideo(env.video);
  env.video.currentTime = 10;
  const audio = Buffer.from('RIFF').toString('base64');

  sched.addSegment(
    { id: 'seg-a', text: 'Hello world this is a test', startTime: 10, endTime: 13, untimed: true },
    audio
  );
  sched.tick();
  assertEq(sched.segments[0]?.state, 'playing', 'first segment playing');
  const before = sched.segments.length;

  sched.addSegment(
    { id: 'seg-dup', text: 'Hello world this is a test', startTime: 10.2, endTime: 13.2, untimed: true },
    audio
  );
  assertEq(sched.segments.length, before, 'identical overlapping segment not added while playing');

  sched.addSegment(
    { id: 'seg-new', text: "And don't get too excited.", startTime: 10.5, endTime: 13.5, untimed: true },
    audio
  );
  assertEq(sched.segments.length, before + 1, 'new sliding-window speech added while playing');
  assertEq(sched.segments[before]?.caption.text, "And don't get too excited.", 'new speech preserved');

  env.video.currentTime = 25;
  const fallback = sched._makeSegment(
    { text: 'No capture time', startTime: null, endTime: null, untimed: true, duration: null },
    audio
  );
  assertEq(fallback.targetStart, 25, 'missing capture time falls back to video.currentTime');
  assertEq(fallback.targetEnd, 28, 'fallback uses default duration');
}

async function testNavigationResetsState() {
  section('Navigation resets caption state');
  const env = createEnv({ withController: false });
  env.setDomText('Before navigation.');
  await delay(500);
  assertEq(env.enqueued.length, 1, 'caption before navigation dispatched');

  env.sandbox.document.dispatch('yt-navigate-finish');
  env.setDomText('After navigation.');
  await delay(500);
  assertEq(env.enqueued.length, 2, 'caption after navigation dispatched');
  assertEq(env.enqueued[1]?.text, 'After navigation.', 'new page caption text');
}

async function testSeekResetsPending() {
  section('Seek discards pending caption state');
  const env = createEnv({ withController: true });
  env.setDomText('Caption before the user seeks.');
  env.video.currentTime = 20;
  env.video.dispatch('seeked');
  await delay(600);
  assertEq(env.enqueued.length, 0, 'pending caption is discarded on a real seek');
  assertEq(env.controller.scheduler.segments.length, 0, 'scheduler cleared on seek');
}

async function run() {
  await testDomStatic();
  await testDomGrowth();
  await testDomSlidingWindow();
  await testRealDomSequence();
  await testShortOverlapPreservesNewSpeech();
  await testMiddlePhraseReusePreservesNewSpeech();
  await testDomDistinctCaptions();
  await testDomRerenderNoDuplicate();
  await testDomCorrectionBeforeStability();
  await testPartialWordGrowth();
  await testNonSpeechFiltering();
  await testTextTrackStatic();
  await testTextTrackGrowth();
  await testTextTrackCorrectionInvalidatesStaleAudio();
  await testFullPipeline();
  await testSchedulerDedupWhilePlaying();
  await testNavigationResetsState();
  await testSeekResetsPending();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`CAPTION PIPELINE: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
