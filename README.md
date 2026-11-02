# AakashVani — Real-Time Indic Video Dubbing

> **Real-time AI-powered video dubbing for YouTube** — Translates and dubs video content into Indic languages (Telugu, Hindi, Kannada, Tamil, Malayalam, Marathi) in real-time using local and cloud AI models.

![AakashVani Demo](docs/demo.gif)

---

## ✨ Features

- **🎙 Real-time Dubbing** — Watch YouTube videos dubbed in your language as they play
- **🌐 6 Indic Languages** — Telugu, Hindi, Kannada, Tamil, Malayalam, Marathi
- **🔄 Dual TTS Backends** — Local (Piper ONNX) or Cloud (Sarvam AI)
- **🎯 Smart Caption Pipeline** — Revision-aware, stability-aware, phrase-segmented
- **⚡ Low Latency** — Streaming TTS (~500ms) with automatic fallback
- **🔒 Privacy-First** — Local Piper runs entirely on your machine
- **🧪 Extensively Tested** — 280+ unit/integration tests, benchmarked

---

## 🏗 Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  YouTube Tab    │────▶│  Content Script  │────▶│  TranscriptController│
│  (Captions)     │     │  (Capture)       │     │  (Reconcile/Stable)  │
└─────────────────┘     └──────────────────┘     └──────────┬──────────┘
                                                             │
                    ┌────────────────────────────────────────┘
                    ▼
         ┌────────────────────────┐
         │   SyncController       │
         │  (Pipeline Orchestrator)│
         └───────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌───────────────┐         ┌───────────────┐
│  Translation  │         │      TTS      │
│  (Chrome/Cloud)│         │  (Piper/Sarvam)│
└───────────────┘         └───────┬───────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
                         ┌─────────────────┐
                         │  Scheduler      │
                         │  (Timeline/Play)│
                         └─────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites
- **Chrome/Chromium** (Manifest V3 support)
- **Node.js 20+** (for backend)
- **Python 3.10+** (for Piper TTS backend)

### 1. Backend Setup (Piper TTS)
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-asr.txt  # Optional: ASR fallback
./venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### 2. Extension Install
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → Select `extension/src`
4. Pin the extension to toolbar

### 3. Configure
1. Click extension icon → Settings
2. **Mode**: Auto (Chrome Translate + Local Piper)
3. **Language**: Select target (te-IN, hi-IN, kn-IN, ta-IN, ml-IN, mr-IN)
4. **TTS Engine**: Piper (local) or Sarvam (cloud, requires API key)
5. **ASR Fallback**: Enable for videos without captions

### 4. Use
1. Open any YouTube video with captions
2. Extension auto-detects captions → translates → dubs in real-time
3. Audio plays automatically, synced to video

---

## ⚙ Configuration

| Setting | Description | Default |
|---|---|---|
| **Mode** | `auto` \| `edge` \| `cloud` \| `off` | `auto` |
| **Language** | `te-IN` \| `hi-IN` \| `kn-IN` \| `ta-IN` \| `ml-IN` \| `mr-IN` | `te-IN` |
| **TTS Engine** | `piper` (local) \| `sarvam` (cloud) | `piper` |
| **Sarvam API Key** | Required for cloud mode | — |
| **ASR Fallback** | Auto-enable when captions fail | `off` |
| **Ducking** | Background video volume during dub | `1%` |

---

## 🧪 Testing

```bash
# Extension tests
cd extension
node tests/test_transcript_regression.js
node tests/test_transcript_controller.js
node tests/test_tts_routing.js
node tests/test_asr_fallback.js
node tests/test_benchmarks.js

# Backend tests
cd backend
PYTHONPATH=. ./venv/bin/python tests/test_piper.py
PYTHONPATH=. ./venv/bin/python tests/test_asr.py
PYTHONPATH=. ./venv/bin/python tests/test_http_integration.py
```

**Test Coverage:** 280+ tests passing (extension + backend)

---

## 📊 Benchmarks

| Trace | Strategy | Commits | Fragments | Late | P50 Latency |
|---|---|---|---|---|---|
| progressive-growth | fixed-current | 3 | 1 | 0 | 1.10s |
| sliding-window | fixed-current | 4 | 3 | 0 | 2.60s |
| asr-correction | fixed-current | 5 | 4 | 1 | 1.10s |
| repeated-speech | fixed-current | 3 | 3 | 0 | 0.60s |

*Pipeline latency: ~500ms–2s (ready-time scheduling)*

---

## 🔧 Tech Stack

| Layer | Technology |
|---|---|
| **Extension** | Chrome MV3, Content Scripts, Offscreen Documents |
| **Translation** | Chrome Translator API (edge) / Sarvam API (cloud) |
| **TTS (Local)** | Piper ONNX (via piper-tts Python) |
| **TTS (Cloud)** | Sarvam Bulbul API |
| **ASR Fallback** | faster-whisper (local) |
| **Backend** | FastAPI + Uvicorn |
| **Testing** | Node.js (extension), pytest (backend) |

---

## 📁 Project Structure

```
aakashvani/
├── backend/                 # FastAPI backend (Piper TTS, ASR)
│   ├── app/
│   │   ├── routers/         # API routes (tts, asr, translate)
│   │   └── services/        # Piper TTS, ASR, models
│   └── tests/               # pytest suite
│
├── extension/               # Chrome MV3 Extension
│   ├── src/
│   │   ├── popup/           # SyncController, TranscriptController
│   │   ├── offscreen.js     # Chrome Translator API host
│   │   └── content.js       # Caption capture (TextTrack + DOM)
│   └── tests/               # Jest-like test suite
│
├── .opencode/               # OpenCode config (Superpowers plugin)
└── docs/                    # Documentation
```

---

## 🤝 Contributing

1. Fork the repo
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Run tests: `make test` (or run test commands above)
3. Commit: `git commit -m 'Add amazing feature'`
4. Push: `git push origin feature/amazing-feature`
4. Open Pull Request

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **Piper TTS** — Local neural TTS by RHVoice/RHVoice team
- **Sarvam AI** — Cloud TTS/Translation API
- **faster-whisper** — ASR fallback by Guillaume Klein
- **Chrome Translator API** — On-device translation
- **Superpowers** — OpenCode agentic workflow plugin

---

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/RUSHI-KOLLA/aakashvani/issues)
- **Discussions:** [GitHub Discussions](https://github.com/RUSHI-KOLLA/aakashvani/discussions)

---

**Built with ❤️ for the Indic language community**