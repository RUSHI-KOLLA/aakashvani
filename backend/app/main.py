"""AakashVani local engine — FastAPI entrypoint.

Endpoints:
  GET  /api/v1/health    liveness + IITM TTS load report
  POST /api/v1/translate translation via Sarvam cloud (BYOK)
  POST /api/v1/tts       speech synthesis (IITM FastSpeech2 + HiFi-GAN)

Translation:
  - cloud mode: POST /api/v1/translate via Sarvam AI (requires SARVAM_API_KEY)
  - edge mode:  Chrome built-in Translator API (in extension, no backend call)

Run: uvicorn app.main:app --host 127.0.0.1 --port 8000  (from ./venv)
"""
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()  # reads backend/.env when run outside containers

from app.routers import translate, tts  # noqa: E402  (after dotenv)

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services import iitm_tts
    await iitm_tts.startup()
    yield
    iitm_tts.shutdown()


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
app.include_router(tts.router)


@app.get("/")
async def root():
    return {"message": "AakashVani Local Engine is running."}


@app.get("/api/v1/health", tags=["Health"])
async def health():
    from app.services import checkpoint_store, iitm_tts

    return {
        "status": "ok",
        "tts_loaded": iitm_tts.is_loaded(),
        "tts_backend": iitm_tts.backend_name(),
        "tts_current_lang": iitm_tts.current_language(),
        "checkpoints_available": checkpoint_store.available_languages(),
        "checkpoint_base_url_configured": bool(checkpoint_store.BASE_URL),
    }
