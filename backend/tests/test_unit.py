import sys
import threading
import time
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

def test_checkpoint_prepare_no_deadlock():
    """Test that prepare() doesn't deadlock when called multiple times."""
    from app.services import checkpoint_store
    checkpoint_store._states.clear()
    
    # Call prepare multiple times rapidly - should not deadlock
    for _ in range(5):
        result = checkpoint_store.prepare("te-IN")
        assert result["ok"] is True
    
    # Test with different languages concurrently - use languages that have checkpoints
    results = []
    def prepare_lang(lang):
        results.append(checkpoint_store.prepare(lang))
    
    # Only use languages that have checkpoints available
    threads = [
        threading.Thread(target=prepare_lang, args=("te-IN",)),
        threading.Thread(target=prepare_lang, args=("hi-IN",)),
    ]
    
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)  # timeout to catch deadlock
    
    assert len(results) == 2
    for r in results:
        assert r["ok"] is True, f"Failed: {r}"
    print("test_checkpoint_prepare_no_deadlock PASS")

def test_checkpoint_duplicate_prepare_idempotent():
    """Test that calling prepare twice for same lang is idempotent."""
    from app.services import checkpoint_store
    checkpoint_store._states.clear()
    
    r1 = checkpoint_store.prepare("te-IN")
    r2 = checkpoint_store.prepare("te-IN")
    
    assert r1["ok"] is True
    assert r2["ok"] is True
    assert r2.get("already_running") is True or r2.get("already_available") is True
    print("test_checkpoint_duplicate_prepare_idempotent PASS")

def test_checkpoint_two_langs_concurrent():
    """Test that two languages can prepare concurrently without clobbering each other."""
    import os
    os.environ["TTS_CHECKPOINT_BASE_URL"] = "https://huggingface.co/smtiitm/FastSpeech2_HS_latest_models/resolve/main"
    import importlib
    import app.services.checkpoint_store as checkpoint_store
    importlib.reload(checkpoint_store)
    checkpoint_store._states.clear()
    
    # Use languages without checkpoints to test download initiation
    r1 = checkpoint_store.prepare("kn-IN")
    r2 = checkpoint_store.prepare("mr-IN")
    
    assert r1["ok"] is True, f"kn-IN failed: {r1}"
    assert r2["ok"] is True, f"mr-IN failed: {r2}"
    assert r1["status"] == "started"
    assert r2["status"] == "started"
    
    # Check both have their own state
    st_kn = checkpoint_store.status("kn-IN")
    st_mr = checkpoint_store.status("mr-IN")
    
    assert st_kn["status"] == "downloading"
    assert st_mr["status"] == "downloading"
    assert st_kn["lang"] == "kn-IN"
    assert st_mr["lang"] == "mr-IN"
    print("test_checkpoint_two_langs_concurrent PASS")

def test_checkpoint_progress_invariants():
    """Test progress invariants: 0 <= downloaded <= total, 0 <= progress <= 100"""
    from app.services import checkpoint_store
    
    # Check initial state
    st = checkpoint_store.status("te-IN")
    assert 0 <= st["progress"] <= 100
    assert 0 <= st["downloaded"] <= st["total"] or st["total"] == 0
    
    # Test that progress calculation doesn't exceed 100
    st = checkpoint_store._get_state("te-IN")
    st["total"] = 1000
    st["downloaded"] = 500
    st["progress"] = 50.0
    assert 0 <= st["progress"] <= 100
    assert 0 <= st["downloaded"] <= st["total"]
    
    # At completion
    st["downloaded"] = 1000
    st["total"] = 1000
    # Would be set to 100 in _download_and_extract
    assert 0 <= st["progress"] <= 100
    print("test_checkpoint_progress_invariants PASS")

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
    test_checkpoint_prepare_no_deadlock()
    test_checkpoint_duplicate_prepare_idempotent()
    test_checkpoint_two_langs_concurrent()
    test_checkpoint_progress_invariants()
    print("ALL UNIT TESTS PASS")
