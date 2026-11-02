// AakashVani — regression tests for the Phase-2 pipeline integration layer:
//   - processLine() must not throw ReferenceError (pre-existing TDZ bug:
//     'backend' was referenced before its declaration — broke EVERY Phase-2
//     segment dispatch in the real pipeline)
//   - Lifecycle transitions committed→translating→synthesizing→queued must be
//     applied to TranscriptController segments during processLine
//   - pumpPipeline markPlaying + scheduler onSegmentCompleted→markCompleted wiring
//   - flush() must reset TranscriptController state (seek/navigation)
//
// Run: node extension/tests/test_processline_lifecycle.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const SYNC_SRC = fs.readFileSync(path.join(__dirname, '../src/popup/sync_controller.js'), 'utf8');
const TC_SRC = fs.readFileSync(path.join(__dirname, '../src/popup/transcript_controller.js'), 'utf8');

function makeSandbox(services = {}) {
  const ttsLog = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg) {
        if (msg.type === 'TRANSLATE') return Promise.resolve({ ok: true, translated: `T:${msg.text}` });
        if (msg.type === 'TTS_ONLY') {
          ttsLog.push({ text: msg.text, backend: msg.backend });
          return Promise.resolve({
            ok: true,
            audio: Buffer.from('RIFF-mock-audio').toString('base64'),
            duration_seconds: 2.5,
            request_id: 'req-123',
          });
        }
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
    constructor(url) {
      this._blobUrl = url;
      this.preload = 'auto';
      this.preservesPitch = true;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.duration = 1;
      this.paused = true;
      this.onended = null;
      this.onerror = null;
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    chrome,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    RegExp,
    Error,
    Uint8Array,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    atob: (v) => Buffer.from(v, 'base64').toString('binary'),
    Audio: MockAudio,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  vm.createContext(sandbox);

  // Load TranscriptController first (as manifest content_scripts ordering does),
  // then sync_controller.js which detects it as a window global.
  vm.runInContext(TC_SRC, sandbox, { filename: 'transcript_controller.js' });
  vm.runInContext(SYNC_SRC, sandbox, { filename: 'sync_controller.js' });

  const controller = sandbox.window.__aakashvani;
  return { sandbox, controller, ttsLog, chrome };
}

// Build a realistic Phase-2 segment object (what TranscriptController.reconcile
// returns and SyncController.enqueue puts into the queue).
function makeSegment(tc, i = 0) {
  return tc._createSegment('Hello world test', {
    id: 'texttrack-cue1',
    text: 'Hello world test',
    startTime: 5,
    endTime: 8,
    duration: 3,
    source: 'texttrack',
    untimed: false,
    capturedAt: Date.now(),
    observedAt: Date.now(),
  }, 'stable');
}

async function run() {
  // ================================================================
  section('TDZ: processLine must not throw ReferenceError for Phase-2 segments');
  {
    const { controller } = makeSandbox();
    const tc = controller.transcriptController;
    assert(tc, 'TranscriptController attached when global is defined');

    const segment = makeSegment(tc);
    let threw = null;
    try {
      await controller.processLine(segment, controller._generation);
    } catch (e) {
      threw = e;
    }
    assertEq(threw, null, `processLine must not throw (got ${threw && threw.message})`);
  }

  // ================================================================
  section('Lifecycle: committed→translating→synthesizing→queued during processLine');
  {
    const { controller } = makeSandbox();
    const tc = controller.transcriptController;
    const segment = makeSegment(tc);

    await controller.processLine(segment, controller._generation);

    assertEq(segment.state, 'queued', 'segment reaches queued state after processLine');
    assert(segment.audioBase64, 'segment carries audio');
    assert(segment.requestId === 'req-123', 'segment carries TTS request id');
    assert(segment.translatingAt > 0, 'translating timestamp recorded');
    assert(segment.synthesizingAt > 0, 'synthesizing timestamp recorded');
    assert(segment.queuedAt > 0, 'queued timestamp recorded');
  }

  // ================================================================
  section('Provider metadata: TTS request carries resolved backend');
  {
    const { controller, ttsLog } = makeSandbox();
    const tc = controller.transcriptController;
    const segment = makeSegment(tc);
    await controller.processLine(segment, controller._generation);
    assertEq(ttsLog.length, 1, 'one TTS request');
    assertEq(ttsLog[0].backend, 'piper', 'backend resolved from settings');
  }

  // ================================================================
  section('markPlaying + scheduler→markCompleted wiring');
  {
    const { controller } = makeSandbox();
    const tc = controller.transcriptController;
    const segment = makeSegment(tc);

    // Simulate full pipeline: queue a segment and run one pump cycle
    controller.queue.push(segment);
    controller.video = null;           // scheduler.tick no-ops safely
    controller.pumpPipeline();

    // Wait for the pipeline promise (translate + tts are async)
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Translating must have been marked by processLine (no TDZ throw here —
    // the async catch would otherwise drop it)
    assert(segment.state !== 'committed', 'segment advanced past committed');

    // The scheduler received the audio segment; simulate playback completion
    // via the onSegmentCompleted hook.
    assert(typeof controller.scheduler.onSegmentCompleted === 'function',
      'scheduler.onSegmentCompleted wired to transcript lifecycle');

    // Drive the hook with the scheduler segment shape
    const schedSeg = { caption: segment };
    controller.scheduler.onSegmentCompleted(schedSeg);
    assertEq(segment.state, 'completed', 'transcript segment marked completed by scheduler hook');
  }

  // ================================================================
  section('flush() resets TranscriptController (seek/video navigation)');
  {
    const { controller } = makeSandbox();
    const tc = controller.transcriptController;
    const segment = makeSegment(tc);
    tc.committedPrefix = 'Old caption before seek';
    tc.uncommitted = 'pending text';
    tc._recentSig.set('1|Old caption before seek', Date.now());

    controller.flush();

    assertEq(tc.committedPrefix, '', 'committedPrefix cleared on flush');
    assertEq(tc.uncommitted, '', 'uncommitted cleared on flush');
    assertEq(tc.segments.length, 0, 'segments cleared on flush');
    assertEq(tc._recentSig.size, 0, 'repeat signatures cleared on flush');
  }

  // ================================================================
  section('Legacy captions (no seq, string) still flow through processLine untouched');
  {
    const { controller, ttsLog } = makeSandbox();
    // Legacy path enqueues plain string captions — must not blow up and must
    // not touch transcripts
    const result = await controller.processLine('plain text line', controller._generation);
    assert(result && result.audioBase64, 'legacy string caption still produces audio');
    assertEq(ttsLog.length, 1, 'TTS requested for legacy caption');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROCESSLINE LIFECYCLE: ${_pass} passed, ${_fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(_fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
