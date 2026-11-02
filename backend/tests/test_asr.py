"""Tests for the optional ASR (speech→text) fallback endpoint.

Deterministic tests run WITHOUT faster-whisper installed: they verify payload
validation, dependency-missing error surfacing, status introspection, and the
WAV decode/resample utilities.

A LIVE round-trip test (synthesizes speech with the local Piper engine, then
transcribes it) runs only when faster-whisper is importable in the venv —
it may download model weights (~145 MB for 'base') on first run.
Run explicitly:
    ./venv/bin/python tests/test_asr.py            (deterministic only)
    ASR_LIVE_TEST=1 ./venv/bin/python tests/test_asr.py   (with live round-trip)
"""

import base64
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from app.main import app
from app.services import asr_service

_PASS = 0
_FAIL = 0


def check(cond, msg):
    global _PASS, _FAIL
    if cond:
        _PASS += 1
    else:
        _FAIL += 1
        print(f"  FAIL: {msg}")


client = TestClient(app)

# ================================================================
# 1. Utilities
# ================================================================
print("--- 1. WAV decode / resample / PCM ------------------------------")

# 1a: decode a generated mono WAV
buf = io.BytesIO()
sr = 22050
x = np.sin(np.linspace(0, 200 * np.pi, sr, dtype=np.float32)).astype(np.float32)
sf.write(buf, x, sr, format="WAV")
audio, sr2 = asr_service.decode_wav(buf.getvalue())
check(sr2 == 22050, f"decode_wav returns original sample rate (got {sr2})")
check(audio.dtype == np.float32, "decode_wav returns float32")
check(audio.ndim == 1, "decode_wav returns mono")

# 1b: empty payload rejected
try:
    asr_service.decode_wav(b"")
    check(False, "decode_wav raises on empty payload")
except ValueError:
    check(True, "decode_wav raises on empty payload")

# 1c: garbage payload rejected
try:
    asr_service.decode_wav(b"not a wav file at all")
    check(False, "decode_wav raises on garbage")
except ValueError:
    check(True, "decode_wav raises on garbage payloads")

# 1d: resample 22050 → 16000 keeps duration
y = asr_service.resample(audio, 22050, 16000)
check(abs(y.shape[0] / 16000.0 - audio.shape[0] / 22050.0) < 0.01, "resample preserves duration")
check(y.dtype == np.float32, "resample returns float32")

# 1e: raw PCM int16 → float32 scale
pcm = np.array([0, 16384, -16384, 32767, -32768], dtype=np.int16).tobytes()
z = asr_service.pcm_bytes_to_array(pcm)
expected = np.array([0, 0.5, -0.5, 0.99997, -1.0], dtype=np.float32)
check(np.allclose(z, expected, atol=1e-3), "pcm_bytes_to_array scales to [-1, 1]")

svc = asr_service.ASRService()
# 1f: language normalization
check(svc.normalize_language("te-IN") == "te", "te-IN → te")
check(svc.normalize_language("hi-IN") == "hi", "hi-IN → hi")
check(svc.normalize_language(None) is None, "None → None")
check(svc.normalize_language("en") == "en", "plain 'en' passes through")

# ================================================================
# 2. Bas64 decode errors → 422
# ================================================================
print("--- 2. Base64 payload validation --------------------------------")


def b64wav(arr, srate=16000):
    b = io.BytesIO()
    sf.write(b, arr, srate, format="WAV")
    return base64.b64encode(b.getvalue()).decode("ascii")


# 2a: invalid base64 → 422
r = client.post("/api/v1/asr", json={"audio": "!!!not-base64!!!", "language": "te-IN"})
check(r.status_code == 422, f"invalid base64 → 422 (got {r.status_code})")
check(r.json()["detail"]["code"] == "invalid_audio", "invalid base64 code reported")

# 2b: empty audio → 422
r = client.post("/api/v1/asr", json={"audio": ""})
check(r.status_code == 422, "empty audio → 422")

# 2c: valid base64 but garbage bytes → 422 (decode failure)
try:
    garbage = base64.b64encode(b"garbagegarbage").decode("ascii")
    r = client.post("/api/v1/asr", json={"audio": garbage})
    check(r.status_code == 422, f"decodable b64 of garbage audio → 422 (got {r.status_code})")
    check(r.json()["detail"]["code"] == "invalid_audio", "garbage audio reports invalid_audio")
except ValueError as exc:
    # decode_wav raises ValueError directly in-thread → surfaced as 422 via router
    check(False, f"garbage audio reached router as unexpected ValueError: {exc}")

# 2d: oversized payload → 422
r = client.post("/api/v1/asr", json={"audio": "A" * (asr_service.__dict__.get("_", 0) or 2_000_000)})
check(r.status_code == 422, f"oversized payload → 422 (got {r.status_code})")
check(r.json()["detail"]["code"] == "audio_too_large", "oversize reports audio_too_large")

# ================================================================
# 3. Dependency-missing behavior (when faster-whisper absent)
# ================================================================
print("--- 3. Dependency state ----------------------------------------")

dep = asr_service.is_dependency_available()
fw = client.get("/api/v1/asr/status").json()["asr"]
check(fw["available"] == dep, "status.available matches dependency check")
check(fw["model"] == os.getenv("ASR_MODEL", "base"), "status shows configured model")
check(fw["install_hint"].endswith("requirements-asr.txt"), "install hint references requirements-asr.txt")

if not dep:
    valid = b64wav(np.zeros(16000, dtype=np.float32), 16000)
    r = client.post("/api/v1/asr", json={"audio": valid, "language": "te-IN"})
    check(r.status_code == 503, f"without faster-whisper → 503 (got {r.status_code})")
    check(r.json()["detail"]["code"] == "asr_dependency_missing", "reports asr_dependency_missing")
else:
    r = client.get("/api/v1/asr/status")
    check(r.status_code == 200, "status ok when dependency present")

# ================================================================
# 4. Health endpoint exposes ASR fields
# ================================================================
print("--- 4. Health fields -------------------------------------------")
h = client.get("/api/v1/health").json()
check("asr_available" in h, "health reports asr_available")
check("asr_model" in h, "health reports asr_model")
check("asr_initialized" in h, "health reports asr_initialized")

# ================================================================
# 5. LIVE round-trip: real speech → real transcription
# ================================================================
print("--- 5. LIVE round-trip (piper speech → faster-whisper) ---------")
CAN_RUN_LIVE = asr_service.is_dependency_available() and os.getenv("ASR_LIVE_TEST") == "1"

if not CAN_RUN_LIVE:
    print("  SKIPPED (requires ASR_LIVE_TEST=1 and faster-whisper installed)")
else:
    try:
        from app.services import piper_tts

        langs = piper_tts.listVoices() if hasattr(piper_tts, "listVoices") else []
        if isinstance(langs, dict):
            langs = list(langs.keys())
        en_lang = next((l for l in langs if l.startswith("en")), None)
        if en_lang is None:
            print(f"  SKIPPED (no English piper voice installed; have {langs})")
        else:
            wav_b64 = piper_tts.tts("Hello world. This is an audio test.", en_lang)
            wav_bytes = base64.b64decode(wav_b64)
            duration_guess = asr_service.decode_wav(wav_bytes)[0].shape[0]
            check(duration_guess > 0, "piper produced audio")

            r = client.post("/api/v1/asr", json={"audio": base64.b64encode(wav_bytes).decode(), "language": "en-US"})
            check(r.status_code == 200, f"transcribe HTTP 200 (got {r.status_code}: {r.text[:160]})")
            if r.status_code == 200:
                data = r.json()
                text = (data.get("text") or "").lower()
                check(data.get("provider") == "faster-whisper", "provider metadata present")
                check(len(text) > 3, f"non-empty transcription: {text!r}")
                import re

                words = re.findall(r"[a-z]+", text)
                check("hello" in words or "world" in words,
                      f"transcription contains expected word: {text!r}")
                print(f"  LIVE TRANSCRIPTION: {text!r}")
    except Exception as exc:  # live portion must fail loudly but not crash the suite
        if "ASRModelInitError" in type(exc).__name__ or "model" in str(exc).lower():
            print(f"  SKIPPED (model weights not downloadable in this env: {exc})")
        else:
            _FAIL += 1
            print(f"  FAIL: live round-trip raised {type(exc).__name__}: {exc}")

print()
print(f"===== ASR TESTS: {_PASS} pass, {_FAIL} fail =====")
sys.exit(1 if _FAIL else 0)
