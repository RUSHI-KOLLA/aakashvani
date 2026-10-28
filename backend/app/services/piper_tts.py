"""Piper ONNX TTS service (per-language, on demand).

Uses piper-tts (PiperVoice) + phonemizer (espeak-ng) + onnxruntime to turn
text into a PCM_16 WAV byte payload whose shape matches the TTS contract,
so the extension can consume Piper output with no changes.

One language is resident at a time; previously loaded voices are cached so
repeated synthesis of the same language avoids a reload.

Exactly one language is resident at a time (VRAM-safe hot swap).
"""
import asyncio
import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.services import piper_models

logger = logging.getLogger("aakashvani.piper_tts")

MAX_WORKERS = int(os.getenv("PIPER_TTS_MAX_WORKERS", "1"))
_TTS_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="piper-tts")

_state = {
    "loaded": False,
    "backend": "no model loaded",
    "lang": None,
    "voice": None,
    "sample_rate": 22050,
    "loading": False,
}
_load_lock = threading.Lock()
_voices: dict = {}  # lang -> PiperVoice (cached after first load)

# Hard cap on synthesis input length to avoid VITS memory blow-up on very long
# captions. Mirrors the spirit of the 450-char chunking but is looser
# because Piper is far lighter; the router still enforces max_length=5000.
MAX_SYNTH_CHARS = int(os.getenv("PIPER_TTS_MAX_CHARS", "1200"))


def _ensure_loaded_locked(lang: str) -> None:
    """Load (or hot-swap to) the Piper voice for `lang`. Caller MUST hold _load_lock."""
    if _state["loaded"] and _state["lang"] == lang and _state.get("voice") is not None:
        return
    if lang in _voices and _voices.get(lang) is not None:
        voice = _voices[lang]
    else:
        voice = _load_voice(lang)
        _voices[lang] = voice

    if _state.get("voice") is not None and _state["lang"] != lang:
        # drop previous language (keep loaded voices cached in _voices)
        _state["voice"] = None

    _state["voice"] = voice
    _state["sample_rate"] = int(voice.config.sample_rate)
    _state["lang"] = lang
    _state["loaded"] = True
    _state["backend"] = f"piper-onnx ({lang})"
    logger.info("Piper TTS [%s] loaded (sr=%d)", lang, _state["sample_rate"])


def _ensure_loaded(lang: str) -> None:
    """Public: load (or hot-swap to) the Piper voice for `lang`."""
    with _load_lock:
        _ensure_loaded_locked(lang)


def _load_voice(lang: str):
    """Instantiate a PiperVoice for `lang`. Raises if the model is unavailable."""
    if not piper_models.is_available(lang):
        model_dir = piper_models.model_dir(lang)
        raise RuntimeError(
            f"Piper voice for {lang} missing at '{model_dir}' "
            "(need {stem}.onnx + {stem}.onnx.json). "
            "Trigger POST /api/v1/tts/piper/prepare to download it."
            .replace("{stem}", piper_models.voice_info(lang)["stem"] if piper_models.voice_info(lang) else "<voice>")
        )
    from piper import PiperVoice  # imported lazily so heavy deps load on first use
    voice = PiperVoice.load(str(piper_models.model_path(lang)))
    return voice


async def startup() -> None:
    logger.info("Piper TTS ready (per-language on-demand loading)")


def shutdown() -> None:
    """Release ONNX sessions and shut down the thread pool executor."""
    with _load_lock:
        _voices.clear()
        _state.update(loaded=False, voice=None, backend="no model loaded", lang=None)
    _TTS_EXECUTOR.shutdown(wait=False)
    logger.info("Piper TTS shut down")


def is_loaded() -> bool:
    return _state["loaded"]


def backend_name() -> str:
    return _state["backend"]


def current_language():
    return _state["lang"]


def is_loading():
    return _state["loading"]


def is_available(lang: str) -> bool:
    return piper_models.is_available(lang)


async def synthesize(text: str, target_lang: str) -> tuple[bytes, float]:
    """Synthesize `text` for `target_lang`, returning (wav_bytes, duration_seconds).

    Load and synthesis run atomically inside a single executor call so concurrent
    requests for different languages cannot hot-swap the resident voice between
    loading and synthesizing.
    """
    if target_lang not in piper_models.PIPER_VOICES:
        raise ValueError(f"Unsupported target language '{target_lang}' for Piper TTS.")
    if not piper_models.is_available(target_lang):
        raise RuntimeError(f"__PIPER_MODEL_MISSING__{target_lang}")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_TTS_EXECUTOR, _synthesize_once, text, target_lang)


def _sanitize_text(text: str) -> str:
    """Strip problematic inputs before sending to Piper (espeak-ng + VITS)."""
    import re
    t = (text or "").strip()
    if not t:
        return ""
    t = re.sub(r"\s+", " ", t).strip()
    # Remove trailing isolated punctuation run that yields empty/no phonemes
    t = re.sub(r"[\s\-–—,.!?;:'\"()\[\]{}]+$", "", t).strip()
    # Drop characters outside basic latin + Indic scripts; anything else -> space
    t = re.sub(r"[^\w\s\u0900-\u0D7F\u0A00-\u0A7F\u0B00-\u0B7F.,!?;:()'\"-]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return ""
    if len(t) > MAX_SYNTH_CHARS:
        t = t[:MAX_SYNTH_CHARS].rsplit(" ", 1)[0].strip() if " " in t[:MAX_SYNTH_CHARS] else t[:MAX_SYNTH_CHARS]
        logger.warning("Piper TTS input truncated to %d chars", MAX_SYNTH_CHARS)
    return t


def _synthesize_once(text, target_lang):
    """Load (if needed) then synthesize, atomically, within one executor call."""
    import traceback
    import numpy as np
    import soundfile as sf

    t0 = time.time()
    try:
        cleaned = _sanitize_text(text)
        if not cleaned:
            raise ValueError("empty text after sanitization (input was punctuation/whitespace only)")

        with _load_lock:
            _ensure_loaded_locked(target_lang)
            voice = _state["voice"]
            sr = int(_state["sample_rate"])

        if voice is None:
            raise RuntimeError("Piper TTS not loaded — checkpoint missing or load failed.")

        # Piper handles phonemization (espeak-ng) + VITS inference internally.
        chunks = list(voice.synthesize(cleaned))
        if not chunks:
            raise ValueError("Piper produced no audio frames")

        pcm = b"".join(getattr(c, "audio_int16_bytes", b"") for c in chunks)
        audio = np.frombuffer(pcm, dtype="<i2")
        if audio.size == 0:
            raise ValueError("Piper produced empty audio")

        buf = io.BytesIO()
        sf.write(buf, audio, sr, subtype="PCM_16", format="WAV")
        duration = float(len(audio)) / sr
        logger.info("Piper TTS [%s]: %.2fs audio in %.2fs", target_lang, duration, time.time() - t0)
        return buf.getvalue(), duration

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[AakashVani:piper_tts] synthesis failed [{target_lang}] text={repr(text[:120])}\n{tb}", flush=True)
        logger.error("Piper TTS synthesis failed [%s]: %s\n%s", target_lang, e, tb)
        raise
