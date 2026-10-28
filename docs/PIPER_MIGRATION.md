# Piper ONNX TTS Migration — AakashVani

## Status

Piper ONNX is the **active TTS engine**. The IITM FastSpeech2-HS + HiFi-GAN pipeline has been removed
(see `a3a4536` and the IITM removal commit). No IITM code, dependency, checkpoint, or config remains.

| Item | Details |
|------|---------|
| Active service | `backend/app/services/piper_tts.py` |
| Model store | `backend/app/services/piper_models.py` |
| Router | `backend/app/routers/piper.py` |
| Tests | `backend/tests/test_piper.py` (real Piper models), `backend/tests/test_http_integration.py` (live server) |
| Wiring | `backend/app/main.py` (lifespan + health + router) |
| Extension | `ttsBackend` setting (default `'piper'`) + popup UI |

## Architecture

- `POST /api/v1/tts/piper` → Piper ONNX TTS (response: `status`, `mode: "piper"`, `language_code`, `duration_seconds`, `audio_base64`)
- `POST /api/v1/tts/piper/prepare` + `GET /api/v1/tts/piper/prepare/status` → per-language voice download
- `GET /api/v1/health` → reports `piper_tts_*` and `piper_voices_available` (plus `tts_loaded`/`tts_backend` for extension `PING_ENGINE`)
- `POST /api/v1/translate` → Sarvam cloud translation (unchanged)

Extension flow: SyncController → `TTS_ONLY` (with `backend`, defaults to `'piper'`) → service worker → `/api/v1/tts/piper` → base64 WAV → timeline playback + ducking (unchanged).

## Dependencies

Python (backend `venv`):

```
onnxruntime numpy soundfile piper-tts phonemizer fastapi uvicorn python-dotenv pydantic httpx
```

System (already present in this environment): `libespeak-ng` + `espeak-ng-data` (phonemizer uses the shared library via ctypes; the `espeak-ng` binary is NOT required).

Install:
```
cd backend
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install --no-cache-dir onnxruntime numpy soundfile piper-tts phonemizer fastapi uvicorn python-dotenv pydantic httpx
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

IITM env vars (`TTS_CHECKPOINT_BASE_URL`, `TTS_GENDER`) removed. Sarvam (`SARVAM_API_KEY`, ...) still used for cloud translation.

## Language → Piper voice mapping

| Lang | Voice (rhasspy/piper-voices) | Status |
|------|------------------------------|--------|
| te-IN | te_IN-maya-medium | Telugu ✓ verified |
| hi-IN | hi_IN-pratham-medium | Hindi ✓ verified |
| ml-IN | ml_IN-arjun-medium | Malayalam ✓ verified |
| mr-IN | mr_IN-google-medium | Marathi ✓ verified |
| kn-IN | **none** | Kannada — no Piper voice exists in rhasspy/piper-voices (unsupported; 503 `piper_voice_missing`) |
| ta-IN | **none** | Tamil — no Piper voice exists in rhasspy/piper-voices (unsupported; 503 `piper_voice_missing`) |

**Language-to-voice correctness is enforced by** `backend/tests/test_piper_language_voice_mapping_correctness()`:
each configured voice's `config.json` `language.family` must equal the app language code. This caught a
`kn-IN → ka_GE-natia-medium` mis-mapping (`ka_GE` is Georgian, not Kannada) — the offending mapping was
removed rather than silently using an unrelated voice.

Models (~40–65 MB each) download on demand via `POST /api/v1/tts/piper/prepare {"lang":"<code>"}}` and are cached under `PIPER_MODEL_DIR`.

## Startup

```
cd backend
source venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Docker: `Dockerfile` builds the CPU image with espeak-ng/espeak-ng-data and the Piper Python deps.
Piper checkpoints are mounted, never baked in.

## Smoke tests

Real-server verification (run the server, then):

```bash
# Health — Piper voices listed
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

# Download a voice (ml-IN) then synthesize
curl -s -X POST .../tts/piper/prepare -d '{"lang":"ml-IN"}'   # -> started
curl -s .../tts/piper/prepare/status?lang=ml-IN  # -> poll until status=ready
curl -s -X POST .../tts/piper -d '{"text":"നമസ്കാരം മലയാളം","target_lang":"ml-IN"}' -> 200
```

## Verification performed

- Piper ONNX inference: Telugu/Hindi/Malayalam produce valid 22050 Hz PCM audio (nonzero signal), synthesis ~0.1 s, model load ~0.8 s.
- Real FastAPI server (uvicorn): `/api/v1/tts/piper` returns valid WAV; missing/unsupported/empty cases return 503/503/400.
- `backend/tests/test_piper.py`: 47 pass / 0 fail using **real** models downloaded from Hugging Face (Telugu, Hindi synthesis; Malayalam missing-model; Tamil/Kannada unsupported; empty text).
- `backend/tests/test_http_integration.py`: live-server integration tests pass.
- Extension: `node --check` on all modified files passes; existing `test_behavioral.js` + `test_adversarial.js` (96 checks) pass.
- **Not feasible in this environment**: browser-based extension E2E (no browser), Sarvam cloud translation (no API key). These are pre-existing environmental limits, not regressions.

## Notes

- Piper Indic voices use espeak-ng phonemes; espeak-ng dictionaries for te/hi/kn/ta/ml/mr/bn/ur are present, so phonemization works for all configured Indic languages except Tamil (no Piper voice in rhasspy/piper-voices).
- `checkpoints/` and `*.onnx`/`*.onnx.json` are gitignored (downloaded models are never committed).
