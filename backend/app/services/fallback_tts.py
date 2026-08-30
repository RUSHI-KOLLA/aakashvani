"""Fallback TTS — ai4bharat/vits_rasa_13 (HF, ~161MB, 13 Indic languages).

Used ONLY when the IITM FastSpeech2 checkpoint is unavailable, so dubbing
works today instead of returning 503. Same executor/locking pattern as the
other services.
"""
import asyncio
import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("aakashvani.fallback_tts")

FALLBACK_MODEL = os.getenv("FALLBACK_TTS_MODEL", "ai4bharat/vits_rasa_13")

# VITS rasa 13 supports these; map app lang IDs -> model lang tags
VITS_LANGS = {
    "te-IN": "Telugu",
    "hi-IN": "Hindi",
    "kn-IN": "Kannada",
    "ta-IN": "Tamil",
    "ml-IN": "Malayalam",
    "mr-IN": "Marathi",
    "bn-IN": "Bengali",
    "gu-IN": "Gujarati",
    "pa-IN": "Punjabi",
}

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fallback-tts")
_state = {"loaded": False, "backend": "unavailable", "pipe": None, "sampling_rate": 22050}
_lock = threading.Lock()


def is_loaded():
    return _state["loaded"]


def backend_name():
    return _state["backend"]


def _try_load():
    with _lock:
        if _state["loaded"]:
            return
        try:
            from transformers import AutoModel, AutoTokenizer
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
            tokenizer = AutoTokenizer.from_pretrained(FALLBACK_MODEL, trust_remote_code=True)
            model = AutoModel.from_pretrained(FALLBACK_MODEL, trust_remote_code=True).to(device)
            model.eval()
            _state.update(pipe=(tokenizer, model, device), loaded=True,
                          backend=f"vits_rasa_13 fallback ({device})",
                          sampling_rate=model.config.sampling_rate)
            logger.info("Fallback TTS loaded: %s", _state["backend"])
        except Exception as exc:
            _state.update(loaded=False, backend=f"error: {exc}", pipe=None)
            logger.error("Fallback TTS load failed: %s", exc)


async def startup():
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _try_load)


async def synthesize(text: str, target_lang: str) -> tuple[bytes, int, float]:
    if not _state["loaded"]:
        raise RuntimeError(f"Fallback TTS not loaded: {_state['backend']}")
    if target_lang not in VITS_LANGS:
        raise ValueError(f"Fallback TTS does not support {target_lang}")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EXECUTOR, _synth_sync, text, VITS_LANGS[target_lang])


def _synth_sync(text: str, lang_tag: str) -> tuple[bytes, int, float]:
    import numpy as np
    import soundfile as sf
    import torch

    tokenizer, model, device = _state["pipe"]
    t0 = time.time()
    # vits_rasa expects the language tag prepended for multilingual routing
    inputs = tokenizer(text=f"<lang:{lang_tag}>{text}", return_tensors="pt").to(device)
    with torch.no_grad():
        out = model(**inputs).waveform.squeeze().cpu().numpy()
    sr = _state["sampling_rate"]
    buf = io.BytesIO()
    sf.write(buf, out, sr, format="WAV", subtype="PCM_16")
    duration = float(len(out)) / sr
    logger.info("fallback TTS: %.2fs audio in %.2fs", duration, time.time() - t0)
    return buf.getvalue(), sr, duration
