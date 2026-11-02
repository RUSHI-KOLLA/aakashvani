"""Optional ASR (speech→text) service for the caption-health fallback path.

Deliberately optional:
  - ``faster-whisper`` is NOT part of the default ``requirements.txt``.
    Install with ``pip install -r requirements-asr.txt``.
  - Model weights are downloaded from Hugging Face on the FIRST transcription
    request only — never at server startup, never unloaded automatically,
    never without an explicit gateway request from the extension user.

ASR backends supported: faster-whisper (CTranslate2/Vosk-style encoder-decoder).
"""

from __future__ import annotations

import base64
import importlib.util
import io
import os
import threading
import time

import numpy as np

try:
    import soundfile as sf
    _SOUNDFILE_OK = True
except Exception:  # pragma: no cover - soundfile is a hard dep of requirements.txt
    sf = None
    _SOUNDFILE_OK = False

TARGET_SAMPLE_RATE = 16000

# 'xx-IN' BCP-47 style extension language codes → Whisper ISO-639-1 codes.
_WHISPER_LANGUAGE_MAP = {
    "te-IN": "te",
    "kn-IN": "kn",
    "ta-IN": "ta",
    "hi-IN": "hi",
    "ml-IN": "ml",
    "mr-IN": "mr",
    "en-IN": "en",
    "en-US": "en",
}


class ASRError(Exception):
    """Base for explicit ASR failures (never silently faked)."""


class ASRDependencyMissing(ASRError):
    """faster-whisper is not installed in this venv."""

    def __init__(self) -> None:
        super().__init__(
            "ASR optional dependency 'faster-whisper' is not installed. "
            "Install with: ./venv/bin/pip install -r requirements-asr.txt"
        )


class ASRModelInitError(ASRError):
    """Model weights failed to download or load."""


def is_dependency_available() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None and _SOUNDFILE_OK


def decode_wav(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode a WAV (or FLAC/OGG) byte payload into ``(float32 mono, sr)``."""
    if not wav_bytes:
        raise ValueError("audio payload is empty")
    if not _SOUNDFILE_OK:
        raise ASRError("soundfile not importable — cannot decode audio")
    try:
        data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=True)
    except Exception as exc:  # soundfile raises RuntimeError/LibsndfileError
        raise ValueError(f"unsupported audio payload: {exc}") from exc
    mono = data.mean(axis=1)
    return np.ascontiguousarray(mono, dtype=np.float32), int(sr)


def resample(x: np.ndarray, orig_sr: int, target_sr: int = TARGET_SAMPLE_RATE) -> np.ndarray:
    """Numpy linear-interpolation resampler (no scipy dependency)."""
    if orig_sr == target_sr or x.size == 0:
        return x
    duration = x.shape[0] / float(orig_sr)
    n_out = max(1, int(round(duration * target_sr)))
    t_in = np.arange(x.shape[0], dtype=np.float32) / float(orig_sr)
    t_out = np.arange(n_out, dtype=np.float32) / float(target_sr)
    return np.interp(t_out, t_in, x).astype(np.float32)


def pcm_bytes_to_array(pcm16: bytes) -> np.ndarray:
    """Raw little-endian 16-bit PCM → float32 array."""
    return np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0


class ASRService:
    """Lazy-loaded faster-whisper wrapper. Thread-safe model init.

    CPU-first by default: CUDA is opt-in via ASR_DEVICE=cuda, and any CUDA
    runtime failure automatically falls back to CPU rather than erroring out.
    """

    def __init__(self) -> None:
        self._model = None
        self._model_name = os.getenv("ASR_MODEL", "base")
        self._device = os.getenv("ASR_DEVICE", "cpu")  # 'cpu' | 'cuda'
        self._compute_type = os.getenv("ASR_COMPUTE_TYPE", "")
        self._lock = threading.Lock()
        self._init_error: str | None = None
        self._initialized_at: float | None = None
        self._fell_back_to_cpu = False

    # ---------------------------------------------------------------
    # Model lifecycle
    # ---------------------------------------------------------------
    def _model_kwargs(self) -> dict:
        compute = self._compute_type
        if not compute:
            if self._device == "cpu":
                compute = "int8"
            elif self._device == "cuda":
                compute = "float16"
            else:  # auto — int8 is both portable and fast
                compute = "int8"
        return {
            # faster-whisper >= 1.2 expects the model spec as the positional
            # parameter `model_size_or_path` (was `model_size_or_dir`).
            "model_size_or_path": self._model_name,
            "device": self._device,
            "compute_type": compute,
        }

    def _ensure_model(self):
        """Initialize the model on first use. Raises explicit ASR errors."""
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            if not is_dependency_available():
                raise ASRDependencyMissing()
            try:
                from faster_whisper import WhisperModel

                t0 = time.time()
                kwargs = self._model_kwargs()
                self._model = WhisperModel(**kwargs)
                self._initialized_at = time.time()
                self._init_error = None
                print(
                    f"[asr] model '{self._model_name}' ready "
                    f"({time.time() - t0:.1f}s, device={kwargs['device']}, "
                    f"compute={kwargs['compute_type']})"
                )
            except Exception as exc:  # download or load failure
                self._init_error = f"{type(exc).__name__}: {exc}"
                self._model = None
                raise ASRModelInitError(
                    f"ASR model init failed for '{self._model_name}': {exc}"
                ) from exc
        return self._model

    # ---------------------------------------------------------------
    # Transcription
    # ---------------------------------------------------------------
    def normalize_language(self, language: str | None) -> str | None:
        if not language:
            return None
        return _WHISPER_LANGUAGE_MAP.get(language, language.split("-")[0].lower() or None)

    def transcribe(self, wav_bytes: bytes, language: str | None = None) -> dict:
        """Transcribe WAV bytes. Runs synchronously — call via ``to_thread``."""
        audio, sr = decode_wav(wav_bytes)
        if audio.size == 0:
            raise ValueError("decoded audio is empty")
        model = self._ensure_model()
        if sr != TARGET_SAMPLE_RATE:
            audio = resample(audio, sr, TARGET_SAMPLE_RATE)

        whisper_lang = self.normalize_language(language)
        try:
            return self._transcribe_with(model, audio, whisper_lang)
        except RuntimeError as exc:
            # CUDA runtime missing mid-load → transparent CPU retry (once)
            msg = str(exc).lower()
            if not self._fell_back_to_cpu and any(k in msg for k in ("cuda", "cublas", "cudnn")):
                with self._lock:
                    self._model = None
                self._fell_back_to_cpu = True
                self._device = "cpu"
                model = self._ensure_model()
                return self._transcribe_with(model, audio, whisper_lang)
            raise

    def _transcribe_with(self, model, audio, whisper_lang):
        segments, info = model.transcribe(
            audio,
            language=whisper_lang,
            beam_size=1,  # low latency: greedy decoding
            vad_filter=True,
        )
        text_parts: list[str] = []
        seg_meta: list[dict] = []
        for seg in segments:
            text_parts.append(seg.text.strip())
            seg_meta.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
        text = " ".join(t for t in text_parts if t).strip()

        return {
            "text": text,
            "detected_language": info.language,
            "language_probability": getattr(info, "language_probability", None),
            "duration_seconds": round(info.duration, 3) if info.duration is not None else round(audio.size / TARGET_SAMPLE_RATE, 3),
            "segments": seg_meta,
            "provider": "faster-whisper",
            "model": self._model_name,
        }

    def decode_base64_wav(self, b64: str) -> bytes:
        try:
            return base64.b64decode(b64, validate=True)
        except Exception as exc:
            raise ValueError(f"invalid base64 audio: {exc}") from exc

    # ---------------------------------------------------------------
    # Introspection
    # ---------------------------------------------------------------
    def status(self) -> dict:
        dep_ok = is_dependency_available()
        return {
            "available": dep_ok,                 # dependency importable
            "initialized": self._model is not None,  # weights already loaded/downloading done
            "model": self._model_name,
            "device": self._device,
            "compute_type": self._model_kwargs()["compute_type"],
            "target_sample_rate": TARGET_SAMPLE_RATE,
            "install_hint": "./venv/bin/pip install -r requirements-asr.txt",
            "error": self._init_error,
        }

    def is_loaded_and_healthy(self) -> bool:
        return self._model is not None


asr_service = ASRService()
