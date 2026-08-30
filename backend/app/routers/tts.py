"""TTS router — IITM FastSpeech2 + HiFi-GAN only.

No fallback models are loaded (vits_rasa/NLLB removed by design). If the
checkpoint is absent the endpoint returns a clear 503 so the operator
restores the ~160MB checkpoint rather than silently degrading quality.
"""
import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import iitm_tts

router = APIRouter(prefix="/api/v1", tags=["TTS"])


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    mode: str = "edge"
    speaker_id: int | str | None = None


@router.post("/tts")
async def synthesize_speech(req: TTSRequest):
    if not iitm_tts.is_loaded():
        raise HTTPException(
            status_code=503,
            detail="IITM FastSpeech2 checkpoint not loaded. "
            f"Set TTS_MODEL_DIR in backend/.env (currently '{iitm_tts.TTS_MODEL_DIR}') "
            "to the folder containing model.pth + config.yaml "
            "(+ optional hifigan/) and restart the engine.",
        )
    wav_bytes, duration = await iitm_tts.synthesize(req.text, req.target_lang)
    return {
        "status": "success",
        "mode": "edge",
        "language_code": req.target_lang,
        "duration_seconds": round(duration, 3),
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
    }

