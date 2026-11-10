# The anonymous gate refused with 403 — and upsold — when the database was unreachable

**Severity:** high · **Status:** resolved

## What happened

`_check_anonymous_gate()` wrapped its `device_id` lookup in a bare `except Exception` and failed **closed**:

```python
except Exception as e:
    # If the device_id column doesn't exist yet (migration 010 not run),
    # fail closed — refuse the conversion rather than letting anonymous
    # bypass succeed silently.
    print(f'[gate] anonymous device_id lookup failed: {e}')
    return {
        'allowed': False,
        'response': {
            'error': 'Anonymous trial temporarily unavailable. Please sign up to continue.',
            'anonymous_unavailable': True,
        },
    }
```

The comment states the intent: guard against a **missing migration**, a structural condition where refusing is correct. But the `except` caught everything, including a transient database outage. During a database outage, logs showed an anonymous user audition two voices, pick one, press Convert — and get a 403 eight seconds later:

```
GET /preview?voice=en-GB-SoniaNeural        206
GET /preview?voice=en-US-EmmaMultilingual   206
[gate] anonymous device_id lookup failed: [Errno -2] Name or service not known
POST /convert-chapters                      403
```

Three things were wrong, in increasing order of cost:

1. **403 is a permanent "no".** The client can't tell "denied" from "broken", so there's no retry path.
2. **It blamed the user's anonymous status** for an infrastructure failure.
3. **It upsold them into a signup that was also broken** — `profiles` couldn't take writes either.

## The same lesson, one layer down

The same class of bug had already been fixed for `/status` and the ownership decorator, which return **503, not 404**, when the database is unreachable (the client drops a task after three 404s, so a misreported outage used to kill healthy conversions). The gate never got the same treatment.

## Resolution

The bare `except` now separates the two cases it conflated:

- **Column genuinely missing** (`42703`, schema-cache, or an error naming `device_id` as a column) → still fails closed with 403.
- **Anything else** (DNS, timeout, connection reset, 5xx, project restricted) → **503** with `retryable: true` and copy saying the servers are unreachable and it is *not* the user's account. No mention of signing up.

All four gate call sites honour a gate-supplied `status` (default 403). Four tests cover it, including one asserting "sign up" never appears in a transient-failure body.

## Lesson

**Fail closed on structural conditions; fail retryable on transient ones.** A bare `except` that maps both to the same permanent refusal turns every infrastructure blip into a lost user.
