"""ASR (speech→text) router — optional, opt-in backend for the extension's
caption-health fallback.

POST /api/v1/asr         transcribe WAV bytes (base64 JSON body)
GET  /api/v1/asr/status  dependency + model load state

The endpooint is explicit about every failure mode: dependency missing
(503, code ``asr_dependency_missing``), model init failure (503, code
``asr_model_init_failed``), invalid payloads (422). It never returns
synthetic text.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.asr_service import (
    ASRDependencyMissing,
    ASRModelInitError,
    ASRError,
)

router = APIRouter(prefix="/api/v1/asr", tags=["ASR"])

# A 2-3 s request that arrives late is worthless for dubbing; cap payload size.
MAX_AUDIO_SECONDS = 12.0
MAX_AUDIO_BYTES = 1_600_000  # ~50s of 16 kHz mono; generous sanity cap


class ASRRequest(BaseModel):
    # Base64 WAV (float/PCM) or raw 16-bit PCM bytes; produced by the
    # extension's tab-audio capture in the offscreen document.
    audio: str = Field(..., description="base64-encoded WAV audio")
    language: str | None = Field(None, description="BCP-47 e.g. 'te-IN' (optional)")


def _asr_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ASRDependencyMissing):
        return HTTPException(
            status_code=503,
            detail={
                "code": "asr_dependency_missing",
                "provider": "faster-whisper",
                "install_hint": "./venv/bin/pip install -r requirements-asr.txt",
                "message": str(exc),
            },
        )
    if isinstance(exc, ASRModelInitError):
        return HTTPException(
            status_code=503,
            detail={
                "code": "asr_model_init_failed",
                "provider": "faster-whisper",
                "message": str(exc),
            },
        )
    if isinstance(exc, ASRError):
        return HTTPException(status_code=503, detail={"code": "asr_error", "message": str(exc)})
    if isinstance(exc, ValueError):
        return HTTPException(
            status_code=422,
            detail={"code": "invalid_audio", "message": str(exc)},
        )
    return HTTPException(status_code=503, detail={"code": "asr_error", "message": str(exc)})


@router.post("")
async def transcribe(req: ASRRequest):
    if not req.audio:
        raise HTTPException(status_code=422, detail={"code": "invalid_audio", "message": "audio field is empty"})
    if len(req.audio) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=422,
            detail={"code": "audio_too_large", "message": f"audio exceeds {MAX_AUDIO_BYTES} base64 chars"},
        )
    # Optional ASR dependency (faster-whisper); the module-level singleton
    # exposes decode_base64_wav/transcribe — route errors explicitly.
    from app.services import asr_service as asr_mod

    try:
        wav_bytes = asr_mod.asr_service.decode_base64_wav(req.audio)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_audio", "message": str(exc)}) from exc

    try:
        result = await asyncio.to_thread(asr_mod.asr_service.transcribe, wav_bytes, req.language)
    except (ASRDependencyMissing, ASRModelInitError, ASRError, ValueError) as exc:
        raise _asr_http_error(exc) from exc

    return {
        "ok": True,
        "text": result["text"],
        "detected_language": result["detected_language"],
        "duration_seconds": result["duration_seconds"],
        "segments": result["segments"],
        "provider": result["provider"],
        "model": result["model"],
        "language_probability": result["language_probability"],
    }


@router.get("/status")
async def status():
    from app.services import asr_service

    return {"ok": True, "asr": asr_service.asr_service.status()}
