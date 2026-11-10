"""
analytics.py
============
Author Analytics & Listening Heatmaps — Flask Blueprint.

Endpoints:
  POST /analytics/heartbeat          — player pings every 5 s of playback
  GET  /analytics/heatmap/<ab_id>    — returns aggregated engagement data
  GET  /analytics/summary/<ab_id>    — returns per-chapter retention summary

Design goals:
  - Heartbeat always returns 200 (analytics must NEVER block playback)
  - Heatmap queries touch a single indexed table with no joins (stays fast
    at 40-80 concurrent users on Render free tier)
  - 5-second segment bucketing means ~720 rows per hour of audio per listener —
    manageable even without time-series infrastructure
"""

import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from auth import require_auth

analytics_bp = Blueprint("analytics", __name__)


# ---------------------------------------------------------------------------
# Lazy Supabase client — avoids circular imports with epub_to_audio.py
# ---------------------------------------------------------------------------
def _supabase():
    from epub_to_audio import supabase  # noqa: PLC0415
    return supabase


# ---------------------------------------------------------------------------
# POST /analytics/heartbeat
# ---------------------------------------------------------------------------
@analytics_bp.route("/analytics/heartbeat", methods=["POST"])
@require_auth
def record_heartbeat():
    """
    Record a single playback heartbeat event.

    Expected JSON body:
        audiobook_id     (str, required)
        chapter_index    (int, default 0)
        position_seconds (float, required)
        playback_rate    (float, default 1.0)

    Always returns HTTP 200 — analytics failures must not interrupt playback.
    """
    user_id = request.user_id  # type: ignore[attr-defined]
    data: Optional[Dict] = request.get_json(silent=True)

    if not data:
        return jsonify({"status": "ok"}), 200

    audiobook_id = data.get("audiobook_id")
    chapter_index = int(data.get("chapter_index", 0))
    position_seconds = float(data.get("position_seconds", 0))
    playback_rate = float(data.get("playback_rate", 1.0))

    if not audiobook_id or position_seconds < 0:
        return jsonify({"status": "ok"}), 200

    try:
        # Bucket to nearest 5-second segment boundary
        segment = math.floor(position_seconds / 5) * 5

        _supabase().table("playback_events").insert(
            {
                "user_id": user_id,
                "audiobook_id": audiobook_id,
                "chapter_index": chapter_index,
                "position_seconds": position_seconds,
                "segment": segment,
                "playback_rate": playback_rate,
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()
    except Exception:
        # Silent fail — analytics must never block playback
        pass

    return jsonify({"status": "ok"}), 200


# ---------------------------------------------------------------------------
# GET /analytics/heatmap/<audiobook_id>
# ---------------------------------------------------------------------------
@analytics_bp.route("/analytics/heatmap/<audiobook_id>", methods=["GET"])
@require_auth
def get_heatmap(audiobook_id: str):
    """
    Return listening heatmap data for an audiobook owned by the caller.

    Query params:
        chapter_index (int, optional) — filter to a single chapter

    Response shape:
    {
        audiobook_id,
        total_listeners,
        total_plays,
        chapters: [{chapter_index, listener_count, play_count, max_position_reached_seconds}],
        heatmap:  [{chapter_index, segment_start, segment_end,
                    listener_count, play_count, drop_off_pct, engagement_score}]
    }
    """
    user_id = request.user_id  # type: ignore[attr-defined]
    chapter_filter = request.args.get("chapter_index", type=int)
    sb = _supabase()

    # Ownership check
    ab = (
        sb.table("audiobooks")
        .select("id, title, user_id")
        .eq("id", audiobook_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if not ab.data:
        return jsonify({"error": "Audiobook not found"}), 404

    # Fetch events — gracefully handle missing table (migration not yet run)
    try:
        q = (
            sb.table("playback_events")
            .select("user_id, chapter_index, segment, recorded_at")
            .eq("audiobook_id", audiobook_id)
        )
        if chapter_filter is not None:
            q = q.eq("chapter_index", chapter_filter)

        events_result = q.execute()
        events: List[Dict] = events_result.data or []
    except Exception as e:
        print(f"[ANALYTICS] playback_events query failed (table may not exist): {e}")
        events = []

    if not events:
        return jsonify(
            {
                "audiobook_id": audiobook_id,
                "total_listeners": 0,
                "total_plays": 0,
                "chapters": [],
                "heatmap": [],
            }
        ), 200

    unique_listeners = len({e["user_id"] for e in events})
    unique_plays = len({(e["user_id"], e["chapter_index"]) for e in events})

    return jsonify(
        {
            "audiobook_id": audiobook_id,
            "total_listeners": unique_listeners,
            "total_plays": unique_plays,
            "chapters": _chapter_stats(events),
            "heatmap": _build_heatmap(events),
        }
    ), 200


# ---------------------------------------------------------------------------
# GET /analytics/summary/<audiobook_id>
# ---------------------------------------------------------------------------
@analytics_bp.route("/analytics/summary/<audiobook_id>", methods=["GET"])
@require_auth
def get_summary(audiobook_id: str):
    """
    High-level engagement summary (used by the dashboard header cards).

    Response:
    {
        audiobook_id,
        total_listeners,
        avg_completion_pct,
        most_replayed_segment: {chapter_index, segment_start, play_count},
        biggest_drop_off:       {chapter_index, segment_start, drop_off_pct}
    }
    """
    user_id = request.user_id  # type: ignore[attr-defined]
    sb = _supabase()

    ab = (
        sb.table("audiobooks")
        .select("id, user_id")
        .eq("id", audiobook_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if not ab.data:
        return jsonify({"error": "Audiobook not found"}), 404

    # Gracefully handle missing table (migration not yet run)
    try:
        events_result = (
            sb.table("playback_events")
            .select("user_id, chapter_index, segment")
            .eq("audiobook_id", audiobook_id)
            .execute()
        )
        events: List[Dict] = events_result.data or []
    except Exception as e:
        print(f"[ANALYTICS] playback_events query failed (table may not exist): {e}")
        events = []

    if not events:
        return jsonify(
            {
                "audiobook_id": audiobook_id,
                "total_listeners": 0,
                "avg_completion_pct": 0,
                "most_replayed_segment": None,
                "biggest_drop_off": None,
            }
        ), 200

    heatmap = _build_heatmap(events)
    total_listeners = len({e["user_id"] for e in events})
    avg_completion = (
        round(
            sum(h["engagement_score"] for h in heatmap) / len(heatmap) * 100,
            1,
        )
        if heatmap
        else 0
    )

    most_replayed = max(heatmap, key=lambda h: h["play_count"], default=None)
    biggest_drop = max(heatmap, key=lambda h: h["drop_off_pct"], default=None)

    return jsonify(
        {
            "audiobook_id": audiobook_id,
            "total_listeners": total_listeners,
            "avg_completion_pct": avg_completion,
            "most_replayed_segment": most_replayed,
            "biggest_drop_off": biggest_drop,
        }
    ), 200


# ---------------------------------------------------------------------------
# Aggregation helpers
# ---------------------------------------------------------------------------

def _build_heatmap(events: List[Dict]) -> List[Dict[str, Any]]:
    """
    Build per-segment engagement data from raw event rows.

    Groups by (chapter_index, segment) and counts unique listeners + total
    plays. Computes engagement_score relative to the hottest segment.
    """
    seg_data: Dict[tuple, Dict] = {}
    for e in events:
        key = (int(e.get("chapter_index", 0)), int(e.get("segment", 0)))
        if key not in seg_data:
            seg_data[key] = {"users": set(), "plays": 0}
        seg_data[key]["users"].add(e["user_id"])
        seg_data[key]["plays"] += 1

    if not seg_data:
        return []

    max_plays = max(v["plays"] for v in seg_data.values())

    result = []
    for (chapter, segment), data in sorted(seg_data.items()):
        engagement = round(data["plays"] / max_plays, 3) if max_plays else 0
        result.append(
            {
                "chapter_index": chapter,
                "segment_start": segment,
                "segment_end": segment + 5,
                "listener_count": len(data["users"]),
                "play_count": data["plays"],
                "drop_off_pct": round((1 - engagement) * 100, 1),
                "engagement_score": engagement,
            }
        )
    return result


def _chapter_stats(events: List[Dict]) -> List[Dict[str, Any]]:
    """Per-chapter listener count and deepest position reached."""
    chapter_data: Dict[int, Dict] = {}
    for e in events:
        ch = int(e.get("chapter_index", 0))
        if ch not in chapter_data:
            chapter_data[ch] = {"users": set(), "max_segment": 0, "plays": 0}
        chapter_data[ch]["users"].add(e["user_id"])
        chapter_data[ch]["plays"] += 1
        chapter_data[ch]["max_segment"] = max(
            chapter_data[ch]["max_segment"], int(e.get("segment", 0))
        )

    return [
        {
            "chapter_index": ch,
            "listener_count": len(d["users"]),
            "play_count": d["plays"],
            "max_position_reached_seconds": d["max_segment"],
        }
        for ch, d in sorted(chapter_data.items())
    ]
