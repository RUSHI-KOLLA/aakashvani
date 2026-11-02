// AakashVani — Regression test for exact live-log patterns from YouTube playback failures.
// Reproduces the fragmented dispatch, repeated replace relations, stale committed state, and dropped audio.

const { TranscriptController, validateCaption } = require('../src/popup/transcript_controller');

let _pass = 0, _fail = 0;
function assert(cond, msg) {
  if (cond) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  if (actual === expected) { _pass++; }
  else { _fail++; console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(name) { console.log(`\n=== ${name} ===`); }

function makeCaption(text, startTime, endTime, source = 'texttrack', id = null) {
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

// Mock Date.now for deterministic testing
let fakeNow = 0;
const origNow = Date.now;
Date.now = () => fakeNow;

section('Regression: Live-log pattern — fragmented dispatch with repeated replaces');

{
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: 300, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 2 },
  });

  // Simulate the exact sequence from logs:
  // Each caption arrives as a separate observation (simulating YouTube's rolling window)
  // with ~250ms between observations (YouTube's DOM poll cadence)
  
  const observations = [
    // First group: "1969," arrives and gets committed as fragment
    { t: 0, text: '1969,', startTime: 10.0, endTime: 12.0 },
    { t: 250, text: '1969,', startTime: 10.0, endTime: 12.0 },  // 2nd observation → stability
    
    // "a young Christian" - replace relation, committed as fragment
    { t: 500, text: 'a young Christian', startTime: 12.0, endTime: 14.0 },
    { t: 750, text: 'a young Christian', startTime: 12.0, endTime: 14.0 },
    
    // "convert" - replace relation, committed as fragment
    { t: 1000, text: 'convert', startTime: 14.0, endTime: 15.0 },
    { t: 1250, text: 'convert', startTime: 14.0, endTime: 15.0 },
    
    // "lays the foundation" - replace relation
    { t: 1500, text: 'lays the foundation', startTime: 15.0, endTime: 17.0 },
    { t: 1750, text: 'lays the foundation', startTime: 15.0, endTime: 17.0 },
    
    // "for the myth that continues" - replace relation
    { t: 2000, text: 'for the myth that continues', startTime: 17.0, endTime: 19.0 },
    { t: 2250, text: 'for the myth that continues', startTime: 17.0, endTime: 19.0 },
    
    // "on WhatsApp" - replace relation
    { t: 2500, text: 'on WhatsApp', startTime: 19.0, endTime: 20.0 },
    { t: 2750, text: 'on WhatsApp', startTime: 19.0, endTime: 20.0 },
    
    // "till date." - replace relation, but committed shows old text
    { t: 3000, text: 'till date.', startTime: 20.0, endTime: 21.0 },
    { t: 3250, text: 'till date.', startTime: 20.0, endTime: 21.0 },
  ];

  const committedSegments = [];
  const relations = [];

  for (const obs of observations) {
    fakeNow = obs.t;
    const cap = makeCaption(obs.text, obs.startTime, obs.endTime);
    const normalized = tc.ingestCaption(cap, 'texttrack', obs.startTime);
    const segments = tc.reconcile(normalized);
    if (segments) {
      for (const s of segments) committedSegments.push(s.text);
    }
    // Capture relation from debug log (we'll check internal state)
    relations.push(tc.uncommitted); // Track pending state
  }

  console.log('Committed segments:', committedSegments);
  console.log('Final committedPrefix:', tc.committedPrefix);
  console.log('Final uncommitted:', tc.uncommitted);
  console.log('Segments count:', tc.segments.length);
  console.log('Segment states:', tc.segments.map(s => ({ text: s.text.slice(0,30), state: s.state })));

  // FIXED: fragments now accumulate into larger phrases (3-4 segments instead of 7)
  // No duplication, no loss, reasonable phrase grouping
  assert(committedSegments.length >= 3 && committedSegments.length <= 4, 
    `FIXED: ${committedSegments.length} larger phrases committed (was 7 fragments)`);
  
  // Check that committedPrefix contains all text (no loss)
  assert(tc.committedPrefix.includes('1969'), 'committedPrefix has 1969');
  assert(tc.committedPrefix.includes('Christian'), 'committedPrefix has Christian');
  assert(tc.committedPrefix.includes('convert'), 'committedPrefix has convert');
  assert(tc.committedPrefix.includes('foundation'), 'committedPrefix has foundation');
  assert(tc.committedPrefix.includes('myth'), 'committedPrefix has myth');
  assert(tc.committedPrefix.includes('WhatsApp'), 'committedPrefix has WhatsApp');
  assert(tc.committedPrefix.includes('till date'), 'committedPrefix has till date');
  
  // Verify phrase structure: segments should be reasonable phrases covering all content
  const allCommitted = committedSegments.join(' ');
  assert(allCommitted.includes('1969'), 'all segments have 1969');
  assert(allCommitted.includes('Christian'), 'all segments have Christian');
  assert(allCommitted.includes('convert'), 'all segments have convert');
  assert(allCommitted.includes('foundation'), 'all segments have foundation');
  assert(allCommitted.includes('myth'), 'all segments have myth');
  assert(allCommitted.includes('WhatsApp'), 'all segments have WhatsApp');
  assert(allCommitted.includes('till date'), 'all segments have till date');
  
  // Verify first segment starts with 1969 and includes Christian
  assert(committedSegments[0].includes('1969') && committedSegments[0].includes('Christian'), 
    'first segment combines 1969 + Christian');
  // Verify last segment ends with till date
  assert(committedSegments[committedSegments.length - 1].includes('till date'), 
    'last segment is till date');
}

section('Regression: Stale committed transcript with new caption arrival');

{
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: 300, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 2 },
  });

  // First, commit some text
  fakeNow = 0;
  let cap = makeCaption('till date. and how he was converted.', 10.0, 13.0);
  let norm = tc.ingestCaption(cap, 'texttrack', 10.0);
  tc.reconcile(norm);
  fakeNow = 300;
  tc.reconcile(norm); // 2nd obs → commit
  assert(tc.committedPrefix.includes('till date'), 'initial commit works');

  // Then a new caption arrives - committed should NOT be rewritten
  fakeNow = 1000;
  cap = makeCaption('this was written by a guy called Devaneyan.', 13.0, 16.0);
  norm = tc.ingestCaption(cap, 'texttrack', 13.0);
  const segments = tc.reconcile(norm);
  
  console.log('Committed after new caption:', tc.committedPrefix);
  console.log('New segments:', segments ? segments.map(s => s.text) : 'none');
  
  // Bug: committedPrefix might be rewritten or show stale partial text
  assert(tc.committedPrefix.includes('till date'), 'old committed text preserved');
  assert(tc.committedPrefix.includes('Devaneyan') || (segments && segments.some(s => s.text.includes('Devaneyan'))), 'new text committed or pending');
}

section('Regression: Short fragments (a, CE, for, starts) committed as utterances');

{
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: 300, MAX_STABILITY_MS: 2000, MIN_OBSERVATIONS: 2 },
  });

  const shortFragments = ['a', 'CE', 'for', 'starts', 'evidence.', 'evidence.'];
  const committed = [];

  // Simulate a SINGLE TextTrack cue growing progressively (same startTime, growing text)
  // This is how YouTube TextTrack cues actually work - the cue startTime stays constant
  const captionId = 'cap-growing-1';
  const startTime = 10;
  const endTime = 13;
  
  for (let i = 0; i < shortFragments.length; i++) {
    fakeNow = i * 500;
    // Each observation has same ID and time, but growing text (cumulative)
    const cumulativeText = shortFragments.slice(0, i+1).join(' ');
    const cap = makeCaption(cumulativeText, startTime, endTime, 'texttrack', captionId);
    const norm = tc.ingestCaption(cap, 'texttrack', startTime);
    let segs = tc.reconcile(norm);  // First observation - might commit on phrase boundary
    if (segs) committed.push(...segs.map(s => s.text));
    fakeNow = i * 500 + 300; // 2nd observation (stability check)
    segs = tc.reconcile(norm);  // Second observation - might commit on stability
    if (segs) committed.push(...segs.map(s => s.text));
  }

  console.log('Short fragments committed:', committed);
  // FIXED: short fragments accumulate until phrase boundary or stability
  // "a CE for starts" commits on stability (4 words), "evidence." on phrase boundary, "evidence." as genuine repeat
  assert(committed.length >= 2 && committed.length <= 3, 
    `FIXED: ${committed.length} commits (was many fragments)`);
  assert(committed.some(t => t.includes('evidence.')), 'evidence. committed');
  assert(committed.some(t => t.includes('starts')), 'starts committed');
}

section('Regression: Stale segment detection timing');

{
  // This tests the TimelineScheduler stale threshold
  // We can't easily test the full scheduler here (requires window), but we can verify the threshold constants
  // by checking the source file directly
  const fs = require('fs');
  const syncSrc = fs.readFileSync('/home/rushi/aakashvani/extension/src/popup/sync_controller.js', 'utf8');
  
  // Check LATE_AUDIO_THRESHOLD = 8.0 (increased for translation+TTS latency)
  assert(syncSrc.includes('LATE_AUDIO_THRESHOLD = 8.0'), 'LATE_AUDIO_THRESHOLD is 8.0s');
  // Check AUDIO_LEAD = 0.3
  assert(syncSrc.includes('AUDIO_LEAD = 0.3'), 'AUDIO_LEAD is 300ms');
  
  console.log('LATE_AUDIO_THRESHOLD: 8.0s (from source)');
  console.log('AUDIO_LEAD: 0.3s (from source)');
}

Date.now = origNow;

console.log(`\n${'='.repeat(60)}`);
console.log(`REGRESSION TESTS: ${_pass} passed, ${_fail} failed`);
console.log(`${'='.repeat(60)}`);
process.exit(_fail > 0 ? 1 : 0);