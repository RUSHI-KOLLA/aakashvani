// AakashVani Transcript Controller — Phase 2: Revision-aware dubbing pipeline.
//
// Responsibilities:
//   - Caption ingestion and validation (YouTube TextTrack + DOM + ASR)
//   - Revision-aware transcript reconciliation (word-level alignment)
//   - Stability-aware text commitment (committed prefix + uncommitted pending)
//   - Phrase segmentation for low-latency TTS dispatch
//   - Segment lifecycle management (observed → committed → translating → synthesizing → queued → playing → completed)
//   - Duplicate/stale/out-of-order prevention
//   - Caption health monitoring and ASR fallback coordination
//
// Architecture (all in extension process):
//   content.js → TranscriptController → SyncController.enqueue() → TTS → TimelineScheduler → playback
//
// The TranscriptController maintains:
//   - committedPrefix: fully committed text ready for TTS
//   - uncommitted:   text observed but not yet committed (stability window)
//   - segments:      committed phrases awaiting translation/TTS/playback
//   - lifecycle:     per-segment state machine with cancel/invalidate support

const CONFIG = {
  // Stability: how long a token must survive unchanged before commitment
  MIN_STABILITY_MS: 300,          // min time a token must be unchanged
  MAX_STABILITY_MS: 2000,         // max wait before forced commitment
  MIN_OBSERVATIONS: 2,            // min consecutive observations of same text
  // Phrase segmentation
  MAX_PHRASE_CHARS: 120,          // max chars per phrase
  MAX_PHRASE_WAIT_MS: 2000,       // max wait before releasing a phrase (>= MAX_STABILITY_MS)
  MIN_PAUSE_CHARS: 40,            // min gap to treat as phrase boundary (chars)
  // Caption health
  STALE_CAPTION_MS: 5000,         // no new caption text → consider stale
  ASR_FALLBACK_MS: 8000,          // no usable caption → trigger ASR fallback
  // Dedup
  MAX_RECENT_IDS: 200,
};

// ---------------------------------------------------------------
// Word-level diff (Myers-style, bounded cost)
// ---------------------------------------------------------------

function _tokens(text) {
  return (text || '').match(/\S+/g) || [];
}

function _normWord(word) {
  return (word || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Compute a word-level diff between prev and next word arrays.
// Returns { added: string[], removed: string[], common: string[] } using a
// bounded LCS (longest common subsequence) approach. O(n*m) worst case but
// bounded by MAX_DIFF_LEN to avoid quadratic blowup on long captions.
const MAX_DIFF_LEN = 300;

function wordDiff(prevWords, nextWords) {
  const n = prevWords.length;
  const m = nextWords.length;
  if (n === 0) return { added: [...nextWords], removed: [], common: [] };
  if (m === 0) return { added: [], removed: [...prevWords], common: [] };

  // Bound lengths to avoid O(n*m) explosion on very long captions
  const p = prevWords.slice(0, MAX_DIFF_LEN);
  const q = nextWords.slice(0, MAX_DIFF_LEN);
  const pn = p.length;
  const qn = q.length;

  // LCS DP table (only two rows needed for length, but we need backtrace;
  // use full table but bounded)
  const dp = [];
  for (let i = 0; i <= pn; i++) dp[i] = new Array(qn + 1).fill(0);

  for (let i = 1; i <= pn; i++) {
    for (let j = 1; j <= qn; j++) {
      if (_normWord(p[i - 1]) === _normWord(q[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrace to find common, added, removed
  const common = [];
  const added = [];
  const removed = [];
  let i = pn, j = qn;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && _normWord(p[i - 1]) === _normWord(q[j - 1])) {
      common.unshift(p[i - 1]);
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added.unshift(q[j - 1]);
      j--;
    } else {
      removed.unshift(p[i - 1]);
      i--;
    }
  }

  return { added, removed, common };
}

// Length of the longest common word-prefix between two word arrays.
function _wordPrefixLen(wa, wb) {
  let len = 0;
  while (len < wa.length && len < wb.length && _normWord(wa[len]) === _normWord(wb[len])) {
    len++;
  }
  return len;
}

// Bug 11 fix: the committed chain accumulates residual commits, so a windowed
// cue's re-shown prefix can sit anywhere in recent history — not just at the
// index-0 prefix or the exact chain tail. Find the LONGEST prefix of the new
// window that appears as a contiguous run in the committed chain, preferring
// the most recent occurrence (rightmost start) so stale matches don't win.
function _recentRunAnchor(committedW, newWords) {
  const maxLen = Math.min(committedW.length, newWords.length);
  if (maxLen === 0) return 0;
  let best = 0;
  for (let s = committedW.length - 1; s >= 0; s--) {
    const cap = Math.min(maxLen, committedW.length - s);
    if (cap <= best) continue;
    let j = 0;
    while (j < cap && _normWord(committedW[s + j]) === _normWord(newWords[j])) j++;
    if (j > best) best = j;
    if (best === maxLen) break;
  }
  return best;
}

function _wordsEqualSeq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (_normWord(a[i]) !== _normWord(b[i])) return false;
  }
  return true;
}

function _isPrefixWords(prefix, seq) {
  if (prefix.length > seq.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (_normWord(prefix[i]) !== _normWord(seq[i])) return false;
  }
  return true;
}

function _isSuffixWords(suffix, seq) {
  if (suffix.length > seq.length) return false;
  for (let i = 0; i < suffix.length; i++) {
    if (_normWord(suffix[i]) !== _normWord(seq[seq.length - suffix.length + i])) return false;
  }
  return true;
}

// Length of the longest common word-prefix between two strings.
function _commonPrefixLen(a, b) {
  return _wordPrefixLen(_tokens(a), _tokens(b));
}

// ---------------------------------------------------------------
// Caption validation
// ---------------------------------------------------------------

const YOUTUBE_UI_STRINGS = /^(?:subtitles?|captions?|cc|auto-generated|english \(auto-generated\)|click for settings|settings|audio|quality|speed|theater|full screen|exit full screen|show transcript|hide transcript|autoplay|shuffle|like|dislike|share|save|download|about|press|question mark to access)$/i;

function isYouTubeUI(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (YOUTUBE_UI_STRINGS.test(t)) return true;
  // Must contain at least one letter or digit
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return false;
}

function validateCaption(caption) {
  if (!caption) return { ok: false, reason: 'empty' };
  const text = (caption.text || '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (isYouTubeUI(text)) return { ok: false, reason: 'youtube-ui' };
  if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, reason: 'no-speech-chars' };
  return { ok: true };
}

// ---------------------------------------------------------------
// TranscriptController
// ---------------------------------------------------------------

class TranscriptController {
  constructor(options = {}) {
    this.config = { ...CONFIG, ...options.config };

    // Committed transcript (safe for TTS)
    this.committedPrefix = '';       // string
    this.committedWords = [];        // word array for alignment baseline

    // Uncommitted pending text (stability window)
    this.uncommitted = '';           // string
    this.uncommittedStart = null;    // video time when uncommitted region began
    this.uncommittedFirstSeen = 0;   // Date.now() when current uncommitted text first appeared
    this.uncommittedObservations = 0; // consecutive observations of same uncommitted text
    this.uncommittedCueStart = null; // startTime of the cue that produced current uncommitted text

    // Segment lifecycle
    this.segments = [];              // array of segment objects
    this.segmentSeq = 0;             // monotonic sequence for segment IDs
    this.maxSegments = 50;

    // Caption health
    this._captionHealth = {
      source: null,           // 'texttrack' | 'dom' | 'asr' | null
      lastUpdate: 0,          // Date.now() of last usable caption
      staleSince: null,       // Date.now() when staleness began
      asrActive: false,       // whether ASR fallback is currently active
      consecutiveFailures: 0,
    };

    // Counters for observability
    this._counters = {
      captionsReceived: 0,
      captionsRejected: 0,
      wordsCommitted: 0,
      segmentsCreated: 0,
      segmentsCancelled: 0,
      segmentsPlayed: 0,
      fallbackActivations: 0,
      duplicateDispatchPrevented: 0,
      staleResponsesRejected: 0,
    };

    // Recent dispatched segment IDs (dedup)
    this._recentIds = new Set();

    // Cue-time|text signatures already dispatched — prevents duplicate dispatch
    // of the same caption observation while allowing GENUINE repeated speech
    // (same words spoken again at a later cue time) to be synthesized.
    this._recentSig = new Map();

    // Highest caption startTime whose content has been committed. A genuine
    // repeat must arrive at a strictly later cue time — re-observations of the
    // same cue (even after its text was committed incrementally) are suppressed
    // here, so the same speech is never synthesized twice.
    this._maxCommittedCueTime = null;

    // Callbacks (set by SyncController)
    this.onSegmentReady = null;    // (segment) => Promise<void>  translate+TTS
    this.onHealthChange = null;    // (health) => void
    this.onError = null;           // (error) => void
  }

  // ---------------------------------------------------------------
  // A. Caption ingestion and validation
  // ---------------------------------------------------------------

  ingestCaption(rawCaption, source = 'texttrack', videoTime = null) {
    this._counters.captionsReceived++;

    const validation = validateCaption(rawCaption);
    if (!validation.ok) {
      this._counters.captionsRejected++;
      this._log('debug', `caption rejected: ${validation.reason}`, { text: rawCaption.text, source });
      return null;
    }

    const text = cleanCaptionText(rawCaption.text || '');
    const startTime = rawCaption.startTime != null ? Number(rawCaption.startTime) : videoTime;
    const endTime = rawCaption.endTime != null ? Number(rawCaption.endTime) : null;
    const duration = rawCaption.duration != null ? Number(rawCaption.duration) :
      (endTime != null && startTime != null ? endTime - startTime : null);

    const caption = {
      id: rawCaption.id || `${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      startTime: startTime != null && Number.isFinite(startTime) ? startTime : null,
      endTime: endTime != null && Number.isFinite(endTime) ? endTime : null,
      duration,
      source,                          // 'texttrack' | 'dom' | 'asr'
      untimed: source === 'dom' || startTime == null,
      capturedAt: Date.now(),
      observedAt: Date.now(),
      videoIdentity: rawCaption.videoId || null,
    };

    this._captionHealth.source = source;
    this._captionHealth.lastUpdate = Date.now();
    this._captionHealth.staleSince = null;

    return caption;
  }

  // ---------------------------------------------------------------
  // B. Revision-aware transcript reconciliation
  // ---------------------------------------------------------------

  // Reconcile a newly observed caption against the current committed prefix
  // and uncommitted region. Returns a list of segment objects ready for TTS
  // dispatch, or null if nothing new to commit.
  //
  // Invariants:
  //   1. committedPrefix is append-only — a later observation can never rewrite
  //      committed text (that speech was already dispatched to TTS).
  //   2. Only the "active region" (words beyond the committed word prefix) may
  //      be edited by later observations, and always as a whole (latest
  //      observation wins for the pending region).
  //   3. Re-observing the same text mutates nothing but stable-observation
  //      counters — it can never produce a duplicate segment.
  //   4. Genuinely repeated speech (identical text arriving at a later, timed
  //      TextTrack cue) IS dispatched again — once per (cueTime, text) signature.
  //   5. When a new cue arrives (different startTime), pending text from the
  //      previous cue is committed if stable, or discarded if unstable.
  reconcile(caption) {
    if (!caption) return null;

    const { text, startTime } = caption;
    const newWords = _tokens(text);
    const committedW = this.committedWords.length ? this.committedWords : _tokens(this.committedPrefix);
    const pendingWords = _tokens(this.uncommitted);

    // Active region = words of the new observation beyond the committed prefix.
    // Strip both forward matches (index-0 prefix) and sliding-window overlaps
    // (new head matches committed tail) so windowed re-shows of already
    // committed words never re-enter the pending region (Bug 11 fix).
    const kw = Math.max(_wordPrefixLen(committedW, newWords), _recentRunAnchor(committedW, newWords));
    const residualWords = newWords.slice(kw);
    const residualText = residualWords.join(' ');

    let relation = 'new';
    let segments = [];

    // Detect cue change: if the new caption has a different startTime than the
    // cue that produced the current uncommitted text, treat it as a new cue.
    // For continuing speech (new cue, later startTime), commit the previous
    // pending text if stable, then start fresh with the new cue's residual.
    // For corrections (same cue ID), the relation logic below handles replace.
    const isNewCue = startTime != null &&
      this.uncommittedCueStart != null &&
      startTime >= this.uncommittedCueStart + 0.5; // >=500ms gap = new cue
    let didCueChangeAppend = false;
    if (isNewCue) {
      // New cue arrived: commit the previous pending text if stable.
      // Then start fresh with the new cue's residual words.
      if (this.uncommitted) {
        const stableMs = Date.now() - this.uncommittedFirstSeen;
        const obsCount = this.uncommittedObservations;
        const isStable = stableMs >= this.config.MIN_STABILITY_MS && obsCount >= this.config.MIN_OBSERVATIONS;
        
        if (isStable) {
          const committedSegments = this._commitPending(caption, 'cue-change');
          if (committedSegments) segments.push(...committedSegments);
        }
        // If not stable, discard the unstable pending (point 5 in invariants).
        // The new cue's residual will become the new pending.
      }
      
      // Start fresh with the new cue's residual words (beyond committed prefix).
      // The committed prefix has been updated (if committed), so residualWords is correct.
      this.uncommitted = residualText;
      this.uncommittedFirstSeen = residualText ? Date.now() : 0;
      this.uncommittedObservations = residualText ? 1 : 0;
      this.uncommittedCueStart = startTime;
      this._log('debug', `cue change: ${this.uncommitted ? 'new pending' : 'no pending'} from residual`);
      didCueChangeAppend = true;
    }

    // Relation is judged against the PENDING region (the active speech),
    // not against committed+pending as a single baseline: after a commit the
    // baseline contains window history that any new windowed cue "removes",
    // which previously churned the stability clock forever (Bug 11).
    // Skip relation logic if we did a cue-change append (already processed).
    const currentPendingWords = _tokens(this.uncommitted);
    if (!didCueChangeAppend) {
      if (_wordsEqualSeq(currentPendingWords, residualWords)) {
        // Exact repeat of the uncommitted active region — repeated observation.
        // Do NOT clear uncommitted text (Bug 1 fix); count it toward stability.
        relation = 'same';
        if (this.uncommitted) this.uncommittedObservations++;
      } else if (_isPrefixWords(currentPendingWords, residualWords)) {
        // Pure growth — append new words to pending WITHOUT resetting the
        // stability timer of words already pending.
        relation = 'growth';
        const addedText = residualWords.slice(currentPendingWords.length).join(' ');
        this.uncommitted = this.uncommitted ? this.uncommitted + ' ' + addedText : addedText;
        if (!currentPendingWords.length) {
          this.uncommittedFirstSeen = Date.now();
          this.uncommittedCueStart = startTime;
        }
        this.uncommittedObservations = (this.uncommittedObservations || 0) + 1;
      } else if (residualWords.length && _isPrefixWords(residualWords, currentPendingWords)) {
        // Retraction — the active region shrank: keep the remaining words
        // (latest observation wins for the pending region; Bug 5 fix).
        relation = 'truncation';
        this.uncommitted = residualText;
        this.uncommittedFirstSeen = Date.now();
        this.uncommittedObservations = 1;
        this.uncommittedCueStart = startTime;
      } else if (residualWords.length && _isSuffixWords(residualWords, currentPendingWords)) {
        // Repeated observation of the tail end of accumulated uncommitted text.
        // This happens when a cue's 2nd+ observation only contains the tail fragment
        // (e.g., accumulated "a young Christian convert", caption "convert" arrives again).
        relation = 'same';
        if (this.uncommitted) this.uncommittedObservations++;
      } else {
        // Correction/replace — the active region was edited: latest observation
        // wins for the pending region, committed text is untouched (Bug 2 fix).
        relation = 'replace';
        this.uncommitted = residualText;
        this.uncommittedFirstSeen = residualText ? Date.now() : 0;
        this.uncommittedObservations = residualText ? 1 : 0;
        this.uncommittedCueStart = residualText ? startTime : null;
      }
    } else {
      // Cue change append already updated uncommitted; count as growth observation
      relation = 'growth';
      this.uncommittedObservations = (this.uncommittedObservations || 0) + 1;
    }

    // Genuine repeated speech: identical text at a LATER timed TextTrack cue.
    // (DOM captions are untimed/capture-time-stamped and excluded: repeated DOM
    // polling of the same window would otherwise duplicate speech.)
    //
    // Rules:
    //   - Only a LATER cue time than the last committed cue counts as a repeat
    //     (re-observing the same cue after its text was committed is a re-poll,
    //      suppressed by the signature/cue-time rules below).
    //   - When commit-history cue time is unknown (committedPrefix seeded
    //     without a cue time, as in unit tests), allow an identical-text repeat
    //     but never a prefix re-show (Bug 2).
    //   - The (cueTime, text) signature suppresses re-observations within the
    //     same cue after the first dispatch.
    const laterCue = this._maxCommittedCueTime != null
      && caption.startTime > this._maxCommittedCueTime;
    const identicalRepeat = this._maxCommittedCueTime == null
      && _wordsEqualSeq(newWords, committedW);
    const sig = `${Math.round(caption.startTime * 2) / 2}|${text}`;
    if (relation === 'same' && !this.uncommitted && this.committedPrefix &&
        caption.startTime != null && !caption.untimed &&
        typeof caption.source === 'string' && caption.source.startsWith('texttrack') &&
        (laterCue || identicalRepeat) && !this._recentSig.has(sig)) {
      this._recentSig.set(sig, Date.now());
      this._evictSig();
      const segment = this._createSegment(text, caption, 'genuine-repeat');
      this.committedPrefix = this.committedPrefix ? this.committedPrefix + ' ' + text : text;
      this.committedWords = _tokens(this.committedPrefix);
      this._maxCommittedCueTime = caption.startTime;
      this._counters.wordsCommitted += newWords.length;
      this._counters.segmentsCreated++;
      segments.push(segment);
      this._log('debug', `genuine repeat committed: ${text.slice(0, 40)}`);
    }

    // Check stability for commitment (normal path)
    const segmentsFromStability = this._checkStability(caption);
    if (segmentsFromStability) segments.push(...segmentsFromStability);

    this._log('debug', `reconcile: relation=${relation}, committed=${this.committedPrefix.slice(0,40)}, pending=${this.uncommitted.slice(0,40)}`);

    return segments.length > 0 ? segments : null;
  }

  // Register a (cueTime, text) signature so the same commitment is never
  // duplicated, and evict old entries beyond MAX_RECENT_IDS.
  _rememberSig(caption, text) {
    if (caption && caption.startTime != null) {
      this._recentSig.set(`${Math.round(caption.startTime * 2) / 2}|${text}`, Date.now());
      this._evictSig();
    }
  }

  _evictSig() {
    while (this._recentSig.size > this.config.MAX_RECENT_IDS) {
      this._recentSig.delete(this._recentSig.keys().next().value);
    }
  }

  // ---------------------------------------------------------------
  // C. Stability-aware commitment
  // ---------------------------------------------------------------

  // Internal helper to commit the current pending text with a given reason.
  // Returns the created segment(s) or null if nothing to commit.
  _commitPending(caption, reason) {
    const pending = this.uncommitted;
    if (!pending) return null;

    // Duplicate guard: never commit the same pending text twice at the same
    // cueTime (signature registered below at first commit). Without this, a
    // cue whose text was committed incrementally (e.g. via residual commits)
    // re-pends on later re-observations and re-triggers stability forever
    // (Bug 11 — trailing duplicate commits per cue).
    const sig = caption && caption.startTime != null ? `${Math.round(caption.startTime * 2) / 2}|${pending}` : null;
    if (sig && this._recentSig.has(sig)) return null;

    // Commit the pending text as a segment
    const segment = this._createSegment(pending, caption, reason);
    this.committedPrefix = this.committedPrefix ?
      this.committedPrefix + ' ' + pending : pending;
    this.committedWords = _tokens(this.committedPrefix);
    this.uncommitted = '';
    this.uncommittedObservations = 0;
    this.uncommittedFirstSeen = 0;
    this.uncommittedCueStart = null;

    // Remember (cueTime,text) so the identical commitment can never repeat
    this._rememberSig(caption, pending);

    if (caption && caption.startTime != null &&
        (this._maxCommittedCueTime == null || caption.startTime > this._maxCommittedCueTime)) {
      this._maxCommittedCueTime = caption.startTime;
    }

    this._counters.wordsCommitted += _tokens(pending).length;
    this._counters.segmentsCreated++;

    return [segment];
  }

  _checkStability(caption) {
    const now = Date.now();
    const pending = this.uncommitted;
    if (!pending) return null;

    const stableMs = now - this.uncommittedFirstSeen;
    const obsCount = this.uncommittedObservations;
    const wordCount = _tokens(pending).length;

    // Determine if pending text is stable enough to commit
    let shouldCommit = false;
    let reason = '';

    // Check for phrase boundary (punctuation or phrase end)
    const phraseBoundary = this._detectPhraseBoundary(pending);
    if (phraseBoundary) {
      shouldCommit = true;
      reason = 'phrase-boundary';
    }
    // Max wait deadline — release best available
    else if (stableMs >= this.config.MAX_STABILITY_MS) {
      shouldCommit = true;
      reason = 'max-wait';
    }
    // Min stability + min observations — BUT NOT for short fragments (< 4 words)
    // without a phrase boundary. Short fragments should accumulate until
    // phrase boundary or max-wait to avoid fragmented dispatch.
    else if (stableMs >= this.config.MIN_STABILITY_MS && obsCount >= this.config.MIN_OBSERVATIONS) {
      if (wordCount >= 4 || phraseBoundary) {
        shouldCommit = true;
        reason = 'stable';
      }
    }

    if (!shouldCommit) return null;

    return this._commitPending(caption, reason);
  }

  _createSegment(text, sourceCaption, commitReason) {
    const seq = this.segmentSeq++;
    const id = `seg-${seq}-${Date.now().toString(36)}`;

    const now = Date.now();
    const segment = {
      id,
      seq,
      text,
      textLength: text.length,
      source: sourceCaption ? sourceCaption.source : 'unknown',
      sourceId: sourceCaption ? sourceCaption.id : null,
      startTime: sourceCaption && sourceCaption.startTime != null ? sourceCaption.startTime : null,
      endTime: sourceCaption && sourceCaption.endTime != null ? sourceCaption.endTime : null,
      duration: sourceCaption && sourceCaption.duration != null ? sourceCaption.duration :
        (sourceCaption && sourceCaption.startTime != null ? 3 : null),
      estimatedStart: sourceCaption && sourceCaption.startTime != null
        ? sourceCaption.startTime
        : (sourceCaption && sourceCaption.observedAt ? sourceCaption.observedAt / 1000 : null),
      capturedAt: sourceCaption ? sourceCaption.capturedAt : now,
      committedAt: now,
      commitReason,
      state: 'committed',   // committed → translating → synthesizing → queued → playing → completed
      provider: null,       // 'piper' | 'sarvam' | null
      audioBase64: null,
      durationSeconds: null,
      requestId: null,
      error: null,
      retries: 0,
      maxRetries: 2,
      cancelled: false,
      completed: false,
      timingConfidence: sourceCaption && sourceCaption.startTime != null ? 'high' : 'estimated',
      // Latency measurement timestamps (Research #1)
      timings: {
        // Source text availability (caption observed/committed)
        sourceAvailableAt: now,
        // Translation stage
        translationRequestedAt: null,
        translationCompletedAt: null,
        // TTS stage
        ttsRequestedAt: null,
        ttsCompletedAt: null,
        // Scheduling/playback
        scheduledAt: null,
        playbackStartedAt: null,
        playbackCompletedAt: null,
      },
      // Derived latency metrics (computed on completion)
      latency: {
        translationMs: null,
        ttsMs: null,
        totalPipelineMs: null,
        scheduledLatenessMs: null,  // actual playback start - target start
        bufferLeadMs: null,         // queuedAt - targetStart (negative = ready before target)
      },
    };

    this.segments.push(segment);
    this._boundSegments();

    return segment;
  }

  _detectPhraseBoundary(text) {
    // Punctuation that strongly indicates phrase end
    const endPunct = /[.!?।।…]+$/;
    if (endPunct.test(text.trim())) return true;
    // Clause boundary
    const clausePunct = /[,;:]$/;
    if (clausePunct.test(text.trim()) && text.length > this.config.MIN_PAUSE_CHARS) return true;
    return false;
  }

  _boundSegments() {
    while (this.segments.length > this.maxSegments) {
      const old = this.segments.shift();
      if (old.state === 'committed' || old.state === 'cancelled') {
        this._counters.segmentsCancelled++;
      }
    }
  }

  // ---------------------------------------------------------------
  // D. Segment lifecycle management
  // ---------------------------------------------------------------

  // Called by SyncController when a segment is dispatched for translation
  markTranslating(segmentId, provider) {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg || seg.state !== 'committed') return false;
    if (seg.cancelled) return false;
    seg.state = 'translating';
    seg.provider = provider;
    seg.translatingAt = Date.now();
    seg.timings.translationRequestedAt = seg.translatingAt;
    return true;
  }

  markSynthesizing(segmentId) {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg || seg.state !== 'translating') return false;
    seg.state = 'synthesizing';
    seg.synthesizingAt = Date.now();
    seg.timings.translationCompletedAt = seg.synthesizingAt;
    seg.timings.ttsRequestedAt = seg.synthesizingAt;
    return true;
  }

  markQueued(segmentId, audioBase64, durationSeconds, requestId) {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg || seg.state !== 'synthesizing') return false;
    if (seg.cancelled) return false;
    seg.state = 'queued';
    seg.audioBase64 = audioBase64;
    seg.durationSeconds = durationSeconds;
    seg.requestId = requestId;
    seg.queuedAt = Date.now();
    seg.timings.ttsCompletedAt = seg.queuedAt;
    // Calculate buffer lead: how early/late the segment is ready relative to target start
    if (seg.startTime != null) {
      seg.latency.bufferLeadMs = seg.queuedAt - (seg.startTime * 1000);
    }
    return true;
  }

  markPlaying(segmentId) {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg || seg.state !== 'queued') return false;
    seg.state = 'playing';
    seg.playingAt = Date.now();
    seg.timings.scheduledAt = seg.playingAt;
    seg.timings.playbackStartedAt = seg.playingAt;
    // Calculate scheduled lateness: actual playback start vs target start
    if (seg.startTime != null) {
      seg.latency.scheduledLatenessMs = seg.playingAt - (seg.startTime * 1000);
    }
    return true;
  }

  markCompleted(segmentId) {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg) return false;
    seg.state = 'completed';
    seg.completedAt = Date.now();
    seg.timings.playbackCompletedAt = seg.completedAt;
    // Calculate derived latency metrics
    if (seg.timings.translationRequestedAt && seg.timings.translationCompletedAt) {
      seg.latency.translationMs = seg.timings.translationCompletedAt - seg.timings.translationRequestedAt;
    }
    if (seg.timings.ttsRequestedAt && seg.timings.ttsCompletedAt) {
      seg.latency.ttsMs = seg.timings.ttsCompletedAt - seg.timings.ttsRequestedAt;
    }
    if (seg.timings.translationRequestedAt && seg.timings.ttsCompletedAt) {
      seg.latency.totalPipelineMs = seg.timings.ttsCompletedAt - seg.timings.translationRequestedAt;
    }
    this._counters.segmentsPlayed++;
    return true;
  }

  cancelSegment(segmentId, reason = 'cancelled') {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg) return false;
    if (seg.state === 'completed' || seg.state === 'cancelled') return false;
    seg.state = 'cancelled';
    seg.cancelReason = reason;
    seg.cancelledAt = Date.now();
    this._counters.segmentsCancelled++;
    return true;
  }

  markFailed(segmentId, error) {
    const seg = this.segments.find(s => s.id === segmentId);
    if (!seg) return false;
    seg.state = 'failed';
    seg.error = error;
    seg.failedAt = Date.now();
    return true;
  }

  // Get segments ready for playback (queued, not cancelled)
  getReadySegments() {
    return this.segments.filter(s => s.state === 'queued' && !s.cancelled);
  }

  // Get segment by ID
  getSegment(segmentId) {
    return this.segments.find(s => s.id === segmentId);
  }

  // Invalidate all pending (non-playing) segments for a caption correction
  invalidatePending(segmentIds) {
    for (const id of segmentIds) {
      this.cancelSegment(id, 'caption-correction');
    }
  }

  // ---------------------------------------------------------------
  // Caption health monitoring (for ASR fallback)
  // ---------------------------------------------------------------

  markCaptionHealthy(source) {
    this._captionHealth.source = source;
    this._captionHealth.lastUpdate = Date.now();
    this._captionHealth.staleSince = null;
    this._captionHealth.asrActive = false;
    this._captionHealth.consecutiveFailures = 0;
    this._notifyHealthChange();
  }

  markCaptionUnhealthy(reason) {
    this._captionHealth.consecutiveFailures++;
    if (!this._captionHealth.staleSince) {
      this._captionHealth.staleSince = Date.now();
    }
    this._notifyHealthChange();
  }

  activateASR() {
    this._captionHealth.asrActive = true;
    this._counters.fallbackActivations++;
    this._notifyHealthChange();
  }

  deactivateASR() {
    this._captionHealth.asrActive = false;
    this._notifyHealthChange();
  }

  isCaptionStale() {
    const now = Date.now();
    if (this._captionHealth.staleSince &&
        now - this._captionHealth.staleSince > this.config.ASR_FALLBACK_MS) {
      return true;
    }
    return false;
  }

  isCaptionDelayed() {
    const now = Date.now();
    return now - this._captionHealth.lastUpdate > this.config.STALE_CAPTION_MS;
  }

  _notifyHealthChange() {
    if (this.onHealthChange) {
      this.onHealthChange({ ...this._captionHealth });
    }
  }

  // ---------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------

  _log(level, msg, data = {}) {
    if (level === 'debug') {
      console.log(`[AakashVani:transcript] ${msg}`, data);
    } else if (level === 'warn') {
      console.warn(`[AakashVani:transcript] ${msg}`, data);
    }
  }

  getStats() {
    return {
      ...this._counters,
      committedWords: this.committedWords.length,
      uncommittedChars: this.uncommitted.length,
      pendingSegments: this.segments.filter(s => s.state === 'committed' || s.state === 'translating' || s.state === 'synthesizing' || s.state === 'queued').length,
      captionHealth: { ...this._captionHealth },
    };
  }

  // Get segment latency data for evidence report (Research #12)
  getSegmentLatencies() {
    return this.segments
      .filter(s => s.latency)
      .map(s => ({
        id: s.id,
        text: s.text,
        textLength: s.textLength,
        state: s.state,
        commitReason: s.commitReason,
        provider: s.provider,
        timings: s.timings,
        latency: s.latency,
      }));
  }

  getConfig() {
    return { ...this.config };
  }

  // Reset all state for seek/video navigation. Clears committed prefix,
  // uncommitted text, and all non-playing segments.
  reset() {
    this.committedPrefix = '';
    this.committedWords = [];
    this.uncommitted = '';
    this.uncommittedStart = null;
    this.uncommittedFirstSeen = 0;
    this.uncommittedObservations = 0;
    this.uncommittedCueStart = null;
    // Cancel all non-playing segments
    for (const seg of this.segments) {
      if (seg.state !== 'playing' && seg.state !== 'completed') {
        seg.state = 'cancelled';
        seg.cancelReason = 'seek';
        seg.cancelledAt = Date.now();
        this._counters.segmentsCancelled++;
      }
    }
    this.segments = this.segments.filter(s => s.state === 'playing' || s.state === 'completed');
    this._recentIds.clear();
    this._recentSig.clear();
    this._maxCommittedCueTime = null;
    this._captionHealth.staleSince = null;
    this._notifyHealthChange();
  }
}

// YouTube includes non-speech annotations such as [Music], (applause), and
// musical-note glyphs in caption text. Strip them so TTS never speaks them.
const NON_SPEECH_ANNOTATION = /\[[^\]]*(?:music|applause|laughter|inaudible|silence|sound effect|foreign|speaking foreign language)[^\]]*\]|\([^)]*(?:music|applause|laughter|inaudible|silence|sound effect|foreign|speaking foreign language)[^)]*\)/gi;
function cleanCaptionText(text) {
  return (text || '')
    .replace(NON_SPEECH_ANNOTATION, ' ')
    .replace(/[♪♫♬♩]+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Attach to window for Chrome extension MV3 (no module system in content scripts).
// Guarded so the Node-style module.exports line never executes in the browser,
// which would throw "Uncaught ReferenceError: module is not defined".
if (typeof window !== 'undefined') {
  window.TranscriptController = TranscriptController;
  window.AV_CONFIG = CONFIG;
  window.AV_validateCaption = validateCaption;
  window.AV_wordDiff = wordDiff;
  window.AV_cleanCaptionText = cleanCaptionText;
}

// CommonJS export for test harnesses that require() this file directly.
// Only reachable outside a browser (no `window`), so it cannot conflict with
// the window attachment above or trigger the ReferenceError in extension pages.
if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
  module.exports = { TranscriptController, CONFIG, validateCaption, wordDiff, cleanCaptionText };
}
