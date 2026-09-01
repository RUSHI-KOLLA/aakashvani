"""IITM FastSpeech2 + HiFi-GAN inference service (per-language, on demand).

Exactly ONE language model is resident at a time (VRAM-safe on small GPUs).
synthesize(text, lang) hot-swaps: if a different language is requested, the
previous model is dropped and the new one loaded from its checkpoint dir
(checkpoints/iitm_fastspeech2_<code>/, see services/checkpoint_store.py).

All heavy tensor work is pinned to _EDGE_TTS_EXECUTOR so the FastAPI event
loop is never blocked. Missing checkpoints raise descriptive RuntimeErrors —
no silent fallbacks (vits_rasa/NLLB removed by design).
"""
import asyncio
import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app.services import checkpoint_store

logger = logging.getLogger("aakashvani.iitm_tts")

MAX_WORKERS = int(os.getenv("TTS_MAX_WORKERS", "1"))  # one GPU job at a time
SUPPORTED_LANGS = sorted(checkpoint_store.LANG_CODES)

_EDGE_TTS_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="edge-tts")

_state = {
    "loaded": False,
    "backend": "no model loaded",
    "lang": None,
    "t2s": None,
    "sample_rate": 22050,
    "loading": False,
}
_load_lock = threading.Lock()


def _find_vocoder_kwargs(model_dir):
    hifigan = model_dir / "hifigan"
    cfg = hifigan / "config.yml"
    if cfg.exists():
        weights = sorted(hifigan.glob("*.pth"))
        if weights:
            return {"vocoder_config": str(cfg), "vocoder_checkpoint": str(weights[0])}
    if (model_dir / "vocoder.pth").exists():
        return {"vocoder_checkpoint": str(model_dir / "vocoder.pth")}
    return {}


def _try_load(lang: str) -> None:
    """Load (or hot-swap to) the checkpoint for `lang`. Raises RuntimeError
    with actionable detail if files are missing/broken."""
    with _load_lock:
        if _state["loaded"] and _state["lang"] == lang:
            return
        _state["loading"] = True
        t0 = time.time()
        try:
            import torch
            from espnet2.bin.tts_inference import Text2Speech

            model_dir = checkpoint_store.checkpoint_dir(lang)
            model_file = model_dir / "model.pth"
            config_file = model_dir / "config.yaml"
            if not model_dir.exists() or not model_file.exists() or not config_file.exists():
                raise RuntimeError(
                    f"IITM FastSpeech2 checkpoint for {lang} not found at '{model_dir}' "
                    "(expected model.pth + config.yaml). Use POST /api/v1/tts/prepare "
                    f"to download it, or restore the folder manually."
                )

            device = "cuda" if torch.cuda.is_available() else "cpu"
            # free the previous language model first (VRAM-safe swap)
            if _state.get("t2s") is not None:
                try:
                    del _state["t2s"]
                    if device == "cuda":
                        torch.cuda.empty_cache()
                except Exception:
                    pass

            t2s = Text2Speech(
                train_config=str(config_file),
                model_file=str(model_file),
                device=device,
                **{k: str(v) for k, v in _find_vocoder_kwargs(model_dir).items()},
            )
            _state["t2s"] = t2s
            _state["sample_rate"] = int(getattr(t2s, "fs", 22050) or 22050)
            _state["lang"] = lang
            _state["loaded"] = True
            _state["backend"] = f"iitm-fastspeech2+hifigan ({device}) [{lang}]"
            logger.info("IITM TTS [%s] loaded from %s on %s in %.1fs",
                        lang, model_dir, device, time.time() - t0)
        except Exception as exc:
            _state.update(loaded=False, backend=f"error: {exc}", t2s=None)
            logger.error("IITM TTS load failed [%s]: %s", lang, exc)
            raise
        finally:
            _state["loading"] = False


def _load_in_executor(lang: str) -> None:
    _try_load(lang)


async def startup() -> None:
    """No auto-load: checkpoints arrive on demand per user-selected language."""
    logger.info("IITM TTS ready (per-language on-demand loading)")


def is_loaded() -> bool:
    return _state["loaded"]


def backend_name() -> str:
    return _state["backend"]


def current_language():
    return _state["lang"]


def is_loading():
    return _state["loading"]


async def synthesize(text: str, target_lang: str) -> tuple[bytes, float]:
    """Hot-swap to `target_lang` if needed, then synthesize.
    Returns (wav_bytes, duration_seconds) for the /api/v1/tts payload."""
    if target_lang not in checkpoint_store.LANG_CODES:
        raise ValueError(
            f"Unsupported target language '{target_lang}'. Supported: {SUPPORTED_LANGS}"
        )
    if not checkpoint_store.is_available(target_lang):
        raise RuntimeError(f"__CHECKPOINT_MISSING__{target_lang}")
    if not _state["loaded"] or _state["lang"] != target_lang:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(_EDGE_TTS_EXECUTOR, _try_load, target_lang)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EDGE_TTS_EXECUTOR, _synthesize_sync, text, target_lang)


def _synthesize_sync(text: str, target_lang: str) -> tuple[bytes, float]:
    """text frontend -> FastSpeech2 mel -> HiFi-GAN waveform -> 16-bit PCM WAV."""
    import soundfile as sf
    import torch

    t2s = _state["t2s"]
    if t2s is None:
        raise RuntimeError("IITM TTS model handle is None — load failed.")
    t0 = time.time()
    with torch.no_grad():
        out = t2s(text)
    wav = getattr(out, "wav", None)
    if wav is None and isinstance(out, dict):
        wav = out.get("wav")
    if wav is None:
        raise RuntimeError(
            f"ESPnet Text2Speech returned no 'wav' (got {type(out).__name__}). "
            "The checkpoint may lack a vocoder; add hifigan/ to the checkpoint dir."
        )
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    wav = wav.squeeze().astype("float32")
    sr = _state["sample_rate"]
    duration = float(len(wav)) / sr
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    logger.info("TTS [%s]: %.2fs audio from %d chars in %.2fs",
                target_lang, duration, len(text), time.time() - t0)
    return buf.getvalue(), duration
