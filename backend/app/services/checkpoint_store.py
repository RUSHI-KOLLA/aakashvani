"""Per-language IITM FastSpeech2-HS checkpoint store.

Downloads on demand from the official IITM release:
  https://huggingface.co/smtiitm/FastSpeech2_HS_latest_models

Repo layout (per language + gender):
  {lang_name}/{gender}/model/{model.pth, config.yaml, feats_stats.npz,
                              energy_stats.npz, pitch_stats.npz}
  vocoder/{gender}/{lang_name}/{config.json, generator}

Local layout after download (checkpoints/iitm_fastspeech2_<code>/):
  model/{model.pth, config.yaml, feats_stats.npz, energy_stats.npz, pitch_stats.npz}
  vocoder/{config.json, generator}

Per-user cost: ~210MB for the selected language only (152MB FastSpeech2 + ~55MB HiFi-GAN).
"""
import logging
import os
import shutil
import threading
import urllib.request
from pathlib import Path

logger = logging.getLogger("aakashvani.checkpoints")

BASE_URL = os.getenv("TTS_CHECKPOINT_BASE_URL", "").rstrip("/")
GENDER = os.getenv("TTS_GENDER", "female")
CHECKPOINTS_ROOT = Path(
    os.getenv("TTS_CHECKPOINTS_ROOT", Path(__file__).resolve().parents[2] / "checkpoints")
)

# app lang id -> (lang_code, repo language folder name)
LANGS = {
    "te-IN": ("te", "telugu_latest"),
    "hi-IN": ("hi", "hindi_latest"),
    "kn-IN": ("kn", "kannada_latest"),
    "ta-IN": ("ta", "tamil_latest"),
    "ml-IN": ("ml", "malayalam_latest"),
    "mr-IN": ("mr", "marathi_latest"),
}


MODEL_FILES = ["model.pth", "config.yaml", "feats_stats.npz", "energy_stats.npz", "pitch_stats.npz"]
# text-preprocessing dictionaries (loaded by IITM's Phonifier via dict_location)
DICT_FILES = ["english"]  # per-language dict added dynamically


_DEFAULT_STATE = {"status": "idle", "lang": None, "progress": 0.0, "downloaded": 0, "total": 0, "error": None, "file": ""}
# Per-language state — robust vs concurrent te-IN + hi-IN downloads (AV-P0-001)
_states: dict[str, dict] = {}
# Global legacy alias for callers expecting single _state (points at currently downloading lang)
_state = dict(_DEFAULT_STATE)
_lock = threading.Lock()

def _get_state(lang: str) -> dict:
    with _lock:
        if lang not in _states:
            _states[lang] = dict(_DEFAULT_STATE, lang=lang)
        return _states[lang]

def _update_state(lang: str, **kw) -> None:
    with _lock:
        st = _states.get(lang)
        if st is None:
            st = dict(_DEFAULT_STATE, lang=lang)
            _states[lang] = st
        st.update(kw)
        # keep legacy global in sync with the most recently active lang (for old /status callers)
        _state.update(st)


def lang_code(lang: str) -> str:
    return LANGS.get(lang, ("", ""))[0]


def repo_lang_name(lang: str) -> str:
    return LANGS.get(lang, ("", ""))[1]


def checkpoint_dir(lang: str) -> Path:
    code = lang_code(lang) or "te"
    return CHECKPOINTS_ROOT / f"iitm_fastspeech2_{code}"


def _remote_files(lang: str) -> list[tuple[str, Path]]:
    """[(repo relative path, local destination path)] for one language."""
    name = repo_lang_name(lang)
    g = GENDER
    d = checkpoint_dir(lang)
    pairs = []
    for f in MODEL_FILES:
        pairs.append((f"{name}/{g}/model/{f}", d / "model" / f))
    pairs.append((f"vocoder/{g}/{name}/config.json", d / "vocoder" / "config.json"))
    pairs.append((f"vocoder/{g}/{name}/generator", d / "vocoder" / "generator"))
    # text-preprocessing phone dictionaries (IITM Phonifier expects
    # phone_dict/<language> and phone_dict/english under dict_location)
    ddict = d / "phone_dict"
    for f in [name] + DICT_FILES:
        pairs.append((f"phone_dict/{f}", ddict / f))
    return pairs


def is_available(lang: str) -> bool:
    d = checkpoint_dir(lang)
    name = repo_lang_name(lang)
    # Check all files that _load_fastspeech2/_load_vocoder actually need
    required = [
        d / "model" / "model.pth",
        d / "model" / "config.yaml",
        d / "model" / "feats_stats.npz",
        d / "model" / "pitch_stats.npz",
        d / "model" / "energy_stats.npz",
        d / "vocoder" / "generator",
        d / "vocoder" / "config.json",
        d / "phone_dict" / name,
        d / "phone_dict" / "english",
    ]
    return all(p.exists() and p.stat().st_size > 0 for p in required)


def available_languages() -> list[str]:
    return [l for l in LANGS if is_available(l)]


def status(lang: str | None = None) -> dict:
    with _lock:
        if lang is not None:
            st = _states.get(lang)
            return dict(st) if st else dict(_DEFAULT_STATE, lang=lang)
        # No lang: return legacy global (most recent) for backward compat
        return dict(_state)

def status_all() -> dict:
    with _lock:
        return {k: dict(v) for k, v in _states.items()}


def _auth_headers() -> dict:
    tok = os.getenv("HF_TOKEN")
    if not tok:
        p = Path(os.path.expanduser("~/.cache/huggingface/token"))
        if p.exists():
            tok = p.read_text().strip()
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def _url(repo_path: str) -> str:
    return f"{BASE_URL}/{repo_path}?download=true"


def _download_file(repo_path: str, dest: Path, counters: dict, lang: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(_url(repo_path), headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=60) as resp:
        size = int(resp.headers.get("Content-Length") or 0)
        counters["total"] += size
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                counters["downloaded"] += len(chunk)
                counters["file"] = repo_path
                if counters["total"]:
                    counters["progress"] = round(
                        counters["downloaded"] * 100.0 / counters["total"], 1
                    )
                else:
                    counters["progress"] = 0.0
                # locked progress update — race-safe for concurrent langs
                _update_state(lang, downloaded=counters["downloaded"], progress=counters["progress"], file=counters["file"])
        tmp.rename(dest)


def _prepare_sizes(lang: str) -> dict[str, int]:
    """Probe each file's size via a 1-byte Range GET (HF resolve URLs reject HEAD)."""
    sizes = {}
    for repo_path, _dest in _remote_files(lang):
        req = urllib.request.Request(
            _url(repo_path), headers={**_auth_headers(), "Range": "bytes=0-0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                cr = resp.headers.get("Content-Range") or ""
                # Content-Range: bytes 0-0/152128410
                total = int(cr.split("/")[-1]) if "/" in cr else 0
                sizes[repo_path] = total
        except Exception as exc:
            logger.warning("size probe failed for %s: %s", repo_path, exc)
            sizes[repo_path] = 0
    return sizes


def _download_and_extract(lang: str) -> None:
    pairs = _remote_files(lang)
    _update_state(lang, status="downloading", progress=0.0, downloaded=0, total=0, error=None, file="")

    # pre-compute total size for accurate progress
    sizes = _prepare_sizes(lang)
    total = sum(sizes.values())
    counters = {"downloaded": 0, "total": total, "progress": 0.0, "file": ""}
    _update_state(lang, total=total)
    logger.info("downloading %s (%.1f MB across %d files)",
                lang, total / 1e6, len(pairs))

    for repo_path, dest in pairs:
        expected = sizes.get(repo_path, -1)
        if dest.exists() and expected > 0 and dest.stat().st_size == expected:
            continue  # already complete from a previous partial run (chained compare fixed)
        _download_file(repo_path, dest, counters, lang)

    missing = [str(d) for _p, d in pairs if not d.exists()]
    if missing:
        raise RuntimeError(f"download incomplete, missing files: {missing}")
    _update_state(lang, status="ready", progress=100.0, error=None, file="")
    logger.info("checkpoint ready for %s at %s", lang, checkpoint_dir(lang))


def _worker(lang: str) -> None:
    try:
        _download_and_extract(lang)
    except Exception as exc:  # network errors, 401/403, bad path
        logger.error("checkpoint fetch failed for %s: %s", lang, exc)
        _update_state(lang, status="error", error=str(exc))


def prepare(lang: str) -> dict:
    """Start background download if needed. Non-blocking. Per-lang state prevents te-IN+hi-IN clobber."""
    if lang not in LANGS:
        return {"ok": False, "error": f"unsupported language '{lang}'"}
    if is_available(lang):
        _update_state(lang, status="ready", progress=100.0, error=None)
        return {"ok": True, "status": "ready", "already_available": True}
    if not BASE_URL:
        return {
            "ok": False,
            "error": "TTS_CHECKPOINT_BASE_URL is not configured. Set it to "
                     "https://huggingface.co/smtiitm/FastSpeech2_HS_latest_models/resolve/main",
        }
    with _lock:
        st = _states.get(lang)
        if st and st.get("status") in ("downloading", "extracting"):
            return {"ok": True, "status": st["status"], "already_running": True}
        _update_state(lang, status="downloading")
        threading.Thread(target=_worker, args=(lang,), daemon=True).start()
    return {"ok": True, "status": "started"}
