"""AakashVani local engine — FastAPI entrypoint.

Endpoints:
  GET  /api/v1/health    liveness + Piper TTS load report
  POST /api/v1/translate translation via Sarvam cloud (BYOK)
  POST /api/v1/tts/piper speech synthesis (Piper ONNX)

Translation:
  - cloud mode: POST /api/v1/translate via Sarvam AI (requires SARVAM_API_KEY)
  - edge mode:  Chrome built-in Translator API (in extension, no backend call)

TTS backend:
  - Piper ONNX (active) at /api/v1/tts/piper

Run: uvicorn app.main:app --host 127.0.0.1 --port 8000  (from ./venv)
"""
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()  # reads backend/.env when run outside containers

from app.routers import translate, piper  # noqa: E402  (after dotenv)

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services import piper_tts
    await piper_tts.startup()
    yield
    piper_tts.shutdown()


app = FastAPI(title="AakashVani Local Engine", version="3.0", lifespan=lifespan)

# Chrome extensions send Origin: chrome-extension://<id>; MV3 fetches from the
# popup/content script need permissive CORS since the origin is opaque.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(translate.router)
app.include_router(piper.router)


@app.get("/")
async def root():
    return {"message": "AakashVani Local Engine is running."}


def piper_models_available() -> list[str]:
    from app.services import piper_models
    return piper_models.available_languages()


@app.get("/api/v1/health", tags=["Health"])
async def health():
    from app.services import piper_tts

    has_sarvam = bool(os.getenv("SARVAM_API_KEY") or os.getenv("HF_TOKEN"))
    # structured health: healthy if Piper voice loaded, unavailable otherwise
    if piper_tts.is_loaded():
        health_status = "healthy"
    else:
        health_status = "unavailable"

    return {
        "status": health_status,
        "tts_loaded": piper_tts.is_loaded(),
        "tts_backend": piper_tts.backend_name(),
        "tts_current_lang": piper_tts.current_language(),
        "tts_loading": piper_tts.is_loading(),
        "piper_tts_loaded": piper_tts.is_loaded(),
        "piper_tts_backend": piper_tts.backend_name(),
        "piper_tts_current_lang": piper_tts.current_language(),
        "piper_tts_loading": piper_tts.is_loading(),
        "piper_voices_available": piper_models_available(),
        "translation": {
            "sarvam_configured": has_sarvam,
            "chrome_translator": "offscreen document — check chrome://on-device-translation-internals",
        },
        "version": "3.0",
    }
