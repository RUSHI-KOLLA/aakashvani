"""TTS router for local IITM synthesis and Sarvam Bulbul cloud synthesis.

POST /api/v1/tts selects a provider explicitly with the backend field.
Local IITM remains the default for backwards compatibility; Sarvam errors are
returned to the caller and never silently switch to local audio.
"""
import base64
import io
import os
import traceback
import wave
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import checkpoint_store, iitm_tts

router = APIRouter(prefix="/api/v1", tags=["TTS"])
SARVAM_BASE_URL = os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai").rstrip("/")


class TTSRequest(BaseModel):
    model_config = {"extra": "ignore"}
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    backend: Literal["iitm", "sarvam"] = "iitm"
    sarvam_api_key: str | None = None
    speaker: str | None = None


class PrepareRequest(BaseModel):
    lang: str = "te-IN"


def _wav_duration_seconds(audio_bytes: bytes) -> float | None:
    """Return WAV duration when its header is readable; otherwise None."""
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
            rate = wav_file.getframerate()
            return wav_file.getnframes() / rate if rate else None
    except (wave.Error, EOFError, OSError):
        return None


async def _synthesize_sarvam(req: TTSRequest) -> dict:
    api_key = (req.sarvam_api_key or os.getenv("SARVAM_API_KEY", "")).strip()
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="Sarvam TTS selected but no API key is configured. Add a key in AakashVani settings or backend/.env.",
        )

    model = os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")
    speaker = req.speaker or os.getenv("SARVAM_TTS_SPEAKER", "shubh")
    payload = {
        "text": req.text,
        "language_code": req.target_lang,
        "model": model,
        "speaker": speaker,
        "output_audio_codec": "wav",
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=5.0)) as client:
            response = await client.post(
                f"{SARVAM_BASE_URL}/text-to-speech",
                json=payload,
                headers={"api-subscription-key": api_key},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Sarvam TTS request timed out.")
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="Sarvam TTS service is unreachable.")

    if response.status_code in (401, 403):
        raise HTTPException(status_code=502, detail="Sarvam TTS authentication failed. Check the API key.")
    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="Sarvam TTS rate limit reached.")
    if response.status_code in (400, 422):
        raise HTTPException(status_code=422, detail="Sarvam rejected the TTS request. Check language, model, speaker, and text length.")
    if response.status_code < 200 or response.status_code >= 300:
        raise HTTPException(status_code=502, detail=f"Sarvam TTS failed with upstream status {response.status_code}.")

    try:
        data = response.json()
        audios = data.get("audios")
        if not isinstance(audios, list) or not audios or not isinstance(audios[0], str):
            raise ValueError("missing audio")
        audio_bytes = base64.b64decode(audios[0], validate=True)
        if not audio_bytes:
            raise ValueError("empty audio")
    except (ValueError, TypeError, KeyError):
        raise HTTPException(status_code=502, detail="Sarvam returned an invalid audio response.")

    duration = _wav_duration_seconds(audio_bytes)
    return {
        "status": "success",
        "mode": "sarvam",
        "provider": "sarvam",
        "model": model,
        "language_code": req.target_lang,
        "duration_seconds": round(duration, 3) if duration is not None else None,
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
    }


@router.post("/tts")
async def synthesize_speech(req: TTSRequest):
    if req.backend == "sarvam":
        return await _synthesize_sarvam(req)

    lang = req.target_lang
    if lang not in checkpoint_store.LANGS:
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"language checkpoint not loaded for '{lang}'. Voice model for this language is not available.",
                "language_checkpoint_not_loaded": lang,
                "supported": list(checkpoint_store.LANGS.keys()),
            },
        )
    if not checkpoint_store.is_available(lang):
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"language checkpoint not loaded for '{lang}'. Trigger download first.",
                "language_checkpoint_not_loaded": lang,
                "checkpoint_missing": lang,
                "prepare_hint": f"POST /api/v1/tts/prepare {{\"lang\":\"{lang}\"}}",
            },
        )
    try:
        wav_bytes, duration = await iitm_tts.synthesize(req.text, lang)
    except RuntimeError as exc:
        msg = str(exc)
        if msg.startswith("__CHECKPOINT_MISSING__"):
            missing = msg.replace("__CHECKPOINT_MISSING__", "")
            raise HTTPException(
                status_code=503,
                detail={
                    "message": f"Voice checkpoint for {missing} is not downloaded yet.",
                    "language_checkpoint_not_loaded": missing,
                    "checkpoint_missing": missing,
                    "prepare_hint": f"POST /api/v1/tts/prepare {{\"lang\":\"{missing}\"}}",
                },
            )
        if "not loaded" in msg.lower() or "checkpoint" in msg.lower():
            raise HTTPException(
                status_code=503,
                detail={"message": f"language checkpoint not loaded: {msg}", "language_checkpoint_not_loaded": lang},
            )
        tb = traceback.format_exc()
        print(f"[AakashVani:tts.py] RuntimeError 503 [{lang}]: {msg}\n{tb}", flush=True)
        raise HTTPException(status_code=503, detail="Local IITM synthesis failed.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        tb = traceback.format_exc()
        print(f"[AakashVani:tts.py] local synthesis failed [{lang}]\n{tb}", flush=True)
        raise HTTPException(
            status_code=503,
            detail={"message": f"Local IITM synthesis failed for '{lang}'.", "language_checkpoint_not_loaded": lang},
        )
    return {
        "status": "success",
        "mode": "iitm",
        "provider": "iitm",
        "language_code": lang,
        "duration_seconds": round(duration, 3),
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
    }


@router.post("/tts/prepare")
async def prepare_checkpoint(req: PrepareRequest):
    """Start downloading the ~160MB checkpoint for lang in the background."""
    result = checkpoint_store.prepare(req.lang)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "prepare failed"))
    return result


@router.get("/tts/prepare/status")
async def prepare_status(lang: str | None = None):
    if lang and lang in checkpoint_store.LANGS:
        st = checkpoint_store.status(lang)
    else:
        st = checkpoint_store.status()
    st["checkpoint_available"] = checkpoint_store.available_languages()
    st["tts_loaded"] = iitm_tts.is_loaded()
    st["tts_current_lang"] = iitm_tts.current_language()
    try:
        st["all_status"] = checkpoint_store.status_all()
    except Exception:
        pass
    return st
