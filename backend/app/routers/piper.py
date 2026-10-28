"""Piper ONNX TTS router.

Endpoints:
  POST /api/v1/tts/piper                synthesize (auto-loads voice if model present)
  POST /api/v1/tts/piper/prepare        start background voice download (~60MB)
  GET  /api/v1/tts/piper/prepare/status poll download progress

Response shape matches the TTS contract so the extension can
consume Piper output with no changes (status, mode="piper", language_code,
duration_seconds, audio_base64). Missing/unsupported language -> 503 with
checkpoint_missing, matching the TTS error contract.
"""
import base64
import traceback

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import piper_models, piper_tts

router = APIRouter(prefix="/api/v1", tags=["TTS - Piper"])


class TTSRequest(BaseModel):
    model_config = {"extra": "ignore"}
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"


class PrepareRequest(BaseModel):
    lang: str = "te-IN"


@router.post("/tts/piper")
async def synthesize_speech(req: TTSRequest):
    lang = req.target_lang
    if lang not in piper_models.PIPER_VOICES:
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"no Piper voice available for '{lang}'.",
                "language_checkpoint_not_loaded": lang,
                "piper_voice_missing": lang,
                "supported": list(piper_models.PIPER_VOICES.keys()),
            },
        )
    if not piper_models.is_available(lang):
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"Piper voice for '{lang}' not downloaded yet. Trigger download first.",
                "language_checkpoint_not_loaded": lang,
                "checkpoint_missing": lang,
                "prepare_hint": f"POST /api/v1/tts/piper/prepare {{\"lang\":\"{lang}\"}}",
            },
        )
    try:
        wav_bytes, duration = await piper_tts.synthesize(req.text, lang)
    except RuntimeError as exc:
        msg = str(exc)
        if msg.startswith("__PIPER_MODEL_MISSING__"):
            missing = msg.replace("__PIPER_MODEL_MISSING__", "")
            raise HTTPException(
                status_code=503,
                detail={
                    "message": f"Piper voice for {missing} is not downloaded yet.",
                    "language_checkpoint_not_loaded": missing,
                    "checkpoint_missing": missing,
                    "prepare_hint": f"POST /api/v1/tts/piper/prepare {{\"lang\":\"{missing}\"}}",
                },
            )
        if "not loaded" in msg.lower() or "voice" in msg.lower():
            raise HTTPException(
                status_code=503,
                detail={"message": f"Piper voice not loaded: {msg}", "language_checkpoint_not_loaded": lang},
            )
        tb = traceback.format_exc()
        print(f"[AakashVani:tts/piper] RuntimeError 503 [{lang}]: {msg}\n{tb}", flush=True)
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[AakashVani:tts/piper] 500 fallback -> 503 [{lang}] text={repr(req.text[:120])}\n{tb}", flush=True)
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"Piper voice not loaded or synthesis failed for '{lang}': {exc}",
                "language_checkpoint_not_loaded": lang,
                "error": str(exc),
            },
        )
    return {
        "status": "success",
        "mode": "piper",
        "language_code": lang,
        "duration_seconds": round(duration, 3),
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
    }


@router.post("/tts/piper/prepare")
async def prepare_voice(req: PrepareRequest):
    """Start downloading the Piper voice for `lang` in the background."""
    result = piper_models.prepare(req.lang)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "prepare failed"))
    return result


@router.get("/tts/piper/prepare/status")
async def prepare_status(lang: str | None = None):
    if lang and lang in piper_models.PIPER_VOICES:
        st = piper_models.status(lang)
    else:
        st = piper_models.status()
    st["voices_available"] = piper_models.available_languages()
    st["tts_loaded"] = piper_tts.is_loaded()
    st["tts_current_lang"] = piper_tts.current_language()
    try:
        st["all_status"] = piper_models.status_all()
    except Exception:
        pass
    return st
