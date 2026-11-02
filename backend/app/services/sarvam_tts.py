"""Sarvam AI Bulbul Text-to-Speech service (cloud TTS).

Calls the Sarvam AI Bulbul v3 text-to-speech REST API:
  POST https://api.sarvam.ai/text-to-speech
  Header: api-subscription-key: <SARVAM_API_KEY>

Request body (verified against official Sarvam docs):
  {
    "text": "Welcome to Sarvam AI!",
    "language_code": "en-IN",   # BCP-47, e.g. te-IN, hi-IN, kn-IN, ta-IN, ml-IN, mr-IN
    "speaker": "shubh",         # optional; default voice for the model
    "model": "bulbul:v3",       # optional; defaults to bulbul:v4-flash on Sarvam side
    "pace": 1.0,                # optional; 0.5-2.0
    "speech_sample_rate": 22050 # optional; matches Piper output rate
  }

Response:
  {
    "request_id": "...",
    "audios": ["<base64 WAV>"]
  }

Returns (wav_bytes, duration_seconds, request_id) so the extension can consume
Sarvam output with the same pipeline as Piper (base64 WAV -> Audio blob -> play).

Authentication is BYOK: the API key is supplied per-request (from the extension
popup) or falls back to the SARVAM_API_KEY environment variable. The key is
never logged and never returned to the client.
"""

import base64
import io
import logging
import os
import time

import httpx

logger = logging.getLogger("aakashvani.sarvam_tts")

SARVAM_BASE_URL = os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai").rstrip("/")
SARVAM_TTS_ENDPOINT = f"{SARVAM_BASE_URL}/text-to-speech"
SARVAM_TTS_MODEL = os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")
SARVAM_TTS_SPEAKER = os.getenv("SARVAM_TTS_SPEAKER", "shubh")
SARVAM_TTS_PACE = float(os.getenv("SARVAM_TTS_PACE", "1.0"))
SARVAM_TTS_SAMPLE_RATE = int(os.getenv("SARVAM_TTS_SAMPLE_RATE", "22050"))

# Max characters per Sarvam Bulbul REST request (per official docs).
SARVAM_MAX_CHARS = 2500

# Languages supported by Sarvam Bulbul v3 (10 Indian + English).
# These overlap with Aakashvani's supported language set.
SARVAM_SUPPORTED_LANGUAGES = {
    "te-IN", "hi-IN", "kn-IN", "ta-IN", "ml-IN", "mr-IN",
    "bn-IN", "gu-IN", "pa-IN", "od-IN", "en-IN",
}

# Default Sarvam speaker per language (Bulbul v3 short names work across languages).
# Users can override via the `speaker` request field.
DEFAULT_SPEAKER_BY_LANG = {
    "te-IN": "shubh",
    "hi-IN": "shubh",
    "kn-IN": "shubh",
    "ta-IN": "shubh",
    "ml-IN": "shubh",
    "mr-IN": "shubh",
    "en-IN": "shubh",
}


class SarvamTTSError(Exception):
    """Raised when Sarvam TTS fails. Carries the HTTP status for router mapping."""

    def __init__(self, message: str, status_code: int = 502, detail: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail or {}


def _default_speaker(lang: str) -> str:
    return DEFAULT_SPEAKER_BY_LANG.get(lang, SARVAM_TTS_SPEAKER)


async def synthesize(
    text: str,
    target_lang: str,
    api_key: str | None = None,
    speaker: str | None = None,
    model: str | None = None,
    pace: float | None = None,
    speech_sample_rate: int | None = None,
) -> tuple[bytes, float, str]:
    """Synthesize `text` via Sarvam Bulbul TTS.

    Returns (wav_bytes, duration_seconds, request_id).

    Raises SarvamTTSError on auth, validation, upstream, or network failures.
    """
    key = api_key or os.getenv("SARVAM_API_KEY", "")
    if not key:
        raise SarvamTTSError(
            "Sarvam API key not configured. Add it in the extension popup or backend/.env as SARVAM_API_KEY.",
            status_code=401,
            detail={"code": "missing_api_key"},
        )

    if not text or not text.strip():
        raise SarvamTTSError("text is required", status_code=400, detail={"code": "invalid_request_error"})

    if target_lang not in SARVAM_SUPPORTED_LANGUAGES:
        raise SarvamTTSError(
            f"Sarvam TTS does not support language '{target_lang}'.",
            status_code=422,
            detail={"code": "unprocessable_entity_error", "supported_languages": sorted(SARVAM_SUPPORTED_LANGUAGES)},
        )

    if len(text) > SARVAM_MAX_CHARS:
        raise SarvamTTSError(
            f"text too long: {len(text)} chars (max {SARVAM_MAX_CHARS}).",
            status_code=422,
            detail={"code": "unprocessable_entity_error"},
        )

    payload = {
        "text": text,
        "language_code": target_lang,
        "speaker": speaker or _default_speaker(target_lang),
        "model": model or SARVAM_TTS_MODEL,
        "pace": pace if pace is not None else SARVAM_TTS_PACE,
        "speech_sample_rate": speech_sample_rate or SARVAM_TTS_SAMPLE_RATE,
    }

    headers = {
        "Content-Type": "application/json",
        "api-subscription-key": key,
    }

    timeout = httpx.Timeout(30.0, connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(SARVAM_TTS_ENDPOINT, json=payload, headers=headers)
    except httpx.ConnectTimeout as exc:
        raise SarvamTTSError(f"Sarvam TTS connection timeout: {exc}", status_code=504,
                             detail={"code": "upstream_timeout"})
    except httpx.ReadTimeout as exc:
        raise SarvamTTSError(f"Sarvam TTS read timeout: {exc}", status_code=504,
                             detail={"code": "upstream_timeout"})
    except httpx.RequestError as exc:
        raise SarvamTTSError(f"Sarvam TTS unreachable: {exc}", status_code=502,
                             detail={"code": "upstream_unreachable"})

    # Auth failures: Sarvam returns 403 (not 401) for invalid/missing keys.
    if resp.status_code == 403:
        detail = {}
        try:
            detail = resp.json().get("error", {})
        except Exception:
            pass
        raise SarvamTTSError(
            f"Sarvam auth failed ({resp.status_code}): invalid API key.",
            status_code=403,
            detail={"code": "invalid_api_key_error", "message": detail.get("message", "")},
        )
    if resp.status_code == 429:
        raise SarvamTTSError(
            f"Sarvam rate limited ({resp.status_code}).",
            status_code=429,
            detail={"code": "rate_limited"},
        )
    if resp.status_code == 400:
        raise SarvamTTSError(
            f"Sarvam bad request ({resp.status_code}).",
            status_code=400,
            detail={"code": "invalid_request_error"},
        )
    if resp.status_code == 422:
        raise SarvamTTSError(
            f"Sarvam unprocessable ({resp.status_code}).",
            status_code=422,
            detail={"code": "unprocessable_entity_error"},
        )
    if resp.status_code != 200:
        raise SarvamTTSError(
            f"Sarvam TTS failed ({resp.status_code}).",
            status_code=502,
            detail={"code": "upstream_error"},
        )

    try:
        data = resp.json()
    except Exception:
        raise SarvamTTSError("Sarvam returned non-JSON response", status_code=502,
                             detail={"code": "upstream_invalid_response"})

    audios = data.get("audios")
    if not isinstance(audios, list) or not audios:
        raise SarvamTTSError("Sarvam response missing audios", status_code=502,
                             detail={"code": "upstream_invalid_response"})

    request_id = data.get("request_id", "")
    audio_b64 = audios[0]

    try:
        wav_bytes = base64.b64decode(audio_b64, validate=True)
    except Exception:
        raise SarvamTTSError("Sarvam returned invalid base64 audio", status_code=502,
                             detail={"code": "upstream_invalid_response"})

    if not wav_bytes:
        raise SarvamTTSError("Sarvam returned empty audio", status_code=502,
                             detail={"code": "upstream_empty_audio"})

    # Determine duration from WAV header if possible, else estimate.
    duration = _wav_duration(wav_bytes)
    logger.info(
        "Sarvam TTS [%s]: %d bytes, %.2fs, request_id=%s",
        target_lang, len(wav_bytes), duration, request_id,
    )
    return wav_bytes, duration, request_id


def _wav_duration(wav_bytes: bytes) -> float:
    """Estimate WAV duration from header (RIFF/PCM). Falls back to 0."""
    try:
        if len(wav_bytes) < 44:
            return 0.0
        if wav_bytes[0:4] != b"RIFF" or wav_bytes[8:12] != b"WAVE":
            return 0.0
        # Find fmt chunk
        idx = 12
        while idx + 8 <= len(wav_bytes):
            chunk_id = wav_bytes[idx:idx + 4]
            chunk_size = int.from_bytes(wav_bytes[idx + 4:idx + 8], "little")
            if chunk_id == b"fmt " and chunk_size >= 16:
                sample_rate = int.from_bytes(wav_bytes[idx + 12:idx + 16], "little")
                bits_per_sample = int.from_bytes(wav_bytes[idx + 34:idx + 36], "little")
                channels = int.from_bytes(wav_bytes[idx + 22:idx + 24], "little")
                byte_rate = int.from_bytes(wav_bytes[idx + 28:idx + 32], "little") or sample_rate * channels * (bits_per_sample // 8)
                # Find data chunk
                data_idx = idx + 8 + chunk_size
                while data_idx + 8 <= len(wav_bytes):
                    if wav_bytes[data_idx:data_idx + 4] == b"data":
                        data_size = int.from_bytes(wav_bytes[data_idx + 4:data_idx + 8], "little")
                        return data_size / byte_rate
                    data_idx += 8
                break
            idx += 8 + chunk_size
    except Exception:
        pass
    return 0.0
