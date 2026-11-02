// AakashVani — deterministic replay benchmarks (Priority 3).
//
// WHAT THIS DOES AND DOES NOT MEASURE
//   - Commit strategies are replayed on VIRTUAL time against identical caption
//     observation streams; translation/TTS pipeline latencies are SIMULATED as
//     constants (translate 350 ms, TTS 250 ms — typical local-piper values).
//     These are replay benchmarks, not network measurements.
//   - The repo contains no raw caption logs, so traces encode the project's
//     known adversarial scenarios (progressive growth, window slide, ASR
//     corrections, repeated speech, stale captions, flapping).
//   - CPU/metrcs are measured in-process (LCS wordDiff cost). Memory: heapUsed
//     delta per strategy (approximate, GC-dependent).
//
// Run: node extension/tests/test_benchmarks.js
// Exit code 0 = harness ran; internal sanity asserts may fail the run.

const { TranscriptController, validateCaption } = require('../src/popup/transcript_controller');

let _sanityFail = 0;
function sanity(cond, msg) {
  if (cond) return;
  _sanityFail++;
  console.error(`  SANITY FAIL: ${msg}`);
}

// ------------------------------------------------------------------
// Strategy interface (committing logic only; pipeline shared)
// ------------------------------------------------------------------
// captionAt(simMs, text, cueStart, cueEnd, source) → pipeline segment text
// A strategy yields commit events: [{ t, text, source }]

const TRANSLATE_MS = 350;
const TTS_MS = 250;
const AUDIO_LEAD_S = 0.3;
const LATE_THRESHOLD_S = 3.0;

function simulate(obs, commitFn, minStabilityMs, maxStabilityMs) {
  // obs: [{ t, text, cueStart, cueEnd, source, obsId }] — timestamps ms
  // commitFn(observation) → array of {text} committed at time obs.t (virtual)
  // VIRTUAL CLOCK: the TranscriptController's stability deadlines are wall-clock
  // based (Date.now()). During replay we pin Date.now() to each observation's
  // virtual timestamp so stability windows behave exactly as they would in a
  // real session (replayed faster in real time).
  const realNow = Date.now;
  Date.now = () => _currentVirtualT;
  let _currentVirtualT = 0;
  const commits = [];
  try {
    for (const o of obs) {
      _currentVirtualT = o.t;
      const out = commitFn(o);
      if (out && out.length) {
        for (const c of out) commits.push({ ...c, t: o.t, cueStart: c.cueStart != null ? c.cueStart : o.cueStart });
      }
    }
  } finally {
    Date.now = realNow;
  }
  return commits;
}

// ------------------------------------------------------------------
// Strategy 1 — legacy content.js style (per-cue stability + delta dispatch)
//   State per stream: lastText, lastChangeAt. On stable for 300 ms OR cue end:
//   send delta relative to LAST SENT text (content.js's wordOverlap logic).
//   No committed-prefix invariant — sliding windows may re-send overlap.
// ------------------------------------------------------------------
function makeLegacyStrategy() {
  let lastSent = [];      // words of the last dispatched delta
  let stableText = null;  // text currently being held for stability
  let stableSince = 0;
  let lastCueStart = null;
  const state = {
    onObservation(o) {
      const words = o.text.match(/\S+/g) || [];
      const textKey = words.join(' ');
      const cueChanged = lastCueStart !== null && o.cueStart !== lastCueStart;

      // (Re)start the stability window whenever the visible text changes.
      if (stableText !== textKey) { stableText = textKey; stableSince = o.t; }

      let out = [];
      const stable = o.t - stableSince >= 300;
      if (cueChanged || stable) {
        // wordOverlap: longest suffix of lastSent matching a prefix of words
        let overlapK = 0;
        const max = Math.min(lastSent.length, words.length);
        for (let k = max; k >= 2; k--) {
          let ok = true;
          for (let i = 0; i < k; i++) {
            if (norm(lastSent[lastSent.length - k + i]) !== norm(words[i])) { ok = false; break; }
          }
          if (ok) { overlapK = k; break; }
        }
        const delta = words.slice(overlapK);
        if (delta.length) {
          out.push({ text: delta.join(' '), cueStart: o.cueStart });
          lastSent = words.slice(); // legacy: window resets to latest observation
          stableText = null;        // dispatched — clear stability hold
        }
      }
      lastCueStart = o.cueStart;
      return out;
    },
  };
  return state;
}

// ------------------------------------------------------------------
// Strategy 2 — plain debounce (whole caption stability, no word logic)
//   Commit the ENTIRE newest visible text once unchanged for 300 ms.
//   Sliding windows re-send overlap → duplicates; corrections re-send too.
// ------------------------------------------------------------------
function makeDebounceStrategy() {
  let stableText = null;
  let stableSince = 0;
  const sent = [];   // committed texts, for duplicate suppression
  return {
    onObservation(o) {
      const words = o.text.match(/\S+/g) || [];
      const textKey = words.join(' ');
      if (stableText !== textKey) { stableText = textKey; stableSince = o.t; return []; }
      if (o.t - stableSince < 300) return [];
      if (sent[sent.length - 1] === textKey) return []; // identical re-send suppressed
      sent.push(textKey);
      stableSince = o.t; // hold until text changes again
      return [{ text: textKey, cueStart: o.cueStart }];
    },
  };
}

// ------------------------------------------------------------------
// Strategy 3 — Phase-2 controller, PRE-AUDIT semantics (replicated)
//   As found in the audit: 'same' clears pending; truncation/replace rewrite
//   committedPrefix without creating segments (speech loss).
// ------------------------------------------------------------------
function pushSeg(out, tc, pending, o, reason) {
  // commit path equivalent to _checkStability
  out.push({ text: pending });
  tc.committedPrefix = tc.committedPrefix ? tc.committedPrefix + ' ' + pending : pending;
  tc.committedWords = tc.committedPrefix.match(/\S+/g) || [];
  tc.uncommitted = '';
  tc.uncommittedFirstSeen = 0;
  tc.uncommittedObservations = 0;
  void reason;
}

function makePreAuditStrategy(minStabilityMs = 300, maxStabilityMs = 2000) {
  const tc = { committedPrefix: '', committedWords: [], uncommitted: '', uncommittedFirstSeen: 0, uncommittedObservations: 0 };
  return {
    onObservation(o) {
      const out = [];
      const text = o.text;
      const newWords = text.match(/\S+/g) || [];
      const pendingWords = (tc.uncommitted || '').match(/\S+/g) || [];
      const base = [...tc.committedWords, ...pendingWords];
      const baseline = base.map(norm);
      const next = newWords.map(norm);
      const bset = new Map();
      baseline.forEach((w) => bset.set(w, (bset.get(w) || 0) + 1));
      const removed = [], added = [];
      const nset = new Map();
      next.forEach((w) => nset.set(w, (nset.get(w) || 0) + 1));
      // multiset diff approximation (as pre-fix code used LCS-multiset semantics)
      for (const [w, c] of nset) {
        const b = bset.get(w) || 0;
        if (c > b) added.push(w);
      }
      for (const [w, c] of bset) {
        const n = nset.get(w) || 0;
        if (c > n) removed.push(w);
      }
      if (!added.length && !removed.length) { /* same */ tc.uncommitted = ''; }
      else if (!added.length) {
        // pre-audit: committed := new text wholesale, pending dropped
        tc.committedPrefix = text;
        tc.committedWords = newWords.slice();
        tc.uncommitted = '';
      } else if (!removed.length) {
        const addedText = added.join(' ');
        tc.uncommitted = tc.uncommitted ? tc.uncommitted + ' ' + addedText : addedText;
        if (!tc.uncommitted || pendingWords.length === 0) tc.uncommittedFirstSeen = o.t;
        tc.uncommittedObservations = (tc.uncommittedObservations || 0) + 1;
      } else {
        // replace: pre-audit bug — committed rewritten, pending cleared, NO segment
        tc.committedPrefix = text;
        tc.committedWords = newWords.slice();
        tc.uncommitted = '';
      }
      // stability commit (mirrors _checkStability)
      if (tc.uncommitted) {
        const stableMs = o.t - (tc.uncommittedFirstSeen || 0);
        const phrase = /[.!?…।।]+$/.test(tc.uncommitted.trim());
        const obsOk = (tc.uncommittedObservations >= 2 && stableMs >= minStabilityMs) ||
          stableMs >= maxStabilityMs || phrase;
        if (obsOk) pushSeg(out, tc, tc.uncommitted, o, 'stable');
      }
      return out.filter(c => c && c.text && c.text.trim());
    },
  };
}

// ------------------------------------------------------------------
// Strategy 4 — CURRENT (fixed) controller, driving the real TranscriptController
// ------------------------------------------------------------------
function makeCurrentStrategy(minStabilityMs = 300, maxStabilityMs = 2000) {
  const tc = new TranscriptController({
    config: { MIN_STABILITY_MS: minStabilityMs, MAX_STABILITY_MS: maxStabilityMs, MIN_OBSERVATIONS: 2 },
    log: false,
  });
  // Silence console
  const origLog = console.log;
  console.log = () => {};
  return {
    onObservation(o) {
      const cap = {
        id: o.obsId || `obs-${o.t}`,
        text: o.text, startTime: o.cueStart, endTime: o.cueEnd, duration: o.cueEnd - o.cueStart,
        source: o.source || 'texttrack', untimed: o.source === 'dom',
        capturedAt: o.wall || o.t, observedAt: o.wall || o.t,
        videoId: 'vid',
      };
      const valid = validateCaption(cap);
      if (!valid.ok) return [];
      const normalized = tc.ingestCaption(cap, o.source || 'texttrack', o.cueStart);
      const segs = tc.reconcile(normalized);
      return (segs || []).map((s) => ({ text: s.text, controller: true }));
    },
    controller: tc,
    _origLog: origLog,
  };
}

function norm(w) {
  return String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// ------------------------------------------------------------------
// Traces — (t, text, cueStart, cueEnd) with realistic observation cadence.
// Cue text observed every 250 ms while visible (YouTube DOM poll cadence).
// ------------------------------------------------------------------
function expandCue(cueTexts, cueStart, cueDur, obsEvery, gapAfter) {
  // Each sub-text is shown for an equal slice of the cue duration; YouTube
  // re-polls the visible text every ~250 ms while the cue is on screen.
  const obs = [];
  const subDur = cueDur / Math.max(1, cueTexts.length);
  let t = cueStart * 1000;
  const cueEndMs = (cueStart + cueDur) * 1000;
  for (let ci = 0; ci < cueTexts.length; ci++) {
    const text = cueTexts[ci];
    const subEndMs = (cueStart + (ci + 1) * subDur) * 1000;
    while (t < subEndMs - 1) {
      obs.push({ t, text, cueStart, cueEnd: subEndMs / 1000 });
      t += obsEvery;
    }
  }
  // Final observation at the very end of the cue.
  obs.push({ t: cueEndMs - 5, text: cueTexts[cueTexts.length - 1], cueStart, cueEnd: cueStart + cueDur });
  return { obs, gapAfter: gapAfter * 1000 };
}

function makeTrace1Progressive() {
  // Cue grows, completes; new cue with fresh sentence
  const cues = [
    expandCue(['Hello', 'Hello world', 'Hello world today'], 0, 3, 250, 0),
    expandCue(['the government is mulling'], 3.5, 3, 250, 0),
    expandCue(['the government is mulling a big tax cut'], 6.5, 3, 250, 0.5),
  ];
  return { name: 'progressive-growth', parts: cues };
}

function makeTrace2Sliding() {
  // Sliding word window: tail of previous becomes head of next
  const cues = [
    expandCue(['Here in India the'], 0, 2.5, 250, 0),
    expandCue(['in India the government'], 2.5, 2.5, 250, 0),
    expandCue(['the government is mulling'], 5, 2.5, 250, 0),
    expandCue(['mulling a big change'], 7.5, 2.5, 250, 0.5),
  ];
  return { name: 'sliding-window', parts: cues };
}

function makeTrace3Correction() {
  // ASR correction BEFORE stability (pending) and AFTER stability (committed)
  const cues = [
    expandCue(['the policy is definately', 'the policy is definately wrong'], 0, 3, 250, 0),
    // correction arrives while pending, then commit
    expandCue(['the policy is definitely wrong'], 3, 3, 250, 0),
    // correction AFTER commit
    expandCue(['the policy is definitely correct'], 6.5, 3, 250, 0.5),
  ];
  return { name: 'asr-correction', parts: cues };
}

function makeTrace4Repeat() {
  // Genuine repeated speech at later cue + same-cue re-observation noise
  const cues = [
    expandCue(['yeah okay'], 0, 2.5, 250, 0),
    expandCue(['yeah okay'], 3.5, 2.5, 250, 0),   // genuine repeat, later cue
    expandCue(['yeah okay'], 7, 2.5, 250, 0.5),   // repeat again
  ];
  return { name: 'repeated-speech', parts: cues };
}

function makeTrace5Gaps() {
  // Caption loss 10 s then recovery — no phantom duplicate of last committed
  const cues = [
    expandCue(['captions work fine here'], 0, 3, 250, 10),
    expandCue(['captions work fine here'], 13, 2.5, 250, 0), // reappears = re-show of same line?
    expandCue(['and audio continues'], 15.5, 3, 250, 0.5),
  ];
  return { name: 'stale-gap-recovery', parts: cues };
}

function makeTrace6Flap() {
  // Alternate quickly then settle (visual caption noise / OCR-ish flap)
  const cues = [
    expandCue(['hello'], 0, 1, 250, 0),
    expandCue(['world'], 1, 1, 250, 0),
    expandCue(['hello'], 2, 1, 250, 0),
    expandCue(['hello world'], 3, 3, 250, 0.5),
  ];
  return { name: 'flapping-captions', parts: cues };
}

// ------------------------------------------------------------------
// Pipeline evaluation of commit events (shared, virtual clock)
// ------------------------------------------------------------------
let opsCount = 0;
function evaluateCommits(trace, commits) {
  // Intermediate pipeline: commit at t → audio ready t+0.35+0.25, play at
  // max(targetStart, audioReadyAgeReached). 'targetStart' = commit source cue start.
  const metrics = { duplicates: 0, duplicationWords: 0, omissions: 0, correctionsAfterCommit: 0, fragments: 0, latencies: [], queueWaits: [], lateDiscarded: 0, plays: [] };
  const committedTexts = [];
  const committedAt = [];
  for (const c of commits) {
    const text = c.text.trim();
    if (!text) continue;
    committedTexts.push(text);
    committedAt.push(c);
  }
  // Duplicates: a commit is a duplicate if its word-set is contained in an
  // EARLIER commit's word-set within a 3 s cue-time window (same-cue re-show
  // or re-dispatch). Identical text at a LATER cue time is a genuine repeat,
  // not a duplicate — the repeat rule is time-scoped.
  const commitWords = committedTexts.map(t => new Set((t.match(/\S+/g) || []).map(norm)));
  for (let i = 1; i < committedTexts.length; i++) {
    opsCount++;
    const ci = committedAt[i];
    for (let j = 0; j < i; j++) {
      const cj = committedAt[j];
      // Same-cue re-show only: genuine repeats at a later cue time are
      // intended re-speech, not duplicates.
      const sameCueWindow = ci.cueStart != null && cj.cueStart != null
        && ci.cueStart === cj.cueStart;
      let contained = true;
      for (const w of commitWords[i]) if (!commitWords[j].has(w)) { contained = false; break; }
      if (contained && sameCueWindow) {
        metrics.duplicates++;
        metrics.duplicationWords += commitWords[j].size;
        break;
      }
    }
  }
  // Omissions: words of the final canonical cue text not in ANY commit
  const finalCueTexts = [];
  for (const part of trace.parts) {
    const lastObs = part.obs[part.obs.length - 1];
    finalCueTexts.push(lastObs.text);
  }
  const committedWords = new Set();
  for (const t of committedTexts) {
    for (const w of (t.match(/\S+/g) || [])) committedWords.add(norm(w));
  }
  const canonicalWords = [];
  for (const t of finalCueTexts) for (const w of (t.match(/\S+/g) || [])) canonicalWords.push(norm(w));
  let omitted = 0;
  for (const w of canonicalWords) {
    if (!committedWords.has(w)) omitted++;
    opsCount++;
  }
  metrics.omissions = omitted;

  // Latency + queue wait + late discard
  for (const c of commits) {
    const audioReady = c.t + TRANSLATE_MS + TTS_MS;
    const targetPlay = (c.cueStart != null ? c.cueStart * 1000 : c.t) + Math.max(LATE_THRESHOLD_S, 0);
    void targetPlay;
    // play at: audio available vs cue-based schedule: the scheduler leads by
    // AUDIO_LEAD and starts as soon as it can; if audioReady is after cueStart,
    // the segment plays late (measured latency).
    const schedAt = (c.cueStart != null ? c.cueStart * 1000 : c.t) + AUDIO_LEAD_S * 1000;
    const actualPlay = Math.max(audioReady, schedAt);
    if (audioReady - schedAt > LATE_THRESHOLD_S * 1000) { metrics.lateDiscarded++; continue; }
    metrics.plays.push({ at: actualPlay, text: c.text });
    metrics.queueWaits.push(Math.max(0, audioReady - c.t - (TRANSLATE_MS + TTS_MS))); // 0 by model
    metrics.latencies.push(actualPlay / 1000 - (c.cueStart || 0));
  }
  // Fragmentation: commits with < 4 words AND not a terminal sentence piece
  for (const c of commits) {
    const words = c.text.match(/\S+/g) || [];
    if (words.length < 4 && !/[.!?…।।]$/.test(c.text.trim())) {
      metrics.fragments++;
    }
  }
  return metrics;
}

function overlapWords(a, b) {
  const setA = new Set(a.map(norm));
  let ov = 0;
  for (const w of b) if (setA.has(norm(w)) && w.length > 2) ov++;
  return ov;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

const fmt = (v, digits = 1) => v == null ? '—' : (typeof v === 'number' ? v.toFixed(digits) : String(v));

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------
async function runBenchmark() {
  const traces = [
    makeTrace1Progressive(), makeTrace2Sliding(), makeTrace3Correction(),
    makeTrace4Repeat(), makeTrace5Gaps(), makeTrace6Flap(),
  ];
  // For each trace: collect per-part observations, replay as one stream in
  // virtual time; each strategy processes identical stream.
  const report = [];

  for (const trace of traces) {
    const stream = [];
    for (const part of trace.parts) {
      for (const o of part.obs) stream.push(o);
    }
    stream.sort((a, b) => a.t - b.t || 0);

    const rows = [];
    const strategies = [
      { name: 'legacy-delta', make: () => makeLegacyStrategy() },
      { name: 'debounce-300', make: () => makeDebounceStrategy() },
      { name: 'phase2-original', make: () => makePreAuditStrategy() },
      { name: 'fixed-current', make: () => makeCurrentStrategy() },
    ];
    for (const strat of strategies) {
      const s = strat.make();
      const t0 = process.hrtime.bigint();
      const heapBefore = process.memoryUsage().heapUsed;
      const commits = simulate(stream, (o) => s.onObservation(o));
      const heapAfter = process.memoryUsage().heapUsed;
      const dt = Number(process.hrtime.bigint() - t0) / 1e6;
      const m = evaluateCommits(trace, commits);
      rows.push({
        strategy: strat.name,
        n: commits.length,
        commits: commits.length,
        duplicates: m.duplicates,
        dupWords: m.duplicationWords,
        omissions: m.omissions,
        fragments: m.fragments,
        late: m.lateDiscarded,
        p50: percentile(m.latencies, 0.5),
        p95: percentile(m.latencies, 0.95),
        p99: percentile(m.latencies, 0.99),
        cpuMs: Math.round(dt * 10) / 10,
        memKB: Math.round((heapAfter - heapBefore) / 102.4) / 10,
      });
      if (s._origLog) console.log = s._origLog;
    }
    report.push({ trace: trace.name, rows });
  }

  // Print report
  for (const { trace, rows } of report) {
    console.log(`\n=== trace: ${trace} ===`);
    console.log('strategy          n   commits dup dups_wrds omit frag late | p50(s) p95(s) p99(s) cpu(ms) mem(kB)');
    for (const r of rows) {
      console.log(
        `${r.strategy.padEnd(17)} ${String(r.n).padStart(4)} ${String(r.commits).padStart(7)} ${String(r.duplicates).padStart(3)} ${String(r.dupWords).padStart(8)} ${String(r.omissions).padStart(4)} ${String(r.fragments).padStart(4)} ${String(r.late).padStart(4)} |  ${fmt(r.p50, 2)}  ${fmt(r.p95, 2)}  ${fmt(r.p99, 2)} ${String(Math.round(r.cpuMs * 100) / 100).padStart(6)} ${String(r.memKB).padStart(7)}`,
      );
    }
  }

  // Stability grid (fixed-current on the most latency-sensitive trace)
  console.log('\n=== stability grid (fixed-current, trace: progressive-growth) ===');
  {
    const trace = makeTrace1Progressive();
    const stream = [];
    for (const part of trace.parts) for (const o of part.obs) stream.push(o);
    stream.sort((a, b) => a.t - b.t);
    console.log('min(ms) max(ms) commits dup omit frg | p50(s) p95(s)');
    for (const [mn, mx] of [[100, 800], [150, 1500], [200, 1000], [300, 1500], [300, 2000], [500, 2500]]) {
      const s = makeCurrentStrategy(mn, mx);
      const commits = simulate(stream, (o) => s.onObservation(o));
      const m = evaluateCommits(trace, commits);
      if (s._origLog) console.log = s._origLog;
      console.log(
        `${String(mn).padStart(7)} ${String(mx).padStart(7)} ${String(commits.length).padStart(7)} ${String(m.duplicates).padStart(3)} ${String(m.omissions).padStart(4)} ${String(m.fragments).padStart(4)} | ${fmt(percentile(m.latencies, 0.5), 2)} ${fmt(percentile(m.latencies, 0.95), 2)}`,
      );
    }
  }

  console.log('\nnotes: translate=350ms tts=250ms (simulated constants); audio lead=300ms; late discard>3s');
  if (_sanityFail) { console.error(`SANITY FAILURES: ${_sanityFail}`); process.exit(1); }
  process.exit(0);
}

runBenchmark();
