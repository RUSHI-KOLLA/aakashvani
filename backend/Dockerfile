# ---------- AakashVani FastAPI backend ----------
# CPU-only PyTorch for a slim image; swap the index URL line for GPU builds.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/app/hf_cache \
    TTS_MODEL_DIR=/app/checkpoints/iitm_fastspeech2

WORKDIR /app

# Build stage: compile native wheels (soundfile/scipy deps) once
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libsndfile1 ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch: ~200MB instead of the 2GB+ CUDA wheel
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code only (checkpoints are mounted, never baked in)
COPY app/ ./app/
COPY third_party/ ./third_party/

# Non-root runtime
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Healthcheck against the live endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:8000/api/v1/health || exit 1

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
