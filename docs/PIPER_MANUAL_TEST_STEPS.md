# AakashVani — Piper Browser E2E Manual Test Steps

These steps verify the parts of the Piper dubbing workflow that cannot be run
autonomously in this headless environment (Chrome Translator API/offscreen,
YouTube caption capture, media playback, ducking, pause/resume, seeking).

## Prerequisites
1. Backend running: `cd backend && ./venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000`
2. Piper voice(s) downloaded: `curl -s -X POST http://127.0.0.1:8000/api/v1/tts/piper/prepare -H 'Content-Type: application/json' -d '{"lang":"te-IN"}'` then poll `/api/v1/tts/piper/prepare/status?lang=te-IN` until `status=ready`.
3. Extension loaded in Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `extension/src`.
4. Open a YouTube video that HAS captions (e.g. any official music video with CC).
5. Open the AakashVani popup, set:
   - Mode = Auto (or Edge)
   - Target Language = te-IN (or another Piper-supported language)
   - TTS Engine = Piper
   - Engine URL = http://127.0.0.1:8000
6. Confirm popup status dot = green ("Engine running").

## Step 1: Piper routing (select Piper → requests hit /api/v1/tts/piper)
**Action:** With TTS Engine = Piper, play the YouTube video so a caption appears.
**Expected:**
- Backend access log shows a `POST /api/v1/tts/piper` (NOT `/api/v1/tts`) for the translated text.
- Response is 200 with `{"status":"success","mode":"piper","language_code":"te-IN","duration_seconds":...,"audio_base64":"..."}`.
- Audio plays and is intelligible Telugu speech.
- Ducking: the YouTube video volume drops (to the configured ducking %, default 10%) while the dub plays, then returns.

## Step 2: IITM routing (select IITM → requests hit /api/v1/tts)
**Action:** In the popup, switch TTS Engine = IITM FastSpeech2 + HiFi-GAN. Play a caption.
**Expected:**
- Backend access log shows `POST /api/v1/tts` (NOT `/api/v1/tts/piper`).
- Because no IITM checkpoint is downloaded, the response is 503 with `language_checkpoint_not_loaded` — this confirms the request reached the IITM endpoint and that IITM is still intact/distinct. (To see IITM succeed, download an IITM checkpoint first via `/api/v1/tts/prepare`.)

## Step 3: Supported vs unsupported language behavior
**Action a:** Set Target Language to an unsupported-for-Piper language (ta-IN Tamil has no Piper voice). Play a caption with Engine = Piper.
**Expected:** Backend returns 503 with `piper_voice_missing` and a `supported` list; no audio plays; the extension shows the segment failure (banner/console).
**Action b:** Set Target Language to a supported language with model NOT yet downloaded (e.g. ml-IN before download). Play a caption with Engine = Piper.
**Expected:** Backend returns 503 `checkpoint_missing`; extension buffers the segment (`checkpoint_preparing`); after you `POST /api/v1/tts/prepare {"lang":"ml-IN"}` and it reaches `ready`, the buffered caption plays automatically (retryCheckpointBuffer).

## Step 4: Pause / resume
**Action:** While the dub is playing, pause the YouTube video.
**Expected:** The dub pauses (pauseDubbed). Resume the video → the dub resumes (resumeDubbed). No audio continues while the video is frozen.

## Step 5: Seeking
**Action:** Seek the video forward/backward by >2s while a dub is queued/playing.
**Expected:** `seeked` flush clears the queues; no stale/out-of-sync audio plays after the seek; the next caption after the seek point is synthesized and played.

## Step 6: Volume ducking
**Action:** In the popup, change Ducking (e.g. 10% → 30%). Play a caption with dubbing.
**Expected:** While the dub plays, YouTube video volume drops to the configured % (e.g. 0.30). When the dub ends, volume returns to the previous level.

## Step 7: Missing-model recovery (end-to-end)
**Action:** Ensure no Piper model is on disk for a supported language (e.g. delete `backend/checkpoints/piper_voices/piper_ml/`), Engine = Piper, Lang = ml-IN. Play a caption.
**Expected:** 503 `checkpoint_missing`; segment buffered. Then `POST /api/v1/tts/prepare {"lang":"ml-IN"}` → poll status until `ready`. The buffered segment auto-plays once ready.

## Step 8: Audio response compatibility (extension consumes Piper output)
**Action:** Confirm the extension plays Piper audio with no changes.
**Expected:** The extension decodes `audio_base64` → `Blob` → `Audio` element → `play()`, exactly as it does for IITM (same response shape: `audio_base64` + `duration_seconds`). No Piper-specific changes were needed in the extension.

## What to observe in backend logs
`tail -f /tmp/opencode/uvicorn_8000.log` should show:
- `POST /api/v1/tts/piper` 200 for Piper-engine captions
- `POST /api/v1/tts/piper/prepare` + `GET /api/v1/tts/piper/prepare/status` during downloads
- `POST /api/v1/tts` 503 for IITM engine (no checkpoint)
- Piper TTS log lines: `Piper TTS [te-IN]: 1.38s audio in 0.11s`

## Success criteria
All 8 steps above behave as expected. If they do, the full Piper dubbing workflow is verified end-to-end through the real extension + real server.
