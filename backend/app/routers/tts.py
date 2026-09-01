"""TTS router — IITM FastSpeech2 + HiFi-GAN only (per-language, on demand).

Endpoints:
  POST /api/v1/tts                synthesize (auto-loads model if checkpoint present)
  POST /api/v1/tts/prepare        start background checkpoint download (~160MB)
  GET  /api/v1/tts/prepare/status poll download/extract progress
"""
import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import checkpoint_store, iitm_tts

router = APIRouter(prefix="/api/v1", tags=["TTS"])


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    mode: str = "edge"
    speaker_id: int | str | None = None


class PrepareRequest(BaseModel):
    lang: str = "te-IN"


@router.post("/tts")
async def synthesize_speech(req: TTSRequest):
    lang = req.target_lang
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
                    "checkpoint_missing": missing,
                    "prepare_hint": f"POST /api/v1/tts/prepare {{\"lang\":\"{missing}\"}}",
                },
            )
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "status": "success",
        "mode": "edge",
        "language_code": lang,
        "duration_seconds": round(duration, 3),
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
    }


@router.post("/tts/prepare")
async def prepare_checkpoint(req: PrepareRequest):
    """Start downloading the ~160MB checkpoint for `lang` in the background."""
    result = checkpoint_store.prepare(req.lang)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "prepare failed"))
    return result


@router.get("/tts/prepare/status")
async def prepare_status():
    st = checkpoint_store.status()
    st["checkpoint_available"] = checkpoint_store.available_languages()
    st["tts_loaded"] = iitm_tts.is_loaded()
    st["tts_current_lang"] = iitm_tts.current_language()
    return st
