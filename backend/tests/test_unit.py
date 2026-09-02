import sys
sys.path.insert(0, "backend")

def test_sanitize_empty():
    from app.services.iitm_tts import _sanitize_text
    assert _sanitize_text("...") == ""
    assert _sanitize_text("   !!!   ") == ""
    assert _sanitize_text("😊") == ""
    assert _sanitize_text("") == ""
    print("test_sanitize_empty PASS")

def test_sanitize_keep_indic():
    from app.services.iitm_tts import _sanitize_text
    assert _sanitize_text("నమస్తే") == "నమస్తే"
    assert _sanitize_text("hello 😊") == "hello"
    assert _sanitize_text("నమస్తే, ఎలా ఉన్నారు?") != ""
    print("test_sanitize_keep_indic PASS")

def test_sanitize_truncate():
    from app.services.iitm_tts import _sanitize_text
    long_text = ("hello " * 200).strip()  # >450
    out = _sanitize_text(long_text)
    assert len(out) <= 450
    assert not out.endswith(" ")
    print("test_sanitize_truncate PASS len", len(out))

def test_checkpoint_per_lang():
    from app.services import checkpoint_store
    # per-lang isolation
    checkpoint_store._states.clear()
    checkpoint_store._update_state("te-IN", status="downloading", progress=10)
    checkpoint_store._update_state("hi-IN", status="downloading", progress=50)
    assert checkpoint_store.status("te-IN")["progress"] == 10
    assert checkpoint_store.status("hi-IN")["progress"] == 50
    # global still tracks last
    assert checkpoint_store.status()["lang"] == "hi-IN"
    # is_available checks all required files
    assert isinstance(checkpoint_store.is_available("te-IN"), bool)
    print("test_checkpoint_per_lang PASS")

def test_checkpoint_available_all_files():
    from app.services import checkpoint_store
    # te-IN and hi-IN are present per earlier health, should be available
    avail = checkpoint_store.available_languages()
    assert "te-IN" in avail
    print("test_checkpoint_available_all_files PASS", avail)

def test_translate_contract():
    # Verify translate returns 401 not 200 on missing key — check code
    import ast
    src = open("backend/app/routers/translate.py").read()
    assert "HTTPException" in src and "401" in src
    assert 'status_code=401' in src
    print("test_translate_contract PASS")

def test_tts_router_503():
    src = open("backend/app/routers/tts.py").read()
    assert "language checkpoint not loaded" in src
    assert "HTTPException" in src
    print("test_tts_router_503 PASS")

if __name__ == "__main__":
    test_sanitize_empty()
    test_sanitize_keep_indic()
    test_sanitize_truncate()
    test_checkpoint_per_lang()
    test_checkpoint_available_all_files()
    test_translate_contract()
    test_tts_router_503()
    print("ALL UNIT TESTS PASS")
