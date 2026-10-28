# ---------- AakashVani FastAPI backend (Piper ONNX TTS) ----------
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/app/hf_cache \
    PIPER_MODEL_DIR=/app/checkpoints/piper_voices

WORKDIR /app

# Piper ONNX needs espeak-ng data (phonemizer) and libsndfile (soundfile).
# No PyTorch is required: Piper runs via onnxruntime (CPU).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libsndfile1 ffmpeg curl espeak-ng espeak-ng-data \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code only (checkpoints are mounted, never baked in)
COPY app/ ./app/

# Non-root runtime
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Healthcheck against the live endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:8000/api/v1/health || exit 1

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
