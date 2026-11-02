"""Sarvam AI Bulbul TTS tests.

These tests exercise the /api/v1/tts Sarvam endpoint without requiring a valid
Sarvam API key:

- Missing API key -> 401 (local validation, no network)
- Invalid API key -> 403 (real network call to Sarvam, confirms routing works)
- Unsupported language -> 422 (local validation)
- Empty text -> 400 (local validation)

Run: backend/venv/bin/python test_sarvam_tts.py  (server must be up on :8000)
"""
import json
import sys
import urllib.request
import urllib.error

import os
BASE = os.environ.get("AV_BASE", "http://127.0.0.1:8000")

passed = 0
failed = 0


def req(method, path, payload=None, timeout=30):
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


def check(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS: {label}")
    else:
        failed += 1
        print(f"  FAIL: {label}")


print("== S1. Sarvam TTS missing API key -> 401 ==")
st, body = req("POST", "/api/v1/tts", {"text": "नमस्ते", "target_lang": "hi-IN"})
check(st == 401, f"missing key HTTP 401 (got {st})")
if st == 401:
    d = body.get("detail", {})
    check(d.get("provider") == "sarvam", "provider=sarvam in error detail")
    check("missing_api_key" in d.get("code", ""), "code=missing_api_key")

print("== S2. Sarvam TTS invalid API key -> 403 (real Sarvam call) ==")
st, body = req("POST", "/api/v1/tts", {"text": "नमस्ते", "target_lang": "hi-IN", "sarvam_api_key": "invalid_key"})
check(st == 403, f"invalid key HTTP 403 (got {st})")
if st == 403:
    d = body.get("detail", {})
    check(d.get("provider") == "sarvam", "provider=sarvam in error detail")
    check("invalid_api_key" in d.get("code", ""), "code=invalid_api_key_error")

print("== S3. Sarvam TTS unsupported language -> 422 ==")
st, body = req("POST", "/api/v1/tts", {"text": "hello", "target_lang": "xx-YY", "sarvam_api_key": "dummy"})
check(st == 422, f"unsupported lang HTTP 422 (got {st})")
if st == 422:
    d = body.get("detail", {})
    check("unprocessable_entity" in d.get("code", ""), "code=unprocessable_entity_error")

print("== S4. Sarvam TTS empty text -> 400 ==")
st, body = req("POST", "/api/v1/tts", {"text": "   ", "target_lang": "hi-IN", "sarvam_api_key": "dummy"})
check(st == 400, f"empty text HTTP 400 (got {st})")

print("== S5. Sarvam TTS text too long -> 422 ==")
long_text = "x" * 3000
st, body = req("POST", "/api/v1/tts", {"text": long_text, "target_lang": "hi-IN", "sarvam_api_key": "dummy"})
check(st == 422, f"long text HTTP 422 (got {st})")

print("== S6. Sarvam TTS response schema for valid request (expect 403 from invalid key, not 404) ==")
st, body = req("POST", "/api/v1/tts", {"text": "नमस्ते", "target_lang": "hi-IN", "sarvam_api_key": "dummy"})
check(st != 404, f"/api/v1/tts endpoint exists (got {st}, not 404)")
check(body.get("detail", {}).get("provider") == "sarvam", "error detail identifies sarvam provider")

print(f"\n===== SARVAM TTS: {passed} pass, {failed} fail =====")
sys.exit(1 if failed else 0)
