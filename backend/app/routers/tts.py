"""Sarvam AI Bulbul TTS router.

Endpoint:
  POST /api/v1/tts                 synthesize via Sarvam Bulbul TTS

Response shape mirrors the Piper TTS contract so the extension can consume
Sarvam output with no pipeline changes (status, mode="sarvam", language_code,
duration_seconds, audio_base64, provider, request_id).
"""

import base64
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import sarvam_tts

logger = logging.getLogger("aakashvani.tts_sarvam")

router = APIRouter(prefix="/api/v1", tags=["TTS - Sarvam"])


class TTSRequest(BaseModel):
    model_config = {"extra": "ignore"}
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    speaker: str | None = None
    model: str | None = None
    pace: float | None = None
    speech_sample_rate: int | None = None
    sarvam_api_key: str | None = None


@router.post("/tts")
async def synthesize_speech(req: TTSRequest):
    lang = req.target_lang
    try:
        wav_bytes, duration, request_id = await sarvam_tts.synthesize(
            text=req.text,
            target_lang=lang,
            api_key=req.sarvam_api_key,
            speaker=req.speaker,
            model=req.model,
            pace=req.pace,
            speech_sample_rate=req.speech_sample_rate,
        )
    except sarvam_tts.SarvamTTSError as exc:
        raise HTTPException(status_code=exc.status_code, detail={
            "message": str(exc),
            "provider": "sarvam",
            "language_code": lang,
            **exc.detail,
        })
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Sarvam TTS unexpected error [%s]", lang)
        raise HTTPException(status_code=503, detail={
            "message": f"Sarvam TTS synthesis failed for '{lang}': {exc}",
            "provider": "sarvam",
            "language_code": lang,
        })

    return {
        "status": "success",
        "mode": "sarvam",
        "provider": "sarvam",
        "language_code": lang,
        "duration_seconds": round(duration, 3),
        "request_id": request_id,
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
    }
