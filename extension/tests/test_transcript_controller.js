// AakashVani TranscriptController tests — Phase 2
// Tests caption ingestion, revision reconciliation, stability commitment,
// phrase segmentation, segment lifecycle, and health monitoring.
// Run: node extension/tests/test_transcript_controller.js

const { TranscriptController, CONFIG, validateCaption, wordDiff } = require('../src/popup/transcript_controller');

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
  section('1. Caption ingestion and validation');

  // 1a: Valid caption
  {
    const tc = new TranscriptController();
    const cap = tc.ingestCaption(makeCaption('Hello world', 5, 8), 'texttrack', 5);
    assert(cap !== null, 'valid caption ingested');
    assert(cap.text === 'Hello world', 'caption text preserved');
    assert(cap.startTime === 5, 'startTime preserved');
  }

  // 1b: Empty caption rejected
  {
    const tc = new TranscriptController();
    const cap = tc.ingestCaption(makeCaption(''), 'texttrack', 5);
    assert(cap === null, 'empty caption rejected');
  }

  // 1c: YouTube UI string rejected
  {
    const tc = new TranscriptController();
    const cap = tc.ingestCaption(makeCaption('English (auto-generated)'), 'texttrack', 5);
    assert(cap === null, 'YouTube UI string rejected');
  }

  // 1d: Punctuation-only rejected
  {
    const tc = new TranscriptController();
    const cap = tc.ingestCaption(makeCaption('...'), 'texttrack', 5);
    assert(cap === null, 'punctuation-only caption rejected');
  }

  section('2. Validation helper');

  {
    assert(validateCaption(makeCaption('Hello')).ok === true, 'valid caption passes');
    assert(validateCaption(makeCaption('')).ok === false, 'empty fails');
    assert(validateCaption(makeCaption('English (auto-generated)')).ok === false, 'UI string fails');
    assert(validateCaption(makeCaption('...')).ok === false, 'no-speech-chars fails');
  }

  section('3. Word-level diff (reconciliation)');

  {
    // Pure growth
    const d1 = wordDiff(['Hello'], ['Hello', 'world']);
    assertEq(d1.added.length, 1, 'growth: one word added');
    assertEq(d1.added[0], 'world', 'growth: "world" added');
    assertEq(d1.removed.length, 0, 'growth: nothing removed');
    assertEq(d1.common.length, 1, 'growth: "Hello" common');

    // Truncation (removal)
    const d2 = wordDiff(['Hello', 'world'], ['Hello']);
    assertEq(d2.added.length, 0, 'truncation: nothing added');
    assertEq(d2.removed.length, 1, 'truncation: "world" removed');
    assertEq(d2.removed[0], 'world', 'truncation: removed word');

    // Replacement
    const d3 = wordDiff(['Hello', 'world'], ['Hello', 'there']);
    assertEq(d3.added.length, 1, 'replace: one added');
    assertEq(d3.added[0], 'there', 'replace: "there" added');
    assertEq(d3.removed.length, 1, 'replace: one removed');
    assertEq(d3.removed[0], 'world', 'replace: "world" removed');
    assertEq(d3.common.length, 1, 'replace: "Hello" common');

    // Same
    const d4 = wordDiff(['Hello'], ['Hello']);
    assertEq(d4.added.length, 0, 'same: nothing added');
    assertEq(d4.removed.length, 0, 'same: nothing removed');
    assertEq(d4.common.length, 1, 'same: one common');

    // Case-insensitive comparison
    const d5 = wordDiff(['Hello'], ['hello']);
    assertEq(d5.added.length, 0, 'case-insensitive: nothing added');
    assertEq(d5.removed.length, 0, 'case-insensitive: nothing removed');
    assertEq(d5.common.length, 1, 'case-insensitive: one common');
  }

  section('4. Revision-aware reconciliation (growth, slide, replace, same)');

  {
    // 4a: Pure growth — new words appended
    {
      const tc = new TranscriptController();
      tc.committedPrefix = 'Hello';
      tc.committedWords = ['Hello'];
      const cap = makeCaption('Hello world', 5, 8);
      const segments = tc.reconcile(cap);
      assert(segments === null || segments.length === 0, 'growth: not yet committed (stability)');
      assert(tc.uncommitted === 'world', 'growth: pending text = new words only');
    }

    // 4b: Replace — correction
    // AUDIT FIX: committed transcript is append-only. "Hello there" arrives as
    // a NEW observation while "Hello world" was already committed and
    // dispatched — committedPrefix must NOT be rewritten; only the uncommitted
    // region changes.
    {
      const tc = new TranscriptController();
      tc.committedPrefix = 'Hello world';
      tc.committedWords = ['Hello', 'world'];
      const cap = makeCaption('Hello there', 5, 8);
      const segments = tc.reconcile(cap);
      assert(tc.committedPrefix === 'Hello world', 'replace: committed PRESERVED (append-only)');
      assert(segments === null || segments.length === 0, 'replace: no segment created (pending not yet stable)');
      assert(tc.uncommitted === 'there', 'replace: corrected tail goes to pending');
    }

    // 4c: Same — repeated observation
    {
      const tc = new TranscriptController();
      tc.committedPrefix = 'Hello';
      tc.committedWords = ['Hello'];
      tc.uncommitted = 'Hello';
      const cap = makeCaption('Hello', 5, 8);
      const segments = tc.reconcile(cap);
      assert(segments === null || segments.length === 0, 'same: no new segment');
    }
  }

  section('5. Stability-aware commitment');

  {
    // 5a: Min stability not met — no commitment
    {
      const tc = new TranscriptController({
        config: { MIN_STABILITY_MS: 300, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 2 },
      });
      // Manually set pending text
      tc.uncommitted = 'Hello world';
      tc.uncommittedFirstSeen = Date.now() - 100; // only 100ms ago
      tc.uncommittedObservations = 1;
      const segments = tc._checkStability(makeCaption('Hello world', 5, 8));
      assert(segments === null || segments.length === 0, 'min stability: not committed yet');
    }

    // 5b: Max wait deadline — forced commitment
    {
      const tc = new TranscriptController({
        config: { MIN_STABILITY_MS: 300, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 2 },
      });
      tc.uncommitted = 'Hello world';
      tc.uncommittedFirstSeen = Date.now() - 2500; // 2.5s ago, exceeds max
      tc.uncommittedObservations = 1;
      const segments = tc._checkStability(makeCaption('Hello world', 5, 8));
      assert(segments !== null && segments.length === 1, 'max wait: committed despite few observations');
      assert(segments[0].text === 'Hello world', 'max wait: correct text committed');
      assert(segments[0].commitReason === 'max-wait', 'max wait: correct reason');
    }

    // 5c: Phrase boundary — immediate commitment
    {
      const tc = new TranscriptController({
        config: { MIN_STABILITY_MS: 300, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 2 },
      });
      tc.uncommitted = 'Hello world.';
      tc.uncommittedFirstSeen = Date.now() - 100; // only 100ms ago
      tc.uncommittedObservations = 1;
      const segments = tc._checkStability(makeCaption('Hello world.', 5, 8));
      assert(segments !== null && segments.length === 1, 'phrase boundary: committed immediately');
      assert(segments[0].commitReason === 'phrase-boundary', 'phrase boundary: correct reason');
    }

    // 5d: Committed text accumulates
    {
      const tc = new TranscriptController({
        config: { MIN_STABILITY_MS: 50, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 1 },
      });
      // First segment - with phrase boundary (period)
      tc.uncommitted = 'Hello.';
      tc.uncommittedFirstSeen = Date.now() - 100;
      tc.uncommittedObservations = 1;
      let segments = tc._checkStability(makeCaption('Hello.', 5, 8));
      assert(segments.length === 1, 'first segment committed');
      assert(tc.committedPrefix === 'Hello.', 'committed prefix = Hello.');

      // Second segment (growth) — uncommitted should be just the new words
      tc.uncommitted = 'world.';
      tc.uncommittedFirstSeen = Date.now() - 100;
      tc.uncommittedObservations = 1;
      segments = tc._checkStability(makeCaption('Hello. world.', 5, 8));
      assert(segments.length === 1, 'second segment committed');
      assert(tc.committedPrefix === 'Hello. world.', 'committed prefix = Hello. world.');
    }
  }

  section('6. Segment lifecycle management');

  {
    const tc = new TranscriptController();
    const segment = tc._createSegment('Hello world', makeCaption('Hello world', 5, 8), 'stable');

    assert(segment.state === 'committed', 'initial state: committed');
    assert(segment.text === 'Hello world', 'segment text correct');
    assert(segment.cancelled === false, 'not cancelled initially');
    assert(segment.completed === false, 'not completed initially');

    // markTranslating
    assert(tc.markTranslating(segment.id, 'piper') === true, 'markTranslating succeeds');
    assert(segment.state === 'translating', 'state: translating');
    assert(segment.provider === 'piper', 'provider set');

    // markSynthesizing
    assert(tc.markSynthesizing(segment.id) === true, 'markSynthesizing succeeds');
    assert(segment.state === 'synthesizing', 'state: synthesizing');

    // markQueued
    assert(tc.markQueued(segment.id, 'base64audio', 2.5, 'req-123') === true, 'markQueued succeeds');
    assert(segment.state === 'queued', 'state: queued');
    assert(segment.audioBase64 === 'base64audio', 'audio stored');
    assert(segment.durationSeconds === 2.5, 'duration stored');
    assert(segment.requestId === 'req-123', 'requestId stored');

    // markPlaying
    assert(tc.markPlaying(segment.id) === true, 'markPlaying succeeds');
    assert(segment.state === 'playing', 'state: playing');

    // markCompleted
    assert(tc.markCompleted(segment.id) === true, 'markCompleted succeeds');
    assert(segment.state === 'completed', 'state: completed');

    // Cannot re-mark completed
    assert(tc.markPlaying(segment.id) === false, 'cannot play completed segment');
    assert(tc.cancelSegment(segment.id) === false, 'cannot cancel completed segment');
  }

  section('7. Segment cancellation');

  {
    const tc = new TranscriptController();
    const segment = tc._createSegment('Hello world', makeCaption('Hello world', 5, 8), 'stable');
    tc.markTranslating(segment.id, 'piper');
    tc.markSynthesizing(segment.id);

    // Cancel while synthesizing
    assert(tc.cancelSegment(segment.id) === true, 'cancel succeeds');
    assert(segment.state === 'cancelled', 'state: cancelled');

    // Cannot cancel again
    assert(tc.cancelSegment(segment.id) === false, 'double cancel returns false');
  }

  section('8. Segment retrieval and ready list');

  {
    const tc = new TranscriptController();
    const s1 = tc._createSegment('First', makeCaption('First', 0, 3), 'stable');
    const s2 = tc._createSegment('Second', makeCaption('Second', 3, 6), 'stable');
    tc.markTranslating(s2.id, 'sarvam');
    tc.markSynthesizing(s2.id);
    tc.markQueued(s2.id, 'audio', 1.5, 'req-2');

    const ready = tc.getReadySegments();
    assertEq(ready.length, 1, 'only queued segment in ready list');
    assertEq(ready[0].id, s2.id, 'correct segment in ready list');

    const found = tc.getSegment(s1.id);
    assert(found !== undefined, 'segment found by ID');
    assert(found.text === 'First', 'correct segment text');
  }

  section('9. Caption health monitoring');

  {
    let healthEvents = [];
    const tc = new TranscriptController();
    tc.onHealthChange = (h) => healthEvents.push({ ...h });

    tc.markCaptionHealthy('texttrack');
    assert(tc._captionHealth.source === 'texttrack', 'source set');
    assert(tc._captionHealth.asrActive === false, 'ASR not active initially');
    assert(healthEvents.length === 1, 'health event fired');

    tc.activateASR();
    assert(tc._captionHealth.asrActive === true, 'ASR activated');
    assert(tc._counters.fallbackActivations === 1, 'fallback counter incremented');

    tc.deactivateASR();
    assert(tc._captionHealth.asrActive === false, 'ASR deactivated');

    assert(tc.isCaptionStale() === false, 'not stale when healthy');
  }

  section('10. Stats and config');

  {
    const tc = new TranscriptController();
    const stats = tc.getStats();
    assert(typeof stats.captionsReceived === 'number', 'captionsReceived counter');
    assert(typeof stats.segmentsCreated === 'number', 'segmentsCreated counter');
    assert(typeof stats.committedWords === 'number', 'committedWords counter');

    const config = tc.getConfig();
    assert(config.MIN_STABILITY_MS === 300, 'config value accessible');
    assert(config.MAX_STABILITY_MS === 2000, 'config value accessible');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TRANSCRIPT CONTROLLER: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
