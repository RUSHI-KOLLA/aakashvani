"""IITM FastSpeech2-HS + HiFi-GAN inference (per-language, on demand).

Follows the official smtiitm/FastSpeech2_HS_latest_models inference.py:
  1. FastSpeech2 via espnet2 Text2Speech, with config.yaml stats paths patched
     to absolute locations (normalize/pitch/energy).
  2. HiFi-GAN vocoder loaded MANUALLY (Generator from the vendored hifigan
     modules in third_party/iitm_indic_tts/hifigan) - NOT via espnet, since
     the release ships Coqui-style config.json + generator files.
  3. Text preprocessing via TTSDurAlignPreprocessor (per-language phone dict).
  4. feat_gen_denorm.T.unsqueeze(0) * 2.3262 -> vocoder -> int16 WAV.

Exactly ONE language is resident at a time (VRAM-safe hot swap).
"""
import asyncio
import io
import json
import logging
import os
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.services import checkpoint_store

logger = logging.getLogger("aakashvani.iitm_tts")

MAX_WORKERS = int(os.getenv("TTS_MAX_WORKERS", "1"))
THIRD_PARTY = Path(__file__).resolve().parents[2] / "third_party" / "iitm_indic_tts"
# vendored hifigan modules (env.py, models.py, meldataset.py) + IITM text
# preprocessing live here; register before any loader imports them
for _p in (str(THIRD_PARTY), str(THIRD_PARTY / "hifigan")):
    if _p not in sys.path:
        sys.path.append(_p)


_TTS_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="iitm-tts")

_state = {
    "loaded": False,
    "backend": "no model loaded",
    "lang": None,
    "t2s": None,
    "vocoder": None,
    "sample_rate": 22050,
    "loading": False,
}
_load_lock = threading.Lock()
_phone_dicts = {}  # lang -> phone_dictionary (grows as words are phonified)


def _load_vocoder(model_dir: Path, device: str):
    """Load the Coqui-style HiFi-GAN generator (config.json + generator)."""
    import torch
    from env import AttrDict
    from meldataset import MAX_WAV_VALUE  # noqa: F401  (used by callers)
    from models import Generator

    vocoder_dir = model_dir / "vocoder"
    with open(vocoder_dir / "config.json") as f:
        h = AttrDict(json.load(f))
    torch.manual_seed(h.seed)
    generator = Generator(h).to(device)
    state_dict_g = torch.load(vocoder_dir / "generator", map_location=device)
    generator.load_state_dict(state_dict_g["generator"])
    generator.eval()
    generator.remove_weight_norm()
    return generator, int(h.get("sampling_rate", 22050))


def _load_fastspeech2(model_dir: Path, device: str):
    """Patch stats-file paths in a temp copy of config.yaml, then espnet Text2Speech."""
    import torch
    import yaml
    from espnet2.bin.tts_inference import Text2Speech

    config_path = model_dir / "model" / "config.yaml"
    with open(config_path) as f:
        config = yaml.safe_load(f)
    config["normalize_conf"]["stats_file"] = str(model_dir / "model" / "feats_stats.npz")
    config["pitch_normalize_conf"]["stats_file"] = str(model_dir / "model" / "pitch_stats.npz")
    config["energy_normalize_conf"]["stats_file"] = str(model_dir / "model" / "energy_stats.npz")

    # Write patched config to a temp file so we never mutate the original
    patched = tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", dir=model_dir / "model", delete=False
    )
    try:
        yaml.dump(config, patched)
        patched.close()
        return Text2Speech(
            train_config=patched.name,
            model_file=str(model_dir / "model" / "model.pth"),
            device=device,
        )
    finally:
        os.unlink(patched.name)


def _try_load(lang: str) -> None:
    """Load (or hot-swap to) the FastSpeech2 + HiFi-GAN pair for `lang`."""
    with _load_lock:
        if _state["loaded"] and _state["lang"] == lang:
            return
        _state["loading"] = True
        t0 = time.time()
        try:
            import torch

            model_dir = checkpoint_store.checkpoint_dir(lang)
            if not checkpoint_store.is_available(lang):
                raise RuntimeError(
                    f"IITM FastSpeech2 checkpoint for {lang} missing at '{model_dir}' "
                    "(need model/model.pth, model/config.yaml, vocoder/generator). "
                    "Trigger POST /api/v1/tts/prepare to download it."
                )
            device = "cuda" if torch.cuda.is_available() else "cpu"

            # drop previous language first (VRAM-safe swap)
            if _state.get("t2s") is not None or _state.get("vocoder") is not None:
                _state["t2s"] = None
                _state["vocoder"] = None
                if device == "cuda":
                    torch.cuda.empty_cache()

            vocoder, sr = _load_vocoder(model_dir, device)
            t2s = _load_fastspeech2(model_dir, device)

            _state["t2s"] = t2s
            _state["vocoder"] = vocoder
            _state["sample_rate"] = sr
            _state["lang"] = lang
            _state["loaded"] = True
            _state["backend"] = f"iitm-fastspeech2-hs + hifigan ({device}) [{lang}]"
            logger.info("IITM TTS [%s] loaded on %s in %.1fs (sr=%d)",
                        lang, device, time.time() - t0, sr)
        except Exception as exc:
            _state.update(loaded=False, backend=f"error: {exc}", t2s=None, vocoder=None)
            logger.error("IITM TTS load failed [%s]: %s", lang, exc)
            raise
        finally:
            _state["loading"] = False


async def startup() -> None:
    logger.info("IITM TTS ready (per-language on-demand loading)")


def shutdown() -> None:
    """Release GPU memory and shut down the thread pool executor."""
    import torch
    if _state.get("t2s") is not None or _state.get("vocoder") is not None:
        _state["t2s"] = None
        _state["vocoder"] = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    _TTS_EXECUTOR.shutdown(wait=False)
    logger.info("IITM TTS shut down")


def is_loaded() -> bool:
    return _state["loaded"]


def backend_name() -> str:
    return _state["backend"]


def current_language():
    return _state["lang"]


def is_loading():
    return _state["loading"]


async def synthesize(text: str, target_lang: str) -> tuple[bytes, float]:
    if target_lang not in checkpoint_store.LANGS:
        raise ValueError(f"Unsupported target language '{target_lang}'.")
    if not checkpoint_store.is_available(target_lang):
        raise RuntimeError(f"__CHECKPOINT_MISSING__{target_lang}")
    if not _state["loaded"] or _state["lang"] != target_lang:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(_TTS_EXECUTOR, _try_load, target_lang)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_TTS_EXECUTOR, _synthesize_sync, text, target_lang)


_preprocess_lock = threading.Lock()


def _preprocess_text(text: str, lang: str) -> str:
    """Official IITM text pipeline (number normalize -> clean -> phonify).

    The vendored IITM Phonifier resolves paths relative to CWD (for
    multilingualcharmap.json and tmp/ dict writes). We save/restore CWD
    around the call, protected by a lock for thread safety.

    CRITICAL: The import of text_preprocess_for_inference MUST happen inside
    the chdir block because the module defines SharedInit with a Phonifier()
    class attribute that opens multilingualcharmap.json relative to CWD at
    import time.
    """
    lang_name = checkpoint_store.repo_lang_name(lang)
    gender = checkpoint_store.GENDER
    model_dir = checkpoint_store.checkpoint_dir(lang)
    phone_dict_dir = model_dir / "phone_dict"

    tmpdir = THIRD_PARTY / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)

    if lang not in _phone_dicts:
        _phone_dicts[lang] = {}
    pre = _phone_dicts[lang]

    with _preprocess_lock:
        old_cwd = os.getcwd()
        try:
            os.chdir(THIRD_PARTY)
            from text_preprocess_for_inference import TTSDurAlignPreprocessor, Phonifier
            preprocessor = TTSDurAlignPreprocessor(
                phonifier=Phonifier(dict_location=str(phone_dict_dir))
            )
            phonified, _phrases = preprocessor.preprocess(text, lang_name, gender, pre)
        finally:
            os.chdir(old_cwd)
    return " ".join(phonified)


def _sanitize_text(text: str) -> str:
    """Strip problematic inputs before ESPnet/dict lookup."""
    import re
    t = (text or "").strip()
    if not t:
        return ""
    # Collapse whitespace, strip leading/trailing punctuation that crashes dict lookup
    t = re.sub(r"\s+", " ", t)
    # Remove trailing isolated punctuation run (e.g. "...", "!!") that yields empty phonemes
    t = re.sub(r"[\s\-–—,.!?;:'\"()\[\]{}]+$", "", t).strip()
    # Drop characters outside Indic + basic latin + common punctuation/numbers
    # Keeps: latin, devanagari (\u0900-\u097F), telugu (\u0C00-\u0C7F), tamil (\u0B80-\u0BFF),
    #        kannada (\u0C80-\u0CFF), malayalam (\u0D00-\u0D7F), gurmukhi, bengali, gujarati etc.
    # Anything outside is replaced with space then collapsed — avoids ?? crashes.
    t = re.sub(r"[^\w\s\u0900-\u0D7F\u0A00-\u0A7F\u0B00-\u0B7F.,!?;:()'\"-]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # Hard cap: ESPnet truncates long feats; chunk to avoid OOM
    if len(t) > 450:
        t = t[:450].rsplit(" ", 1)[0]
    return t


def _synthesize_sync(text: str, target_lang: str) -> tuple[bytes, float]:
    import traceback
    import numpy as np
    import soundfile as sf
    import torch
    from meldataset import MAX_WAV_VALUE

    t0 = time.time()
    try:
        # --- text sanitization (prevents dict lookup crashes on emojis/empty/punct) ---
        cleaned = _sanitize_text(text)
        if not cleaned:
            raise ValueError("empty text after sanitization (input was punctuation/whitespace only)")

        t2s = _state["t2s"]
        vocoder = _state["vocoder"]
        if t2s is None or vocoder is None:
            raise RuntimeError("IITM TTS not loaded — checkpoint missing or load failed.")

        spoken = _preprocess_text(cleaned, target_lang)
        if not spoken or not spoken.strip():
            # Fallback to cleaned text if preprocessor returned empty
            spoken = cleaned
            logger.warning("TTS [%s]: preprocessor empty, falling back to raw cleaned text", target_lang)

        alpha = float(os.getenv("TTS_ALPHA", "1"))
        with torch.inference_mode():
            out = t2s(spoken, decode_conf={"alpha": alpha})
            x = out["feat_gen_denorm"].T.unsqueeze(0) * 2.3262
            x = x.to(next(vocoder.parameters()).device)
            y_g_hat = vocoder(x)
            audio = y_g_hat.squeeze() * MAX_WAV_VALUE
            audio = audio.cpu().numpy().astype("int16")

        sr = _state["sample_rate"]
        # Single-pass float32 processing with soundfile in-memory stream buffer
        audio_f32 = audio.astype(np.float32) / 32768.0
        buf = io.BytesIO()
        sf.write(buf, audio_f32, sr, subtype="PCM_16", format="WAV")
        duration = float(len(audio)) / sr
        logger.info("TTS [%s]: %.2fs audio in %.2fs",
                    target_lang, duration, time.time() - t0)
        return buf.getvalue(), duration

    except Exception as e:
        tb = traceback.format_exc()
        # Print to console so backend terminal shows exact stack trace during synthesis
        print(f"[AakashVani:iitm_tts] synthesis failed [{target_lang}] text={repr(text[:120])}\n{tb}", flush=True)
        logger.error("TTS synthesis failed [%s]: %s\n%s", target_lang, e, tb)
        raise
