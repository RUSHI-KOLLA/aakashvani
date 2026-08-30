"""IITM FastSpeech2 + HiFi-GAN inference service (single-language checkpoint).

Loads ONE local checkpoint directory (TTS_MODEL_DIR in .env) containing:
  - model.pth        — FastSpeech2 espnet checkpoint
  - config.yaml      — espnet training config (token list, frontend)
  - feats_stats.npz  — normalization statistics
  - hifigan/ (optional) — separate HiFi-GAN vocoder (config.yml + *.pth)

All heavy tensor work is pinned to _EDGE_TTS_EXECUTOR so the FastAPI event
loop is never blocked. Missing checkpoints raise descriptive RuntimeErrors —
no silent fallbacks.
"""
import asyncio
import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

logger = logging.getLogger("aakashvani.iitm_tts")

TTS_MODEL_DIR = Path(os.getenv("TTS_MODEL_DIR", "checkpoints/iitm_fastspeech2"))
MAX_WORKERS = int(os.getenv("TTS_MAX_WORKERS", "1"))  # one GPU job at a time

# Supported Indic language identifiers (single checkpoint = single language;
# the identifier is validated and echoed in the response payload).
SUPPORTED_LANGS = {"te-IN", "hi-IN", "kn-IN", "ta-IN", "ml-IN", "mr-IN"}

# Dedicated executor: keeps synthesis off the event loop and caps GPU
# concurrency explicitly (unbounded default pools caused VRAM thrash).
_EDGE_TTS_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="edge-tts")

_state = {"loaded": False, "backend": "unavailable", "t2s": None, "sample_rate": 22050}
_load_lock = threading.Lock()

def _find_vocoder_kwargs(model_dir: Path) -> dict:
    """Detect a separate HiFi-GAN vocoder next to the FastSpeech2 checkpoint."""
    hifigan = model_dir / "hifigan"
    cfg = hifigan / "config.yml"
    if cfg.exists():
        weights = sorted(hifigan.glob("*.pth"))
        if weights:
            return {"vocoder_config": str(cfg), "vocoder_checkpoint": str(weights[0])}
    if (model_dir / "vocoder.pth").exists():
        return {"vocoder_checkpoint": str(model_dir / "vocoder.pth")}
    return {}


def _try_load() -> None:
    """Load the single-language FastSpeech2 checkpoint. Runs once in a worker
    thread at startup. Raises RuntimeError with actionable detail on failure."""
    with _load_lock:
        if _state["loaded"]:
            return
        t0 = time.time()
        try:
            import torch
            from espnet2.bin.tts_inference import Text2Speech

            if not TTS_MODEL_DIR.exists():
                raise RuntimeError(
                    f"IITM TTS checkpoint directory not found: '{TTS_MODEL_DIR}'. "
                    "Expected layout: model.pth, config.yaml, feats_stats.npz "
                    "(+ optional hifigan/). Set TTS_MODEL_DIR in backend/.env and "
                    "place the IITM FastSpeech2 + HiFi-GAN (HS) release there."
                )
            model_file = TTS_MODEL_DIR / "model.pth"
            config_file = TTS_MODEL_DIR / "config.yaml"
            if not model_file.exists() or not config_file.exists():
                raise RuntimeError(
                    f"Incomplete checkpoint in '{TTS_MODEL_DIR}': "
                    f"model.pth={model_file.exists()}, config.yaml={config_file.exists()}. "
                    "Restore the full IITM FastSpeech2 checkpoint for this language."
                )

            device = "cuda" if torch.cuda.is_available() else "cpu"
            t2s = Text2Speech(
                train_config=str(config_file),
                model_file=str(model_file),
                device=device,
                **{k: str(v) for k, v in _find_vocoder_kwargs(TTS_MODEL_DIR).items()},
            )
            _state["t2s"] = t2s
            _state["sample_rate"] = int(getattr(t2s, "fs", 22050) or 22050)
            _state["loaded"] = True
            _state["backend"] = f"iitm-fastspeech2+hifigan ({device})"
            logger.info("IITM TTS loaded from %s on %s in %.1fs",
                        TTS_MODEL_DIR, device, time.time() - t0)
        except Exception as exc:
            _state.update(loaded=False, backend=f"error: {exc}", t2s=None)
            logger.error("IITM TTS load failed: %s", exc)


async def startup() -> None:
    """Called at app startup; loads the checkpoint once, off the request path."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _try_load)


def is_loaded() -> bool:
    return _state["loaded"]


def backend_name() -> str:
    return _state["backend"]


async def synthesize(text: str, target_lang: str) -> tuple[bytes, float]:
    """Synthesize speech. All tensor work stays inside _EDGE_TTS_EXECUTOR.

    Returns (wav_bytes, duration_seconds) for the /api/v1/tts payload.
    Raises RuntimeError when the checkpoint is missing/not loaded or the
    language identifier is unsupported.
    """
    if not _state["loaded"]:
        raise RuntimeError(
            f"IITM TTS not loaded: {_state['backend']}. Restore the checkpoint "
            f"at '{TTS_MODEL_DIR}' and restart the engine."
        )
    if target_lang not in SUPPORTED_LANGS:
        raise ValueError(
            f"Unsupported target language '{target_lang}'. Supported: {sorted(SUPPORTED_LANGS)}"
        )
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EDGE_TTS_EXECUTOR, _synthesize_sync, text, target_lang)


def _synthesize_sync(text: str, target_lang: str) -> tuple[bytes, float]:
    """Full sequential pipeline inside the thread worker:
    text preprocessing (g2p/phonemize inside Text2Speech) -> FastSpeech2
    mel-spectrogram -> HiFi-GAN waveform -> 16-bit PCM WAV bytes.
    """
    import soundfile as sf
    import torch

    t2s = _state["t2s"]
    if t2s is None:
        raise RuntimeError("IITM TTS model handle is None — startup load failed.")

    t0 = time.time()

    # 1+2) Text frontend (normalize -> phonemize) and FastSpeech2 decoding,
    #      including HiFi-GAN vocoding if the checkpoint bundles/points to one.
    with torch.no_grad():
        out = t2s(text)

    wav = getattr(out, "wav", None)
    if wav is None and isinstance(out, dict):
        wav = out.get("wav")
    if wav is None:
        raise RuntimeError(
            f"ESPnet Text2Speech returned no 'wav' attribute (got {type(out).__name__}). "
            "The checkpoint may lack a vocoder; add hifigan/ to the checkpoint dir."
        )
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    wav = wav.squeeze().astype("float32")

    sr = _state["sample_rate"]
    duration = float(len(wav)) / sr

    # 3) Encode raw float waveform to 16-bit PCM WAV in-memory for the router.
    buf = io.BytesIO()

    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    logger.info("TTS %s: %.2fs audio from %d chars in %.2fs",
                target_lang, duration, len(text), time.time() - t0)
    return buf.getvalue(), duration

