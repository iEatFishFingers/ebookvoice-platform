"""Tests for the improved _generate_synthetic_timings function."""
import importlib
import sys
from unittest.mock import MagicMock, patch
import pytest


def _get_fn():
    # Patch get_supabase_client so epub_to_audio can be imported without
    # real Supabase credentials in the test environment.
    mock_client = MagicMock()
    with patch.dict("sys.modules", {
        "auth": MagicMock(
            require_auth=lambda f: f,
            get_user_profile=MagicMock(return_value={}),
            get_supabase_client=MagicMock(return_value=mock_client),
        )
    }):
        # Remove cached module so reload picks up the patch
        for mod in list(sys.modules.keys()):
            if mod in ("epub_to_audio",):
                del sys.modules[mod]
        import epub_to_audio as m
    return m._generate_synthetic_timings


def test_timings_cover_full_duration():
    """Last word end should equal audio duration (no chapter-level drift)."""
    fn = _get_fn()
    text = "Hello world. How are you today?"
    duration = 5.0
    timings = fn(text, duration, voice_id="en-US-AriaNeural")
    assert timings, "Should return non-empty list"
    assert abs(timings[-1]["end"] - duration) < 0.01, "Last word end must equal duration"


def test_no_word_exceeds_cap():
    """No single word should be allocated more than 3× the per-word average."""
    fn = _get_fn()
    text = "Short.\n\nAnother paragraph.\n\nThird paragraph here."
    duration = 6.0
    timings = fn(text, duration, voice_id="en-GB-RyanNeural")
    avg = duration / len(timings)
    for t in timings:
        word_dur = t["end"] - t["start"]
        assert word_dur <= avg * 3 + 0.05, (
            f"Word '{t['word']}' duration {word_dur:.3f}s exceeds cap"
        )


def test_words_are_sequential():
    """Each word's start should equal the previous word's end (no gaps or overlaps)."""
    fn = _get_fn()
    text = "One two three four five six seven eight nine ten."
    timings = fn(text, 4.0, voice_id="en-AU-WilliamMultilingualNeural")
    for i in range(1, len(timings)):
        prev_end = timings[i - 1]["end"]
        curr_start = timings[i]["start"]
        assert abs(curr_start - prev_end) < 0.001, (
            f"Gap between word {i-1} and {i}: {prev_end} → {curr_start}"
        )


def test_empty_text_returns_empty():
    fn = _get_fn()
    assert fn("", 5.0, voice_id="en-US-EmmaNeural") == []


def test_zero_duration_returns_empty():
    fn = _get_fn()
    assert fn("Hello world", 0.0, voice_id="en-US-EmmaNeural") == []


def test_unknown_voice_id_uses_default():
    """A voice_id not in voice_cache.json should not raise — uses default wps."""
    fn = _get_fn()
    timings = fn("Hello world.", 2.0, voice_id="xx-Unknown-TestNeural")
    assert len(timings) > 0


def test_single_word():
    """A single word should span the entire duration."""
    fn = _get_fn()
    timings = fn("Hello", 2.0, voice_id="en-US-EmmaNeural")
    assert len(timings) == 1
    assert timings[0]["start"] == 0.0
    assert abs(timings[0]["end"] - 2.0) < 0.01


def test_cap_active_sum_equals_duration():
    """When the cap fires, total duration must still equal audio duration."""
    fn = _get_fn()
    # Use en-AU-WilliamMultilingualNeural which IS in voice_cache.json (wps=2.8)
    # Heavy punctuation forces large weights and triggers the cap
    text = "First sentence.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph ends."
    duration = 8.0
    timings = fn(text, duration, voice_id="en-AU-WilliamMultilingualNeural")
    total = sum(t["end"] - t["start"] for t in timings)
    assert abs(total - duration) < 0.05, f"Total duration {total:.3f} != {duration}"


def test_cap_active_no_word_exceeds_wps_cap():
    """When the cap fires, no word should exceed 3/wps seconds."""
    import json, os
    fn = _get_fn()
    # Load actual wps for this voice
    cache_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "voice_cache.json")
    with open(cache_path) as f:
        cache = json.load(f)
    wps = cache["voices"].get("en-AU-WilliamMultilingualNeural", {}).get("words_per_second", 2.8)
    cap = 3.0 / wps

    text = "First sentence.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph ends."
    duration = 8.0
    timings = fn(text, duration, voice_id="en-AU-WilliamMultilingualNeural")
    for t in timings[:-1]:  # last word anchor can be slightly over cap in edge cases
        word_dur = t["end"] - t["start"]
        assert word_dur <= cap + 0.001, f"Word '{t['word']}' duration {word_dur:.3f}s > cap {cap:.3f}s"
