"""
emotional_director.py
=====================
Autonomous "Emotional Voice Director" Agent.

Analyzes a chapter's text using rule-based NLP (zero extra dependencies —
works with the existing requirements.txt) to detect the dominant emotional
register, then wraps the text in SSML <prosody> tags to instruct the Edge
TTS engine to adjust rate, pitch, and volume accordingly.

Design goals:
- No ML model download — instant startup, zero extra RAM on Render free tier
- Deterministic — same chapter always produces the same emotion profile
- Overridable — callers can bypass auto-detection by passing emotion= directly
"""

import re
from typing import Dict, Any, List, Tuple, Optional


# ---------------------------------------------------------------------------
# Prosody profiles per emotion
# Adjustments are relative Edge TTS SSML values.
# ---------------------------------------------------------------------------
EMOTION_PROFILES: Dict[str, Dict[str, Any]] = {
    "action": {
        "rate": "+25%",
        "pitch": "+10Hz",
        "volume": "+10%",
        "description": "Fast-paced and energetic narration",
    },
    "suspense": {
        "rate": "-20%",
        "pitch": "-20Hz",
        "volume": "-5%",
        "description": "Slow, tension-building delivery",
    },
    "romance": {
        "rate": "-10%",
        "pitch": "+10Hz",
        "volume": "-5%",
        "description": "Warm, intimate tone",
    },
    "comedy": {
        "rate": "+15%",
        "pitch": "+20Hz",
        "volume": "+5%",
        "description": "Light and playful energy",
    },
    "drama": {
        "rate": "-5%",
        "pitch": "+0Hz",
        "volume": "+5%",
        "description": "Deliberate, weighty delivery",
    },
    "neutral": {
        "rate": "+0%",
        "pitch": "+0Hz",
        "volume": "+0%",
        "description": "Natural, balanced narration",
    },
}

# ---------------------------------------------------------------------------
# Keyword signal banks — words that strongly imply an emotional register
# ---------------------------------------------------------------------------
EMOTION_KEYWORDS: Dict[str, List[str]] = {
    "action": [
        "ran", "burst", "crashed", "exploded", "attack", "fight", "chase",
        "sprint", "shot", "battle", "kill", "danger", "rescue", "escape",
        "urgent", "quick", "sudden", "impact", "charge", "fled", "fired",
        "screamed", "lunged", "struck", "ducked", "slammed", "blazed",
    ],
    "suspense": [
        "shadow", "creak", "silence", "dark", "whisper", "fear", "lurk",
        "watch", "strange", "quiet", "alone", "trap", "secret", "hidden",
        "unknown", "dread", "cold", "slowly", "careful", "footstep",
        "breathless", "shiver", "ominous", "stalked", "unease", "warned",
    ],
    "romance": [
        "love", "heart", "tender", "kiss", "warmth", "smile", "gentle",
        "soft", "beautiful", "longing", "desire", "sweet", "hold", "embrace",
        "together", "care", "passion", "gaze", "blush", "touch", "adore",
        "cherish", "intimate", "whispered", "caress", "devoted",
    ],
    "comedy": [
        "laugh", "funny", "silly", "ridiculous", "absurd", "joke", "grin",
        "snort", "chuckle", "bizarre", "awkward", "clumsy", "hilarious",
        "ironic", "sarcastic", "mockery", "wit", "banter", "tease",
        "blundered", "stumbled", "bumbled", "snickered", "smirked",
    ],
    "drama": [
        "betrayal", "sorrow", "pain", "loss", "grief", "struggle", "conflict",
        "regret", "sacrifice", "despair", "hope", "truth", "justice", "fate",
        "change", "burden", "wound", "broken", "tears", "forgiveness",
        "shattered", "mourned", "wept", "haunted", "anguish",
    ],
}


def detect_emotion(text: str) -> Tuple[str, float, Dict[str, int]]:
    """
    Detect the dominant emotional register of a text passage.

    Uses a multi-signal scoring system:
      1. Keyword density for each emotion category
      2. Punctuation patterns (exclamations → action/comedy, ellipses → suspense)
      3. Sentence-length statistics (short → action, long → literary drama)

    Returns:
        (emotion_name, confidence_score_0_to_1, per-category_keyword_counts)
    """
    text_lower = text.lower()
    words = re.findall(r"\b\w+\b", text_lower)
    word_set = set(words)

    # 1. Keyword scores
    scores: Dict[str, int] = {e: 0 for e in EMOTION_KEYWORDS}
    for emotion, keywords in EMOTION_KEYWORDS.items():
        scores[emotion] = sum(1 for kw in keywords if kw in word_set)

    # 2. Punctuation signals
    sentence_count = max(len(re.findall(r"[.!?]+", text)), 1)
    exclamation_count = text.count("!")
    ellipsis_count = text.count("...")
    question_count = text.count("?")

    if exclamation_count > 2:
        scores["action"] += exclamation_count
        scores["comedy"] += exclamation_count // 2
    if ellipsis_count > 1:
        scores["suspense"] += ellipsis_count * 2
    if question_count > sentence_count * 0.4:
        scores["suspense"] += 1

    # 3. Sentence-length signal
    sentences = [
        s.strip()
        for s in re.split(r"[.!?]+", text)
        if len(s.strip()) > 5
    ]
    if sentences:
        avg_len = sum(len(s.split()) for s in sentences) / len(sentences)
        if avg_len < 8:
            scores["action"] += 3
        elif avg_len < 12:
            scores["comedy"] += 1
        elif avg_len > 20:
            scores["drama"] += 2
            scores["romance"] += 1

    total = sum(scores.values())
    if total == 0:
        return "neutral", 1.0, scores

    dominant = max(scores, key=scores.get)  # type: ignore[arg-type]
    confidence = round(scores[dominant] / total, 3)

    # Require at least 2 signals to accept a non-neutral result
    if scores[dominant] < 2:
        return "neutral", 1.0, scores

    return dominant, confidence, scores


def get_prosody_params(
    text: str,
    emotion: Optional[str] = None,
) -> Dict[str, str]:
    """
    Return edge_tts-compatible prosody parameters for the detected emotion.

    edge_tts.Communicate accepts rate/volume as percentage strings (e.g. "+25%")
    and pitch as a Hz string (e.g. "+10Hz").  Pass the returned dict directly
    as kwargs to generate_audio_with_timings or edge_tts.Communicate.

    If emotion is None or unrecognized, auto-detects via detect_emotion().
    """
    if emotion is None or emotion not in EMOTION_PROFILES:
        emotion, _, _ = detect_emotion(text)

    profile = EMOTION_PROFILES[emotion]
    return {
        "rate": profile["rate"],
        "pitch": profile["pitch"],
        "volume": profile["volume"],
    }


# ---------------------------------------------------------------------------
# Kept for backward compatibility — not used for audio generation any more.
# edge_tts 7.x escapes SSML passed as the text parameter, causing the XML
# tags to be read aloud.  Use get_prosody_params() + edge_tts kwargs instead.
# ---------------------------------------------------------------------------
def wrap_text_in_ssml(
    text: str,
    voice: str,
    emotion: Optional[str] = None,
    lang: str = "en-US",
) -> str:  # pragma: no cover
    raise NotImplementedError(
        "wrap_text_in_ssml is disabled: edge_tts 7.x does not support SSML "
        "as text input.  Use get_prosody_params() and pass the result as "
        "kwargs to edge_tts.Communicate instead."
    )


def analyze_chapter_emotions(
    chapters: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Bulk-analyze a list of chapter dicts and attach emotion metadata.

    Input chapters must have at least a "content" key.
    Returns the same list with these keys added to each item:
        detected_emotion, emotion_confidence, emotion_description,
        emotion_keyword_counts
    """
    enriched = []
    for chapter in chapters:
        content = chapter.get("content", "")
        emotion, confidence, keyword_counts = detect_emotion(content)
        profile = EMOTION_PROFILES[emotion]
        enriched.append(
            {
                **chapter,
                "detected_emotion": emotion,
                "emotion_confidence": confidence,
                "emotion_description": profile["description"],
                "emotion_keyword_counts": keyword_counts,
            }
        )
    return enriched
