"""Translation router — Sarvam cloud NMT (BYOK)."""

import os

import httpx
from fastapi import APIRouter, HTTPException
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
        raise HTTPException(
            status_code=401,
            detail="Sarvam API key not configured. Add it in the extension popup (Settings) or backend/.env as SARVAM_API_KEY.",
        )

    payload = {
        "input": req.text,
        "source_language_code": req.source_lang,
        "target_language_code": req.target_lang,
        "model": SARVAM_NMT_MODEL,
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{SARVAM_BASE_URL}/translate",
                json=payload,
                headers={"api-subscription-key": api_key},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Sarvam upstream unreachable: {exc}")

    if resp.status_code in (401, 403):
        raise HTTPException(status_code=resp.status_code, detail=f"Sarvam auth failed ({resp.status_code}): invalid API key. {resp.text[:160]}")
    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail=f"Sarvam rate limited: {resp.text[:160]}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Sarvam translate failed: {resp.status_code} {resp.text[:200]}")

    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Sarvam returned non-JSON response")
    translated = data.get("translated_text")
    if not translated:
        texts = data.get("texts")
        if isinstance(texts, list) and texts:
            translated = texts[0]
    if not translated:
        raise HTTPException(status_code=502, detail="Sarvam response missing translated_text")
    return {"translated_text": translated, "source": "sarvam"}
