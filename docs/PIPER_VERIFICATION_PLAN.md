# Piper Integration — End-to-End Verification Results

## Automated verification (all PASSED)

### A. Real HTTP integration against running backend (`backend/tests/test_http_integration.py`: 35/35)
Ran against a live uvicorn server (`http://127.0.0.1:8000`), Piper models downloaded from Hugging Face at runtime.

| # | Check | Result |
|---|-------|--------|
| A1 | `GET /api/v1/health` reports `piper_tts_*`, `piper_voices_available`, IITM fields intact | PASS |
| A2 | Piper TTS te-IN → 200, mode=piper, valid PCM_16 WAV 22050Hz, nonzero audio | PASS |
| A3 | Piper TTS hi-IN → 200, valid PCM_16 WAV 22050Hz | PASS |
| A4 | ml-IN missing → 503 `checkpoint_missing`; `POST /prepare` → download → ready → 200 valid WAV | PASS |
| A4b | kn-IN unsupported (no Kannada voice) → 503 `piper_voice_missing`, prepare rejected 400 | PASS |
| A5 | ta-IN (unsupported, no Piper voice) → 503 `piper_voice_missing` + supported list | PASS |
| A6 | empty/punct text → 400 | PASS |
| A7 | long text (>1200 chars) → 200 valid WAV (truncation) | PASS |
| A8 | IITM `/api/v1/tts` still returns 503 (no IITM checkpoint) — IITM untouched & distinct | PASS |
| A9 | Concurrent te-IN + hi-IN → both 200, valid WAV, no clobber | PASS (5/5 repeat runs stable) |
| A10 | IITM=503 & Piper=200 on same lang — endpoints distinct, no cross-talk | PASS |

### Piper unit tests (`backend/tests/test_piper.py`: 28/28)
Real models from Hugging Face: Telugu + Hindi synthesis; Kannada missing-model; Tamil unsupported; empty text; voice info.

### B. Extension logic (Node)
| Test | Result |
|------|--------|
| `node --check` on all 5 modified extension JS files | PASS |
| `test_behavioral.js` | PASS |
| `test_adversarial.js` | 96/96 PASS |
| `test_tts_routing.js` (endpoint selection: piper↔`/api/v1/tts/piper`, iitm↔`/api/v1/tts`, default↔iitm) | 13/13 PASS |

### C. Browser attempt (Chrome headless)
- Chrome 153 headless launches; DevTools on :9222; X server on :1 → environment SUPPORTS browser testing.
- Extension loaded via `--load-extension`; its service worker **registered** (`chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js`) — extension is valid and loads in real Chrome.
- YouTube page loads.
- Full caption→translate→TTS→playback→ducking→pause/seek E2E could NOT be completed autonomously because:
  - Chrome Translator API (`window.Translator`) + offscreen document are not available in headless Chrome (translation path cannot be exercised headless).
  - Content scripts run in an isolated JS world; `Runtime.getExecutionContexts` is not exposed by this headless Chrome's CDP, so isolated-world injection couldn't be confirmed via CDP.
  - YouTube redirected the headless session to a sign-in page on the homepage; video caption access + media playback in headless is unreliable.

Therefore: **real browser E2E is NOT claimed as passed.** Precise manual steps are below.

## Root-cause fix during verification
- **Concurrency bug found and fixed**: `synthesize()` previously submitted `_ensure_loaded` and `_synthesize_sync` as separate executor calls to the single-worker thread pool. Two concurrent requests for different languages interleaved: te-IN loaded, hi-IN hot-swapped the resident voice, then te-IN's synthesize saw `state.lang=="hi-IN"` and raised "Piper TTS not loaded". Fixed by making load+synthesize atomic inside one executor submission (`_synthesize_once`), capturing `voice`/`sr` under the lock. Verified stable across 5 concurrent runs.

## Remaining unverified (browser) — manual steps
See `docs/PIPER_MANUAL_TEST_STEPS.md` (below).

## Files changed in this phase
- `backend/app/services/piper_tts.py` (concurrency atomicity fix + `_sanitize_text` restored)
- `backend/tests/test_http_integration.py` (new, real-server integration tests)
- `extension/tests/test_tts_routing.js` (new, endpoint-routing verification)
- `docs/PIPER_VERIFICATION_PLAN.md` (this file)
