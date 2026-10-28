import sys
import time

sys.path.insert(0, "backend")

from app.services import piper_models, piper_tts  # noqa: E402

PASS = 0
FAIL = 0


def assert_(cond, msg):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS: {msg}")
    else:
        FAIL += 1
        print(f"  FAIL: {msg}")


def wait_available(lang, timeout=120):
    """Poll until a Piper voice is ready (downloads in background via prepare)."""
    if piper_models.is_available(lang):
        return True
    result = piper_models.prepare(lang)
    assert result.get("ok"), f"prepare({lang}) failed: {result}"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if piper_models.is_available(lang):
            return True
        st = piper_models.status(lang)
        if st.get("status") == "error":
            return False
        time.sleep(2)
    return piper_models.is_available(lang)


def test_piper_voice_info():
    info = piper_models.voice_info("te-IN")
    assert_(info is not None, "te-IN voice info present")
    assert_(info["stem"] == "te_IN-maya-medium", "te-IN stem correct")
    assert_(piper_models.voice_info("ta-IN") is None, "ta-IN has no Piper voice (missing-model scenario)")
    assert_("te-IN" in piper_models.PIPER_VOICES, "te-IN in PIPER_VOICES")
    print(f"  configured voices: {sorted(piper_models.PIPER_VOICES.keys())}")


def test_piper_prepare_downloads_real_model():
    ok = wait_available("te-IN")
    assert_(ok, "te-IN Piper voice downloaded and available (real HF model)")
    assert_(piper_models.is_available("te-IN"), "is_available(te-IN) true after prepare")
    # prepare() guarantees the per-lang status is "ready" (sets already_available/ready)
    result = piper_models.prepare("te-IN")
    assert_(result.get("ok") and result.get("status") == "ready", f"prepare ready: {result}")
    st = piper_models.status("te-IN")
    assert_(st.get("status") == "ready", f"te-IN status ready, got {st.get('status')}")
    m = piper_models.model_path("te-IN")
    c = piper_models.config_path("te-IN")
    assert_(m.exists() and m.stat().st_size > 1_000_000, f"onnx model present and large: {m}")
    assert_(c.exists() and c.stat().st_size > 0, f"config present: {c}")
    assert_("te-IN" in piper_models.available_languages(), "te-IN in available_languages()")


def test_piper_synthesize_real_telugu():
    assert wait_available("te-IN"), "te-IN model must be available"
    import asyncio
    import soundfile as sf
    import io
    wav, dur = asyncio.run(piper_tts.synthesize("నమస్తే telugu hello world", "te-IN"))
    assert_(isinstance(wav, bytes) and len(wav) > 1000, f"nonempty WAV bytes ({len(wav)})")
    assert_(dur > 0, f"positive duration ({dur})")
    data, sr = sf.read(io.BytesIO(wav))
    assert_(sr == 22050, f"sample rate 22050, got {sr}")
    assert_(len(data) > 0, "nonzero audio samples")
    assert_(int((data != 0).sum()) > 0, "audio contains signal")
    assert_(piper_tts.is_loaded(), "tts marked loaded after synthesize")
    assert_(piper_tts.current_language() == "te-IN", "current language te-IN")
    print(f"  Telugu synth: {len(wav)} bytes, {dur:.2f}s, sr={sr}, nonzero={int((data != 0).sum())}")


def test_piper_synthesize_real_hindi():
    assert wait_available("hi-IN"), "hi-IN model must be available"
    import asyncio
    import soundfile as sf
    import io
    wav, dur = asyncio.run(piper_tts.synthesize("नमस्ते हिंदी", "hi-IN"))
    assert_(isinstance(wav, bytes) and len(wav) > 1000, f"nonempty Hindi WAV ({len(wav)})")
    assert_(dur > 0, "positive Hindi duration")
    data, sr = sf.read(io.BytesIO(wav))
    assert_(sr == 22050, f"Hindi sr 22050, got {sr}")
    print(f"  Hindi synth: {len(wav)} bytes, {dur:.2f}s")


def test_piper_missing_model_scenario():
    # kn-IN has a Piper voice configured but model NOT downloaded -> __PIPER_MODEL_MISSING__
    assert_("kn-IN" in piper_models.PIPER_VOICES, "kn-IN voice is configured")
    # Guarantee the missing state (hermetic: prior E2E runs may have downloaded it)
    _remove_voice_files("kn-IN")
    assert_(not piper_models.is_available("kn-IN"), "kn-IN model not downloaded yet")
    import asyncio
    try:
        asyncio.run(piper_tts.synthesize("ನಮಸ್ಕಾರ", "kn-IN"))
        assert_(False, "expected RuntimeError for kn-IN missing model")
    except RuntimeError as exc:
        assert_("__PIPER_MODEL_MISSING__kn-IN" in str(exc), f"missing-model error raised: {exc}")
    # ta-IN has NO Piper voice configured at all -> unsupported (ValueError), permanent
    assert_(not piper_models.is_available("ta-IN"), "ta-IN unavailable (no Piper voice)")
    assert_("ta-IN" not in piper_models.PIPER_VOICES, "ta-IN not in PIPER_VOICES")


def _remove_voice_files(lang: str):
    """Delete downloaded voice files for `lang` (test-only, hermetic missing state)."""
    import shutil
    d = piper_models.model_dir(lang)
    if d.exists():
        shutil.rmtree(d)


def test_piper_unsupported_lang():
    import asyncio
    try:
        asyncio.run(piper_tts.synthesize("hi", "xx-YY"))
        assert_(False, "expected ValueError for unsupported lang")
    except ValueError as exc:
        assert_("Unsupported target language" in str(exc), f"unsupported lang error: {exc}")


def test_piper_empty_text():
    assert wait_available("te-IN")
    import asyncio
    try:
        asyncio.run(piper_tts.synthesize("   !!!   ", "te-IN"))
        assert_(False, "expected ValueError for empty text")
    except ValueError as exc:
        assert_("empty text" in str(exc).lower(), f"empty text error: {exc}")


if __name__ == "__main__":
    test_piper_voice_info()
    test_piper_prepare_downloads_real_model()
    test_piper_synthesize_real_telugu()
    test_piper_synthesize_real_hindi()
    test_piper_missing_model_scenario()
    test_piper_unsupported_lang()
    test_piper_empty_text()
    print(f"\nPIPER TESTS: {PASS} pass, {FAIL} fail")
    sys.exit(1 if FAIL else 0)
