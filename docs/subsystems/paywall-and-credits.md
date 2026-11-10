# Paywall, Credits & Payments

## Design principle

The free tier is the **funnel**, not the firewall. Every gate was held to one test:

- **Does it protect something paid users would happily pay for?** → good gate.
- **Does it punish a free user mid-flow?** → bad gate, removed.

Consequences: all playback — karaoke follow-along, the full voice catalogue, the voice picker, background play with lock-screen / Bluetooth / CarPlay controls — is free for everyone. Friction appears only when a user asks for **more**.

## Accruing conversion credits — the only paid gate

The allowance **grows over time**, with no cron and no reset job:

```
allowance = starter_credits + monthly_accrual × full months since profiles.created_at
```

Computed in `tier_limits.conversion_allowance`. Credits effectively roll over, by design.

| Tier | Starting credits | Monthly accrual | Per-book word cap |
|---|--:|--:|--:|
| Anonymous (no account) | 1 | — | 120k |
| Free | 3 | +1/mo | 120k |
| Starter | 10 | +10/mo | 200k |
| Pro / Lifetime / Enterprise | unlimited | — | uncapped |

A global `MAX_CONVERSION_WORDS=500k` infrastructure ceiling applies to everyone. The free cap is 120k so a typical full-length novel (*Pride & Prejudice* is ~115k) fits.

### The counter

The gate uses `profiles.conversion_count`, which:

- increments **only when a conversion completes**, via the atomic `increment_conversion_count` RPC (migration `012`)
- **never decreases** — deleting an audiobook does not refund a credit

Gate function: `_check_lifetime_conversion_gate(profile)` in `epub_to_audio.py`. The client reads `conversionCount`, `maxLifetimeConversions` (the current accrued allowance — name kept for binary compatibility), `lifetimeConversionsRemaining` and `maxConversionWords` from `/api/profile`. The hard-wall UI is `<ConversionLimitModal>`.

### Word-cap rejection names a specific tier

Word caps are enforced in `/convert-chapters` **before** enqueue. The 413 body carries `tier_word_limit: true`, `word_count`, `max_words`, `suggested_tier` and `suggested_tier_max_words`. `tier_limits.cheapest_tier_for_words(total_words, current_tier, infra_ceiling)` returns the **smallest** tier that fits the book:

> *"This book is about 195,002 words, and your plan converts books up to 120,000 words. Starter converts books up to 200,000 words."*

Three rules shaped this message:

1. **Never suggest splitting the book.** Earlier copy did; users followed it instead of upgrading, spending credits on broken halves.
2. **Never present signup as the fix for the word cap.** Anonymous and free users have the same cap, so signing up changes nothing there. The signup prompt belongs on the *credit* gate, where 1 → 3 + 1/month is a real upgrade.
3. **Always pass `infra_ceiling`.** An unlimited tier's `max_conversion_words` is `None`; without the global ceiling, a 600k book would be told "Pro converts books of any length".

Client side, `mobile-app/src/utils/wordCap.ts` opens `SubscriptionScreen` with `{ reason: 'word_cap', suggestedTier, suggestedTierMaxWords, wordCount }`. The paywall pre-selects and focuses the suggested tier (including VoiceOver focus), badges it **FITS YOUR BOOK**, and shows the word-count banner.

### Anonymous users

Anonymous use is gated **structurally**: with no `profiles` row, `_check_anonymous_conversion_gate` checks whether the device already has a book.

- Anonymous users **cannot delete their trial book** (backend 403 + hidden button), or the row-existence gate would reopen.
- Anonymous users **can** play and save progress. `PUT /api/audiobooks/<id>/progress` is `@optional_auth` and scopes by `device_id` (a `user_id XOR device_id` ownership pattern). When it once used `@require_auth`, every anonymous progress-save returned 401.
- `POST /api/anonymous/claim` migrates a device's books to a new account on signup.

## Payments by platform

Two payment systems exist because **Apple requires a second one**.

| Platform | Processor | Path |
|---|---|---|
| Web | **Stripe** | `POST /api/create-checkout-session` → hosted checkout; webhook updates the tier |
| iOS | **RevenueCat → Apple IAP** | `purchaseService.purchaseTier()`; RevenueCat webhook + client-initiated sync |
| Android | RevenueCat → Google Play Billing | same code path as iOS (configuration only, never released) |

Stripe was built first, for web, and initially shipped on iOS too. App Review rejected it: guideline 3.1.1 requires Apple's In-App Purchase for digital content sold inside an iOS app. RevenueCat was adopted as the IAP layer.

**Tier resolution is unified even though purchase isn't.** Whichever processor took the money, the tier lands on `profiles.subscription_tier` — Stripe via its webhook, RevenueCat via its webhook and `/api/sync-mobile-purchase`. Every gate reads that one column. The split is confined to the purchase moment; everything downstream is processor-blind.

### Purchase-sync hardening

`/api/sync-mobile-purchase` re-derives the tier from the RevenueCat REST API rather than trusting the client. After an incident where it returned 500 on its own misconfiguration (see [RevenueCat key incident](../incidents/revenuecat-v2-key-breaks-purchase-sync.md)), it:

- **never returns 500** for its own configuration problems
- **ignores sandbox entitlements** in production
- **never downgrades** a tier

### Lifetime tier

One-time RevenueCat **non-consumable** (entitlement and package id `lifetime`). Unlimited in code; fair use lives in the Terms, not in code.

- The webhook handles `NON_RENEWING_PURCHASE`.
- **`EXPIRATION` re-derives the remaining tier from the RevenueCat REST API**, so an expiring subscription can't downgrade a lifetime holder. `_tier_from_rc_subscriber` ranks `lifetime > pro > starter`.

## Superseded models

The current model replaced three earlier ones, all removed:

- **Monthly conversion counter** (Free 5 / Starter 10 per month) with a pg_cron reset job, an atomic monthly-increment RPC, and SHA-256 source-hash de-duplication so retries didn't count (migrations `001`–`003`).
- **A hard lifetime cap** (free: 2 conversions, never refreshed) — too punishing for habit formation.
- **Feature trials** — one-use karaoke trials, a premium voice-picker paywall, and "limited-time" banners on follow-along.

## Related

- [App Store & web](../operations/app-store-and-web.md) — why pricing never appears in store metadata
- [Platforms](../platforms.md)
