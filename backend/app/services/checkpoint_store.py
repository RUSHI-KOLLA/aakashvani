"""Per-language IITM FastSpeech2 checkpoint store.

Design (confirmed): the end user downloads ONLY the ~160MB checkpoint for the
language they pick. Checkpoints are fetched on demand from

    {TTS_CHECKPOINT_BASE_URL}/{lang_code}.zip     e.g. .../te.zip

Publish the zips anywhere reachable (e.g. your own HuggingFace dataset repo:
https://huggingface.co/datasets/<user>/aakashvani-checkpoints/resolve/main/te.zip).
If the repo is private, HF_TOKEN (or the cached ~/.cache/huggingface/token)
authorizes the request. Each zip must contain (top-level or under one folder):

    model.pth, config.yaml, feats_stats.npz [, hifigan/config.yml + *.pth]

Extraction lands in  checkpoints/iitm_fastspeech2_<code>/  and is picked up by
services/iitm_tts.py for that language.
"""
import logging
import os
import shutil
import threading
import urllib.request
import zipfile
from pathlib import Path

logger = logging.getLogger("aakashvani.checkpoints")

BASE_URL = os.getenv("TTS_CHECKPOINT_BASE_URL", "").rstrip("/")
CHECKPOINTS_ROOT = Path(
    os.getenv("TTS_CHECKPOINTS_ROOT", Path(__file__).resolve().parents[2] / "checkpoints")
)

LANG_CODES = {
    "te-IN": "te", "hi-IN": "hi", "kn-IN": "kn",
    "ta-IN": "ta", "ml-IN": "ml", "mr-IN": "mr",
}

_state = {
    "status": "idle", "lang": None, "progress": 0.0,
    "downloaded": 0, "total": 0, "error": None,
}
_lock = threading.Lock()


def lang_code(lang: str) -> str:
    return LANG_CODES.get(lang, "")


def checkpoint_dir(lang: str) -> Path:
    return CHECKPOINTS_ROOT / f"iitm_fastspeech2_{lang_code(lang) or 'te'}"


def is_available(lang: str) -> bool:
    d = checkpoint_dir(lang)
    return (d / "model.pth").exists() and (d / "config.yaml").exists()


def available_languages() -> list[str]:
    return [l for l in LANG_CODES if is_available(l)]


def status() -> dict:
    return dict(_state)


def _auth_headers() -> dict:
    tok = os.getenv("HF_TOKEN")
    if not tok:
        p = Path(os.path.expanduser("~/.cache/huggingface/token"))
        if p.exists():
            tok = p.read_text().strip()
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def _download_and_extract(lang: str) -> None:
    code = lang_code(lang)
    url = f"{BASE_URL}/{code}.zip"
    logger.info("downloading %s", url)
    _state.update(status="downloading", lang=lang, progress=0.0,
                  downloaded=0, total=0, error=None)
    CHECKPOINTS_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = CHECKPOINTS_ROOT / f"{code}.zip.part"
    req = urllib.request.Request(url, headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        _state["total"] = total
        done = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                _state.update(downloaded=done,
                              progress=round(done * 100.0 / total, 1) if total else 0.0)
    _state["status"] = "extracting"
    dest = checkpoint_dir(lang)
    if dest.exists():
        shutil.rmtree(dest)
    with zipfile.ZipFile(tmp) as z:
        members = [m for m in z.namelist() if not m.endswith("/")]
        # tolerate a single top-level folder inside the zip
        prefix = ""
        models = [m for m in members if m.endswith("model.pth")]
        if models:
            prefix = models[0][: models[0].rfind("model.pth")]
        for m in members:
            rel = m[len(prefix):] if prefix and m.startswith(prefix) else m
            if not rel or rel.startswith("/") or ".." in rel:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    tmp.unlink(missing_ok=True)
    _state.update(status="ready", lang=lang, progress=100.0, error=None)
    logger.info("checkpoint ready for %s at %s", lang, dest)


def _worker(lang: str) -> None:
    try:
        _download_and_extract(lang)
    except Exception as exc:  # network errors, bad zip, 401/403, missing file
        logger.error("checkpoint fetch failed for %s: %s", lang, exc)
        _state.update(status="error", error=str(exc))


def prepare(lang: str) -> dict:
    """Start background download+extract if needed. Non-blocking."""
    if lang not in LANG_CODES:
        return {"ok": False, "error": f"unsupported language '{lang}'"}
    if is_available(lang):
        _state.update(status="ready", lang=lang, progress=100.0, error=None)
        return {"ok": True, "status": "ready", "already_available": True}
    if not BASE_URL:
        return {
            "ok": False,
            "error": "TTS_CHECKPOINT_BASE_URL is not configured. Publish per-language "
                     "zips (te.zip, hi.zip, ...) there, or drop the checkpoint folder "
                     f"manually into {checkpoint_dir(lang)} and restart.",
        }
    with _lock:
        if _state["status"] in ("downloading", "extracting") and _state["lang"] == lang:
            return {"ok": True, "status": _state["status"], "already_running": True}
        _state["status"] = "downloading"
        _state["lang"] = lang
        threading.Thread(target=_worker, args=(lang,), daemon=True).start()
    return {"ok": True, "status": "started"}
