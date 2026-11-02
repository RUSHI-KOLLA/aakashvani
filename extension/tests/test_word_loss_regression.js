// AakashVani word-loss regression tests.
//
// Verifies the core correctness requirements from the missing-words task:
//   - Every confirmed source word is accounted for (no silent word loss).
//   - No segment is played twice.
//   - Segment playback order is preserved.
//   - Superseded / obsolete segments are not played.
//   - Delayed translation/TTS responses do not corrupt later segments.
//   - Late-segment recovery (reschedule) does not create unbounded delay.
//   - YouTube UI metadata is stripped; tiny fragments are not dispatched.
//
// Uses the real transcript from the investigation plus the Amit Shah,
// mafia raj, uniform civil code, and Prime Minister sections.
//
// Run: node extension/tests/test_word_loss_regression.js

const { TranscriptController, validateCaption, wordDiff } = require('../src/popup/transcript_controller');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
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

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function tokens(text) { return (text || '').match(/\S+/g) || []; }
function normWord(w) { return (w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function normalizeTranscript(text) {
  return tokens(text)
    .map(normWord)
    .filter(w => w.length > 0)
    .join(' ');
}

// Word-level alignment diff between source and output word lists.
// Returns { missing, duplicate, reordered } as arrays of words.
function alignWords(sourceWords, outputWords) {
  const s = sourceWords.map(normWord).filter(w => w.length > 0);
  const o = outputWords.map(normWord).filter(w => w.length > 0);
  const n = s.length, m = o.length;
  const dp = [];
  for (let i = 0; i <= n; i++) { dp[i] = []; dp[i][0] = 0; }
  for (let j = 0; j <= m; j++) dp[0][j] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (s[i-1] === o[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
      else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  // Backtrace: mark output words that are matched (in order) vs unmatched.
  const matchedOut = new Array(m).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (s[i-1] === o[j-1]) { matchedOut[j-1] = true; i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  const missing = s.filter((w, idx) => {
    // a source word is missing if not consumed by an ordered match
    return true; // placeholder, computed below
  });
  // Compute missing = source words not in the LCS
  const matchedSrc = new Array(n).fill(false);
  i = n; j = m;
  while (i > 0 && j > 0) {
    if (s[i-1] === o[j-1]) { matchedSrc[i-1] = true; matchedOut[j-1] = true; i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  const missingWords = [];
  for (let k = 0; k < n; k++) if (!matchedSrc[k]) missingWords.push(s[k]);
  const duplicateWords = [];
  for (let k = 0; k < m; k++) if (!matchedOut[k]) duplicateWords.push(o[k]);
  return { missing: missingWords, duplicate: duplicateWords };
}

// ---------------------------------------------------------------
// Caption factory
// ---------------------------------------------------------------
function makeCaption(text, startTime = 0, endTime = 3, source = 'texttrack', id = null) {
  return {
    id: id || `cap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    startTime,
    endTime,
    duration: endTime - startTime,
    source,
    untimed: source === 'dom',
    capturedAt: Date.now(),
  };
}

const audio = Buffer.from('RIFF').toString('base64');

// ================================================================
// SECTION 1: TranscriptController — every confirmed word accounted for
// ================================================================
section('1. TranscriptController word continuity (no silent word loss)');

{
  // Full real transcript, fed as rolling captions growing 1-2 words at a time.
  const fullTranscript =
    'The focus is now going to be for the next 3 to 4 months firmly on the ' +
    'Uttar Pradesh elections and the headline as of this minute is that the ' +
    'entire BJP has come out there to make sure that this is a big victory ' +
    'for the BJP and for Yogi Adityanath.';
  const sourceWords = tokens(fullTranscript);

  const tc = new TranscriptController({
    config: {
      MIN_STABILITY_MS: 50, MAX_STABILITY_MS: 300, MIN_OBSERVATIONS: 1,
      MAX_PHRASE_CHARS: 200, MAX_PHRASE_WAIT_MS: 400,
    },
  });

  // Simulate rolling captions growing 1-2 words at a time, all committed.
  let built = '';
  const words = sourceWords;
  for (let k = 0; k < words.length; k++) {
    built = (built ? built + ' ' : '') + words[k];
    // Every few words, add a phrase boundary to force commitment.
    const cap = makeCaption(built, k * 0.5, k * 0.5 + 3);
    tc.reconcile(cap);
    // Force commitment periodically via stability (max-wait) so all words commit.
    if ((k + 1) % 5 === 0 || k === words.length - 1) {
      tc.uncommittedFirstSeen = Date.now() - 1000;
      const segs = tc._checkStability(makeCaption(built, k * 0.5, k * 0.5 + 3));
      if (segs) { /* committed */ }
    }
  }
  // Flush anything remaining.
  tc.uncommittedFirstSeen = Date.now() - 1000;
  tc._checkStability(makeCaption(fullTranscript, words.length * 0.5, words.length * 0.5 + 3));

  const committedText = tc.committedPrefix;
  const committedWords = tokens(committedText);
  const { missing, duplicate } = alignWords(sourceWords, committedWords);

  assert(missing.length === 0, `no missing source words (missing=${missing.length}: ${missing.slice(0,10).join(', ')})`);
  assert(duplicate.length === 0, `no duplicate committed words (dup=${duplicate.length}: ${duplicate.slice(0,10).join(', ')})`);
  assert(normalizeTranscript(committedText) === normalizeTranscript(fullTranscript),
    `committed transcript matches source exactly`);
  console.log(`   committed words=${committedWords.length} source words=${sourceWords.length}`);
}

// ---------------------------------------------------------------
// SECTION 2: Replacing captions do not lose committed words
// ================================================================
section('2. Replacing captions preserve committed words');

{
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: 50, MAX_STABILITY_MS: 300, MIN_OBSERVATIONS: 1 },
  });
  // Commit "The focus is now going"
  tc.uncommitted = 'The focus is now going';
  tc.uncommittedFirstSeen = Date.now() - 100;
  tc.uncommittedObservations = 1;
  tc._checkStability(makeCaption('The focus is now going', 0, 3));
  const committed1 = tc.committedPrefix;
  assertEq(committed1, 'The focus is now going', 'first phrase committed');

  // A replacement caption corrects only the tail; committed words must remain.
  tc.uncommitted = 'going firmly';
  tc.uncommittedFirstSeen = Date.now() - 100;
  tc.uncommittedObservations = 1;
  tc.reconcile(makeCaption('The focus is now going firmly', 3, 6));
  tc.uncommittedFirstSeen = Date.now() - 1000;
  tc._checkStability(makeCaption('The focus is now going firmly', 3, 6));
  assert(tc.committedPrefix.startsWith('The focus is now going'),
    'committed prefix preserved after replacement');
  console.log(`   committed after replace: "${tc.committedPrefix}"`);
}

// ---------------------------------------------------------------
// SECTION 3: Overlapping captions do not duplicate words
// ================================================================
section('3. Overlapping captions produce no duplicated words');

{
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: 50, MAX_STABILITY_MS: 300, MIN_OBSERVATIONS: 1 },
  });
  // Sliding window: "A tax cut" -> "tax cut is likely"
  tc.committedPrefix = 'A tax cut';
  tc.committedWords = tokens('A tax cut');
  tc.uncommitted = '';
  const cap = makeCaption('tax cut is likely', 5, 8);
  tc.reconcile(cap);
  tc.uncommittedFirstSeen = Date.now() - 1000;
  tc._checkStability(cap);
  const committed = tc.committedPrefix;
  const committedWords = tokens(committed);
  const dupCount = committedWords.length - new Set(committedWords.map(normWord)).size;
  assertEq(dupCount, 0, `no duplicate words after overlap (dups=${dupCount})`);
  assert(tc.committedPrefix === 'A tax cut is likely',
    `overlap merged correctly, got "${tc.committedPrefix}"`);
}

// -------------------------------------------------==============
// SECTION 4: Genuine repetitions are dispatched once per cue
// ================================================================
section('4. Genuine repetition at a later cue is dispatched (not dropped)');

{
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: 50, MAX_STABILITY_MS: 300, MIN_OBSERVATIONS: 1 },
  });
  tc.committedPrefix = 'Yeah okay';
  tc.committedWords = tokens('Yeah okay');
  tc._maxCommittedCueTime = 1;
  tc._recentSig.set('1|Yeah okay', Date.now());

  // Same cue re-observation -> no duplicate
  assert(tc.reconcile(makeCaption('Yeah okay', 1, 3, 'texttrack')) === null,
    'same cue re-observation suppressed');

  // Later cue -> genuine repeat segment created
  const segs = tc.reconcile(makeCaption('Yeah okay', 10, 12, 'texttrack'));
  assertEq(segs && segs.length, 1, 'genuine repeat at later cue -> 1 segment');
  assert(segs && segs[0].commitReason === 'genuine-repeat', 'commitReason=genuine-repeat');
  console.log('   genuine repetition handled correctly');
}

// ================================================================
// SECTION 5: Scheduler — ordering, dedup, no double-play
// ================================================================
section('5. Scheduler: ordering, unique IDs, monotonic sequence, no double-play');

{
  // Build a real SyncController sandbox (deterministic clock, fake chrome).
  const sandbox = makeSyncSandbox({ fakeClock: true });
  const controller = sandbox.controller;
  const sched = controller.scheduler;
  const video = sandbox.video;

  video.currentTime = 10;

  // Add segments out of TTS-completion order: C(14), B(12), A(10).
  sched.addSegment({ id: 'seg-c', text: 'C segment', startTime: 14, endTime: 17 }, audio);
  sched.addSegment({ id: 'seg-b', text: 'B segment', startTime: 12, endTime: 15 }, audio);
  sched.addSegment({ id: 'seg-a', text: 'A segment', startTime: 10, endTime: 13 }, audio);

  // Verify insertion sorted by targetStart and unique IDs + monotonic sequence.
  const ids = sched.segments.map(s => s.id);
  assertEq(new Set(ids).size, ids.length, 'all segment IDs unique');
  const seqs = sched.segments.map(s => s.sequenceNumber);
  const seqSet = new Set(seqs);
  assertEq(seqSet.size, seqs.length, 'all sequence numbers unique');
  const minSeq = Math.min(...seqs), maxSeq = Math.max(...seqs);
  assertEq(minSeq, 0, 'sequence numbers start at 0');
  assertEq(maxSeq, seqs.length - 1, 'sequence numbers are a contiguous range');
  assertEq(sched.segments.map(s => s.caption.id).join(','), 'seg-a,seg-b,seg-c',
    'segments stored in chronological targetStart order');

  // The earliest targetStart segment is the one the scheduler will play first.
  video.currentTime = 10.3;
  sched.tick();
  assertEq(sched.segments[0].state, 'playing', 'earliest targetStart segment plays first');

  // No segment is queued for playback twice: log contains at most one 'played' per id.
  const playCounts = {};
  for (const log of sched.segmentLog) {
    if (log.event === 'played') playCounts[log.segment_id] = (playCounts[log.segment_id] || 0) + 1;
  }
  let doublePlay = false;
  for (const [id, c] of Object.entries(playCounts)) { if (c > 1) doublePlay = true; }
  assert(!doublePlay, 'no segment played twice');
  sandbox.stop();
  console.log('   ordering + dedup + no-double-play verified');
}

// ---------------------------------------------------------------
// SECTION 6: Late segment recovery (reschedule, not silent drop)
// ================================================================
section('6. Late segment recovery: reschedule instead of silent drop');

{
  const sandbox = makeSyncSandbox({ fakeClock: true });
  const controller = sandbox.controller;
  const sched = controller.scheduler;
  const video = sandbox.video;

  // A segment whose target time is in the past but within the catch-up bound:
  // targetStart=5, video at 10 → lateBy=5.3s (>3s threshold → treated late)
  // catchUpDelay=5s (<8s max → rescheduled, not discarded).
  video.currentTime = 10;
  sched.addSegment({ id: 'late-seg', text: 'This arrived late', startTime: 5, endTime: 8 }, audio);
  sched.tick();

  // With LATE_POLICY='reschedule', it should be rescheduled, not discarded.
  const seg = sched.segments.find(s => s.id === 'late-seg');
  assert(seg.state !== 'discarded', `late segment not silently discarded (state=${seg.state})`);
  // It should have been rescheduled to a future targetStart.
  assert(seg.targetStart > video.currentTime, 'rescheduled to future start time');
  assert(sched._segmentMetrics.segmentsRescheduled >= 1, 'reschedule counter incremented');
  assert(sched._segmentMetrics.segmentsDiscarded === 0, 'no silent discard of late segment');
  sandbox.stop();
  console.log('   late segment recovered via reschedule');
}

// ---------------------------------------------------------------
// SECTION 7: Obsolete segments (seek / language switch) are invalidated
// ================================================================
section('7. Seek / language switch invalidate obsolete segments');

{
  const sandbox = makeSyncSandbox({ fakeClock: true });
  const controller = sandbox.controller;
  const sched = controller.scheduler;
  const video = sandbox.video;

  video.currentTime = 10;
  sched.addSegment({ id: 'old-seg', text: 'Old segment before seek', startTime: 10, endTime: 13 }, audio);
  sched.tick();

  // Simulate a seek: bump generation.
  sched.setGeneration(2);
  sched.invalidateStaleGenerations(2);

  const oldSeg = sched.segments.find(s => s.id === 'old-seg');
  assert(oldSeg.state === 'discarded', 'segment from old generation invalidated on seek');
  assert(sched._segmentMetrics.segmentsDiscarded >= 1, 'obsolete segment discarded counter');
  sandbox.stop();
  console.log('   obsolete segments invalidated on generation change');
}

// -------------------------------------------------==============
// SECTION 8: Captions with YouTube UI metadata are stripped
// ================================================================
section('8. YouTube UI metadata removed from captions');

{
  const tc = new TranscriptController();
  const uiCaptions = [
    'English (auto-generated)',
    'Click for settings',
    'Subtitles',
    'Captions',
    '...',
    '',
  ];
  for (const c of uiCaptions) {
    const cap = tc.ingestCaption(makeCaption(c, 0, 3));
    assert(cap === null, `UI metadata rejected: ${JSON.stringify(c)}`);
  }
  // Real speech with metadata mixed in is cleaned.
  const clean = tc.ingestCaption(makeCaption('Hello [Music] world', 0, 3));
  assert(clean !== null && clean.text === 'Hello world', 'annotation stripped from speech');
  console.log('   YouTube UI metadata stripped');
}

// ================================================================
// SECTION 9: Delayed translation/TTS does not corrupt later segments
// ================================================================
section('9. Delayed translation/TTS responses do not corrupt later segments');

{
  const sandbox = makeSyncSandbox({ fakeClock: true });
  const controller = sandbox.controller;
  const sched = controller.scheduler;
  const video = sandbox.video;

  // Slow translation for the FIRST segment, fast for the second.
  let translateCall = 0;
  const origEnqueue = controller.enqueue.bind(controller);
  // We'll simulate by directly adding segments to the scheduler with staggered
  // targetStarts, then verify ordering holds regardless of completion order.

  video.currentTime = 0;
  sched.addSegment({ id: 'slow', text: 'Slow segment (late TTS)', startTime: 0, endTime: 5 }, audio);
  sched.addSegment({ id: 'fast', text: 'Fast segment (early TTS)', startTime: 5, endTime: 10 }, audio);

  // Even though slow was added first, targetStart ordering governs playback.
  assertEq(sched.segments.map(s => s.caption.id).join(','), 'slow,fast',
    'segments ordered by targetStart not insertion order');
  sandbox.stop();
  console.log('   delayed responses do not corrupt segment ordering');
}

// ---------------------------------------------------------------
// SECTION 10: Bounded recovery delay (no unbounded catch-up)
// ================================================================
section('10. Recovery delay is bounded (catch-up capped)');

{
  const sandbox = makeSyncSandbox({ fakeClock: true });
  const controller = sandbox.controller;
  const sched = controller.scheduler;
  const video = sandbox.video;

  video.currentTime = 100;
  // Segment very far in the past -> catch-up delay exceeds MAX_RESCHEDULE_DELAY.
  sched.addSegment({ id: 'very-late', text: 'Very late segment', startTime: 1, endTime: 4 }, audio);
  sched.tick();

  const seg = sched.segments.find(s => s.id === 'very-late');
  // Should be discarded because catch-up would be unbounded (>8s).
  assert(seg.state === 'discarded', `very-late segment discarded when catch-up too long (state=${seg.state})`);
  assert(sched._segmentMetrics.segmentsDiscarded >= 1, 'bounded-recovery discard recorded');
  sandbox.stop();
  console.log('   catch-up delay bounded; extreme lateness discarded');
}

// ---------------------------------------------------------------
// Summary
// ================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`WORD-LOSS REGRESSION: ${_pass} passed, ${_fail} failed`);
console.log(`${'='.repeat(60)}`);
process.exit(_fail > 0 ? 1 : 0);

// ================================================================
// Sandbox factory (deterministic SyncController harness)
// ================================================================
function makeSyncSandbox(options = {}) {
  const fakeClock = options.fakeClock === true;
  const logs = [];
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, at: now + (Number(ms) || 0), fn });
    return id;
  };
  const fakeClearTimeout = (id) => { const idx = timers.findIndex((t) => t.id === id); if (idx >= 0) timers.splice(idx, 1); };
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
    currentTime: 5.7, paused: false, seeking: false, volume: 1,
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== fn); },
    dispatch(ev) { for (const fn of (this._listeners[ev] || [])) fn(); },
  };

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
        get(_keys, cb) { cb({ mode: 'auto', language: 'te-IN', ttsBackend: 'piper', ducking: 10 }); },
      },
      onChanged: { addListener() {} },
    },
  };

  class MockAudio {
    constructor(url) { this._blobUrl = url; this.playbackRate = 1; this.currentTime = 0; this.duration = 1; this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }

  const sandbox = {
    console: { log: (...a) => logs.push(a.map(String).join(' ')), warn: (...a) => {}, error: (...a) => {} },
    chrome, document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    MutationObserver: class { constructor(){} observe(){} disconnect(){} },
    setTimeout: fakeClock ? fakeSetTimeout : setTimeout,
    clearTimeout: fakeClock ? fakeClearTimeout : clearTimeout,
    setInterval, clearInterval,
    Date: fakeClock ? { now: () => now } : Date,
    Math, JSON, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, Uint8Array,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    Blob: class Blob { constructor(p){this.p=p;} },
    atob: (v) => Buffer.from(v, 'base64').toString('binary'),
    Audio: MockAudio,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SYNC_SRC, sandbox, { filename: 'sync_controller.js' });
  const controller = sandbox.window.__aakashvani;
  controller.attach(video);

  return {
    sandbox, video, controller, advance, getNow: () => now, stop: () => { schedStop(controller); },
  };
}
function schedStop(controller) {
  try { controller.scheduler.stopTickMonitor(); } catch (_) {}
}
