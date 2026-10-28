"""Piper ONNX voice model store (per-language, on demand).

Downloads Piper voices from the official rhasspy/piper-voices release on
Hugging Face and keeps them under a local checkpoints directory.

This module is fully independent of the IITM checkpoint_store so the IITM
implementation is left completely untouched during the migration.

Repo layout (per language):
  https://huggingface.co/rhasspy/piper-voices/resolve/main/{lang}/{voice}/{quality}/

Local layout after download (checkpoints/piper_voices/<code>/):
  {voice-stem}.onnx
  {voice-stem}.onnx.json
"""
import logging
import os
import threading
import urllib.request
from pathlib import Path

logger = logging.getLogger("aakashvani.piper_models")

BASE_URL = os.getenv(
    "PIPER_VOICES_BASE_URL",
    "https://huggingface.co/rhasspy/piper-voices/resolve/main",
).rstrip("/")

MODELS_ROOT = Path(
    os.getenv("PIPER_MODEL_DIR", Path(__file__).resolve().parents[2] / "checkpoints" / "piper_voices")
)

# app lang id -> (hf relative voice dir, model file stem)
#
# Language-to-voice correctness is enforced by test_piper_language_voice_mapping_correctness():
# each configured voice's config.json language.family must equal the app language code.
#
# NOTE: ta-IN (Tamil) and kn-IN (Kannada) have NO Piper voice in rhasspy/piper-voices —
# intentionally omitted so they are reported as explicitly unsupported rather than silently
# mapped to an unrelated voice (e.g. the Georgian ka_GE voice was previously mis-mapped to kn-IN).
# Confirmed via the Hugging Face repo tree: Indian-language dirs present are bn, hi, ml, mr, te, ur;
# kn (Kannada) and ta (Tamil) are absent.
PIPER_VOICES = {
    "te-IN": ("te/te_IN/maya/medium", "te_IN-maya-medium"),
    "hi-IN": ("hi/hi_IN/pratham/medium", "hi_IN-pratham-medium"),
    "ml-IN": ("ml/ml_IN/arjun/medium", "ml_IN-arjun-medium"),
    "mr-IN": ("mr/mr_IN/google/medium", "mr_IN-google-medium"),
}

MODEL_EXTENSIONS = (".onnx", ".onnx.json")

_DEFAULT_STATE = {"status": "idle", "lang": None, "progress": 0.0, "downloaded": 0, "total": 0, "error": None, "file": ""}
_states: dict[str, dict] = {}
_state = dict(_DEFAULT_STATE)
_lock = threading.RLock()


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
        _state.update(st)


def voice_info(lang: str) -> dict | None:
    """Return {repo_dir, stem} for `lang`, or None if no Piper voice exists."""
    entry = PIPER_VOICES.get(lang)
    if entry is None:
        return None
    repo_dir, stem = entry
    return {"repo_dir": repo_dir, "stem": stem, "model_file": f"{stem}.onnx", "config_file": f"{stem}.onnx.json"}


def voice_config(lang: str) -> dict | None:
    """Return the parsed .onnx.json config for `lang`'s Piper voice.

    Reads the local config file if the voice is downloaded; otherwise fetches it
    from the Hugging Face repo. Returns None if no voice is configured for `lang`.
    The config's ``language.family`` field is the authoritative language identity
    used by test_piper_language_voice_mapping_correctness().
    """
    info = voice_info(lang)
    if info is None:
        return None
    cfg_path = config_path(lang)
    if cfg_path.exists() and cfg_path.stat().st_size > 0:
        import json
        with open(cfg_path) as f:
            return json.load(f)
    # Fall back to fetching the config from Hugging Face (no model download).
    import json
    import urllib.request
    repo_url = f"{BASE_URL}/{info['repo_dir']}/{info['stem']}.onnx.json?download=true"
    try:
        with urllib.request.urlopen(repo_url, timeout=30) as resp:
            return json.load(resp)
    except Exception as exc:
        logger.warning("could not fetch voice config for %s: %s", lang, exc)
        return None


def model_dir(lang: str) -> Path:
    code = lang.split("-")[0]
    return MODELS_ROOT / f"piper_{code}"


def model_path(lang: str) -> Path:
    info = voice_info(lang)
    if info is None:
        return Path()
    return model_dir(lang) / info["model_file"]


def config_path(lang: str) -> Path:
    info = voice_info(lang)
    if info is None:
        return Path()
    return model_dir(lang) / info["config_file"]


def is_available(lang: str) -> bool:
    info = voice_info(lang)
    if info is None:
        return False
    d = model_dir(lang)
    return all((d / f).exists() and (d / f).stat().st_size > 0 for f in (info["model_file"], info["config_file"]))


def available_languages() -> list[str]:
    return [l for l in PIPER_VOICES if is_available(l)]


def status(lang: str | None = None) -> dict:
    with _lock:
        if lang is not None:
            st = _states.get(lang)
            return dict(st) if st else dict(_DEFAULT_STATE, lang=lang)
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
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                counters["downloaded"] += len(chunk)
                counters["file"] = repo_path
                if counters["total"]:
                    counters["progress"] = round(counters["downloaded"] * 100.0 / counters["total"], 1)
                else:
                    counters["progress"] = 0.0
                _update_state(
                    lang,
                    downloaded=counters["downloaded"],
                    progress=counters["progress"],
                    file=counters["file"],
                )
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
                total = int(cr.split("/")[-1]) if "/" in cr else 0
                sizes[repo_path] = total
        except Exception as exc:
            logger.warning("size probe failed for %s: %s", repo_path, exc)
            sizes[repo_path] = 0
    return sizes


def _remote_files(lang: str) -> list[tuple[str, Path]]:
    """[(repo relative path, local destination path)] for one language."""
    info = voice_info(lang)
    if info is None:
        return []
    d = model_dir(lang)
    pairs = []
    for suffix in MODEL_EXTENSIONS:
        repo_path = f"{info['repo_dir']}/{info['stem']}{suffix}"
        pairs.append((repo_path, d / f"{info['stem']}{suffix}"))
    return pairs


def _download_and_extract(lang: str) -> None:
    pairs = _remote_files(lang)
    _update_state(lang, status="downloading", progress=0.0, downloaded=0, total=0, error=None, file="")

    sizes = _prepare_sizes(lang)
    total = sum(sizes.values())
    counters = {"downloaded": 0, "total": total, "progress": 0.0, "file": ""}
    _update_state(lang, total=total)
    logger.info("downloading piper voice %s (%.1f MB across %d files)", lang, total / 1e6, len(pairs))

    for repo_path, dest in pairs:
        expected = sizes.get(repo_path, -1)
        if dest.exists() and expected > 0 and dest.stat().st_size == expected:
            continue
        _download_file(repo_path, dest, counters, lang)

    missing = [str(d) for _p, d in pairs if not d.exists()]
    if missing:
        raise RuntimeError(f"download incomplete, missing files: {missing}")
    _update_state(lang, status="ready", progress=100.0, error=None, file="")
    logger.info("piper voice ready for %s at %s", lang, model_dir(lang))


def _worker(lang: str) -> None:
    try:
        _download_and_extract(lang)
    except Exception as exc:
        logger.error("piper voice fetch failed for %s: %s", lang, exc)
        _update_state(lang, status="error", error=str(exc))


def prepare(lang: str) -> dict:
    """Start background download if needed. Non-blocking. Per-lang state."""
    info = voice_info(lang)
    if info is None:
        return {"ok": False, "error": f"no Piper voice configured for language '{lang}'"}
    if is_available(lang):
        _update_state(lang, status="ready", progress=100.0, error=None)
        return {"ok": True, "status": "ready", "already_available": True}
    with _lock:
        st = _states.get(lang)
        if st and st.get("status") in ("downloading", "extracting"):
            return {"ok": True, "status": st["status"], "already_running": True}
        _update_state_unlocked(lang, status="downloading")
        threading.Thread(target=_worker, args=(lang,), daemon=True).start()
    return {"ok": True, "status": "started"}


def _update_state_unlocked(lang: str, **kw) -> None:
    """Internal helper that updates state WITHOUT acquiring the lock.
    Caller MUST hold _lock."""
    st = _states.get(lang)
    if st is None:
        st = dict(_DEFAULT_STATE, lang=lang)
        _states[lang] = st
    st.update(kw)
    _state.update(st)
