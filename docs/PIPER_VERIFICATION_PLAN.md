# Piper Integration — End-to-End Verification Results

## Automated verification (all PASSED)

### A. Real HTTP integration against running backend (`backend/tests/test_http_integration.py`)
Ran against a live uvicorn server (`http://127.0.0.1:8000`), Piper models downloaded from Hugging Face at runtime.

| # | Check | Result |
|---|-------|--------|
| A1 | `GET /api/v1/health` reports `piper_tts_*`, `tts_loaded` (Piper), `piper_voices_available` | PASS |
| A2 | Piper TTS te-IN → 200, mode=piper, valid PCM_16 WAV 22050Hz, nonzero audio | PASS |
| A3 | Piper TTS hi-IN → 200, valid PCM_16 WAV 22050Hz | PASS |
| A4 | ml-IN missing → 503 `checkpoint_missing`; `POST /prepare` → download → ready → 200 valid WAV | PASS |
| A4b | kn-IN unsupported (no Kannada voice) → 503 `piper_voice_missing`, prepare rejected 400 | PASS |
| A5 | ta-IN (unsupported, no Piper voice) → 503 `piper_voice_missing` + supported list | PASS |
| A6 | empty/punct text → 400 | PASS |
| A7 | long text (>1200 chars) → 200 valid WAV (truncation) | PASS |
| A9 | Concurrent te-IN + hi-IN → both 200, valid WAV, no clobber | PASS |

IITM `/api/v1/tts` endpoint removed — no A8/A10 checks apply.

### Piper unit tests (`backend/tests/test_piper.py`: 47/47)
Real models from Hugging Face: Telugu + Hindi synthesis; Malayalam missing-model; Tamil/Kannada unsupported; empty text; language-to-voice mapping correctness.

### B. Extension logic (Node)
| Test | Result |
|------|--------|
| `node --check` on all modified extension JS files | PASS |
| `test_behavioral.js` | PASS |
| `test_adversarial.js` | 96/96 PASS |
| `test_tts_routing.js` (endpoint selection: piper↔`/api/v1/tts/piper`, default→`/api/v1/tts/piper`) | 13/13 PASS |

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

## Files changed in this phase (IITM removal)
- `backend/app/main.py` — removed IITM lifespan/health wiring; Piper-only health
- `backend/app/services/iitm_tts.py` — deleted (IITM TTS service)
- `backend/app/services/checkpoint_store.py` — deleted (IITM checkpoint store)
- `backend/app/routers/tts.py` — deleted (IITM `/api/v1/tts` router)
- `backend/third_party/iitm_indic_tts/` — deleted (vendored IITM/HiFi-GAN code)
- `backend/requirements.txt` — removed espnet/torch/scipy/pandas/tqdm/pyyaml/IITM deps; added onnxruntime/piper-tts/phonemizer
- `backend/.env.example` — removed TTS_CHECKPOINT_BASE_URL/TTS_GENDER; added PIPER_* vars
- `backend/Dockerfile` — removed torch/IITM model dir; added espeak-ng/espeak-ng-data
- `backend/tests/test_unit.py` — deleted (IITM-only tests)
- `backend/tests/test_http_integration.py` — removed IITM A8/A10 checks
- `extension/src/popup/{service_worker,sync_controller,popup}.js` — default ttsBackend 'iitm'→'piper'
- `extension/src/popup/popup.html` — removed IITM TTS option
- `extension/tests/test_tts_routing.js` — piper-default routing checks
- `scripts/cleanup.sh` — removed stale iitm_indic_tts references
- docs updated to describe Piper as active TTS engine
