"""TTS router — delegates to the IITM FastSpeech2 + HiFi-GAN service."""
import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import fallback_tts, iitm_tts

router = APIRouter(prefix="/api/v1", tags=["TTS"])


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    mode: str = "edge"
    speaker_id: int | str | None = None
    sarvam_api_key: str | None = None


@router.post("/tts")
async def synthesize_speech(req: TTSRequest):
    if iitm_tts.is_loaded():
        wav_bytes, duration = await iitm_tts.synthesize(req.text, req.target_lang)
        mode = "edge"
    else:
        # IITM checkpoint unavailable -> fallback voice so dubbing still works
        try:
            wav_bytes, _sr, duration = await fallback_tts.synthesize(req.text, req.target_lang)
            mode = "edge-fallback"
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"TTS unavailable: {exc}")
    return {
        "status": "success",
        "mode": mode,
        "language_code": req.target_lang,
        "duration_seconds": round(duration, 3),
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
    }

