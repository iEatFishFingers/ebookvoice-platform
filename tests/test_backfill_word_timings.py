"""Tests for the word-timings backfill safety gate.

timings_match() is the only thing standing between `--clear` and permanent
karaoke loss: it decides whether the CDN copy is a faithful replacement for the
blob about to be nulled. Everything else in the script is recoverable.
"""
import importlib.util
import os
import pytest

_SPEC_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'scripts', 'backfill_word_timings.py',
)


def _load():
    """Import the script without running main(); needs env vars to exist."""
    os.environ.setdefault('SUPABASE_URL', 'https://example.supabase.co')
    os.environ.setdefault('SUPABASE_SERVICE_KEY', 'test-key')
    os.environ.setdefault('CLOUDINARY_CLOUD_NAME', 'test-cloud')
    spec = importlib.util.spec_from_file_location('backfill_word_timings', _SPEC_PATH)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit as e:
        pytest.skip(f'script guard tripped: {e}')
    return mod


TIMINGS = [
    {"word": "Hello", "start": 0.0, "end": 0.5},
    {"word": "world.", "start": 0.5, "end": 1.2},
]


def test_identical_arrays_match():
    m = _load()
    assert m.timings_match(TIMINGS, [dict(t) for t in TIMINGS])


def test_float_noise_within_tolerance_matches():
    """A JSONB -> JSON round trip must not block the clear."""
    m = _load()
    nudged = [{"word": "Hello", "start": 0.0, "end": 0.5000001},
              {"word": "world.", "start": 0.5000001, "end": 1.2}]
    assert m.timings_match(TIMINGS, nudged)


def test_different_length_does_not_match():
    m = _load()
    assert not m.timings_match(TIMINGS, TIMINGS[:1])


def test_different_word_does_not_match():
    m = _load()
    wrong = [{"word": "Hello", "start": 0.0, "end": 0.5},
             {"word": "there.", "start": 0.5, "end": 1.2}]
    assert not m.timings_match(TIMINGS, wrong)


def test_drifted_timing_does_not_match():
    """A real desync must keep the blob, not silently discard it."""
    m = _load()
    drifted = [{"word": "Hello", "start": 0.0, "end": 0.5},
               {"word": "world.", "start": 0.9, "end": 1.6}]
    assert not m.timings_match(TIMINGS, drifted)


def test_none_never_matches():
    m = _load()
    assert not m.timings_match(None, TIMINGS)
    assert not m.timings_match(TIMINGS, None)
    assert not m.timings_match(None, None)


def test_malformed_remote_does_not_match():
    """A CDN 404 page parsed as JSON must not read as a valid replacement."""
    m = _load()
    assert not m.timings_match(TIMINGS, [{"error": "not found"}, {"error": "x"}])


def test_public_id_is_stable_for_a_chapter():
    m = _load()
    assert m.public_id_for({'audiobook_id': 'abc', 'position': 0}) == 'abc_0'
    assert m.public_id_for({'audiobook_id': 'abc', 'position': 12}) == 'abc_12'
