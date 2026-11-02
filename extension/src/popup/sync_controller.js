// AakashVani sync controller — timeline-based audio synchronization.
// Translation + TTS for segment N+1 overlap while segment N is playing.
// Timeline scheduler synchronizes audio segments to YouTube video timeline.
//
// Phase 2: TranscriptController handles caption ingestion, revision-aware
// reconciliation, stability-aware commitment, and phrase segmentation.
// SyncController handles segment lifecycle: translate → TTS → playback scheduling.
//
// TranscriptController is loaded as a global (window.TranscriptController)
// via manifest.json content_scripts ordering.

class TimelineScheduler {
  constructor() {
    this.segments = [];
    this.currentIndex = 0;
    this.video = null;
    this._monitorTimer = null;
    this._tickTimer = null;
    this.duckLevel = 10;
    this._prevVolume = null;
    this._generation = 0;
    // Monotonic sequence number assigned to each segment added to this scheduler.
    this._segmentSeq = 0;
    // Structured per-segment lifecycle log (for observability / regression).
    this.segmentLog = [];
    // Per-segment metrics counters.
    this._segmentMetrics = {
      segmentsAdded: 0,
      segmentsPlayed: 0,
      segmentsDiscarded: 0,
      segmentsRescheduled: 0,
      duplicateDiscards: 0,
      outOfOrder: 0,
      totalLatenessMs: 0,
      latenessSamples: 0,
    };
    // Optional hook: called when a segment's audio finishes (playing → completed)
    // SyncController uses it to advance the TranscriptController lifecycle.
    this.onSegmentCompleted = null;
    // Optional hook: called when a segment starts playing (queued → playing)
    this.onSegmentPlaying = null;
    // Optional hook: called when a segment starts playing with timing info
    this.onSegmentPlaybackTiming = null;
    // Optional hook: called when a segment is discarded as missed (too late)
    this.onSegmentMissed = null;
    // Optional hook: called when a segment is discarded as stale (too late for policy)
    this.onStaleDrop = null;
  }

  setGeneration(gen) {
    this._generation = gen;
  }

  // ---- Structured per-segment lifecycle logging (Research #4 / #12) ----
  logSegment(segmentId, event, extra = {}) {
    this.segmentLog.push({
      segment_id: segmentId,
      event,
      generation: this._generation,
      ts: Date.now(),
      ...extra,
    });
    // Keep the log bounded.
    if (this.segmentLog.length > 2000) {
      this.segmentLog = this.segmentLog.slice(-1000);
    }
  }

  // Get a snapshot of per-segment logs and aggregate metrics.
  getSegmentMetrics() {
    const m = this._segmentMetrics;
    const avgLateness = m.latenessSamples > 0 ? m.totalLatenessMs / m.latenessSamples : 0;
    const sorted = [...this.segmentLog]
      .filter((e) => e.event === 'played')
      .map((e) => e.latenessMs)
      .filter((v) => v != null);
    const p90 = sorted.length
      ? sorted.sort((a, b) => a - b)[Math.ceil(0.9 * sorted.length) - 1]
      : 0;
    return {
      segmentsAdded: m.segmentsAdded,
      segmentsPlayed: m.segmentsPlayed,
      segmentsDiscarded: m.segmentsDiscarded,
      segmentsRescheduled: m.segmentsRescheduled,
      duplicateDiscards: m.duplicateDiscards,
      outOfOrder: m.outOfOrder,
      avgLatenessMs: Math.round(avgLateness),
      p90LatenessMs: Math.round(p90),
      pendingSegments: this.segments.filter(
        (s) => s.state === 'ready' || s.state === 'playing'
      ).length,
      queueDepth: this.segments.length,
      segmentLog: this.segmentLog,
    };
  }

  // Invalidate all segments from previous generations (Research #6)
  invalidateStaleGenerations(currentGeneration) {
    let invalidated = 0;
    for (const seg of this.segments) {
      if (seg.generation < currentGeneration && (seg.state === 'ready' || seg.state === 'playing')) {
        seg.state = 'discarded';
        this._cleanupSegment(seg);
        this._segmentMetrics.segmentsDiscarded++;
        this.logSegment(seg.id, 'discarded', {
          sequence_number: seg.sequenceNumber,
          generation: seg.generation,
          drop_reason: 'stale-generation',
          caption_text: (seg.caption.text || '').slice(0, 120),
        });
        invalidated++;
      }
    }
    if (invalidated > 0) {
      console.log(`[AakashVani] invalidated ${invalidated} stale segments from generation < ${currentGeneration}`);
      // Reset currentIndex to re-scan from beginning
      this.currentIndex = 0;
    }
    return invalidated;
  }

  setVideo(video) { this.video = video; }

  // Lower/restore background video volume while a dub segment is playing.
  duck(on) {
    const v = this.video;
    if (!v) return;
    if (on) {
      if (this._prevVolume === null) this._prevVolume = v.volume;
      v.volume = Math.max(0, Math.min(1, (this.duckLevel ?? 10) / 100));
    } else if (this._prevVolume !== null) {
      v.volume = this._prevVolume;
      this._prevVolume = null;
    }
  }

  // Start a periodic tick so segments play at their scheduled time even when
  // no caption/TTS event fires between now and the segment's targetStart.
  startTickMonitor() {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this.tick(), 100);
  }

  stopTickMonitor() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
  }

  // ---- P0-1: Insert sorted by targetStart — completion order never affects playback order ----
  // ---- Fix 3: Duplicate segment prevention — discard older segment if overlap + similar text ----
  addSegment(caption, audioBase64) {
    const seg = this._makeSegment(caption, audioBase64);
    const newText = (caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, '');

    // Helper: check if two texts are truly duplicates (same content)
    // NOT similar - sliding window captions have suffix/prefix overlap but are NOT duplicates.
    function textsDuplicate(a, b) {
      if (a === b) return true;
      // One is substring of the other WITHOUT significant addition = duplicate
      // "hello" vs "hello world" = NOT duplicate (growth)
      // "hello world" vs "hello" = duplicate (correction to shorter)
      if (a.length > 5 && a.includes(b) && a.length - b.length < 10) return true;
      if (b.length > 5 && b.includes(a) && b.length - a.length < 10) return true;
      return false;
    }

    // Helper: check if new text is a GROWTH of existing text (contains it + significant addition)
    function isGrowth(existing, incoming) {
      return incoming.startsWith(existing) && incoming.length > existing.length + 10;
    }

    // Helper: check if new text is a SLIDING WINDOW continuation of existing text
    // (new text starts with the end of existing text, then adds new content).
    // Require len < incoming.length: if the incoming text is entirely a suffix of
    // the existing text it adds no speech and must not count as a continuation.
    function isSlidingWindowContinuation(existing, incoming) {
      if (!incoming || incoming === existing) return false;
      const minLen = Math.min(existing.length, incoming.length, 80);
      for (let len = minLen; len >= 15; len--) {
        if (len < incoming.length && incoming.startsWith(existing.slice(-len))) return true;
      }
      return false;
    }

    // Check for overlapping segments with DUPLICATE text — discard the older one.
    // Never interrupt a segment that is currently playing; that would cut audio
    // off midway. Instead, skip the new segment when a playing segment covers
    // the same time range with duplicate content.
    // Use full time-range overlap (not just targetStart proximity).
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const existing = this.segments[i];
      if (existing.state === 'discarded' || existing.state === 'completed' || existing.state === 'playing') continue;
      const existText = (existing.caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, '');
      // Full time-range overlap: segments overlap if neither is completely before the other
      const timeOverlap = !(existing.targetEnd <= seg.targetStart || seg.targetEnd <= existing.targetStart);
      if (timeOverlap && textsDuplicate(existText, newText)) {
        // Discard the older segment, keep the new one
        existing.state = 'discarded';
        this._cleanupSegment(existing);
        this._segmentMetrics.segmentsDiscarded++;
        this._segmentMetrics.duplicateDiscards++;
        this.logSegment(existing.id, 'discarded', {
          sequence_number: existing.sequenceNumber,
          generation: existing.generation,
          drop_reason: 'duplicate',
          caption_text: (existing.caption.text || '').slice(0, 120),
        });
        console.log(`[AakashVani] duplicate segment discarded: "${existing.caption.text.slice(0,40)}" (overlap @ ${existing.targetStart.toFixed(1)}s)`);
      }
    }

    // If a playing segment already covers this time range, check if new segment
    // is a duplicate, growth, or sliding window continuation.
    const isPlayingOverlap = this.segments.some(s =>
      s.state === 'playing' &&
      !(s.targetEnd <= seg.targetStart || seg.targetEnd <= s.targetStart)
    );
    if (isPlayingOverlap) {
      // Check if any playing segment has duplicate content
      const hasDuplicate = this.segments.some(s =>
        s.state === 'playing' &&
        !(s.targetEnd <= seg.targetStart || seg.targetEnd <= s.targetStart) &&
        textsDuplicate(
          (s.caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, ''),
          newText
        )
      );
      // Check if new segment is a growth of any playing segment
      const isGrowthOfPlaying = this.segments.some(s =>
        s.state === 'playing' &&
        !(s.targetEnd <= seg.targetStart || seg.targetEnd <= s.targetStart) &&
        isGrowth(
          (s.caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, ''),
          newText
        )
      );
      // Check if new segment is a sliding window continuation of any playing segment
      const isSlidingWindowOfPlaying = this.segments.some(s =>
        s.state === 'playing' &&
        !(s.targetEnd <= seg.targetStart || seg.targetEnd <= s.targetStart) &&
        isSlidingWindowContinuation(
          (s.caption.text || '').trim().toLowerCase().replace(/[.!?।।…\u0964\u0965]+$/, ''),
          newText
        )
      );
      // Skip only if duplicate AND not growth AND not sliding window continuation
      if (hasDuplicate && !isGrowthOfPlaying && !isSlidingWindowOfPlaying) {
        console.log(`[AakashVani] skipping duplicate segment while audio playing: "${seg.caption.text.slice(0,40)}"`);
        return;
      }
      // Allow growth and sliding window continuations (will play after current finishes)
    }

    let insertIdx = this.segments.length;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].targetStart > seg.targetStart) {
        insertIdx = i;
        break;
      }
    }
    this.segments.splice(insertIdx, 0, seg);
    // If we inserted before currentIndex, bump it so we don't skip
    if (insertIdx <= this.currentIndex) this.currentIndex = insertIdx;
  }

  _makeSegment(caption, audioBase64) {
    const audio = this._createAudio(audioBase64);
    // Prefer the caption's captured start time even for DOM (untimed) captions.
    // content.js records video.currentTime when the caption first appears, so
    // scheduling from that point compensates for translation/TTS latency.
    // Only fall back to the current video time when no capture time exists.
    let targetStart, targetEnd;
    if (caption.startTime != null) {
      targetStart = caption.startTime;
      targetEnd = caption.endTime != null
        ? caption.endTime
        : targetStart + (caption.duration || 3);
    } else {
      targetStart = this.video ? this.video.currentTime : 0;
      targetEnd = targetStart + (caption.duration || 3);
    }
    // Stable segment ID for centralized scheduling (Research #4)
    const segmentId = caption.id || `seg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Monotonic sequence number within this playback generation.
    const sequenceNumber = this._segmentSeq++;
    // Target language for language-switch tracking (Research #8)
    const targetLanguage = this._targetLanguage || (this.settings && this.settings.language) || 'te-IN';
    const generation = this._generation || 0;
    const segment = {
      id: segmentId,
      sequenceNumber,
      generation,
      caption,
      audio,
      targetStart,
      targetEnd,
      // Preserve the original intended start time for latency tracking
      originalTargetStart: targetStart,
      state: 'ready',
      scheduledAt: null,
      targetLanguage,
    };
    this._segmentMetrics.segmentsAdded++;
    // Pull pipeline timing from the transcript segment (committedAt and the
    // translation/TTS stage timestamps recorded by TranscriptController).
    const timings = caption && caption.timings ? caption.timings : {};
    this.logSegment(segmentId, 'added', {
      sequence_number: sequenceNumber,
      generation,
      source_start: targetStart,
      source_end: targetEnd,
      commit_time: caption && caption.committedAt != null ? caption.committedAt : null,
      translation_start: timings.translationRequestedAt,
      translation_end: timings.translationCompletedAt,
      tts_start: timings.ttsRequestedAt,
      tts_end: timings.ttsCompletedAt,
      caption_text: (caption.text || '').slice(0, 120),
      target_language: targetLanguage,
    });
    return segment;
  }

  _createAudio(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true;
    audio._blobUrl = url;
    return audio;
  }

  // ---- P1-5: Invalidate segments whose captionId matches (correction arrived) ----
  invalidateSegmentsByCaptionId(captionId) {
    for (const seg of this.segments) {
      if (seg.caption.id === captionId && (seg.state === 'ready' || seg.state === 'pending')) {
        seg.state = 'discarded';
        this._cleanupSegment(seg);
        console.log(`[AakashVani] invalidated stale segment: ${seg.caption.id} "${seg.caption.text.slice(0,40)}"`);
      }
    }
  }

  // ---- Fix 4: Audio lead time (300ms) to compensate for processing latency ----
  static AUDIO_LEAD = 0.3;

  // Segments arriving more than this many seconds late are skipped (stale audio).
  static LATE_AUDIO_THRESHOLD = 3.0;

  // Late segment policy (Research #5): 'drop' | 'play' | 'compress' | 'reschedule'
  // - 'drop': discard late segments (default, current behavior)
  // - 'play': play late segments immediately (may overlap)
  // - 'compress': play with time-compression (playbackRate > 1)
  // - 'reschedule': shift to play as soon as possible (causes overlapping audio — use with caution)
  static LATE_POLICY = 'drop';

  // Maximum additional delay (seconds) a rescheduled late segment may introduce
  // before it is considered obsolete and dropped. Prevents unbounded catch-up.
  static MAX_RESCHEDULE_DELAY = 8.0;

  tick() {
    if (!this.video || this.video.paused) return;
    const now = this.video.currentTime;

    // ---- B3: Explicit seek detection ----
    if (this._lastVideoTime !== undefined && Math.abs(now - this._lastVideoTime) > 1.5) {
      // Large jump = seek; reset to find correct segment
      this.currentIndex = 0;
      this._lastVideoTime = now;
      this.stopTickMonitor();
      // Fall through to re-evaluate
    }
    this._lastVideoTime = now;

    // Single pass: advance past completed/discarded, play ready-at-time, discard stale
    while (this.currentIndex < this.segments.length) {
      const seg = this.segments[this.currentIndex];

      // Skip segments from stale generations (Research #6)
      if (seg.generation < this._generation) {
        if (seg.state === 'ready' || seg.state === 'playing') {
          seg.state = 'discarded';
          this._cleanupSegment(seg);
          this._segmentMetrics.segmentsDiscarded++;
          this.logSegment(seg.id, 'discarded', {
            sequence_number: seg.sequenceNumber,
            generation: seg.generation,
            drop_reason: 'stale-generation',
            caption_text: (seg.caption.text || '').slice(0, 120),
          });
          console.log(`[AakashVani] discarded stale-generation segment: "${seg.caption.text.slice(0,40)}" (gen ${seg.generation} < ${this._generation})`);
        }
        this.currentIndex++;
        continue;
      }

      // Skip completed/discarded
      if (seg.state === 'completed' || seg.state === 'discarded') {
        this.currentIndex++;
        continue;
      }

      // Skip segments that arrived too late for their target time
      if (seg.state === 'ready') {
        const playAt = seg.targetStart - TimelineScheduler.AUDIO_LEAD;
        const lateBy = now - playAt;
        if (lateBy > TimelineScheduler.LATE_AUDIO_THRESHOLD) {
          // Apply late segment policy (Research #5)
          switch (TimelineScheduler.LATE_POLICY) {
            case 'play':
              // Play immediately despite being late
              console.log(`[AakashVani] late segment playing immediately (${lateBy.toFixed(1)}s late): "${seg.caption.text.slice(0,40)}"`);
              this._playSegment(this.currentIndex);
              break;
            case 'compress':
              // Play with time compression to catch up
              console.log(`[AakashVani] late segment playing with compression (${lateBy.toFixed(1)}s late): "${seg.caption.text.slice(0,40)}"`);
              this._playSegment(this.currentIndex, true);
              break;
            case 'reschedule':
              // Reschedule to play as soon as possible without advancing currentIndex,
              // so the segment is picked up on the next tick and played immediately.
              // Only reschedule if the segment is still valid (same generation,
              // not superseded) and the catch-up delay is bounded.
              const catchUpDelay = now - seg.targetStart;
              const stillValid = seg.generation === this._generation;
              if (!stillValid) {
                // Obsolete generation (seek/language switch) — drop instead.
                seg.state = 'discarded';
                this._cleanupSegment(seg);
                this._segmentMetrics.segmentsDiscarded++;
                this.logSegment(seg.id, 'discarded', {
                  sequence_number: seg.sequenceNumber,
                  generation: seg.generation,
                  drop_reason: 'obsolete-generation',
                  caption_text: (seg.caption.text || '').slice(0, 120),
                });
                this.currentIndex++;
                console.log(`[AakashVani] stale segment discarded (obsolete generation ${seg.generation} < ${this._generation}): "${seg.caption.text.slice(0,40)}"`);
                if (this.onStaleDrop) {
                  try { this.onStaleDrop(seg); } catch (_) {}
                }
                continue;
              }
              if (catchUpDelay > TimelineScheduler.MAX_RESCHEDULE_DELAY) {
                // Too far behind — playing it would create unbounded delay.
                seg.state = 'discarded';
                this._cleanupSegment(seg);
                this._segmentMetrics.segmentsDiscarded++;
                this.logSegment(seg.id, 'discarded', {
                  sequence_number: seg.sequenceNumber,
                  generation: seg.generation,
                  source_start: seg.targetStart,
                  source_end: seg.targetEnd,
                  lateness_ms: lateBy * 1000,
                  catch_up_delay_ms: catchUpDelay * 1000,
                  drop_reason: 'catch-up-too-long',
                  segment_status: 'discarded',
                  caption_text: (seg.caption.text || '').slice(0, 120),
                });
                this.currentIndex++;
                console.log(`[AakashVani] stale segment discarded (catch-up ${catchUpDelay.toFixed(1)}s > max ${TimelineScheduler.MAX_RESCHEDULE_DELAY}s): "${seg.caption.text.slice(0,40)}"`);
                if (this.onStaleDrop) {
                  try { this.onStaleDrop(seg); } catch (_) {}
                }
                continue;
              }
              console.log(`[AakashVani] late segment rescheduled (${lateBy.toFixed(1)}s late, catch-up ${catchUpDelay.toFixed(1)}s): "${seg.caption.text.slice(0,40)}"`);
              this._segmentMetrics.segmentsRescheduled++;
              this.logSegment(seg.id, 'rescheduled', {
                sequence_number: seg.sequenceNumber,
                generation: seg.generation,
                source_start: seg.originalTargetStart,
                source_end: seg.targetEnd,
                lateness_ms: lateBy * 1000,
                catch_up_delay_ms: catchUpDelay * 1000,
                segment_status: 'rescheduled',
                caption_text: (seg.caption.text || '').slice(0, 120),
              });
              seg.targetStart = now + TimelineScheduler.AUDIO_LEAD;
              seg.targetEnd = seg.targetStart + (seg.caption.duration || 3);
              // Do NOT advance currentIndex — next tick will play this segment.
              this.startTickMonitor();
              continue;
            case 'drop':
            default:
              // Discard late segments (default behavior)
              seg.state = 'discarded';
              this._cleanupSegment(seg);
              this._segmentMetrics.segmentsDiscarded++;
              this.logSegment(seg.id, 'discarded', {
                sequence_number: seg.sequenceNumber,
                generation: seg.generation,
                source_start: seg.targetStart,
                source_end: seg.targetEnd,
                lateness_ms: lateBy * 1000,
                drop_reason: 'stale-late',
                segment_status: 'discarded',
                caption_text: (seg.caption.text || '').slice(0, 120),
              });
              this.currentIndex++;
              console.log(`[AakashVani] stale segment discarded (${lateBy.toFixed(1)}s late): "${seg.caption.text.slice(0,40)}"`);
              if (this.onSegmentMissed) {
                try { this.onSegmentMissed(seg); } catch (_) {}
              }
              if (this.onStaleDrop) {
                try { this.onStaleDrop(seg); } catch (_) {}
              }
              continue;
          }
        } else if (now >= playAt) {
          this._playSegment(this.currentIndex);
        } else {
          // Play time hasn't arrived yet — start periodic tick so the segment
          // plays at the correct time even if no caption/TTS event fires.
          this.startTickMonitor();
        }
        break; // Only play one at a time; next tick will advance
      }

      // Segment is playing — check for completion or stale
      if (seg.state === 'playing') {
        const audioDone = seg.audio.currentTime >= seg.audio.duration - 0.1;
        const videoPastEnd = now > seg.targetEnd + 1.0;

        if (audioDone) {
          seg.state = 'completed';
          this._cleanupSegment(seg);
          if (this.onSegmentCompleted) {
            try { this.onSegmentCompleted(seg); } catch (_) {}
          }
          this.currentIndex++;
          continue; // Check next segment in same tick
        }

        if (videoPastEnd && !audioDone) {
          // Video moved past segment but audio still playing — let it finish
        }
      }

      break; // Stop at first non-advanced segment
    }

    // Stop periodic tick when no segments are pending playback
    const hasPending = this.segments.some(
      s => (s.state === 'ready' || s.state === 'playing') && s.generation >= this._generation
    );
    if (!hasPending) {
      this.stopTickMonitor();
    }
  }

  _playSegment(index, compress = false) {
    const seg = this.segments[index];
    if (seg.state !== 'ready') return;
    seg.state = 'playing';
    seg.scheduledAt = Date.now();
    seg.audio.playbackRate = compress ? 1.5 : 1.0;  // Time compression for late segments
    seg.audio.preservesPitch = true;
    // Lower background video volume while the dub segment is speaking.
    this.duck(true);
    // Notify TranscriptController: queued → playing
    if (this.onSegmentPlaying) {
      try { this.onSegmentPlaying(seg); } catch (_) {}
    }
    // Track playback timing for prefetch stats (Research #2)
    // Use originalTargetStart for accurate lateness relative to original video timeline
    const originalStart = seg.originalTargetStart ?? seg.targetStart;
    const playAt = originalStart - TimelineScheduler.AUDIO_LEAD;
    const now = this.video ? this.video.currentTime : Date.now() / 1000;
    const latenessMs = (now - playAt) * 1000;
    if (this.onSegmentPlaybackTiming) {
      try { this.onSegmentPlaybackTiming(seg, latenessMs); } catch (_) {}
    }
    const done = () => {
      if (seg.state !== 'playing') return;
      seg.state = 'completed';
      try { URL.revokeObjectURL(seg.audio._blobUrl); } catch (_) {}
      // Restore background video volume once the dub segment finishes.
      this.duck(false);
      // TranscriptController lifecycle: playing → completed
      if (this.onSegmentCompleted) {
        try { this.onSegmentCompleted(seg); } catch (_) {}
      }
      // B4: Do NOT call tick() here — let main loop drive
    };
    seg.audio.onended = done;
    seg.audio.onerror = done;
    seg.audio.play().catch(done);
    this._segmentMetrics.segmentsPlayed++;
    this._segmentMetrics.totalLatenessMs += latenessMs;
    this._segmentMetrics.latenessSamples++;
    this.logSegment(seg.id, 'played', {
      sequence_number: seg.sequenceNumber,
      generation: seg.generation,
      source_start: originalStart,
      source_end: seg.targetEnd,
      scheduled_time: playAt,
      actual_play_time: now,
      lateness_ms: latenessMs,
      segment_status: 'playing',
      caption_text: (seg.caption.text || '').slice(0, 120),
    });
    console.log(`[AakashVani] playing segment @ ${originalStart.toFixed(2)}s (compress=${compress}, lateness=${latenessMs.toFixed(0)}ms): ${seg.caption.text.slice(0,40)}`);
  }

  _cleanupSegment(seg) {
    try {
      seg.audio.pause();
      seg.audio.src = '';
      URL.revokeObjectURL(seg.audio._blobUrl);
    } catch (_) {}
  }

  checkDrift() {
    // B2: Disabled — playbackRate changes desync targetStart/targetEnd wall-clock times
    // Instead rely on tick() re-evaluation and segment completion detection
  }

  clear() {
    if (this._monitorTimer) { clearInterval(this._monitorTimer); this._monitorTimer = null; }
    this.segments.forEach(s => this._cleanupSegment(s));
    this.segments = [];
    this.currentIndex = 0;
  }
}

class SyncController {
  constructor() {
    this.settings = { ducking: 10, mode: 'auto', ttsBackend: 'piper', asrFallback: false };
    this.queue = [];
    this.inflight = [];
    this.playing = false;
    this.video = null;
    this.prevVolume = null;
    this.LOOKAHEAD = 3;
    this._lastBanner = 0;
    this._lastErr = null;
    this._generation = 0;
    this.scheduler = new TimelineScheduler();
    this._checkpointBuffer = [];
    this._checkpointBufferMax = 10;

    // Prefetch effectiveness tracking (Research #2)
    this._prefetchStats = {
      segmentsPrepared: 0,
      segmentsPlayedOnTime: 0,
      segmentsPlayedLate: 0,
      segmentsMissed: 0,
      totalBufferLeadMs: 0,
      bufferLeadSamples: 0,
    };

    // Language switching latency measurement (Research #8)
    this._languageSwitchStats = {
      currentLanguage: this.settings.language || 'te-IN',
      switchInitiatedAt: null,
      firstNewLanguageAudioAt: null,
      lastOldLanguageAudioAt: null,
      switchCount: 0,
      totalAckToFirstAudioMs: 0,
      totalFirstToLastOldMs: 0,
    };

    // Resource bounds tracking (Research #11)
    this._resourceStats = {
      maxQueueDepth: 0,
      maxInFlight: 0,
      maxSchedulerSegments: 0,
      currentQueueDepth: 0,
      currentInFlight: 0,
      currentSchedulerSegments: 0,
      underruns: 0,
      staleDrops: 0,
      cancellations: 0,
      cacheEvictions: 0,
    };

    // Initialize scheduler's target language
    this.scheduler._targetLanguage = this.settings.language || 'te-IN';

    // ---- ASR fallback state (opt-in via popup toggle; off unless enabled) ----
    this._asrActive = false;      // capture currently running
    this._asrRequestedAt = 0;     // cooldown for auto (re)activation
    this._asrFailures = 0;        // consecutive activation failures → backoff
    this._asrSeq = 0;             // monotonic ASR transcript id

    // C3: LRU cache for translation + TTS
    this._translationCache = new Map();
    this._ttsCache = new Map();
    this._cacheMax = 50;

    chrome.storage.local.get(['ducking', 'mode', 'ttsBackend', 'apiKey', 'asrFallback'], (s) => {
      this.settings = { ...this.settings, ...s };
      this.settings.asrFallback = !!this.settings.asrFallback;
      this.scheduler.duckLevel = this.settings.ducking ?? 10;
    });

    // Phase 2: TranscriptController for revision-aware caption pipeline
    // (Available globally when loaded via manifest content_scripts ordering.)
    if (typeof TranscriptController !== 'undefined') {
      this.transcriptController = new TranscriptController({
        config: {
          MIN_STABILITY_MS: 300,
          MAX_STABILITY_MS: 2000,
          MIN_OBSERVATIONS: 2,
          MAX_PHRASE_CHARS: 120,
          MAX_PHRASE_WAIT_MS: 1500,
          MIN_PAUSE_CHARS: 40,
          STALE_CAPTION_MS: 5000,
          ASR_FALLBACK_MS: 8000,
        },
      });

      // Wire TranscriptController callbacks
      this.transcriptController.onHealthChange = (health) => {
        this._onCaptionHealthChange(health);
      };
      this.transcriptController.onError = (error) => {
        console.warn('[AakashVani] transcript error:', error);
      };

      // TranscriptController lifecycle: playing → completed when audio ends.
      // scheduler segments carry the enqueued Segment object as .caption.
      this.scheduler.onSegmentCompleted = (schedSeg) => {
        const id = schedSeg && schedSeg.caption && schedSeg.caption.id;
        if (id && this.transcriptController) {
          this.transcriptController.markCompleted(id);
        }
      };
      // TranscriptController lifecycle: queued → playing when audio starts.
      this.scheduler.onSegmentPlaying = (schedSeg) => {
        const id = schedSeg && schedSeg.caption && schedSeg.caption.id;
        if (id && this.transcriptController) {
          this.transcriptController.markPlaying(id);
        }
      };
      // Track playback timing for prefetch effectiveness (Research #2)
      this.scheduler.onSegmentPlaybackTiming = (schedSeg, latenessMs) => {
        if (latenessMs <= 100) {  // Within 100ms of target = on time
          this._prefetchStats.segmentsPlayedOnTime++;
        } else {
          this._prefetchStats.segmentsPlayedLate++;
        }
        // Track language switch timing (Research #8)
        const segLang = schedSeg.targetLanguage;
        if (segLang && this._languageSwitchStats.switchInitiatedAt) {
          if (segLang === this._languageSwitchStats.currentLanguage && !this._languageSwitchStats.firstNewLanguageAudioAt) {
            this._languageSwitchStats.firstNewLanguageAudioAt = Date.now();
            const ackToFirstMs = this._languageSwitchStats.firstNewLanguageAudioAt - this._languageSwitchStats.switchInitiatedAt;
            this._languageSwitchStats.totalAckToFirstAudioMs += ackToFirstMs;
            console.log(`[AakashVani] First new-language audio: ${segLang} (${ackToFirstMs}ms after switch)`);
          } else if (segLang !== this._languageSwitchStats.currentLanguage) {
            this._languageSwitchStats.lastOldLanguageAudioAt = Date.now();
            // If we have both first new and last old, calculate transition time
            if (this._languageSwitchStats.firstNewLanguageAudioAt) {
              const firstToLastMs = this._languageSwitchStats.lastOldLanguageAudioAt - this._languageSwitchStats.firstNewLanguageAudioAt;
              this._languageSwitchStats.totalFirstToLastOldMs += firstToLastMs;
              console.log(`[AakashVani] Language transition complete: ${firstToLastMs}ms from first new to last old`);
              // Reset for next switch
              this._languageSwitchStats.switchInitiatedAt = null;
              this._languageSwitchStats.firstNewLanguageAudioAt = null;
              this._languageSwitchStats.lastOldLanguageAudioAt = null;
            }
          }
        }
      };
      // Track missed segments (Research #2)
      this.scheduler.onSegmentMissed = (schedSeg) => {
        this._prefetchStats.segmentsMissed++;
      };
      // Track stale drops (Research #11)
      this.scheduler.onStaleDrop = (schedSeg) => {
        this._resourceStats.staleDrops++;
      };
    } else {
      this.transcriptController = null;
    }

    chrome.storage.onChanged.addListener((ch) => {
      if (ch.ducking) {
        this.settings.ducking = ch.ducking.newValue;
        this.scheduler.duckLevel = ch.ducking.newValue;
      }
      if (ch.mode) {
        this.settings.mode = ch.mode.newValue;
        if (ch.mode.newValue === 'off') this.flush();
      }
      if (ch.language) {
        // C5: Clear checkpoint buffer on language change
        // Also increment generation to invalidate in-flight work for old language (Research #6, #8)
        const newLanguage = ch.language.newValue;
        const oldLanguage = this.settings.language;
        if (oldLanguage && oldLanguage !== newLanguage) {
          // Track language switch timing (Research #8)
          this._languageSwitchStats.switchInitiatedAt = Date.now();
          this._languageSwitchStats.currentLanguage = newLanguage;
          this._languageSwitchStats.firstNewLanguageAudioAt = null;
          this._languageSwitchStats.lastOldLanguageAudioAt = null;
          this._languageSwitchStats.switchCount++;
          console.log(`[AakashVani] Language switch initiated: ${oldLanguage} → ${newLanguage}`);
        }
        this._generation++;
        this.scheduler.setGeneration(this._generation);
        this.scheduler.invalidateStaleGenerations(this._generation);
        // Update scheduler's target language for new segments
        this.scheduler._targetLanguage = newLanguage;
        console.log('[AakashVani] Language changed — clearing checkpoint buffer, caches, and invalidating stale segments');
        this._checkpointBuffer = [];
        this._translationCache.clear();
        this._ttsCache.clear();
      }
      if (ch.apiKey) {
        // C7: API key change — persist latest value so Sarvam TTS requests
        // use the current key without requiring an extension reload.
        this.settings.apiKey = ch.apiKey.newValue;
      }
      if (ch.ttsBackend) {
        // C6: Provider switch — update setting and clear TTS cache so stale
        // audio from the previous provider is never reused.
        const prev = this.settings.ttsBackend;
        this.settings.ttsBackend = ch.ttsBackend.newValue;
        this._ttsCache.clear();
        console.log(
          `[AakashVani] TTS backend switched: ${prev} → ${this.settings.ttsBackend} — TTS cache cleared`
        );
      }
      if (ch.asrFallback !== undefined) {
        const prev = this.settings.asrFallback;
        this.settings.asrFallback = !!ch.asrFallback.newValue;
        // Turning the toggle off must also stop any active capture
        if (prev === true && this.settings.asrFallback === false && this._asrActive) {
          this._deactivateAsr('setting-disabled');
        }
      }
    });

    // C1: Listen for checkpoint progress from service worker — auto-retry when ready.
    // Also receives ASR_RESULT (service worker → here → transcript pipeline).
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'CHECKPOINT_PROGRESS' && msg.status === 'ready') {
        console.log('[AakashVani] Checkpoint ready for', msg.lang, '— retrying buffered captions');
        this.retryCheckpointBuffer();
      }
      if (msg.type === 'ASR_RESULT') {
        this.ingestAsr(msg.text, msg);
      }
      if (msg.type === 'ASR_ERROR') {
        this._handleAsrError(msg);
      }
    });
  }

  attach(videoEl) {
    this.video = videoEl;
    this.scheduler.setVideo(videoEl);
  }

  enqueue(caption) {
    if (!caption) return;
    if (this.settings.mode === 'off') return;
    const text = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
    if (!text) return;
    const MAX_QUEUE = 8;
    if (this.queue.length >= MAX_QUEUE) {
      console.warn(`[AakashVani] queue full (8) — dropping oldest`);
      this.queue.shift();
      this._resourceStats.staleDrops++;
    }
    // Dedup by caption ID (stable) not by text
    const cid = caption.id || '';
    const isDuplicate = this.queue.some(q => (q.id || '') === cid) ||
      this.inflight.some(p => p._aakashCid === cid) ||
      this.scheduler.segments.some(s => (s.caption.id || '') === cid && (s.state === 'ready' || s.state === 'playing' || s.state === 'pending' || s.state === 'completed'));
    if (isDuplicate) return;
    this.queue.push(caption);
    // Track resource usage (Research #11)
    this._updateResourceStats();
    // Don't pump TTS while video is paused — avoids generating dubs that would
    // burst into playback all at once on resume. Pumping resumes in resumeDubbed().
    if (!this.video || !this.video.paused) {
      this.pumpPipeline();
    }
    this.scheduler.tick();
  }

  _updateResourceStats() {
    const rs = this._resourceStats;
    rs.currentQueueDepth = this.queue.length;
    rs.currentInFlight = this.inflight.length;
    rs.currentSchedulerSegments = this.scheduler.segments.filter(s => s.state !== 'completed' && s.state !== 'discarded').length;
    rs.maxQueueDepth = Math.max(rs.maxQueueDepth, rs.currentQueueDepth);
    rs.maxInFlight = Math.max(rs.maxInFlight, rs.currentInFlight);
    rs.maxSchedulerSegments = Math.max(rs.maxSchedulerSegments, rs.currentSchedulerSegments);
  }

  // Phase 2: Ingest a caption through the revision-aware transcript pipeline.
  // Accepts a caption object (from content.js) with id, text, startTime, etc.
  // Returns segments ready for translation+TTS, or null if waiting for stability.
  ingestCaption(caption) {
    if (this.settings.mode === 'off') return null;
    // If TranscriptController is not available (e.g. test sandbox), fall back
    // to direct enqueue.
    if (!this.transcriptController) {
      this.enqueue(caption);
      return [caption];
    }

    const source = caption.source || 'texttrack';
    const videoTime = caption.startTime != null ? caption.startTime : null;

    const cap = this.transcriptController.ingestCaption(caption, source, videoTime);
    if (!cap) return null;

    const segments = this.transcriptController.reconcile(cap);
    if (!segments || segments.length === 0) return null;

    // Enqueue each committed segment through the existing pipeline
    for (const segment of segments) {
      this.enqueue(segment);
    }
    return segments;
  }

  // Phase 2: Caption health change handler
  _onCaptionHealthChange(health) {
    if (health.asrActive) {
      console.log('[AakashVani] caption health: ASR fallback active');
    }
    const fallbackMs = this.transcriptController ? this.transcriptController.config.ASR_FALLBACK_MS : 8000;
    if (health.staleSince && Date.now() - health.staleSince > fallbackMs) {
      console.warn('[AakashVani] captions stale — ASR fallback may be needed');
      this._maybeActivateAsr('captions-stale');
    } else if (!health.staleSince && this._asrActive && health.source === 'texttrack') {
      // Captions recovered: stop ASR to save CPU — transcript dedup prevents
      // double speech between the two sources.
      this._deactivateAsr('captions-recovered');
    }
  }

  // ---------------------------------------------------------------
  // ASR fallback coordination (opt-in only — never silent, never automatic
  // model downloads; the backend loads Whisper weights on first request).
  // ---------------------------------------------------------------

  ASR_RETRY_MS() { return 30000; }

  async _maybeActivateAsr(reason) {
    if (!this.settings.asrFallback) return;               // user opt-in required
    if (this._asrActive) return;                            // already running
    const now = Date.now();
    // Cooldown + failure backoff (2^n * 10 s, capped 3 min)
    const backoff = Math.min(3 * 60000, Math.pow(2, this._asrFailures) * 10000);
    if (now - this._asrRequestedAt < backoff) return;
    this._asrRequestedAt = now;
    console.log(`[AakashVani] requesting ASR fallback (${reason}) attempt=${this._asrFailures + 1}`);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ASR_ENABLE' });
      if (resp && resp.ok) {
        this._asrActive = true;
        this._asrFailures = 0;
        if (this.transcriptController) this.transcriptController.activateASR();
        console.log('[AakashVani] ASR fallback activated');
      } else {
        const code = resp && resp.error && resp.error.code ? resp.error.code : 'asr_unknown';
        this._handleAsrError(resp && resp.error ? resp.error : { code, message: 'ASR start failed' });
      }
    } catch (e) {
      this._handleAsrError({ code: 'asr_transport_error', message: String(e.message || e) });
    }
  }

  async _deactivateAsr(reason) {
    if (!this._asrActive) return;
    this._asrActive = false;
    if (this.transcriptController) this.transcriptController.deactivateASR();
    try {
      await chrome.runtime.sendMessage({ type: 'ASR_DISABLE' });
      if (reason && reason !== 'setting-disabled') {
        console.log(`[AakashVani] ASR fallback deactivated (${reason})`);
      }
    } catch (_) {}
  }

  _handleAsrError(err) {
    const code = err && err.code ? err.code : 'asr_error';
    const message = err && err.message ? err.message : 'ASR error';
    this._asrFailures++;
    // Permission/capability failures are terminal for auto-retry: pause the
    // fallback (never loops prompts) until the user re-toggles.
    const terminal = code === 'asr_tabcapture_unavailable' || code === 'asr_permission_denied';
    if (terminal) {
      this._asrActive = false;
      if (this.transcriptController) this.transcriptController.deactivateASR();
    }
    console.warn(`[AakashVani] ASR error (${code}): ${message}`);
    // Re-show the same error at most once per 20 s (banner timeout window).
    // The banner is UI-only: a rendering failure must never corrupt the
    // error accounting above.
    const now = Date.now();
    try {
      if (!this._lastAsrBanner || now - this._lastAsrBanner > 20000) {
        this._lastAsrBanner = now;
        this.showBanner(`ASR fallback unavailable (${code}): ${message}`);
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------
  // ASR transcript ingestion — same reconciliation path as captions.
  // Committed words are append-only, so text that captions already processed
  // is suppressed ('same' relation); new ASR-only speech commits to segments.
  // ---------------------------------------------------------------
  ingestAsr(text, meta = {}) {
    if (!text || typeof text !== 'string') return null;
    if (this.settings.mode === 'off') return null;
    if (!this.video) return null;
    this._asrSeq++;
    const caption = {
      id: `asr-chunk-${this._asrSeq}`,
      text: text.trim(),
      startTime: this.video.currentTime,
      endTime: null,
      duration: 2,
      source: 'asr',
      capturedAt: Date.now(),
    };
    return this.ingestCaption(caption);
  }

  pumpPipeline() {
    while (this.inflight.length < this.LOOKAHEAD && this.queue.length > 0) {
      const caption = this.queue.shift();
      const text = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
      const gen = this._generation;
      const p = this.processLine(caption, gen)
        .then((result) => {
          if (gen !== this._generation) {
            if (result && result.audioBase64) { try { const tmp = this.makeAudio(result.audioBase64); URL.revokeObjectURL(tmp.url); } catch (_) {} }
            return;
          }
          if (result && result.audioBase64) {
            this.scheduler.addSegment(caption, result.audioBase64);
            this.scheduler.tick();
            // Track prefetch: segment prepared, measure buffer lead
            this._prefetchStats.segmentsPrepared++;
            if (caption.startTime != null && this.video) {
              const bufferLeadMs = (caption.startTime - this.video.currentTime) * 1000;
              this._prefetchStats.totalBufferLeadMs += bufferLeadMs;
              this._prefetchStats.bufferLeadSamples++;
            }
            // Lifecycle: queued → playing
            if (caption.seq !== undefined && this.transcriptController) {
              this.transcriptController.markPlaying(caption.id);
            }
          }
        })
        .catch((e) => {
          if (gen !== this._generation) return null;
          const now = Date.now();
          if (!this._lastErr || this._lastErr.msg !== e.message || now - this._lastErr.t > 30000) {
            console.warn(`[AakashVani] segment failed | text=${JSON.stringify(text).slice(0, 80)} | error:`, e.message);
            this._lastErr = { msg: e.message, t: now };
          }
          return null;
        })
        .finally(() => {
          this.inflight = this.inflight.filter((x) => x !== p);
          this._updateResourceStats();
          this.pumpPipeline();
        });
      p._aakashCid = caption.id || '';
      this.inflight.push(p);
      this._updateResourceStats();
    }
  }

  // Get prefetch effectiveness stats (Research #2)
  getPrefetchStats() {
    const s = this._prefetchStats;
    const avgBufferLead = s.bufferLeadSamples > 0 ? s.totalBufferLeadMs / s.bufferLeadSamples : 0;
    const onTimeRate = s.segmentsPrepared > 0 ? (s.segmentsPlayedOnTime / s.segmentsPrepared) * 100 : 0;
    return {
      segmentsPrepared: s.segmentsPrepared,
      segmentsPlayedOnTime: s.segmentsPlayedOnTime,
      segmentsPlayedLate: s.segmentsPlayedLate,
      segmentsMissed: s.segmentsMissed,
      avgBufferLeadMs: Math.round(avgBufferLead),
      onTimeRatePercent: Math.round(onTimeRate),
    };
  }

  // Get language switch latency stats (Research #8)
  getLanguageSwitchStats() {
    const s = this._languageSwitchStats;
    const avgAckToFirst = s.switchCount > 0 ? s.totalAckToFirstAudioMs / s.switchCount : 0;
    const avgFirstToLastOld = s.switchCount > 0 ? s.totalFirstToLastOldMs / s.switchCount : 0;
    return {
      currentLanguage: s.currentLanguage,
      switchCount: s.switchCount,
      avgAckToFirstAudioMs: Math.round(avgAckToFirst),
      avgFirstToLastOldAudioMs: Math.round(avgFirstToLastOld),
      lastSwitchInitiatedAt: s.switchInitiatedAt,
      lastFirstNewLanguageAudioAt: s.firstNewLanguageAudioAt,
      lastOldLanguageAudioAt: s.lastOldLanguageAudioAt,
    };
  }

  // Get resource usage stats (Research #11)
  getResourceStats() {
    const rs = this._resourceStats;
    return {
      maxQueueDepth: rs.maxQueueDepth,
      maxInFlight: rs.maxInFlight,
      maxSchedulerSegments: rs.maxSchedulerSegments,
      currentQueueDepth: rs.currentQueueDepth,
      currentInFlight: rs.currentInFlight,
      currentSchedulerSegments: rs.currentSchedulerSegments,
      underruns: rs.underruns,
      staleDrops: rs.staleDrops,
      cancellations: rs.cancellations,
      cacheEvictions: rs.cacheEvictions,
    };
  }

  // Comprehensive end-to-end evidence report (Research #12)
  getEvidenceReport() {
    const prefetch = this.getPrefetchStats();
    const langSwitch = this.getLanguageSwitchStats();
    const resources = this.getResourceStats();
    const transcriptStats = this.transcriptController ? this.transcriptController.getStats() : null;
    
    // Collect segment latency data from transcript controller
    let segmentLatencies = [];
    let wordLoss = 0;
    let duplicateIncidents = 0;
    let overlapIncidents = 0;
    
    if (this.transcriptController) {
      const segments = this.transcriptController.segments || [];
      for (const seg of segments) {
        if (seg.latency) {
          segmentLatencies.push({
            id: seg.id,
            translationMs: seg.latency.translationMs,
            ttsMs: seg.latency.ttsMs,
            totalPipelineMs: seg.latency.totalPipelineMs,
            scheduledLatenessMs: seg.latency.scheduledLatenessMs,
            bufferLeadMs: seg.latency.bufferLeadMs,
            state: seg.state,
            commitReason: seg.commitReason,
          });
        }
        if (seg.state === 'cancelled') wordLoss += seg.textLength || 0;
      }
      
      // Count duplicate/overlap incidents from counters
      duplicateIncidents = transcriptStats.duplicateDispatchPrevented || 0;
    }
    
    // Calculate latency percentiles
    const calcPercentile = (arr, p) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil(p / 100 * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    };
    
    const translationLatencies = segmentLatencies.map(s => s.translationMs).filter(v => v != null);
    const ttsLatencies = segmentLatencies.map(s => s.ttsMs).filter(v => v != null);
    const totalLatencies = segmentLatencies.map(s => s.totalPipelineMs).filter(v => v != null);
    const latenessValues = segmentLatencies.map(s => s.scheduledLatenessMs).filter(v => v != null);
    const bufferLeadValues = segmentLatencies.map(s => s.bufferLeadMs).filter(v => v != null);
    
    return {
      timestamp: Date.now(),
      prefetch: prefetch,
      languageSwitch: langSwitch,
      resources: resources,
      transcript: transcriptStats,
      latency: {
        translation: {
          count: translationLatencies.length,
          p50: calcPercentile(translationLatencies, 50),
          p95: calcPercentile(translationLatencies, 95),
          p99: calcPercentile(translationLatencies, 99),
        },
        tts: {
          count: ttsLatencies.length,
          p50: calcPercentile(ttsLatencies, 50),
          p95: calcPercentile(ttsLatencies, 95),
          p99: calcPercentile(ttsLatencies, 99),
        },
        totalPipeline: {
          count: totalLatencies.length,
          p50: calcPercentile(totalLatencies, 50),
          p95: calcPercentile(totalLatencies, 95),
          p99: calcPercentile(totalLatencies, 99),
        },
        scheduledLateness: {
          count: latenessValues.length,
          p50: calcPercentile(latenessValues, 50),
          p95: calcPercentile(latenessValues, 95),
          p99: calcPercentile(latenessValues, 99),
        },
        bufferLead: {
          count: bufferLeadValues.length,
          p50: calcPercentile(bufferLeadValues, 50),
          p95: calcPercentile(bufferLeadValues, 95),
          p99: calcPercentile(bufferLeadValues, 99),
        },
      },
      quality: {
        segmentsTotal: segmentLatencies.length,
        segmentsCompleted: segmentLatencies.filter(s => s.state === 'completed').length,
        segmentsCancelled: segmentLatencies.filter(s => s.state === 'cancelled').length,
        segmentsFailed: segmentLatencies.filter(s => s.state === 'failed').length,
        wordLossChars: wordLoss,
        duplicateIncidents,
        overlapIncidents,
      },
      segments: segmentLatencies,
    };
  }

  async processLine(caption, genAtStart) {
    if (genAtStart !== undefined && genAtStart !== this._generation) return null;
    const settings = this.settings;
    const rawText = typeof caption === 'string' ? caption.trim() : (caption.text || '').trim();
    if (!rawText) return null;

    const lang = settings.language || 'te-IN';
    const cacheKey = `${rawText}|${lang}|${settings.mode || 'auto'}`;

    // C3: Check translation cache
    let translated = this._translationCache.get(cacheKey);
    if (!translated) {
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: 'TRANSLATE',
          text: rawText,
          language: lang,
          mode: settings.mode || 'auto',
          apiKey: settings.apiKey || '',
        });
      } catch (e) {
        if (genAtStart !== undefined && genAtStart !== this._generation) return null;
        console.warn(`[AakashVani] TRANSLATE transport error:`, e.message);
        return null;
      }
      if (genAtStart !== undefined && genAtStart !== this._generation) return null;
      if (!res) return null;
      if (!res.ok) {
        const errMsg = res.error && res.error.message ? res.error.message : (res.error || 'translation failed');
        console.warn(`[AakashVani] TRANSLATE failed | text=${JSON.stringify(rawText).slice(0, 80)} | server: ${errMsg}`);
        if (caption.seq !== undefined && this.transcriptController) {
          this.transcriptController.markFailed(caption.id, errMsg);
        }
        throw new Error(errMsg);
      }
      translated = res.translated;
      if (!translated) return null;
      // Cache translation
      if (this._translationCache.size >= this._cacheMax) {
        const firstKey = this._translationCache.keys().next().value;
        this._translationCache.delete(firstKey);
        this._resourceStats.cacheEvictions++;
      }
      this._translationCache.set(cacheKey, translated);
    }

    if (genAtStart !== undefined && genAtStart !== this._generation) return null;

    if (genAtStart !== undefined && genAtStart !== this._generation) return null;

    // Resolve TTS backend BEFORE lifecycle marking (backend is used below for
    // both markTranslating metadata and the TTS cache key).
    const backend = this.settings.ttsBackend || 'piper';

    // Lifecycle: committed → translating
    if (caption.seq !== undefined && this.transcriptController) {
      this.transcriptController.markTranslating(caption.id, backend);
    }

    // C3: Check TTS cache — key includes backend/provider so Piper and Sarvam
    // audio for the same text+lang never collide.
    const ttsCacheKey = `${translated}|${lang}|${backend}`;
    let audioBase64 = this._ttsCache.get(ttsCacheKey);
    let ttsDuration = null;
    let ttsRequestId = null;
    if (!audioBase64) {
      let tts;
      try {
        tts = await chrome.runtime.sendMessage({ type: 'TTS_ONLY', text: translated, language: lang, backend, apiKey: settings.apiKey || '' });
      } catch (e) {
        if (genAtStart !== undefined && genAtStart !== this._generation) return null;
        console.warn(`[AakashVani] TTS transport error:`, e.message);
        return null;
      }
      if (!tts) return null;
      if (!tts.ok) {
        const errMsg = tts.error || '';
        if (errMsg.startsWith('checkpoint_preparing:')) {
          const missingLang = errMsg.split(':')[1];
          console.warn(`[AakashVani] TTS checkpoint preparing for ${missingLang} — buffering segment`);
          if (this._checkpointBuffer.length < this._checkpointBufferMax) {
            this._checkpointBuffer.push({ caption, genAtStart, translated });
          }
          if (caption.seq !== undefined && this.transcriptController) {
            this.transcriptController.markFailed(caption.id, errMsg);
          }
          return null;
        }
        console.warn(`[AakashVani] TTS failed (${tts.error?.slice(0, 120)}) | text=${JSON.stringify(translated).slice(0, 80)}`);
        if (caption.seq !== undefined && this.transcriptController) {
          this.transcriptController.markFailed(caption.id, tts.error);
        }
        throw new Error(tts.error);
      }
      audioBase64 = tts.audio;
      ttsDuration = tts.duration_seconds;
      ttsRequestId = tts.request_id;
      // Cache TTS
      if (this._ttsCache.size >= this._cacheMax) {
        const firstKey = this._ttsCache.keys().next().value;
        this._ttsCache.delete(firstKey);
        this._resourceStats.cacheEvictions++;
      }
      this._ttsCache.set(ttsCacheKey, audioBase64);
    }

    // Lifecycle: synthesizing → queued
    if (caption.seq !== undefined && this.transcriptController) {
      this.transcriptController.markSynthesizing(caption.id);
      this.transcriptController.markQueued(caption.id, audioBase64, ttsDuration, ttsRequestId);
    }

    return { audioBase64, durationSeconds: ttsDuration, requestId: ttsRequestId };
  }

  // ---- P1-7: Retry buffered captions when checkpoint becomes ready ----
  async retryCheckpointBuffer() {
    if (!this._checkpointBuffer.length) return;
    const buffer = this._checkpointBuffer.splice(0, this._checkpointBufferMax);
    for (const item of buffer) {
      if (item.genAtStart !== this._generation) continue;
      try {
        const backend = this.settings.ttsBackend || 'piper';
        const tts = await chrome.runtime.sendMessage({ type: 'TTS_ONLY', text: item.translated, language: this.settings.language || 'te-IN', backend, apiKey: this.settings.apiKey || '' });
        if (tts && tts.ok && item.genAtStart === this._generation) {
          this.scheduler.addSegment(item.caption, tts.audio);
          this.scheduler.tick();
        }
      } catch (e) {
        console.warn(`[AakashVani] checkpoint buffer retry failed:`, e.message);
      }
    }
  }

  showBanner(msg) {
    let b = document.getElementById('__aakashvani_banner');
    if (!b) {
      b = document.createElement('div');
      b.id = '__aakashvani_banner';
      b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:#1e293b;color:#e2e8f0;border:1px solid #f59e0b;padding:12px 16px;border-radius:8px;font:13px/1.4 system-ui;max-width:560px;box-shadow:0 4px 16px rgba(0,0,0,.5);cursor:pointer;';
      b.innerHTML = '<b style="color:#f59e0b">AakashVani:</b> ';
      const span = document.createElement('span');
      b.appendChild(span);
      document.body.appendChild(b);
      b.addEventListener('click', () => b.remove());
    }
    b.querySelector('span').textContent = msg + ' (click to dismiss)';
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => b.remove(), 20000);
  }

  makeAudio(audioBase64) {
    const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true;
    audio._blobUrl = url;
    return { audio, url };
  }

  // ---- P1-5: Invalidate stale TTS for a caption ID (correction arrived) ----
  invalidateCaption(captionId) {
    this._generation++;
    this.scheduler.setGeneration(this._generation);
    this.scheduler.invalidateStaleGenerations(this._generation);
    this.scheduler.invalidateSegmentsByCaptionId(captionId);
    this.queue = this.queue.filter(q => (q.id || '') !== captionId);
    this._checkpointBuffer = this._checkpointBuffer.filter(b => (b.caption.id || '') !== captionId);
    this._resourceStats.cancellations++;
    this._updateResourceStats();
  }

  tryPlayNext() {
    this.scheduler.tick();
    // drift check disabled
  }

  _startDriftMonitor() {
    // drift monitor disabled
  }

  _stopDriftMonitor() {
    if (this.scheduler._monitorTimer) { clearInterval(this.scheduler._monitorTimer); this.scheduler._monitorTimer = null; }
  }

  pauseDubbed() {
    const seg = this.scheduler.segments[this.scheduler.currentIndex];
    if (seg && seg.state === 'playing' && !seg.audio.paused) {
      try { seg.audio.pause(); } catch (_) {}
      this._stopDriftMonitor();
      this.scheduler.stopTickMonitor();
      // Restore background video volume while the dub is paused.
      this.scheduler.duck(false);
      console.log('[AakashVani] dub paused (video paused)');
    }
  }

  resumeDubbed() {
    const seg = this.scheduler.segments[this.scheduler.currentIndex];
    if (seg && seg.state === 'playing' && seg.audio.paused) {
      seg.audio.play().catch(() => {});
      this._startDriftMonitor();
      this.scheduler.startTickMonitor();
      // Re-apply background volume ducking now that the dub is speaking again.
      this.scheduler.duck(true);
      console.log('[AakashVani] dub resumed');
    } else {
      this.scheduler.tick();
      this.scheduler.startTickMonitor();
      this.pumpPipeline();
    }
  }

  duck(on) {
    this.scheduler.duck(on);
  }

  flush() {
    this._generation++;
    this.scheduler.setGeneration(this._generation);
    this.scheduler.invalidateStaleGenerations(this._generation);
    this._stopDriftMonitor();
    this.scheduler.clear();
    this.queue = [];
    this._checkpointBuffer = [];
    this._translationCache.clear();
    this._ttsCache.clear();
    this.playing = false;
    this.duck(false);
    this._resourceStats.cancellations++;
    this._updateResourceStats();
    // Reset transcript controller on seek/video navigation
    if (this.transcriptController) {
      this.transcriptController.reset();
    }
  }
}

window.__aakashvani = new SyncController();
