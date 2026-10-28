"""Real HTTP integration tests against the running AakashVani backend.
Covers verification plan categories A1-A9 (Piper TTS).
Run: backend/venv/bin/python test_http_integration.py  (server must be up on :8000)
"""
import base64, io, json, sys, time
import urllib.request, urllib.error

import os
BASE = os.environ.get("AV_BASE", "http://127.0.0.1:8000")
VENV_PY = "/home/rushi/aakashvani/backend/venv/bin/python"

passed = 0
failed = 0

def req(method, path, payload=None, timeout=120):
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode()
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body) if body else {}
        except Exception:
            return e.code, {"_raw": body.decode(errors="replace")}

def wav_valid(b64, label):
    import soundfile as sf
    import numpy as np
    wav = base64.b64decode(b64)
    data, sr = sf.read(io.BytesIO(wav))
    ok = sr == 22050 and len(data) > 0 and int((data != 0).sum()) > 0
    print(f"  [{label}] WAV: sr={sr} samples={len(data)} nonzero={int((data != 0).sum())} bytes={len(wav)} {'OK' if ok else 'INVALID'}")
    return ok, len(wav), round(len(data) / sr, 3) if sr else 0

def check(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS: {label}")
    else:
        failed += 1
        print(f"  FAIL: {label}")

# ---------------- A1. Health ----------------
print("== A1. Health endpoint ==")
st, body = req("GET", "/api/v1/health")
check(st == 200, f"health HTTP 200 (got {st})")
check(body.get("status") in ("healthy", "degraded", "unavailable"), "health has status field")
check("piper_tts_loaded" in body, "health reports piper_tts_loaded")
check("piper_tts_backend" in body, "health reports piper_tts_backend")
check("piper_voices_available" in body, "health reports piper_voices_available")
check("tts_loaded" in body and "tts_backend" in body, "health still reports tts fields (Piper backend)")
print(f"  piper_voices_available: {body.get('piper_voices_available')}")
print(f"  tts_loaded (Piper): {body.get('tts_loaded')}")

# ---------------- A2/A3. Piper TTS downloaded langs ----------------
for lang, text in [("te-IN", "నమస్తే telugu"), ("hi-IN", "नमस्ते हिंदी")]:
    print(f"== A{2 if lang=='te-IN' else 3}. Piper TTS {lang} ==")
    st, body = req("POST", "/api/v1/tts/piper", {"text": text, "target_lang": lang}, timeout=180)
    check(st == 200, f"{lang} HTTP 200 (got {st}) body={str(body)[:200]}")
    if st == 200:
        check(body.get("mode") == "piper", f"{lang} mode=piper (got {body.get('mode')})")
        check(body.get("language_code") == lang, f"{lang} language_code={lang}")
        ok, nbytes, dur = wav_valid(body.get("audio_base64", ""), lang)
        check(ok, f"{lang} valid PCM_16 WAV 22050Hz nonzero ({nbytes} bytes, {dur}s)")
        check(body.get("duration_seconds") is not None, f"{lang} duration_seconds present")

# ---------------- A4. Piper missing model -> prepare -> ready -> synth ----------------
# kn-IN (Kannada) has NO Piper voice -> intentionally unsupported (see A4b).
print("== A4. Piper missing model (ml-IN) then prepare/download/synth ==")
st, body = req("POST", "/api/v1/tts/piper", {"text": "നമസ്കാരം മലയാളം", "target_lang": "ml-IN"})
check(st == 503, f"ml-IN synth before download HTTP 503 (got {st})")
if st == 503:
    check(body.get("detail", {}).get("checkpoint_missing") == "ml-IN", "ml-IN 503 has checkpoint_missing=ml-IN")
    check("prepare_hint" in body.get("detail", {}), "ml-IN 503 has prepare_hint")

st, body = req("POST", "/api/v1/tts/piper/prepare", {"lang": "ml-IN"})
check(st == 200 and body.get("ok") is True, f"ml-IN prepare started (got {st} {body})")

# poll until ready
ready = False
for _ in range(60):
    st2, b2 = req("GET", "/api/v1/tts/piper/prepare/status?lang=ml-IN")
    if b2.get("status") == "ready":
        ready = True
        break
    if b2.get("status") == "error":
        break
    time.sleep(2)
check(ready, "ml-IN download reached 'ready' within 120s")
if ready:
    st, body = req("POST", "/api/v1/tts/piper", {"text": "നമസ്കാരം മലയാളം", "target_lang": "ml-IN"}, timeout=180)
    check(st == 200, f"ml-IN synth after download HTTP 200 (got {st})")
    if st == 200:
        ok, nbytes, dur = wav_valid(body.get("audio_base64", ""), "ml-IN")
        check(ok, "ml-IN valid PCM_16 WAV nonzero")

# ---------------- A4b. Piper unsupported language kn-IN (Kannada: no voice exists) ----------------
print("== A4b. Piper unsupported language kn-IN (Kannada) ==")
st, body = req("POST", "/api/v1/tts/piper", {"text": "ನಮಸ್ಕಾರ", "target_lang": "kn-IN"})
check(st == 503, f"kn-IN HTTP 503 (got {st})")
if st == 503:
    d = body.get("detail", {})
    check(d.get("piper_voice_missing") == "kn-IN", f"kn-IN piper_voice_missing=kn-IN (got {d.get('piper_voice_missing')})")
    check("supported" in d, "kn-IN 503 lists supported voices")
    check("kn-IN" not in d.get("supported", []), "kn-IN not listed as supported")

st, body = req("POST", "/api/v1/tts/piper/prepare", {"lang": "kn-IN"})
check(st == 400 and body.get("ok") is not True, f"kn-IN prepare rejected (got {st} {body})")

# ---------------- A5. Piper unsupported language ta-IN (Tamil: no voice exists) ----------------
print("== A5. Piper unsupported language ta-IN (Tamil) ==")
st, body = req("POST", "/api/v1/tts/piper", {"text": "வணக்கம்", "target_lang": "ta-IN"})
check(st == 503, f"ta-IN HTTP 503 (got {st})")
if st == 503:
    d = body.get("detail", {})
    check(d.get("piper_voice_missing") == "ta-IN", f"ta-IN piper_voice_missing=ta-IN (got {d.get('piper_voice_missing')})")
    check("supported" in d, "ta-IN 503 lists supported voices")
    check("ta-IN" not in d.get("supported", []), "ta-IN not listed as supported")

# ---------------- A6. Piper empty/punct text -> 400 ----------------
print("== A6. Piper empty/punct text -> 400 ==")
st, body = req("POST", "/api/v1/tts/piper", {"text": "   !!!   ", "target_lang": "te-IN"})
check(st == 400, f"empty text HTTP 400 (got {st})")

# ---------------- A7. Piper long text truncation ----------------
print("== A7. Piper long text (>1200 chars) ==")
long_text = ("hello world " * 150).strip()
st, body = req("POST", "/api/v1/tts/piper", {"text": long_text, "target_lang": "te-IN"}, timeout=180)
check(st == 200, f"long text HTTP 200 (got {st})")
if st == 200:
    ok, nbytes, dur = wav_valid(body.get("audio_base64", ""), "long-text")
    check(ok, "long text produces valid WAV")

# ---------------- A9. Concurrent Piper two languages ----------------
print("== A9. Concurrent Piper te-IN + hi-IN ==")
import concurrent.futures
def synth(lang, text):
    st, body = req("POST", "/api/v1/tts/piper", {"text": text, "target_lang": lang}, timeout=180)
    return lang, st, body
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
    futs = [ex.submit(synth, "te-IN", "నమస్తే"), ex.submit(synth, "hi-IN", "नमस्ते")]
    results = [f.result() for f in concurrent.futures.as_completed(futs)]
check(all(st == 200 for _, st, _ in results), "both concurrent langs HTTP 200")
for lang, st, body in results:
    if st == 200:
        ok, _, _ = wav_valid(body.get("audio_base64", ""), lang)
        check(ok, f"concurrent {lang} valid WAV")

print(f"\n===== HTTP INTEGRATION: {passed} pass, {failed} fail =====")
sys.exit(1 if failed else 0)
