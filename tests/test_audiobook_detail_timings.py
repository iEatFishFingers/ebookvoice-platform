"""Contract tests for GET /api/audiobooks/<id> and the ?timings=url opt-out.

Two generations of client depend on this one response shape at the same time:

  * builds 38/39 (live) expect `word_timings` inline and know nothing about
    the CDN — they must keep working unchanged
  * phase-2 builds pass ?timings=url and fetch each chapter themselves

If either half breaks, karaoke silently disappears for that generation, which
is the flagship feature for the blind / print-disabled audience.
"""
import sys
import uuid
from unittest.mock import MagicMock, patch

BOOK_ID = str(uuid.uuid4())
DEVICE_ID = str(uuid.uuid4())
TIMINGS = [
    {"word": "Hello", "start": 0.0, "end": 0.5},
    {"word": "world.", "start": 0.5, "end": 1.2},
]


class _Chain:
    """Minimal stand-in for the postgrest builder: every filter returns self."""

    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):
        return lambda *a, **k: self

    def execute(self):
        return MagicMock(data=self._data)


def _app_with_book(chapters):
    book = {
        'id': BOOK_ID, 'title': 'Test Book', 'author': 'A', 'description': '',
        'voice_id': 'v', 'voice_name': 'V', 'cover_url': None, 'duration': 10,
        'created_at': '2026-09-11T00:00:00Z', 'status': 'completed', 'progress': 0,
        'current_position': 0, 'current_chapter': 0, 'is_custom': False,
        'is_demo': False, 'audiobook_chapters': chapters,
    }
    mock_client = MagicMock()
    mock_client.table.return_value = _Chain(book)

    with patch.dict("sys.modules", {
        "auth": MagicMock(
            require_auth=lambda f: f,
            get_user_profile=MagicMock(return_value={}),
            get_supabase_client=MagicMock(return_value=mock_client),
            TERMS_VERSION='1',
        )
    }):
        for mod in list(sys.modules.keys()):
            if mod == "epub_to_audio":
                del sys.modules[mod]
        import epub_to_audio as m
    m.get_supabase_client = MagicMock(return_value=mock_client)
    m.app.config['TESTING'] = True
    return m


def _chapter(**over):
    base = {
        'chapter_id': 'ch1', 'title': 'One', 'audio_url': 'https://cdn/a.mp3',
        'duration': 10, 'position': 0, 'word_timings': None,
        'word_timings_url': None, 'image_inserts': None,
    }
    base.update(over)
    return [base]


def _get(m, query=''):
    return m.app.test_client().get(
        f'/api/audiobooks/{BOOK_ID}{query}',
        headers={'X-Device-Id': DEVICE_ID},
    )


# ── legacy clients (builds 38 / 39) ──────────────────────────────────────────

def test_legacy_client_gets_cdn_timings_hydrated_inline():
    """No ?timings — the server must fetch the CDN copy and inline it."""
    m = _app_with_book(_chapter(word_timings_url='https://cdn/0.json'))
    with patch.object(m, 'fetch_word_timings', return_value=TIMINGS) as fetch:
        resp = _get(m)
    assert resp.status_code == 200
    chapter = resp.get_json()['audiobook']['chapters'][0]
    assert chapter['word_timings'] == TIMINGS, 'live binaries read this key'
    fetch.assert_called_once()


def test_legacy_client_still_gets_inline_rows_untouched():
    """A pre-016 row has no URL; nothing should be fetched."""
    m = _app_with_book(_chapter(word_timings=TIMINGS))
    with patch.object(m, 'fetch_word_timings') as fetch:
        resp = _get(m)
    assert resp.get_json()['audiobook']['chapters'][0]['word_timings'] == TIMINGS
    fetch.assert_not_called()


def test_legacy_client_survives_a_dead_cdn():
    """Karaoke degrades; the book itself must still load."""
    m = _app_with_book(_chapter(word_timings_url='https://cdn/0.json'))
    with patch.object(m, 'fetch_word_timings', return_value=None):
        resp = _get(m)
    assert resp.status_code == 200
    assert resp.get_json()['audiobook']['chapters'][0]['word_timings'] is None


# ── phase-2 clients ──────────────────────────────────────────────────────────

def test_phase2_client_gets_the_url_and_no_hydration():
    m = _app_with_book(_chapter(word_timings_url='https://cdn/0.json'))
    with patch.object(m, 'fetch_word_timings') as fetch:
        resp = _get(m, '?timings=url')
    chapter = resp.get_json()['audiobook']['chapters'][0]
    assert chapter['wordTimingsUrl'] == 'https://cdn/0.json'
    # Render must stay out of the path entirely for a phase-2 client.
    fetch.assert_not_called()


def test_phase2_client_still_receives_legacy_inline_timings():
    """Pre-backfill books have no URL — the client needs the blob to fall back on."""
    m = _app_with_book(_chapter(word_timings=TIMINGS))
    resp = _get(m, '?timings=url')
    chapter = resp.get_json()['audiobook']['chapters'][0]
    assert chapter['word_timings'] == TIMINGS
    assert chapter['wordTimingsUrl'] is None


def test_unknown_timings_value_falls_back_to_hydration():
    """Only the exact opt-out disables hydration; anything else stays safe."""
    m = _app_with_book(_chapter(word_timings_url='https://cdn/0.json'))
    with patch.object(m, 'fetch_word_timings', return_value=TIMINGS) as fetch:
        resp = _get(m, '?timings=banana')
    assert resp.get_json()['audiobook']['chapters'][0]['word_timings'] == TIMINGS
    fetch.assert_called_once()


def test_url_is_always_present_in_the_payload():
    """Both generations get the key; only one acts on it."""
    m = _app_with_book(_chapter(word_timings_url='https://cdn/0.json'))
    with patch.object(m, 'fetch_word_timings', return_value=TIMINGS):
        resp = _get(m)
    assert resp.get_json()['audiobook']['chapters'][0]['wordTimingsUrl'] == 'https://cdn/0.json'
