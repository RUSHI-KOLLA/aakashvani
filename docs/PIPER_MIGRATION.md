# Piper ONNX TTS Migration — AakashVani

## Status

Piper ONNX is implemented as a **separate, additive TTS backend**. The existing IITM FastSpeech2-HS + HiFi-GAN implementation is **completely intact** (no code, dependency, checkpoint, or config removed).

| Item | Details |
|------|---------|
| New service | `backend/app/services/piper_tts.py` |
| Model store | `backend/app/services/piper_models.py` |
| Router | `backend/app/routers/piper.py` |
| Tests | `backend/tests/test_piper.py` (real Piper models) |
| Wiring | `backend/app/main.py` (lifespan + health + router) |
| Extension | `ttsBackend` setting ('iitm'\|'piper', default 'iitm') + popup UI |

## Architecture (unchanged for IITM)

- `POST /api/v1/tts` → IITM FastSpeech2 + HiFi-GAN (untouched)
- `POST /api/v1/tts/piper` → Piper ONNX (new, same response shape: `status`, `mode: "piper"`, `language_code`, `duration_seconds`, `audio_base64`)
- `POST /api/v1/tts/piper/prepare` + `GET /api/v1/tts/piper/prepare/status` → per-language voice download
- `GET /api/v1/health` → reports `piper_tts_*` and `piper_voices_available`

Extension flow: SyncController → `TTS_ONLY` (with `backend`) → service worker → `/api/v1/tts` (IITM) or `/api/v1/tts/piper` (Piper) → base64 WAV → timeline playback + ducking (unchanged). Default `ttsBackend='iitm'` preserves existing behavior exactly.

## Dependencies

Python (backend `venv`):

```
onnxruntime numpy soundfile piper-tts phonemizer fastapi uvicorn python-dotenv pydantic httpx pyyaml
```

System (already present in this environment): `libespeak-ng` + `espeak-ng-data` (phonemizer uses the shared library via ctypes; the `espeak-ng` binary is NOT required).

Install:
```
cd backend
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install --no-cache-dir onnxruntime numpy soundfile piper-tts phonemizer fastapi uvicorn python-dotenv pydantic httpx pyyaml
```

## Configuration (`backend/.env`, never committed)

```
HOST=127.0.0.1
PORT=8000

# Piper voice source (rhasspy/piper-voices on Hugging Face)
PIPER_VOICES_BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"
# Where downloaded voices live (mounted in Docker, never baked in)
PIPER_MODEL_DIR=/app/checkpoints/piper_voices

# Piper TTS tuning
PIPER_TTS_MAX_WORKERS=1
PIPER_TTS_MAX_CHARS=1200
```

IITM env vars (`TTS_CHECKPOINT_BASE_URL`, `TTS_GENDER`, `SARVAM_API_KEY`, ...) are untouched.

## Language → Piper voice mapping

| Lang | Voice (rhasspy/piper-voices) |
|------|------------------------------|
| te-IN | te_IN-maya-medium |
| hi-IN | hi_IN-pratham-medium |
| kn-IN | ka_GE-natia-medium |
| ml-IN | ml_IN-arjun-medium |
| mr-IN | mr_IN-google-medium |
| ta-IN | **none** (no Piper voice → permanent 503; exercises missing-model path) |

Models (~40–65 MB each) download on demand via `POST /api/v1/tts/piper/prepare {"lang":"<code>"}}` and are cached under `PIPER_MODEL_DIR`.

## Startup

```
cd backend
source venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Docker: existing `Dockerfile` builds the CPU image; add `espeak-ng`/`espeak-ng-data` and the Piper Python deps to `requirements.txt`/`Dockerfile` for container builds. Checkpoints (IITM + Piper) are mounted, not baked in.

## Smoke tests

Real-server verification (run the server, then):

```bash
# Health — Piper voices listed, IITM untouched
curl -s http://127.0.0.1:8000/api/v1/health | python3 -m json.tool

# Telugu synthesis via Piper (expect 200, mode=piper, valid WAV)
curl -s -X POST http://127.0.0.1:8000/api/v1/tts/piper \
  -H 'Content-Type: application/json' -d '{"text":"నమస్తే","target_lang":"te-IN"}' | \
  python3 -c "import sys,json,base64,io,soundfile as sf,numpy as np
d=json.load(sys.stdin); wav=base64.b64decode(d['audio_base64']); data,sr=sf.read(io.BytesIO(wav))
assert d['mode']=='piper' and sr==22050 and (data!=0).sum()>0
print('PIPER OK', d['duration_seconds'], 's')"

# Hindi
curl -s -X POST ... -d '{"text":"नमस्ते हिंदी","target_lang":"hi-IN"}'  -> 200, mode=piper

# Missing model (Tamil: no Piper voice) -> 503
curl -s -o /dev/null -w "%{http_code}" -X POST ... -d '{"text":"வணக்கம்","target_lang":"ta-IN"}'  -> 503

# Empty text -> 400
curl -s -o /dev/null -w "%{http_code}" -X POST ... -d '{"text":"   ","target_lang":"te-IN"}' -> 400

# Download a voice (kn-IN) then synthesize
curl -s -X POST .../tts/piper/prepare -d '{"lang":"kn-IN"}'   # -> started
curl -s .../tts/piper/prepare/status?lang=kn-IN  # -> poll until status=ready
curl -s -X POST .../tts/piper -d '{"text":"ನಮಸ್ಕಾರ","target_lang":"kn-IN"}' -> 200
```

IITM regression: `POST /api/v1/tts` (no checkpoint) still returns 503 exactly as before.

## Verification performed

- Piper ONNX inference: Telugu/Hindi/Kannada produce valid 22050 Hz PCM audio (nonzero signal), synthesis ~0.1 s, model load ~0.8 s.
- Real FastAPI server (uvicorn): `/api/v1/tts/piper` returns valid WAV; missing/unsupported/empty cases return 503/503/400 with the same contract as IITM.
- `backend/tests/test_piper.py`: 28 pass / 0 fail using **real** models downloaded from Hugging Face (Telugu, Hindi synthesis; Tamil/Kannada missing-model; unsupported language; empty text).
- Existing IITM tests that can run without downloaded checkpoints: pass.
- Extension: `node --check` on all modified files passes; existing `test_behavioral.js` + `test_adversarial.js` (96 checks) pass.
- **Not feasible in this environment**: browser-based extension E2E (no browser), Sarvam cloud translation (no API key), IITM checkpoint download (needs HF `smtiitm` model + GPU/TTS stack). These are pre-existing environmental limits, not regressions.

## Notes

- Piper Indic voices use espeak-ng phonemes; espeak-ng dictionaries for te/hi/kn/ta/ml/mr/bn/ur are present, so phonemization works for all configured Indic languages except Tamil (no Piper voice in rhasspy/piper-voices).
- `checkpoints/` and `*.onnx`/`*.onnx.json` are gitignored (downloaded models are never committed).
