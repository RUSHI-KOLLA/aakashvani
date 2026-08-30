"""AakashVani local engine — minimal FastAPI entrypoint.

Endpoints:
  GET  /api/v1/health    liveness + IITM TTS load report
  POST /api/v1/tts       speech synthesis (IITM FastSpeech2 + HiFi-GAN)
  POST /api/v1/chat      (chrome built-in translation only, calls /tts)

NOTE: NMT/translation now happens INSIDE the Chrome extension via Chrome's
built-in on-device Translator API ("GTX" mode) — the backend does not do
translation and no NMT weights (NLLB/others) are loaded or stored here.

Run: uvicorn app.main:app --host 127.0.0.1 --port 8000  (from ./venv)
"""
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()  # reads backend/.env when run outside containers

from app.routers import tts  # noqa: E402  (after dotenv)

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

app = FastAPI(title="AakashVani Local Engine", version="3.0")

# Chrome extensions send Origin: chrome-extension://<id>; MV3 fetches from the
# popup/content script need permissive CORS since the origin is opaque.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tts.router)


@app.on_event("startup")
async def _startup():
    from app.services import iitm_tts

    await iitm_tts.startup()  # preload FastSpeech2 checkpoint off the request path


@app.get("/")
async def root():
    return {"message": "AakashVani Local Engine is running."}


@app.get("/api/v1/health", tags=["Health"])
async def health():
    from app.services import iitm_tts

    return {
        "status": "ok",
        "tts_loaded": iitm_tts.is_loaded(),
        "tts_backend": iitm_tts.backend_name(),
    }
