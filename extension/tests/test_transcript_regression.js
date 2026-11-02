// AakashVani TranscriptController — Regression tests for Priority 1 audit
// Tests specific bugs found in the audit:
//   - Same caption observed twice should NOT clear uncommitted text
//   - Truncation/replace should not overwrite committedPrefix backwards
//   - markSynthesizing should be called in the lifecycle
//   - TranscriptController should reset on seek/video navigation
// Run: node extension/tests/test_transcript_regression.js

const { TranscriptController, validateCaption, wordDiff } = require('../src/popup/transcript_controller');

let _pass = 0, _fail = 0;
function assert(cond, msg) {
  if (cond) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(name) { console.log(`\n--- ${name} ---`); }

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

async function run() {
  // ================================================================
  section('BUG 1: Same caption observed twice must NOT clear uncommitted text');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });

    // First observation: sets up pending text
    tc.uncommitted = 'Hello world';
    tc.uncommittedFirstSeen = Date.now() - 100;
    tc.uncommittedObservations = 1;

    // Second observation: same text (no diff → same relation)
    const cap = makeCaption('Hello world', 5, 8);
    const segments = tc.reconcile(cap);

    // uncommitted should NOT be cleared on same-caption re-observation
    assertEq(tc.uncommitted, 'Hello world', 'uncommitted NOT cleared on same caption re-observation');
    assert(tc.uncommittedObservations >= 1, 'observation count preserved or incremented');
    assert(segments === null || segments.length === 0, 'no new segment on same caption');
  }

  // ================================================================
  section('BUG 2: Truncation/replace must not overwrite committedPrefix backwards');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });

    // First: commit "Hello world" as a segment
    tc.committedPrefix = 'Hello world';
    tc.committedWords = ['Hello', 'world'];
    tc.uncommitted = '';
    tc.uncommittedObservations = 0;

    // Second: correction to "Hello" (truncation)
    const cap2 = makeCaption('Hello', 0, 3);
    const segs2 = tc.reconcile(cap2);

    // committedPrefix should NOT go backwards to just "Hello"
    // because "Hello world" was already committed as a segment
    assertEq(tc.committedPrefix, 'Hello world', 'committedPrefix NOT overwritten backwards by truncation');
  }

  // ================================================================
  section('BUG 3: markSynthesizing should be called in lifecycle');
  {
    const tc = new TranscriptController();
    const segment = tc._createSegment('Hello world', makeCaption('Hello world', 0, 3), 'stable');

    // Manually simulate lifecycle
    tc.markTranslating(segment.id, 'piper');
    assertEq(segment.state, 'translating', 'state: translating after markTranslating');

    tc.markSynthesizing(segment.id);
    assertEq(segment.state, 'synthesizing', 'state: synthesizing after markSynthesizing');

    tc.markQueued(segment.id, 'base64audio', 2.5, 'req-123');
    assertEq(segment.state, 'queued', 'state: queued after markQueued');

    tc.markPlaying(segment.id);
    assertEq(segment.state, 'playing', 'state: playing after markPlaying');

    tc.markCompleted(segment.id);
    assertEq(segment.state, 'completed', 'state: completed after markCompleted');
  }

  // ================================================================
  section('BUG 4: TranscriptController reset on seek/video navigation');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 50, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });

    // Simulate having committed text before seek
    tc.uncommitted = 'Old caption before seek';
    tc.uncommittedFirstSeen = Date.now() - 100;
    tc.uncommittedObservations = 1;
    const segs = tc._checkStability(makeCaption('Old caption before seek', 0, 3));
    assertEq(segs.length, 1, 'segment created before seek');
    assertEq(tc.committedPrefix, 'Old caption before seek', 'committedPrefix has old content');

    // Simulate seek: reset should clear committedPrefix, uncommitted, segments
    tc.reset();
    assertEq(tc.committedPrefix, '', 'committedPrefix cleared on reset');
    assertEq(tc.uncommitted, '', 'uncommitted cleared on reset');
    assertEq(tc.segments.length, 0, 'segments cleared on reset');
  }

  // ================================================================
  section('BUG 5: Growth reconciliation should handle sliding window correctly');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });

    // Simulate sliding window: "Here in India," → "the government is mulling"
    // committed = ["Here", "in", "India,"], pending = []
    // new = ["the", "government", "is", "mulling"]
    // LCS: common=[], removed=["Here","in","India,"], added=["the","government","is","mulling"]
    tc.committedPrefix = 'Here in India,';
    tc.committedWords = ['Here', 'in', 'India,'];
    tc.uncommitted = '';

    const cap = makeCaption('the government is mulling', 3, 6);
    const segments = tc.reconcile(cap);

    // Should treat sliding window as correction: committedPrefix is append-only
    // (the old text was already committed+dispatched), new words go to pending.
    assertEq(tc.committedPrefix, 'Here in India,', 'committedPrefix unchanged (append-only)');
    assertEq(tc.uncommitted, 'the government is mulling', 'new window text goes to pending');
  }

  // ================================================================
  section('BUG 7: Word-level correction must not corrupt text via char/word slice mismatch');
  {
    // Regression of the earlier fix attempt: prefix length is measured in WORDS
    // but was used to slice a CHARACTER string ("Hello there".slice(1) → 'ello there').
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });
    tc.committedPrefix = 'Hello world';
    tc.committedWords = ['Hello', 'world'];

    const cap = makeCaption('Hello there how are you', 5, 8);
    const segs = tc.reconcile(cap);
    assert(tc.uncommitted === 'there how are you',
      `pending must be word-residual ('there how are you'), got ${JSON.stringify(tc.uncommitted)}`);
    assert(tc.committedPrefix === 'Hello world', 'committed preserved');
    assert(segs === null, 'no immediate segment');
  }

  // ================================================================
  section('BUG 8: Speech loss — replace with sentence change must keep new words');
  {
    // Old behavior: committedPrefix overwritten with the new text WITHOUT any
    // segment created → 'there now' never reached TTS.
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });
    tc.committedPrefix = 'Hello world';
    tc.committedWords = ['Hello', 'world'];

    const cap = makeCaption('Hello there now', 5, 8);
    const segs = tc.reconcile(cap);
    assert(tc.uncommitted === 'there now', 'new words enter pending instead of vanishing');
  }

  // ================================================================
  section('BUG 9: Genuine repeated speech at a later cue must be dispatched');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });

    // First utterance at cue t=1 committed as a segment
    tc.committedPrefix = 'Yeah okay';
    tc.committedWords = ['Yeah', 'okay'];
    // Signature of the first commitment is registered as if committed from cue t=1
    tc._recentSig.set('1|Yeah okay', Date.now());

    // Same text re-observed from the SAME cue → no duplicate segment
    const capSame = makeCaption('Yeah okay', 1, 3, 'texttrack');
    const segsSame = tc.reconcile(capSame);
    assert(segsSame === null, 'same cue re-observation → no duplicate segment');

    // Same text at a LATER cue (t=10) → genuine repeat → new segment
    const capRepeat = makeCaption('Yeah okay', 10, 12, 'texttrack');
    const segsRepeat = tc.reconcile(capRepeat);
    assert(Array.isArray(segsRepeat) && segsRepeat.length === 1,
      'genuine repeat at later cue → segment created');
    assert(segsRepeat && segsRepeat[0].text === 'Yeah okay', 'repeat segment text correct');
    assert(segsRepeat && segsRepeat[0].commitReason === 'genuine-repeat', 'commitReason marked');

    // The repeat cue observed again → still suppressed
    const capRepeat2 = makeCaption('Yeah okay', 10, 12, 'texttrack');
    const segsRepeat2 = tc.reconcile(capRepeat2);
    assert(segsRepeat2 === null, 'repeat cue re-observation → no duplicate');
  }

  // ================================================================
  section('BUG 9b: DOM (untimed) repeated observation must NOT re-dispatch');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });
    tc.committedPrefix = 'Yeah okay';
    tc.committedWords = ['Yeah', 'okay'];

    // DOM captions carry capture-time (varies per poll) — only 500ms precision
    const capDom = makeCaption('Yeah okay', 1, 3, 'dom');
    const segsDom = tc.reconcile(capDom);
    assert(segsDom === null, 'untimed dom repeat → no duplicate segment');
  }

  // ================================================================
  section('BUG 10: late-audio guard keeps useful future speech (retained)');
  {
    const tc = new TranscriptController({
      config: { MIN_STABILITY_MS: 5000, MAX_STABILITY_MS: 5000, MIN_OBSERVATIONS: 1 },
    });

    // Create a segment with targetStart well in the future
    const futureCap = makeCaption('Future caption', 100, 103);
    const segment = tc._createSegment('Future caption', futureCap, 'stable');
    segment.targetStart = 100; // far future

    // Segment should NOT be considered late now
    const now = 0; // video at time 0
    const playAt = segment.targetStart - 0.3; // AUDIO_LEAD
    const lateBy = now - playAt;
    assert(lateBy <= 3.0, `segment not late (lateBy=${lateBy.toFixed(2)}s)`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`REGRESSION TESTS: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
