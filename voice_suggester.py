"""
voice_suggester.py
==================
AI Voice Suggestion Engine.

Analyzes a text sample's writing style (sentence structure, vocabulary
complexity, punctuation patterns, dialogue density) and ranks available
Edge TTS voices by how well their characteristic profile fits the prose.

All analysis is pure Python regex — zero extra dependencies.
The scoring is additive and capped at 1.0. Top-N suggestions are returned
with human-readable reasoning so the UI can show authors *why* a voice
was recommended.
"""

import re
from typing import Dict, Any, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Voice profiles — curated to match Edge TTS voice IDs we already expose.
# Each profile has:
#   tags: searchable genre/style keywords used in scoring
#   best_for: human-readable description shown in the UI
#   style: narration style sentence shown in the suggestion card
#   sentence_length_range: (min, max) average words per sentence
#   complexity_range: (min, max) ratio of long/uncommon words
# ---------------------------------------------------------------------------
VOICE_PROFILES: Dict[str, Dict[str, Any]] = {
    "en-US-AndrewMultilingualNeural": {
        "tags": ["authoritative", "literary", "academic", "formal", "non-fiction"],
        "best_for": "Literary fiction, non-fiction, academic works",
        "style": "Deep, authoritative — ideal for serious or complex content",
        "sentence_length_range": (15, 40),
        "complexity_range": (0.5, 1.0),
    },
    "en-US-EmmaMultilingualNeural": {
        "tags": ["warm", "romance", "personal", "memoir", "women"],
        "best_for": "Romance, personal narratives, memoirs, women's fiction",
        "style": "Warm and expressive — draws the listener in emotionally",
        "sentence_length_range": (10, 25),
        "complexity_range": (0.3, 0.7),
    },
    "en-US-DavisNeural": {
        "tags": ["thriller", "noir", "mystery", "action", "detective", "gritty"],
        "best_for": "Thrillers, detective fiction, noir, action sequences",
        "style": "Gritty and intense — builds tension naturally",
        "sentence_length_range": (5, 15),
        "complexity_range": (0.2, 0.6),
    },
    "en-US-TonyNeural": {
        "tags": ["comedy", "casual", "young", "contemporary", "conversational"],
        "best_for": "Contemporary fiction, humor, young adult, casual tone",
        "style": "Energetic and approachable — great for modern, snappy voices",
        "sentence_length_range": (8, 18),
        "complexity_range": (0.2, 0.5),
    },
    "en-GB-SoniaNeural": {
        "tags": ["british", "period", "literary", "drama", "historical"],
        "best_for": "Period pieces, British settings, literary drama",
        "style": "Refined and measured — adds gravitas to dramatic moments",
        "sentence_length_range": (12, 30),
        "complexity_range": (0.4, 0.9),
    },
    "en-US-AriaNeural": {
        "tags": ["neutral", "professional", "general", "business", "self-help"],
        "best_for": "Business books, self-help, how-to guides",
        "style": "Clear and professional — easy to follow for long sessions",
        "sentence_length_range": (10, 20),
        "complexity_range": (0.3, 0.6),
    },
    "en-AU-NatashaNeural": {
        "tags": ["adventure", "outdoors", "young-adult", "uplifting", "journey"],
        "best_for": "Adventure stories, young adult, uplifting narratives",
        "style": "Bright and energetic with natural warmth",
        "sentence_length_range": (8, 20),
        "complexity_range": (0.2, 0.5),
    },
    "en-US-GuyNeural": {
        "tags": ["narration", "documentary", "history", "biography", "factual"],
        "best_for": "Non-fiction, history, biography, documentary style",
        "style": "Confident narrator voice — authoritative yet engaging",
        "sentence_length_range": (15, 35),
        "complexity_range": (0.4, 0.8),
    },
    "en-US-SteffanNeural": {
        "tags": ["fantasy", "epic", "sci-fi", "world-building", "dramatic"],
        "best_for": "Fantasy, science fiction, epic world-building narratives",
        "style": "Bold and dramatic — perfect for grand storytelling",
        "sentence_length_range": (12, 35),
        "complexity_range": (0.4, 0.85),
    },
    "en-US-AnaNeural": {
        "tags": ["children", "whimsical", "light", "playful", "fairy-tale"],
        "best_for": "Children's books, fairy tales, whimsical stories",
        "style": "Bright and playful — captivating for younger audiences",
        "sentence_length_range": (5, 14),
        "complexity_range": (0.1, 0.35),
    },
}

# High-frequency words excluded from vocabulary complexity scoring
_COMMON_WORDS = frozenset(
    """the a an and or but in on at to for of with by from is was are were be
    been have has had do does did will would could should may might can not
    he she it they we you i me him her us them my your his its our their this
    that these those what who which when where how why into up out over just
    all also more so then than there if as about after before while during
    through between against under because since though although until""".split()
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def analyze_writing_style(text: str) -> Dict[str, Any]:
    """
    Compute style metrics for a text sample.

    Returns a dict with keys:
        avg_sentence_length, sentence_variance, avg_word_length,
        vocabulary_richness, complexity_ratio, exclamation_density,
        ellipsis_density, dialogue_density, word_count, sentence_count,
        has_british_spellings
    """
    clean = re.sub(r"\s+", " ", text).strip()

    # Tokenize sentences and words
    sentences = [
        s.strip()
        for s in re.split(r"[.!?]+", clean)
        if len(s.strip()) > 5
    ]
    words = re.findall(r"\b[a-zA-Z]+\b", clean)

    if not sentences or not words:
        return {"error": "Insufficient text for analysis (need at least 1 sentence)"}

    words_lower = [w.lower() for w in words]
    unique_words = set(words_lower)

    # Sentence metrics
    sent_lengths = [len(re.findall(r"\b\w+\b", s)) for s in sentences]
    avg_sentence_length = sum(sent_lengths) / len(sent_lengths)
    sentence_variance = _variance(sent_lengths)

    # Vocabulary metrics
    complex_words = [
        w for w in words_lower if len(w) > 7 and w not in _COMMON_WORDS
    ]
    vocabulary_richness = len(unique_words) / len(words_lower)
    complexity_ratio = len(complex_words) / len(words_lower)
    avg_word_length = sum(len(w) for w in words_lower) / len(words_lower)

    # Punctuation / style signals
    sentence_count = max(len(sentences), 1)
    exclamation_density = text.count("!") / sentence_count
    ellipsis_density = text.count("...") / sentence_count
    # Count both straight and curly double quotes as dialogue markers
    quote_chars = text.count('"') + text.count("\u201c") + text.count("\u201d")
    dialogue_density = quote_chars / max(len(words_lower), 1)

    # British English detection
    british_spellings = {
        "colour", "honour", "favour", "labour", "neighbour", "whilst",
        "amongst", "realise", "recognise", "organise", "analyse", "centre",
        "theatre", "travelling", "marvellous",
    }
    has_british = bool(unique_words & british_spellings)

    return {
        "avg_sentence_length": round(avg_sentence_length, 1),
        "sentence_variance": round(sentence_variance, 1),
        "avg_word_length": round(avg_word_length, 2),
        "vocabulary_richness": round(vocabulary_richness, 3),
        "complexity_ratio": round(complexity_ratio, 3),
        "exclamation_density": round(exclamation_density, 3),
        "ellipsis_density": round(ellipsis_density, 3),
        "dialogue_density": round(dialogue_density, 3),
        "word_count": len(words_lower),
        "sentence_count": len(sentences),
        "has_british_spellings": has_british,
    }


def suggest_voices(
    text: str,
    available_voice_ids: Optional[List[str]] = None,
    top_n: int = 3,
) -> List[Dict[str, Any]]:
    """
    Suggest the best-matching Edge TTS voices for a text sample.

    Args:
        text: A text excerpt to analyze (a full chapter works best).
        available_voice_ids: IDs to consider. None = use all built-in profiles.
        top_n: How many suggestions to return.

    Returns:
        Sorted list (best first) of suggestion dicts:
        {voice_id, match_percentage, reasons, best_for, style_description, metrics}
    """
    metrics = analyze_writing_style(text)
    if "error" in metrics:
        return []

    pool = VOICE_PROFILES
    if available_voice_ids:
        pool = {k: v for k, v in VOICE_PROFILES.items() if k in available_voice_ids}
        if not pool:
            pool = VOICE_PROFILES  # fall back if none of theirs matched our profiles

    scored: List[Dict[str, Any]] = []
    for voice_id, profile in pool.items():
        score, reasons = _score_voice(metrics, profile)
        scored.append(
            {
                "voice_id": voice_id,
                "score": score,
                "match_percentage": min(100, round(score * 100)),
                "reasons": reasons,
                "best_for": profile["best_for"],
                "style_description": profile["style"],
                "metrics": metrics,
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_n]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _score_voice(
    metrics: Dict[str, Any],
    profile: Dict[str, Any],
) -> Tuple[float, List[str]]:
    """
    Score how well a voice profile fits the text metrics.
    Returns (score_0_to_1, list_of_human_readable_reasons).
    """
    score = 0.0
    reasons: List[str] = []

    avg_len: float = metrics["avg_sentence_length"]
    complexity: float = metrics["complexity_ratio"]
    tags: List[str] = profile["tags"]
    len_min, len_max = profile["sentence_length_range"]
    comp_min, comp_max = profile["complexity_range"]

    # ── Sentence length fit (weight 0.40) ────────────────────────────────
    if len_min <= avg_len <= len_max:
        score += 0.40
        reasons.append(
            f"Avg sentence length ({avg_len:.0f} words) is ideal for this voice"
        )
    elif abs(avg_len - (len_min + len_max) / 2) < 5:
        score += 0.20
        reasons.append("Sentence length is close to this voice's ideal range")

    # ── Vocabulary complexity fit (weight 0.30) ───────────────────────────
    if comp_min <= complexity <= comp_max:
        score += 0.30
        reasons.append("Vocabulary complexity matches this voice's register")
    elif abs(complexity - (comp_min + comp_max) / 2) < 0.08:
        score += 0.15

    # ── British spellings (weight 0.15) ───────────────────────────────────
    if metrics.get("has_british_spellings") and "british" in tags:
        score += 0.15
        reasons.append("British spellings detected — British accent recommended")

    # ── High dialogue density (weight 0.12) ───────────────────────────────
    if metrics["dialogue_density"] > 0.04:
        conversational_tags = {"warm", "casual", "contemporary", "comedy", "conversational"}
        if conversational_tags & set(tags):
            score += 0.12
            reasons.append(
                "Heavy dialogue suits this voice's conversational warmth"
            )

    # ── High exclamation density → energetic voices (weight 0.12) ─────────
    if metrics["exclamation_density"] > 0.20:
        energetic_tags = {"action", "thriller", "comedy", "adventure"}
        if energetic_tags & set(tags):
            score += 0.12
            reasons.append(
                "High-energy punctuation style matches this voice's intensity"
            )

    # ── High ellipsis density → suspense (weight 0.10) ────────────────────
    if metrics["ellipsis_density"] > 0.15:
        if {"thriller", "noir", "mystery", "gritty"} & set(tags):
            score += 0.10
            reasons.append("Suspenseful pacing aligns with this voice")

    # ── Short punchy sentences → noir/action (weight 0.15) ────────────────
    if avg_len < 10 and {"thriller", "noir", "action", "detective"} & set(tags):
        score += 0.15
        reasons.append("Short, punchy sentences suit this gritty voice style")

    # ── Long flowing sentences → literary/romance (weight 0.12) ──────────
    if avg_len > 20 and {"literary", "romance", "drama", "period", "historical"} & set(tags):
        score += 0.12
        reasons.append("Long, flowing sentences suit this expressive delivery")

    # ── Low complexity + short sentences → children's (weight 0.15) ──────
    if complexity < 0.15 and avg_len < 12 and "children" in tags:
        score += 0.15
        reasons.append("Simple vocabulary and short sentences fit a children's voice")

    return min(score, 1.0), reasons[:3]  # cap and limit to 3 reasons


def _variance(numbers: List[float]) -> float:
    if len(numbers) < 2:
        return 0.0
    mean = sum(numbers) / len(numbers)
    return sum((x - mean) ** 2 for x in numbers) / len(numbers)
