# The purchase sync returned 500 on every purchase — a RevenueCat v2 key against a v1 endpoint

**Severity:** high (money path) · **Status:** resolved

## What happened

`sync_mobile_purchase()` calls `GET https://api.revenuecat.com/v1/subscribers/{user_id}` with `REVENUECAT_SECRET_KEY`. The configured key was an **API v2 secret**:

```
403 {"code": 7723, "message": "You're trying to use a secret API key incompatible with RevenueCat API V1."}
```

The handler mapped 401/403 to a **500** (`'Purchase verification misconfigured'`). In production logs, a real purchase looked like this:

```
[revenuecat-webhook] Event: INITIAL_PURCHASE for user: <uuid>
[revenuecat-webhook] Activated starter for <uuid>
[sync-mobile-purchase] RC auth error 403 — check REVENUECAT_SECRET_KEY
"POST /api/sync-mobile-purchase HTTP/1.1" 500
```

## What the buyer actually saw

The initial diagnosis assumed the buyer was shown an error. **That was wrong**, and the correction is the most useful part of this write-up:

- The client's `syncMobilePurchase()` catches **any** failure and returns `{pending: true}`.
- `SubscriptionScreen` then polls the profile — and the webhook had already written the tier 140 ms *before* the sync's 500.
- The app showed **"Success"**.

The analytics trail agreed: the catch branch that fires `subscription_cancelled` never fired. Reading a server log as if it were the user's screen produced a confident, wrong story; the client code and the event trail corrected it.

## What was really broken

1. **A 500 for the server's own misconfiguration** — harmless to this client, but noise on the money path and wrong for any client that didn't swallow it.
2. **A sandbox hole that fixing the key alone would have opened.** The webhook ignores every `SANDBOX` event, but `_tier_from_rc_subscriber()` had no sandbox check — `_is_entitlement_active()` looked only at `expires_date`. With a working key, a TestFlight tester's sandbox purchase would have been written as a paid tier, and because the webhook ignores sandbox `EXPIRATION`, nothing would ever revoke it.
3. **`_fetch_rc_tier()` always returned `None`** with the broken key, so a `TRANSFER` was skipped and an `EXPIRATION` fell back to `free` — an expiring subscription could downgrade a lifetime holder.

## Resolution (`epub_to_audio.py`, tests in `tests/test_purchase_sync.py`)

- 401/403 from RevenueCat → `202 {pending: true}`, the same shape as other transient failures; the client polls the profile and picks up the webhook's write.
- Sandbox-granted entitlements are ignored in `_tier_from_rc_subscriber()` (covering sync, `TRANSFER` and `EXPIRATION`) by mapping each entitlement's `product_identifier` to `subscriptions.<product>.is_sandbox` / `non_subscriptions.<product>[].is_sandbox`.
- The sync **only upgrades** — it never writes `free`; downgrades stay with the webhook.
- A v1 secret key was issued and configured.
- Client: `subscription_confirmed` is tracked after a successful purchase, so analytics can tell a completed purchase from a dismissed payment sheet (previously `subscription_started` was a tap and `subscription_cancelled` came from the error handler, not a user quitting).

## Lessons

- **Never return 500 for your own misconfiguration on a path a paying user is waiting on.**
- **Fixing an auth bug can open a hole the bug was hiding** — audit what the newly-working path will write.
- **Verify what the user saw from the client code and event trail**, not the server log.
