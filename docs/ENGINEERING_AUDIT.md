# AakashVani Engineering Audit — Living Document

> Autonomous production hardening. Updated each phase. Source: `RUSHI-KOLLA/aakashvani` @ 2026-09-02, manifest 1.1.0.

## 1. Requirements Matrix

| Requirement | Implemented? | Correct? | Production-ready? | Gap |
|---|---|---|---|---|
| MV3 extension | Yes | Partial | No | Missing `tabs` permission, no CSP, offscreen race |
| YouTube captions | Yes | Partial | No | Selector `.ytp-caption-segment` fragile, no `textTracks` fallback |
| real-time capture | Yes | Partial | No | 250ms debounce + punct flush, but superstring repeat was bug (now delta fix) |
| timestamp preservation | No | No | No | Only `text` — no `startTime/endTime/capturedAt/id` |
| hybrid translation | Yes | Partial | No | Offscreen Chrome + Sarvam, but over-broad `includes('no')` fallback |
| local translation | Yes | Partial | No | Service worker blocked; offscreen fixes it, but model download not surfaced |
| cloud fallback | Yes | Partial | No | `cloudFallback` flag ignored in some paths (now fixed to fallback when key present) |
| Indic languages | Yes | Partial | No | 6 in registry, only te/hi/kn checkpoints present, `LANGS` duplicated |
| checkpoint management | Yes | No | No | Global `_state` race, single slot, no per-lang, no checksum, no atomic rename |
| TTS | Yes | Partial | No | IITM+HiFiGAN works (te/hi verified), but `MAX_WORKERS=1` bottleneck, CWD lock |
| low latency | Partial | Partial | No | LOOKAHEAD=3 pipelining, but no warmup, no backpressure, unbounded memory if paused |
| audio synchronization | Partial | Partial | No | Simple drift 400/650/900ms → 1.05/1.15/1.25x, no slowdown, no scheduler |
| pause/resume | No | No | No | `tryPlayNext` blocks on `video.paused` but active audio not paused on video pause |
| seeking | Partial | Partial | No | `seeked → flush()` clears queues but not `inflight` fetches (stale TTS can arrive) |
| navigation | Partial | Partial | No | `yt-navigate-finish` flush, but not `popstate`, not `MutationObserver.disconnect` on unload |
| pitch preservation | Yes | Unverified | No | `preservesPitch=true` only, no measurement |
| audio cleanup | Partial | No | No | `URL.revokeObjectURL` on `onended`+`flush` but playing blob leaks on seek |
| error recovery | Partial | Partial | No | `503` for missing checkpoint, but translate returns `200 {detail}` on missing key |
| security | No | No | No | API key plaintext in `chrome.storage.local`, CORS `chrome-extension://*` permissive, logs may leak text |
| observability | No | No | No | Random `console.warn`, no request ID, no structured health |
| tests | No | No | No | Zero test files |

## 2. Architecture (final after offscreen patch)

```
YouTube DOM (.ytp-caption-segment) → content.js (250ms debounce, superstring delta) → SyncController.enqueue
→ SyncController LOOKAHEAD=3 → processLine: TRANSLATE via service_worker → offscreen.js (window.Translator or Sarvam backend) → TTS_ONLY via service_worker → backend /api/v1/tts (checkpoint_store + iitm_tts ThreadPool1) → base64 WAV → Audio blob → ducking + drift playbackRate → video
Popup → settings (chrome.storage: mode, language, apiKey, cloudFallback, engineUrl, ducking) → service_worker + sync_controller
Backend: FastAPI lifespan → checkpoint_store (HuggingFace) → iitm_tts (FastSpeech2+HiFiGAN, one resident)
```

## 3. Known Bugs (Open)

| ID | Sev | Component | Root Cause | Status |
|---|---|---|---|---|
| AV-P0-001 | P0 | checkpoint_store | Global `_state` single-slot, unsynchronized progress updates, second lang overwrites first | OPEN |
| AV-P0-002 | P0 | content/sync pause | Video pause does not pause active dubbed audio → dub continues while video frozen | OPEN |
| AV-P0-003 | P0 | content seek | `seeked` flush doesn't abort inflight TRANSLATE/TTS fetches → stale audio can play after seek | OPEN |
| AV-P0-004 | P0 | offscreen race | Two concurrent `ensureOffscreenDocument()` → second `createDocument` throws `Only a single offscreen document` | OPEN |
| AV-P0-005 | P0 | translate API | Returns `200 {detail}` on missing key instead of 401 → offscreen must sniff field | OPEN |
| AV-P0-006 | P1 | content selector | `.ytp-caption-segment` fragile, no `video.textTracks` fallback | OPEN |
| AV-P0-007 | P1 | offscreen fallback | `errMsg.includes('no')` over-broad → auth errors fallback to Sarvam loop | OPEN (partial fix: now more specific, still broad) |
| AV-P0-008 | P1 | audio cleanup | `flush()` while `playing=true` leaks active blob URL (playing item not revoked) | OPEN |
| AV-P0-009 | P1 | checkpoint race | `_download_file` no atomic `.part` rename, size probe chained comparison unreadable | OPEN |
| AV-P0-010 | P1 | manifest | Missing `tabs` perm for `chrome.tabs.query`, no `activeTab` | OPEN |
| AV-P0-011 | P1 | iitm_tts | Hard truncate `t[:450].rsplit(" ",1)[0]` may cut Indic grapheme mid-cluster | OPEN |
| AV-P0-012 | P1 | sync_controller | Unbounded `playback` if video paused (gate prevents play, queue grows) | OPEN |
| AV-P0-013 | P2 | security | API key plaintext in storage, no encryption, logs may contain caption text | OPEN |
| AV-P0-014 | P2 | backend CORS | `allow_origin_regex=chrome-extension://.*` too permissive | OPEN |
| AV-P0-015 | P2 | requirements | No pins, `espnet==202511` future version | OPEN |
| AV-P0-016 | P2 | observability | No request ID, no structured logging | OPEN |
| AV-P0-017 | P2 | Dockerfile | HEALTHCHECK hardcodes :8000 vs PORT env | OPEN |

## 4. Fixed Bugs (This Cycle)

| ID | Sev | Component | Root Cause | Fix | Test | Status |
|---|---|---|---|---|---|---|
| AV-F-001 | P0 | offscreen | Service worker blocked Translator API (Web Worker) → __CHROME_TRANSLATOR_MISSING__ loop | Offscreen doc pattern: `ensureOffscreenDocument()` + `EXECUTE_TRANSLATE` + `fetchCloudTranslation` fallback ` | `node --check` + manual `__CHROME_TRANSLATOR_MISSING__` → fallback | FIXED |
| AV-F-002 | P0 | content | Superstring `Hello` → `Hello world` dispatched twice → stutter | `maybeDispatch` delta: `t.startsWith(lastDispatched) → delta` only | python sim `Hello→world delta` | FIXED |
| AV-F-003 | P0 | sync_controller | No queue dedup → duplicate captions replayed | `queue/inflight/playback` exact dedup + tags | enqueue sim | FIXED |
| AV-F-004 | P0 | sync_controller | Spam log per caption | Throttled 30s + banner | manual | FIXED |
| AV-F-005 | P0 | iitm_tts/backend | 500 leak on empty/punct, missing checkpoint | `_sanitize_text`, `try/except traceback`, router early 503 | `curl ...` → 400/503 not 500 | FIXED |
| AV-F-006 | P1 | content | 60ms debounce too short | 250ms + punctuation flush | sim | FIXED |
| AV-F-007 | P1 | sync_controller | Drift not compensated, blob leak | 300ms interval 400/650/900→1.05/1.15/1.25, revoke on done/flush | code review | FIXED |
| AV-F-008 | P1 | iitm_tts | `torch.no_grad` slower, int16 wav | `torch.inference_mode` + soundfile float32 | round-trip test | FIXED |

## 5. Remaining Gaps

- No timestamp-based caption identity (Phase 3)
- No real scheduler (Phase 4)
- No explicit state machine (Phase 5)
- TranslationProvider abstraction missing (Phase 6)
- Checkpoint per-lang state (Phase 10)
- No tests at all (Phase 18)
- Pause/resume/seek/navigation not fully verified (Phase 2,19)

## 6. Security Risks

- `Sarvam API key` in `chrome.storage.local` readable by any extension with storage permission
- `engineUrl` configurable to arbitrary host without validation
- Error messages may contain caption text (PII)

## 7. Performance Risks

- Single TTS worker, 3 concurrent fetches block on it
- `atob` + Blob on main thread
- MutationObserver on `document.body subtree` high CPU on live chat

## 8. Test Coverage

- Current: 0 files, 0% — UNVERIFIED except manual curl + node --check

## 9. Production Readiness (0-10)

- Correctness: 5
- Reliability: 4
- Synchronization: 4
- Performance: 5
- Security: 3
- Maintainability: 5
- Testing: 0
- Production readiness: 3/10

## 10. Immediate Next Actions (P0)

1. AV-P0-002 pause/resume
2. AV-P0-003 seek abort
3. AV-P0-004 offscreen double-create
4. AV-P0-005 translate 200→401
5. AV-P0-001 checkpoint per-lang
