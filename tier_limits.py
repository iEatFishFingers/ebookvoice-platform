"""
Single source of truth for subscription tier limits.

These values are read by:
- the conversion gate in `epub_to_audio.py` (/convert-chapters and the
  legacy /convert + /convert-text routes)
- the RevenueCat webhook handler (/api/revenuecat-webhook)
- the iOS sync-mobile-purchase endpoint (/api/sync-mobile-purchase)
- the Stripe subscription updater (`stripe_utils.update_subscription_in_db`)
- the default profile creation in `auth.get_user_profile`

Changing a limit here changes it everywhere on the backend.  The frontend
reads `maxLifetimeConversions` / `lifetimeConversionsRemaining` directly off
the `/api/profile` response — there is no frontend mirror to keep in sync.

`None` means "unlimited" (no cap).

June 2026 v3 — the ACCRUING conversion-credit model
───────────────────────────────────────────────────
The paid gate is conversion credits, counted in the lifetime
`profiles.conversion_count` (increments only when a conversion COMPLETES,
never decreases — deleting a book does NOT refund a credit).  Instead of a
hard lifetime cap, each tier's allowance GROWS over time:

    allowance = starter_credits + monthly_accrual × full months since signup

so a free user gets 3 conversions up front and 1 more each month — they stay
alive, build the habit, and "I read more than a book a month" self-selects
who upgrades.  No cron, no reset job, no new columns: the allowance is pure
arithmetic over `profiles.created_at`, compared against the monotonically
increasing counter.  (Credits effectively roll over; that's deliberate —
generosity errs in the user's favor and the ceiling stays ~accrual/month.)

`max_conversion_words` is the per-BOOK length cap for the tier (long books
are the expensive, additive luxury).  The global MAX_CONVERSION_WORDS in
epub_to_audio.py stays as the hard infra ceiling.

The `lifetime` tier is the one-time-purchase (RevenueCat non-consumable);
its ~20/month fair-use cap is enforced in the Terms, not in code.

Anonymous trial (1 conversion per device) is NOT a tier in this dict by
design — anonymous users have no `profiles` row; the limit is enforced by
row-existence in `_check_anonymous_conversion_gate`, and their word cap is
the free tier's.
"""

from datetime import datetime, timezone

TIER_LIMITS: dict = {
    'free': {
        'starter_credits': 3,
        'monthly_accrual': 1,
        'max_conversion_words': 120_000,  # 120k so Pride & Prejudice (115k) fits on free
    },
    'starter': {
        'starter_credits': 10,
        'monthly_accrual': 10,
        'max_conversion_words': 200_000,
    },
    'pro': {
        'starter_credits': None,        # unlimited
        'monthly_accrual': None,
        'max_conversion_words': None,   # global infra cap still applies
    },
    'lifetime': {
        'starter_credits': None,        # unlimited in code; fair-use in Terms
        'monthly_accrual': None,
        'max_conversion_words': None,
    },
    'enterprise': {
        'starter_credits': None,
        'monthly_accrual': None,
        'max_conversion_words': None,
    },
}

# Retained so older app binaries reading these off /api/profile still get a
# sane "unlimited" value; they gate nothing.
_LEGACY_KEYS = {'max_audiobooks': None, 'max_monthly_conversions': None}


def limits_for(tier: str) -> dict:
    """Return the limit dict for a tier name, defaulting to free if unknown."""
    return {**TIER_LIMITS.get(tier, TIER_LIMITS['free']), **_LEGACY_KEYS}


# Cheapest-first, so the word-cap rejection can name the *smallest* tier that
# actually clears the book instead of a generic "upgrade".
_UPGRADE_LADDER = ('free', 'starter', 'pro')


def cheapest_tier_for_words(
    total_words: int,
    current_tier: str = 'free',
    infra_ceiling: int | None = None,
) -> str | None:
    """Name the cheapest tier that can convert a book of `total_words`.

    Returns a tier name above `current_tier`, or None when no upgrade would
    help — either nothing on the ladder is big enough, or the book is over
    `infra_ceiling` (the global MAX_CONVERSION_WORDS), which **no** tier
    clears because it's a hardware limit rather than a plan limit.

    Pass `infra_ceiling` whenever you're about to show this to a user. An
    unlimited tier's `max_conversion_words` is None, so without it a 600k
    book would be told "Pro converts books of any length" — which is false,
    and precisely the kind of false promise this function exists to remove.

    Why this exists: the 413 used to say only "Upgrade to convert longer
    books". On 2026-08-21 a user with a 195,002-word book — which fits
    starter's 200k cap with room to spare — was left to guess, chose pro,
    saw that price and abandoned the purchase. Naming the right tier is the
    difference between an upsell and a dead end.
    """
    if infra_ceiling is not None and total_words > infra_ceiling:
        return None
    try:
        start = _UPGRADE_LADDER.index(current_tier)
    except ValueError:
        start = 0
    for tier in _UPGRADE_LADDER[start + 1:]:
        cap = TIER_LIMITS[tier].get('max_conversion_words')
        if cap is None or total_words <= cap:
            return tier
    return None


def _months_since(created_at) -> int:
    """Full calendar months elapsed since `created_at` (ISO string or datetime).

    Unparseable/missing dates count as 0 months — the user still gets their
    starter credits, never an error.
    """
    if not created_at:
        return 0
    try:
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        months = (now.year - created_at.year) * 12 + (now.month - created_at.month)
        if now.day < created_at.day:
            months -= 1  # the current month isn't complete yet
        return max(0, months)
    except Exception:
        return 0


def conversion_allowance(tier: str, created_at) -> int | None:
    """Current total conversion credits for this account. None = unlimited.

    Compared against the lifetime `profiles.conversion_count` by the gate.
    """
    limits = limits_for(tier)
    base = limits['starter_credits']
    if base is None:
        return None
    return base + (limits['monthly_accrual'] or 0) * _months_since(created_at)
