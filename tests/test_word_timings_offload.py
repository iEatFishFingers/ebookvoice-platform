"""Tests for the word-timings CDN offload (migration 016 / phase 1).

The timings are moved out of Postgres onto Cloudinary; these cover the two
properties that matter for a live app:

  * a failed upload must degrade to the old inline behaviour, never lose karaoke
  * hydration must restore the exact response shape builds 38/39 expect
"""
import json
import sys
from unittest.mock import MagicMock, patch


def _get_module():
    mock_client = MagicMock()
    with patch.dict("sys.modules", {
        "auth": MagicMock(
            require_auth=lambda f: f,
            get_user_profile=MagicMock(return_value={}),
            get_supabase_client=MagicMock(return_value=mock_client),
        )
    }):
        for mod in list(sys.modules.keys()):
            if mod in ("epub_to_audio",):
                del sys.modules[mod]
        import epub_to_audio as m
    return m


TIMINGS = [
    {"word": "Hello", "start": 0.0, "end": 0.5},
    {"word": "world.", "start": 0.5, "end": 1.2},
]


# ── upload_word_timings ──────────────────────────────────────────────────────

def test_upload_returns_secure_url():
    m = _get_module()
    with patch.object(m.cloudinary.uploader, "upload",
                      return_value={"secure_url": "https://cdn/x.json"}) as up:
        url = m.upload_word_timings(TIMINGS, "book_0")
    assert url == "https://cdn/x.json"
    kwargs = up.call_args.kwargs
    assert kwargs["resource_type"] == "raw", "must upload as raw, not video/image"
    assert kwargs["public_id"] == "book_0.json"


def test_upload_payload_is_compact_json():
    """Whitespace-stripped JSON — the blob is the whole reason this exists."""
    m = _get_module()
    captured = {}

    def _capture(stream, **kwargs):
        captured["body"] = stream.read()
        return {"secure_url": "https://cdn/x.json"}

    with patch.object(m.cloudinary.uploader, "upload", side_effect=_capture):
        m.upload_word_timings(TIMINGS, "book_0")

    body = captured["body"].decode("utf-8")
    assert json.loads(body) == TIMINGS, "round-trips losslessly"
    assert ", " not in body and '": ' not in body, "must not contain pretty-print padding"


def test_upload_returns_none_on_failure():
    """A CDN outage must not raise into the conversion — caller falls back."""
    m = _get_module()
    with patch.object(m.cloudinary.uploader, "upload", side_effect=RuntimeError("boom")):
        assert m.upload_word_timings(TIMINGS, "book_0") is None


def test_upload_skips_empty_timings():
    m = _get_module()
    with patch.object(m.cloudinary.uploader, "upload") as up:
        assert m.upload_word_timings([], "book_0") is None
        assert m.upload_word_timings(None, "book_0") is None
    up.assert_not_called()


# ── hydrate_word_timings ─────────────────────────────────────────────────────

def test_hydrate_fills_timings_from_url():
    m = _get_module()
    chapters = [{"position": 0, "word_timings": None, "word_timings_url": "https://cdn/0.json"}]
    with patch.object(m, "fetch_word_timings", return_value=TIMINGS):
        m.hydrate_word_timings(chapters)
    assert chapters[0]["word_timings"] == TIMINGS


def test_hydrate_leaves_legacy_inline_rows_untouched():
    """Pre-016 rows still carry the blob; they must not be re-fetched."""
    m = _get_module()
    chapters = [{"position": 0, "word_timings": TIMINGS, "word_timings_url": None}]
    with patch.object(m, "fetch_word_timings") as fetch:
        m.hydrate_word_timings(chapters)
    fetch.assert_not_called()
    assert chapters[0]["word_timings"] == TIMINGS


def test_hydrate_degrades_to_none_on_fetch_failure():
    """Karaoke is worth a retry next open; it is not worth a 500 on the book."""
    m = _get_module()
    chapters = [{"position": 0, "word_timings": None, "word_timings_url": "https://cdn/0.json"}]
    with patch.object(m, "fetch_word_timings", side_effect=RuntimeError("cdn down")):
        m.hydrate_word_timings(chapters)
    assert chapters[0]["word_timings"] is None


def test_hydrate_is_a_noop_without_urls():
    m = _get_module()
    chapters = [{"position": 0, "word_timings": None, "word_timings_url": None}]
    with patch.object(m, "fetch_word_timings") as fetch:
        assert m.hydrate_word_timings(chapters) is chapters
    fetch.assert_not_called()


def test_hydrate_handles_many_chapters():
    """A 40-chapter book resolves every chapter, not just the pool width."""
    m = _get_module()
    chapters = [
        {"position": i, "word_timings": None, "word_timings_url": f"https://cdn/{i}.json"}
        for i in range(40)
    ]
    with patch.object(m, "fetch_word_timings", return_value=TIMINGS):
        m.hydrate_word_timings(chapters)
    assert all(ch["word_timings"] == TIMINGS for ch in chapters)


# ── fetch_word_timings ───────────────────────────────────────────────────────

def test_fetch_returns_none_on_http_error():
    m = _get_module()
    with patch.object(m.http_requests, "get", side_effect=RuntimeError("404")):
        assert m.fetch_word_timings("https://cdn/0.json") is None


def test_fetch_returns_none_for_empty_url():
    m = _get_module()
    with patch.object(m.http_requests, "get") as get:
        assert m.fetch_word_timings("") is None
        assert m.fetch_word_timings(None) is None
    get.assert_not_called()


def test_hydrate_respects_its_time_budget():
    """A slow CDN must not pin the single sync gunicorn worker.

    Regression guard: ThreadPoolExecutor used as a context manager calls
    shutdown(wait=True) on exit, which waits for every queued fetch and makes
    the budget cosmetic. 40 chapters x a hanging CDN blocked the worker for
    ~50s before this was fixed.
    """
    import time as _time
    m = _get_module()
    m.WORD_TIMINGS_HYDRATE_BUDGET_S = 1

    def _slow(_url):
        _time.sleep(30)
        return TIMINGS

    chapters = [
        {"position": i, "word_timings": None, "word_timings_url": f"https://cdn/{i}.json"}
        for i in range(40)
    ]
    with patch.object(m, "fetch_word_timings", side_effect=_slow):
        started = _time.monotonic()
        m.hydrate_word_timings(chapters)
        elapsed = _time.monotonic() - started

    assert elapsed < 5, f"hydration blocked for {elapsed:.1f}s despite a 1s budget"
    assert all(ch["word_timings"] is None for ch in chapters), "slow fetches degrade to None"


# ── _safe_destroy_raw ────────────────────────────────────────────────────────

def test_destroy_raw_keeps_the_json_extension():
    """Raw public_ids include the extension; stripping it makes destroy a no-op."""
    m = _get_module()
    url = "https://res.cloudinary.com/demo/raw/upload/v1234567890/word_timings/bk_0.json"
    with patch.object(m.cloudinary.uploader, "destroy") as destroy:
        m._safe_destroy_raw(url)
    args, kwargs = destroy.call_args
    assert args[0] == "word_timings/bk_0.json"
    assert kwargs["resource_type"] == "raw"


def test_destroy_raw_without_version_segment():
    m = _get_module()
    url = "https://res.cloudinary.com/demo/raw/upload/word_timings/bk_0.json"
    with patch.object(m.cloudinary.uploader, "destroy") as destroy:
        m._safe_destroy_raw(url)
    assert destroy.call_args[0][0] == "word_timings/bk_0.json"


def test_destroy_raw_ignores_blank_and_malformed_urls():
    m = _get_module()
    with patch.object(m.cloudinary.uploader, "destroy") as destroy:
        m._safe_destroy_raw(None)
        m._safe_destroy_raw("")
        m._safe_destroy_raw("https://example.com/not-cloudinary.json")
    destroy.assert_not_called()


def test_destroy_raw_swallows_cloudinary_errors():
    """Cleanup runs in a daemon thread; a raise there kills the sweep."""
    m = _get_module()
    url = "https://res.cloudinary.com/demo/raw/upload/word_timings/bk_0.json"
    with patch.object(m.cloudinary.uploader, "destroy", side_effect=RuntimeError("boom")):
        m._safe_destroy_raw(url)  # must not raise


def test_extract_public_id_would_have_been_wrong_here():
    """Documents why _safe_destroy_raw exists rather than reusing the helper."""
    m = _get_module()
    url = "https://res.cloudinary.com/demo/raw/upload/word_timings/bk_0.json"
    assert m.extract_public_id(url).endswith("bk_0"), "strips .json — wrong for raw"


def test_destroy_raw_logs_a_not_found_result(capsys):
    """destroy() returns {'result': 'not found'} without raising.

    Swallowing that would let a public_id-derivation bug orphan every timings
    file silently — which is exactly the failure mode this cleanup exists to
    prevent. Verified against the live API 2026-09-11: a correct public_id
    returns 'ok'; note the CDN still serves the URL from edge cache for a
    while afterwards, so HTTP 200 is NOT proof the asset survived.
    """
    m = _get_module()
    url = "https://res.cloudinary.com/demo/raw/upload/word_timings/bk_0.json"
    with patch.object(m.cloudinary.uploader, "destroy", return_value={"result": "not found"}):
        m._safe_destroy_raw(url)
    out = capsys.readouterr().out
    assert "not found" in out and "orphaned" in out


def test_destroy_raw_stays_quiet_on_success(capsys):
    m = _get_module()
    url = "https://res.cloudinary.com/demo/raw/upload/word_timings/bk_0.json"
    with patch.object(m.cloudinary.uploader, "destroy", return_value={"result": "ok"}):
        m._safe_destroy_raw(url)
    assert "orphaned" not in capsys.readouterr().out


# ── anonymous gate: 503 vs 403 ───────────────────────────────────────────────

def _gate(m, exc):
    """Run _check_anonymous_conversion_gate with the lookup raising `exc`."""
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.side_effect = exc
    return m._check_anonymous_conversion_gate(sb, "device-123")


def test_gate_returns_503_when_the_database_is_unreachable():
    """The Aug-Sep 2026 outage: a real user was refused with 403 + an upsell.

    A transient failure must read as "we are down", not "you are not allowed",
    or the client has no retry path and the user blames themselves.
    """
    m = _get_module()
    g = _gate(m, Exception("[Errno -2] Name or service not known"))
    assert g["allowed"] is False
    assert g["status"] == 503, "transient failure must not be a permanent refusal"
    assert g["response"]["retryable"] is True
    body = g["response"]["error"].lower()
    assert "sign up" not in body, "never upsell during an outage"


def test_gate_still_fails_closed_when_the_column_is_missing():
    """Structural + permanent: refusing is correct, and 403 is the honest code."""
    m = _get_module()
    for msg in ('column audiobooks.device_id does not exist',
                'PGRST204 could not find the schema cache entry',
                'ERROR: 42703: undefined column'):
        g = _gate(m, Exception(msg))
        assert g["allowed"] is False, msg
        assert g.get("status", 403) == 403, f"should stay 403 for: {msg}"


def test_gate_allows_a_device_with_no_prior_conversion():
    m = _get_module()
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value = \
        MagicMock(count=0)
    g = m._check_anonymous_conversion_gate(sb, "fresh-device")
    assert g["allowed"] is True


def test_gate_refuses_a_device_that_already_converted():
    """The real trial limit must still be a 403 — that is a genuine denial."""
    m = _get_module()
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value = \
        MagicMock(count=1)
    g = m._check_anonymous_conversion_gate(sb, "used-device")
    assert g["allowed"] is False
    assert g.get("status", 403) == 403
    assert g["response"].get("anonymous_limit_reached") is True
