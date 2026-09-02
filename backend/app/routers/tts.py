"""TTS router — IITM FastSpeech2 + HiFi-GAN only (per-language, on demand).

Endpoints:
  POST /api/v1/tts                synthesize (auto-loads model if checkpoint present)
  POST /api/v1/tts/prepare        start background checkpoint download (~160MB)
  GET  /api/v1/tts/prepare/status poll download/extract progress
"""
import base64
import traceback

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import checkpoint_store, iitm_tts

router = APIRouter(prefix="/api/v1", tags=["TTS"])


class TTSRequest(BaseModel):
    model_config = {"extra": "ignore"}
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"


class PrepareRequest(BaseModel):
    lang: str = "te-IN"


@router.post("/tts")
async def synthesize_speech(req: TTSRequest):
    lang = req.target_lang
    # Early 503 for missing checkpoint — avoids 500 crash on synthesize()
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
        # Any other RuntimeError from model not loaded — explicit 503
        if "not loaded" in msg.lower() or "checkpoint" in msg.lower():
            raise HTTPException(
                status_code=503,
                detail={"message": f"language checkpoint not loaded: {msg}", "language_checkpoint_not_loaded": lang},
            )
        # Fallback 503 with traceback logged
        tb = traceback.format_exc()
        print(f"[AakashVani:tts.py] RuntimeError 503 [{lang}]: {msg}\n{tb}", flush=True)
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[AakashVani:tts.py] 500 fallback → 503 [{lang}] text={repr(req.text[:120])}\n{tb}", flush=True)
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"language checkpoint not loaded or synthesis failed for '{lang}': {exc}",
                "language_checkpoint_not_loaded": lang,
                "error": str(exc),
            },
        )
    return {
        "status": "success",
        "mode": "iitm",
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
async def prepare_status(lang: str | None = None):
    # per-lang status when lang query is provided (concurrent downloads), else legacy global
    if lang and lang in checkpoint_store.LANGS:
        st = checkpoint_store.status(lang)
    else:
        st = checkpoint_store.status()
    st["checkpoint_available"] = checkpoint_store.available_languages()
    st["tts_loaded"] = iitm_tts.is_loaded()
    st["tts_current_lang"] = iitm_tts.current_language()
    # expose full per-lang map for debugging
    try:
        st["all_status"] = checkpoint_store.status_all()
    except Exception:
        pass
    return st
