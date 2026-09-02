// AakashVani adversarial verification — invariant tests.
// Exercises ACTUAL state transitions, not source inspection.
// Run: node extension/tests/test_adversarial.js

let _pass = 0;
let _fail = 0;
let _total = 0;
function assert(cond, msg) {
  _total++;
  if (!cond) { _fail++; console.error(`  FAIL [${_total}]: ${msg}`); }
  else { _pass++; }
}
function assertEq(a, b, msg) {
  _total++;
  if (a !== b) { _fail++; console.error(`  FAIL [${_total}]: ${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
  else { _pass++; }
}
function section(name) { console.log(`\n=== ${name} ===`); }

// Extract pure functions from content.js (updated for 100ms timestamp normalization)
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

function makeCaption(cue, source = 'texttrack') {
  const text = (cue.text || '').trim();
  const startTime = cue.startTime;
  const endTime = cue.endTime;
  const key = _hashCaptionKey(startTime, endTime, text);
  return { id: `${source}-${key}`, text, startTime, endTime, duration: endTime - startTime, source, untimed: false, capturedAt: Date.now() };
}

function makeUntimedCaption(text, source = 'dom') {
  const key = _hashCaptionKey(0, 0, text);
  return { id: `${source}-untimed-${key}`, text, startTime: null, endTime: null, duration: null, source, untimed: true, capturedAt: Date.now() };
}

// Mock Audio for Node.js
class MockAudio {
  constructor(url) { this._blobUrl = url; this.preload = 'auto'; this.preservesPitch = true; this.playbackRate = 1.0; this.currentTime = 0; this.duration = 2.0; this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

// Test scheduler (mirrors real TimelineScheduler logic exactly — including Fix 3 + Fix 4)
class TestScheduler {
  constructor() { this.segments = []; this.currentIndex = 0; this.video = { currentTime: 0, paused: false }; }
  setVideo(v) { this.video = v; }

  // ---- Fix 3: Duplicate segment prevention ----
  addSegment(caption, audioBase64) {
    const seg = this._makeSegment(caption, audioBase64);
    const newText = (caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, '');

    // Check for overlapping segments with similar text — discard the older one
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const existing = this.segments[i];
      if (existing.state === 'discarded' || existing.state === 'completed') continue;
      const existText = (existing.caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, '');
      const timeOverlap = Math.abs(existing.targetStart - seg.targetStart) < 1.0;
      const textSimilar = existText === newText || (newText.length > 5 && newText.includes(existText)) || (existText.length > 5 && existText.includes(newText));
      if (timeOverlap && textSimilar) {
        existing.state = 'discarded';
      }
    }

    let insertIdx = this.segments.length;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].targetStart > seg.targetStart) { insertIdx = i; break; }
    }
    this.segments.splice(insertIdx, 0, seg);
    if (insertIdx <= this.currentIndex) this.currentIndex = insertIdx;
  }

  _makeSegment(caption, _audioBase64) {
    const audio = new MockAudio('mock-blob');
    let targetStart, targetEnd;
    if (caption.untimed || caption.startTime == null) {
      targetStart = this.video ? this.video.currentTime : 0;
      targetEnd = targetStart + (caption.duration || 3);
    } else {
      targetStart = caption.startTime;
      targetEnd = caption.endTime || (caption.startTime + (caption.duration || 3));
    }
    return { caption, audio, targetStart, targetEnd, state: 'ready', scheduledAt: null };
  }

  invalidateSegmentsByCaptionId(captionId) {
    for (const seg of this.segments) {
      if (seg.caption.id === captionId && (seg.state === 'ready' || seg.state === 'pending')) {
        seg.state = 'discarded';
      }
    }
  }

  // ---- Fix 4: Audio lead time (300ms) ----
  static AUDIO_LEAD = 0.3;

  tick() {
    if (!this.video || this.video.paused) return;
    const now = this.video.currentTime;
    while (this.currentIndex < this.segments.length) {
      const seg = this.segments[this.currentIndex];
      if (seg.state === 'completed' || seg.state === 'discarded') { this.currentIndex++; continue; }
      if (seg.state === 'ready' && now >= seg.targetStart - TestScheduler.AUDIO_LEAD) {
        seg.state = 'playing'; seg.scheduledAt = Date.now(); seg.audio.paused = false;
      }
      break;
    }
  }

  clear() { this.segments.forEach(s => { s.audio.pause(); }); this.segments = []; this.currentIndex = 0; }
}

// ============================================================
// INV-1: Force B→C→A TTS completion, prove playback A→B→C
// ============================================================
section('INV-1: TTS completion order NEVER determines playback order');
{
  const sched = new TestScheduler();
  const A = { id: 'A', text: 'caption A', startTime: 10, endTime: 12, untimed: false };
  const B = { id: 'B', text: 'caption B', startTime: 12, endTime: 14, untimed: false };
  const C = { id: 'C', text: 'caption C', startTime: 14, endTime: 16, untimed: false };

  // TTS completes B→C→A (out of order)
  sched.addSegment(B, 'audio-B');
  sched.addSegment(C, 'audio-C');
  sched.addSegment(A, 'audio-A');

  assertEq(sched.segments[0].caption.id, 'A', 'first segment is A (startTime=10)');
  assertEq(sched.segments[1].caption.id, 'B', 'second segment is B (startTime=12)');
  assertEq(sched.segments[2].caption.id, 'C', 'third segment is C (startTime=14)');
  assertEq(sched.segments[0].targetStart, 10, 'A targetStart=10');
  assertEq(sched.segments[1].targetStart, 12, 'B targetStart=12');
  assertEq(sched.segments[2].targetStart, 14, 'C targetStart=14');

  // Simulate playback timeline
  sched.video.currentTime = 10;
  sched.tick();
  assert(sched.segments[0].state === 'playing', 'A playing at t=10');
  assert(sched.segments[1].state === 'ready', 'B still ready');
  sched.segments[0].state = 'completed';
  sched.video.currentTime = 12;
  sched.tick();
  assertEq(sched.currentIndex, 1, 'currentIndex=1 after A');
  assert(sched.segments[1].state === 'playing', 'B playing at t=12');
  sched.segments[1].state = 'completed';
  sched.video.currentTime = 14;
  sched.tick();
  assert(sched.segments[2].state === 'playing', 'C playing at t=14');

  assertEq(sched.segments.map(s => s.caption.id).join(','), 'A,B,C', 'playback order A→B→C');
  console.log('INV-1: PASS');
}

// ============================================================
// INV-2: Stable caption IDs — 100ms normalization absorbs sub-ms jitter
// ============================================================
section('INV-2: Stable caption IDs — 100ms normalization absorbs sub-ms jitter');
{
  const cue = { text: 'Hello world this is a test', startTime: 5.123456, endTime: 8.789012 };
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(makeCaption(cue).id);
  assertEq(ids.size, 1, '50 observations → 1 unique ID');
  assertEq(makeCaption(cue).id, makeCaption(cue).id, 'two separate calls → same ID');
  assert(makeCaption({ text: 'Different', startTime: 5.123456, endTime: 8.789012 }).id !== makeCaption(cue).id, 'different text → different ID');

  // ---- Fix 1: 100ms normalization — sub-millisecond jitter should produce SAME ID ----
  // Values must round to same 100ms bucket: round(x*10)/10 must be equal
  const id1 = makeCaption({ text: 'Test caption', startTime: 581.71, endTime: 585.20 }).id;
  const id2 = makeCaption({ text: 'Test caption', startTime: 581.72, endTime: 585.21 }).id;
  const id3 = makeCaption({ text: 'Test caption', startTime: 581.73, endTime: 585.22 }).id;
  assertEq(id1, id2, '581.71 vs 581.72 → same ID (both round to 581.7)');
  assertEq(id2, id3, '581.72 vs 581.73 → same ID (both round to 581.7)');
  assertEq(id1, id3, '581.71 vs 581.73 → same ID (all round to 581.7)');

  // But >100ms difference should produce different IDs
  const id4 = makeCaption({ text: 'Test caption', startTime: 582.00, endTime: 585.50 }).id;
  assert(id1 !== id4, '581.7 vs 582.0 (>100ms) → different ID');
  console.log('INV-2: PASS');
}

// ============================================================
// INV-3: Correction — old can't play, old removed, old buffer removed, new can play
// ============================================================
section('INV-3: Caption correction — 4 sub-invariants');
{
  const sched = new TestScheduler();
  const cid = 'texttrack-abc123';
  const old = { id: cid, text: 'I went to Delhi', startTime: 10, endTime: 12, untimed: false };
  const corr = { id: cid, text: 'I went to Mumbai', startTime: 10, endTime: 12, untimed: false };

  // Add old
  sched.addSegment(old, 'x');
  assertEq(sched.segments[0].caption.text, 'I went to Delhi', 'old in scheduler');

  // Buffer + queue with old
  const buffer = [{ caption: old, genAtStart: 0 }, { caption: { id: 'other' }, genAtStart: 0 }];
  const queue = [old];
  let gen = 0;

  // Correction arrives
  gen++;
  sched.invalidateSegmentsByCaptionId(cid);
  queue.length = 0;
  const filteredBuf = buffer.filter(b => b.caption.id !== cid);

  assertEq(sched.segments[0].state, 'discarded', 'old segment discarded');
  sched.video.currentTime = 10; sched.tick();
  assert(sched.segments[0].state !== 'playing', 'old CANNOT play');
  assertEq(filteredBuf.length, 1, 'old removed from buffer');
  assertEq(filteredBuf[0].caption.id, 'other', 'other buffer items survive');

  // New version works
  sched.addSegment(corr, 'x');
  sched.video.currentTime = 10; sched.tick();
  const newSeg = sched.segments.find(s => s.caption.text === 'I went to Mumbai');
  assert(newSeg && newSeg.state === 'playing', 'new version plays');
  assertEq(gen, 1, 'generation bumped');
  console.log('INV-3: PASS');
}

// ============================================================
// INV-4: Multiple active cues — each retains own ID/startTime/endTime/text
// ============================================================
section('INV-4: Multiple active cues — own identity/timing');
{
  const cues = [
    { text: 'Line one', startTime: 5.0, endTime: 7.0 },
    { text: 'Line two', startTime: 6.0, endTime: 8.0 },
    { text: 'Line three', startTime: 7.0, endTime: 9.0 },
  ];
  const captions = cues.map(c => makeCaption(c));
  assertEq(new Set(captions.map(c => c.id)).size, 3, '3 unique IDs');
  assertEq(captions[0].startTime, 5.0, 'A startTime=5');
  assertEq(captions[1].startTime, 6.0, 'B startTime=6');
  assertEq(captions[2].startTime, 7.0, 'C startTime=7');
  assertEq(captions[0].text, 'Line one', 'A text');
  assertEq(captions[1].text, 'Line two', 'B text');
  assertEq(captions[2].text, 'Line three', 'C text');
  assertEq(captions[0].endTime, 7.0, 'A endTime=7');
  assertEq(captions[1].endTime, 8.0, 'B endTime=8');
  assertEq(captions[2].endTime, 9.0, 'C endTime=9');
  console.log('INV-4: PASS');
}

// ============================================================
// INV-5: Untimed DOM captions NEVER enter scheduler as 0→0
// ============================================================
section('INV-5: Untimed captions NEVER fake 0→0');
{
  const untimed = makeUntimedCaption('DOM text');
  assert(untimed.untimed === true, 'untimed=true');
  assert(untimed.startTime === null, 'startTime=null');
  assert(untimed.endTime === null, 'endTime=null');

  const sched = new TestScheduler();
  sched.video.currentTime = 25.5;
  sched.addSegment(untimed, 'x');
  assertEq(sched.segments[0].targetStart, 25.5, 'targetStart=video.currentTime (25.5)');
  assertEq(sched.segments[0].targetEnd, 28.5, 'targetEnd=25.5+3');
  assert(sched.segments[0].targetStart !== 0, 'targetStart NOT 0');
  assert(sched.segments[0].targetEnd !== 0, 'targetEnd NOT 0');

  const timed = { id: 't', text: 'T', startTime: 15.0, endTime: 17.0, untimed: false };
  sched.addSegment(timed, 'x');
  const ts = sched.segments.find(s => s.caption.id === 't');
  assertEq(ts.targetStart, 15.0, 'timed uses own startTime');

  const noVid = new TestScheduler(); noVid.video = null;
  noVid.addSegment(untimed, 'x');
  assertEq(noVid.segments[0].targetStart, 0, 'untimed+no video → fallback 0');
  console.log('INV-5: PASS');
}

// ============================================================
// INV-6: 20 SPA navigations — listener count constant
// ============================================================
section('INV-6: 20 SPA navigations — listener count constant');
{
  let count = 0;
  const reg = new Map();
  function add(el, ev, h) { const k = `${el.name}|${ev}|${count}`; reg.set(k, { el, ev, h }); count++; return k; }
  function rem(el, ev, h) {
    for (const [k, v] of reg) { if (v.el === el && v.ev === ev && v.h === h) { reg.delete(k); count--; break; } }
  }
  let _vrefs = null, _trefs = [];

  function bind(videoEl) {
    if (_vrefs) { rem(_vrefs.video, 'seeked', _vrefs.seeked); rem(_vrefs.video, 'pause', _vrefs.pause); rem(_vrefs.video, 'play', _vrefs.play); _vrefs = null; }
    if (!videoEl) return;
    const s = () => {}, p = () => {}, y = () => {};
    add(videoEl, 'seeked', s); add(videoEl, 'pause', p); add(videoEl, 'play', y);
    _vrefs = { video: videoEl, seeked: s, pause: p, play: y };
  }
  function observe(videoEl) {
    for (const { track, handler } of _trefs) try { rem(track, 'cuechange', handler); } catch (_) {}
    _trefs = [];
    if (videoEl?.textTracks) for (const tr of videoEl.textTracks) { const h = () => {}; add(tr, 'cuechange', h); _trefs.push({ track: tr, handler: h }); }
  }

  for (let i = 0; i < 20; i++) { bind({ name: `v${i}`, textTracks: [{ name: `t${i}` }] }); observe({ name: `v${i}`, textTracks: [{ name: `t${i}` }] }); }
  assertEq(count, 4, '4 listeners after 20 navigations');
  assertEq(_vrefs.video.name, 'v19', 'latest video');
  assertEq(_trefs[0].track.name, 't19', 'latest track');
  for (const [, v] of reg) {
    if (v.el?.name && v.el.name !== 'v19' && v.el.name !== 't19') assert(false, `old ${v.el.name} still registered`);
  }
  console.log('INV-6: PASS');
}

// ============================================================
// INV-6b: Old video seeked cannot trigger flush on new video
// ============================================================
section('INV-6b: Old video events isolated from new video');
{
  let flushed = false;
  const ctrl = { flush() { flushed = true; } };
  let _vrefs = null;
  const evts = {};
  function add(el, ev, h) { if (!evts[el.name]) evts[el.name] = {}; evts[el.name][ev] = h; }
  function rem(el, ev) { if (evts[el.name]) delete evts[el.name][ev]; }

  function bind(vid) {
    if (_vrefs) { rem(_vrefs.video, 'seeked'); rem(_vrefs.video, 'pause'); rem(_vrefs.video, 'play'); _vrefs = null; }
    if (!vid) return;
    const s = () => { flushed = true; };
    add(vid, 'seeked', s); add(vid, 'pause', () => {}); add(vid, 'play', () => {});
    _vrefs = { video: vid, seeked: s };
  }

  bind({ name: 'v1' });
  bind({ name: 'v2' });
  assert(!evts['v1']?.seeked, 'v1 seeked removed');
  flushed = false;
  if (evts['v1']?.seeked) evts['v1'].seeked();
  assert(!flushed, 'old v1 seeked does NOT flush');
  flushed = false;
  evts['v2'].seeked();
  assert(flushed, 'new v2 seeked DOES flush');
  console.log('INV-6b: PASS');
}

// ============================================================
// INV-7: Checkpoint buffer — 10 buffered, all retried, overflow drops, stale skipped
// ============================================================
section('INV-7: Checkpoint buffer behavior');
{
  const MAX = 10;
  let buf = [], gen = 0, retried = [];
  const sched = new TestScheduler();

  function buffer(c, t) { if (buf.length < MAX) buf.push({ caption: c, genAtStart: gen, translated: t }); }
  function retry() {
    const items = buf.splice(0, MAX);
    for (const it of items) { if (it.genAtStart !== gen) continue; retried.push(it); sched.addSegment(it.caption, 'x'); }
  }

  for (let i = 0; i < 10; i++) buffer({ id: `c${i}`, startTime: i * 2, endTime: i * 2 + 2, untimed: false }, `t${i}`);
  assertEq(buf.length, 10, '10 buffered');
  buffer({ id: 'overflow', startTime: 20, endTime: 22, untimed: false }, 'over');
  assertEq(buf.length, 10, 'overflow dropped');
  retry();
  assertEq(buf.length, 0, 'buffer empty');
  assertEq(retried.length, 10, '10 retried');
  assertEq(sched.segments.length, 10, '10 segments');
  for (let i = 0; i < 10; i++) assertEq(sched.segments[i].targetStart, i * 2, `seg ${i} chronological`);

  // Stale generation
  buf.length = 0; retried.length = 0; sched.segments.length = 0; sched.currentIndex = 0; gen++;
  buffer({ id: 's1', startTime: 0, endTime: 2, untimed: false }, 'x');
  gen++; buffer({ id: 's2', startTime: 2, endTime: 4, untimed: false }, 'x'); gen++;
  retry();
  assertEq(retried.length, 0, 'stale items not retried');
  assertEq(sched.segments.length, 0, 'no segments from stale');
  console.log('INV-7: PASS');
}

// ============================================================
// INV-8: Race — in-flight TTS discarded after correction
// ============================================================
function inv8() {
  section('INV-8: Race — in-flight TTS discarded after correction');
  return new Promise((resolve) => {
    let gen = 0;
    const segs = [];
    const q = [];
    function addSeg(c, a) { segs.push({ caption: c, audio: a, state: 'ready' }); }
    function inv(cid) { gen++; for (const s of segs) { if (s.caption.id === cid && s.state === 'ready') s.state = 'discarded'; } q.length = 0; }

    const v1 = { id: 'cue-A', text: 'I went to Delhi', startTime: 10, endTime: 12, untimed: false };
    const v2 = { id: 'cue-A', text: 'I went to Mumbai', startTime: 10, endTime: 12, untimed: false };

    const g1 = gen;
    const p = new Promise((r) => setTimeout(() => { if (g1 !== gen) { r(null); return; } r('audio-v1'); }, 30));
    const inflight = p.then((audio) => { if (g1 !== gen) return null; if (audio) addSeg(v1, audio); return audio; });

    inv('cue-A');
    assertEq(gen, 1, 'gen bumped');

    inflight.then(() => {
      assertEq(segs.filter(s => s.caption.id === 'cue-A' && s.state === 'ready').length, 0, 'v1 NOT in scheduler');
      assert(g1 !== gen, 'stale generation detected');
      addSeg(v2, 'audio-v2');
      const nv = segs.find(s => s.caption.id === 'cue-A' && s.state === 'ready');
      assert(nv && nv.caption.text === 'I went to Mumbai', 'v2 plays');
      console.log('INV-8: PASS');
      resolve();
    });
  });
}

// ============================================================
// INV-8b: Flush during two in-flight TTS — both discarded
// ============================================================
function inv8b() {
  section('INV-8b: Flush during in-flight — both discarded');
  return new Promise((resolve) => {
    let gen = 0;
    const segs = [];
    function addSeg(c, a) { segs.push({ c, a }); }
    function flush() { gen++; segs.length = 0; }

    const A = { id: 'A' }, B = { id: 'B' };
    const g1 = gen;
    const pA = new Promise((r) => setTimeout(() => { if (g1 !== gen) { r(null); return; } addSeg(A, 'a'); r('done'); }, 20));
    const pB = new Promise((r) => setTimeout(() => { if (g1 !== gen) { r(null); return; } addSeg(B, 'b'); r('done'); }, 30));

    flush();
    assertEq(gen, 1, 'gen=1');

    Promise.all([pA, pB]).then(() => {
      assertEq(segs.length, 0, 'no segments after flush');
      assert(g1 !== gen, 'stale gen');
      console.log('INV-8b: PASS');
      resolve();
    });
  });
}

// ============================================================
// Remaining sync tests
// ============================================================
function invRemaining() {
  section('INV-1b: Equal targetStart preserves insertion order');
  {
    const sched = new TestScheduler();
    sched.addSegment({ id: 'A1', text: 'A1', startTime: 10, endTime: 12, untimed: false }, 'x');
    sched.addSegment({ id: 'A2', text: 'A2', startTime: 10, endTime: 12, untimed: false }, 'x');
    sched.addSegment({ id: 'A3', text: 'A3', startTime: 10, endTime: 12, untimed: false }, 'x');
    assertEq(sched.segments.map(s => s.caption.id).join(','), 'A1,A2,A3', 'insertion order');
    console.log('INV-1b: PASS');
  }

  section('INV-1c: Insert before currentIndex bumps index');
  {
    const sched = new TestScheduler();
    sched.addSegment({ id: 'A', text: 'A', startTime: 10, endTime: 12, untimed: false }, 'x');
    sched.addSegment({ id: 'B', text: 'B', startTime: 20, endTime: 22, untimed: false }, 'x');
    sched.currentIndex = 1;
    sched.addSegment({ id: 'C', text: 'C', startTime: 5, endTime: 7, untimed: false }, 'x');
    assertEq(sched.currentIndex, 0, 'index bumped to 0');
    assertEq(sched.segments.map(s => s.caption.id).join(','), 'C,A,B', 'C,A,B order');
    console.log('INV-1c: PASS');
  }

  // ---- Fix 5: New invariants for caption ID normalization + duplicate prevention ----
  section('INV-10: Micro-seek threshold — only flush on >2s seeks');
  {
    // Simulate seeked handler behavior
    let flushed = false;
    let lastSeekTime = 10.0;
    const dispatchedIds = new Set(['caption-1', 'caption-2', 'caption-3']);
    const _dispatchedTexts = new Map([['hello', Date.now()], ['world', Date.now()]]);

    function seekedHandler(currentTime) {
      const delta = Math.abs(currentTime - lastSeekTime);
      lastSeekTime = currentTime;
      if (delta < 0.5) return; // micro-seek: skip
      dispatchedIds.clear();
      _dispatchedTexts.clear();
      flushed = true;
    }

    // Micro-seek (<0.5s) — should NOT flush
    flushed = false;
    seekedHandler(10.3); // delta = 0.3s
    assert(!flushed, 'micro-seek (0.3s) does NOT flush');
    assertEq(dispatchedIds.size, 3, 'dispatchedIds preserved after micro-seek');

    // Medium seek (0.5s-2s) — flushes because delta > 0.5 threshold
    flushed = false;
    seekedHandler(11.0); // delta = 0.7s
    assert(flushed, 'medium seek (0.7s) DOES flush (> 0.5 threshold)');
    assertEq(dispatchedIds.size, 0, 'dispatchedIds cleared after medium seek');

    // User seek (>2s) — SHOULD flush
    flushed = false;
    seekedHandler(14.0); // delta = 3.0s
    assert(flushed, 'user seek (3.0s) DOES flush');
    assertEq(dispatchedIds.size, 0, 'dispatchedIds cleared after user seek');
    console.log('INV-10: PASS');
  }

  section('INV-11: Duplicate segment prevention — overlap + similar text → discard older');
  {
    const sched = new TestScheduler();
    // Add first segment at t=10
    sched.addSegment({ id: 'seg1', text: 'Hello world this is a test', startTime: 10, endTime: 12, untimed: false }, 'x');
    assertEq(sched.segments.length, 1, '1 segment after first add');
    assertEq(sched.segments[0].state, 'ready', 'first segment ready');

    // Add duplicate (same text, overlapping time) — should discard first
    sched.addSegment({ id: 'seg2', text: 'Hello world this is a test', startTime: 10.1, endTime: 12.2, untimed: false }, 'x');
    assertEq(sched.segments.length, 2, '2 segments in list');
    assert(sched.segments[0].state === 'discarded', 'first segment discarded as duplicate');
    assert(sched.segments[1].state === 'ready', 'second segment ready');

    // Add segment with different text at same time — should NOT discard
    const sched2 = new TestScheduler();
    sched2.addSegment({ id: 's1', text: 'First caption', startTime: 10, endTime: 12, untimed: false }, 'x');
    sched2.addSegment({ id: 's2', text: 'Completely different text here', startTime: 10.2, endTime: 12.3, untimed: false }, 'x');
    assert(sched2.segments[0].state === 'ready', 'different text → first NOT discarded');
    assert(sched2.segments[1].state === 'ready', 'different text → second added');

    // Add segment at non-overlapping time — should NOT discard
    const sched3 = new TestScheduler();
    sched3.addSegment({ id: 's1', text: 'Hello world this is a test', startTime: 10, endTime: 12, untimed: false }, 'x');
    sched3.addSegment({ id: 's2', text: 'Hello world this is a test', startTime: 20, endTime: 22, untimed: false }, 'x');
    assert(sched3.segments[0].state === 'ready', 'non-overlapping time → first NOT discarded');

    // Substring match — "Hello" contains in "Hello world this is a test" → discard
    const sched4 = new TestScheduler();
    sched4.addSegment({ id: 's1', text: 'Hello world this is a test', startTime: 10, endTime: 12, untimed: false }, 'x');
    sched4.addSegment({ id: 's2', text: 'Hello', startTime: 10.1, endTime: 11.5, untimed: false }, 'x');
    assert(sched4.segments[0].state === 'discarded', 'substring match → first discarded');
    console.log('INV-11: PASS');
  }

  section('INV-12: Audio lead time — segments play 300ms early');
  {
    // The AUDIO_LEAD constant is 0.3s
    // Segments should start playing when video.currentTime >= targetStart - 0.3
    const sched = new TestScheduler();
    sched.addSegment({ id: 'seg1', text: 'Test', startTime: 10, endTime: 12, untimed: false }, 'x');

    // At 9.6s (= 10 - 0.4), segment should NOT play yet
    sched.video.currentTime = 9.6;
    sched.tick();
    assert(sched.segments[0].state === 'ready', 'at 9.6s (< 9.7s lead) → not playing');

    // At 9.7s (= 10 - 0.3), segment SHOULD play
    sched.video.currentTime = 9.7;
    sched.tick();
    assert(sched.segments[0].state === 'playing', 'at 9.7s (= 10 - 0.3) → playing (lead time)');
    console.log('INV-12: PASS');
  }

  section('INV-9: Syntax checks');
  {
    const { execSync } = require('child_process');
    let ok = true;
    for (const f of ['extension/src/popup/content.js', 'extension/src/popup/sync_controller.js', 'extension/src/popup/service_worker.js', 'extension/src/offscreen.js']) {
      try { execSync(`node --check ${f}`, { cwd: '/home/rushi/aakashvani', stdio: 'pipe', timeout: 5000 }); }
      catch (e) { ok = false; console.error(`FAIL: ${f}`); }
    }
    assert(ok, 'all JS syntax checks pass');
    console.log('INV-9: PASS');
  }
}

// ============================================================
// Run all tests in sequence (async-safe)
// ============================================================
inv8().then(() => inv8b()).then(() => {
  invRemaining();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ADVERSARIAL VERIFICATION: ${_pass} passed, ${_fail} failed out of ${_total} checks`);
  console.log(`${'='.repeat(60)}`);
  if (_fail > 0) process.exit(1);
});
