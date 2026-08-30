"""Local NMT service — facebook/nllb-200-distilled-600M (cached in HF hub).

Lazy-loads once in a background thread at startup; never blocks the event
loop. Translation runs on the dedicated executor (single worker to avoid
VRAM contention with TTS).
"""
import asyncio
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

logger = logging.getLogger("aakashvani.nmt")

NMT_MODEL = os.getenv("NMT_MODEL", "facebook/nllb-200-distilled-600M")

# BCP-47 style IDs used by the app -> NLLB flores-200 codes
NLLB_LANGS = {
    "te-IN": "tel_Telu",
    "hi-IN": "hin_Deva",
    "kn-IN": "kan_Knda",
    "ta-IN": "tam_Taml",
    "ml-IN": "mal_Mlym",
    "mr-IN": "mar_Deva",
    "en-IN": "eng_Latn",
}

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nmt")
_state = {"loaded": False, "backend": "unavailable", "pipe": None}
_load_lock = threading.Lock()


def is_loaded() -> bool:
    return _state["loaded"]


def backend_name() -> str:
    return _state["backend"]


def _try_load() -> None:
    with _load_lock:
        if _state["loaded"]:
            return
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

            device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if device == "cuda" else torch.float32
            tokenizer = AutoTokenizer.from_pretrained(NMT_MODEL)
            try:
                model = AutoModelForSeq2SeqLM.from_pretrained(NMT_MODEL, torch_dtype=dtype)
                model.to(device)
            except torch.cuda.OutOfMemoryError:
                logger.warning("CUDA OOM loading NMT — falling back to CPU")
                torch.cuda.empty_cache()
                device = "cpu"
                model = AutoModelForSeq2SeqLM.from_pretrained(NMT_MODEL)
                model.to(device)
            model.eval()
            _state["pipe"] = (tokenizer, model, device)
            _state["loaded"] = True
            _state["backend"] = f"nllb-200-distilled-600M ({device})"
            logger.info("NMT loaded: %s", _state["backend"])
        except Exception as exc:
            _state.update(loaded=False, backend=f"error: {exc}", pipe=None)
            logger.error("NMT load failed: %s", exc)


async def startup() -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _try_load)


async def translate(text: str, source_lang: str, target_lang: str) -> str:
    if not _state["loaded"]:
        raise RuntimeError(f"Local NMT not loaded: {_state['backend']}")
    src = NLLB_LANGS.get(source_lang)
    tgt = NLLB_LANGS.get(target_lang)
    if not tgt:
        raise ValueError(f"Unsupported target language for local NMT: {target_lang}")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EXECUTOR, _translate_sync, text, src or "eng_Latn", tgt)


def _translate_sync(text: str, src: str, tgt: str) -> str:
    import torch

    tokenizer, model, device = _state["pipe"]
    tokenizer.src_lang = src
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=256).to(device)
    with torch.no_grad():
        tokens = model.generate(
            **inputs,
            forced_bos_token_id=tokenizer.convert_tokens_to_ids(tgt),
            max_new_tokens=256,
            num_beams=2,
        )
    return tokenizer.batch_decode(tokens, skip_special_tokens=True)[0].strip()
