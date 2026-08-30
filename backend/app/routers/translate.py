"""Translation router — routes between local NLLB (edge/auto) and Sarvam cloud.

- mode=edge (or auto with no valid Sarvam key): local nllb-200-distilled-600M
- mode=cloud (or explicit API key + cloud fallback): Sarvam NMT (BYOK)
"""
import os

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import nmt

router = APIRouter(prefix="/api/v1", tags=["Translation"])

SARVAM_BASE_URL = os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai")
SARVAM_NMT_MODEL = os.getenv("SARVAM_NMT_MODEL", "mayura:v1")


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target_lang: str = "te-IN"
    source_lang: str = "en-IN"
    mode: str = "auto"  # edge | auto | cloud
    sarvam_api_key: str | None = None


@router.post("/translate")
async def translate_text(req: TranslateRequest):
    api_key = req.sarvam_api_key or os.getenv("SARVAM_API_KEY", "")
    use_cloud = req.mode == "cloud" or (req.mode == "auto" and api_key and nmt.is_loaded() is False)

    if not use_cloud:
        # Local-first: edge mode, or auto when the key is absent/invalid
        try:
            translated = await nmt.translate(req.text, req.source_lang, req.target_lang)
            return {"translated_text": translated, "source": "local-nllb"}
        except Exception as exc:
            if not api_key:
                return {"detail": f"Local NMT failed and no Sarvam key configured: {exc}"}
            # fall through to cloud

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
    translated = data.get("translated_text") or data.get("texts", [""])[0]
    return {"translated_text": translated, "source": "sarvam"}
