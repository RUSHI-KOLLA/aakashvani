"""Translation router — Sarvam cloud NMT (BYOK)."""

import os

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/v1", tags=["Translation"])

SARVAM_BASE_URL = os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai")
SARVAM_NMT_MODEL = os.getenv("SARVAM_NMT_MODEL", "mayura:v1")


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    source_lang: str = "en-IN"
    mode: str = "cloud"
    sarvam_api_key: str | None = None


@router.post("/translate")
async def translate_text(req: TranslateRequest):
    api_key = req.sarvam_api_key or os.getenv("SARVAM_API_KEY", "")
    if not api_key:
        return {
            "detail": "Sarvam API key not configured. Add it in the extension popup (Settings) or backend/.env."
        }

    payload = {
        "input": req.text,
        "source_language_code": req.source_lang,
        "target_language_code": req.target_lang,
        "model": SARVAM_NMT_MODEL,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{SARVAM_BASE_URL}/translate",
            json=payload,
            headers={"api-subscription-key": api_key},
        )
    if resp.status_code != 200:
        return {"detail": f"Sarvam translate failed: {resp.status_code} {resp.text[:200]}"}
    data = resp.json()
    translated = data.get("translated_text") or data.get("texts", [""])[0] if isinstance(data.get("texts"), list) else data.get("translated_text", "")
    # fallback for different response shapes
    if not translated:
        translated = data.get("translated_text", "") or (data.get("texts", [""])[0] if data.get("texts") else "")
    return {"translated_text": translated, "source": "sarvam"}
