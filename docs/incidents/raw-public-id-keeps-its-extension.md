# `raw` public_ids keep their file extension — one "improvement" away from deleting every karaoke file

**Severity:** high (latent) · **Status:** guarded; never triggered in production

## The hazard

`url_to_public_id()` in `scripts/cleanup_orphan_cdn_assets.py` strips the file extension unconditionally:

```python
path = parts[1]
if '.' in path:
    path = path.rsplit('.', 1)[0]
```

That's right for `image` and `video`, where Cloudinary's `public_id` **excludes** the format. It's wrong for `raw`, where the extension **is part of the id** (and Cloudinary reports `format: None`):

```
DB  word_timings_url:  https://res.cloudinary.com/<cloud>/raw/upload/v<ver>/word_timings/<book>_7.json
Cloudinary public_id:  'word_timings/<book>_7.json'
```

The cleanup script didn't scan `raw`, so nothing was being deleted. The hazard was the next person who "completed" it by adding the `raw` scope with the existing helper: it would have reaped **all 1,396 live word-timing files (156 MB)** and broken follow-along across the whole library.

## How it was caught

A trial scan of `raw` with the helper produced:

| | |
|---|--:|
| referenced `word_timings_url` values | 1,396 |
| `raw` assets on the CDN | 1,396 |
| "orphans" | **1,396** |

All three equal — which is impossible: if every asset is referenced, none can be orphaned. With the extension preserved, true orphans: **0**.

156 MB of "reclaimable space" is a perfectly plausible-looking result. It was caught only because the numbers were *arithmetically impossible*. A number that cannot be true deserves more scrutiny than one that merely looks surprising.

## The knowledge already existed — in the wrong place

The backend's single-asset delete path already documented this exact gotcha and used a dedicated `_safe_destroy_raw()`. The standalone script, written later, re-implemented extraction and reintroduced the bug — two helpers, one correct, nothing connecting them.

## Resolution

- A `[!danger]` block in the script's docstring explains why the `raw` scope must not be added with this helper.
- The script also refuses to run while any conversion is queued or processing (in-flight chapters upload before their rows exist, so they all look orphaned), and skips assets younger than `--min-age-hours` (default 48) as a second line of defence. An asset with an unparseable `created_at` is treated as new and kept.

Before any `raw` scan could ship safely, it should assert `referenced + orphaned == total` and `orphaned < total` whenever anything is referenced.

## Lessons

- **Sanity-check results against invariants**, not against intuition.
- **Duplicated helpers drift.** Share one implementation of a subtle rule, or it will be reimplemented wrongly.
