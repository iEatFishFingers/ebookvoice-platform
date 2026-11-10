# Every player open pulled the whole book's word timings out of Supabase — and restricted the project

**Severity:** critical (full outage) · **Status:** resolved by moving timings to the CDN

## What happened

`GET /api/audiobooks/<id>` read **every chapter's full word-timing array** and returned all of it on **every** open of the Player:

```python
.select('*, audiobook_chapters(*)')      # '*' includes word_timings
...
'word_timings': ch.get('word_timings'),  # and it all goes out again
```

The client requested it on every open and never cached it — the on-device library cache deliberately excluded the timings to keep `/api/audiobooks` light. A listener on chapter 3 doesn't need chapter 56's timings; they were fetched anyway.

| | |
|---|--:|
| Per timing entry | ~40–45 B JSON |
| Per chapter (~3,500 words) | ~150 KB |
| **Per open of a 56-chapter book** | **~8 MB** |

Against a 5 GB/month egress allowance, ~600 opens of one long book exhausts the month. When it did, Supabase **restricted the project** — and a restricted project does not resume when the quota period resets; it needs a manual restore. The result was a multi-week database outage.

Float precision was checked and ruled out: `sanitize_word_timings()` already rounds to 3 dp. The fix had to be *fetching less*, not compressing. Note also that Flask-Compress compresses Render → client, which isn't the metered hop.

## How it went unseen

1. **It was born as a performance fix.** Splitting karaoke arrays out of the library list made the *client* payload smaller and left the Supabase read untouched.
2. **An earlier egress fix addressed a different leak** — `/status` polling pulling the `chapters` blob every ~3 s during conversion. That fix worked and still holds, but it never looked at the listening path.
3. **It was free until people started listening.** At under one open per day a multi-MB read is noise; at ~10 opens/day the same code costs ~7× more.
4. **The cost review that should have caught it measured the wrong path** — it priced progress writes (~32 MB per heavy listener-month) and never counted the detail fetch, ~250× larger per event.

## Resolution

Timings moved out of Postgres onto Cloudinary (migration `016`, `scripts/backfill_word_timings.py`), so the detail route has nothing large left to read. Newer clients fetch one chapter's timings at a time from the CDN with a memory + disk cache; older binaries still get inline timings hydrated server-side. Full design: [word-timings storage](../subsystems/word-timings-storage.md).

The outage also changed monitoring: the endpoint previously used as a health check (`/api/feature-flags`) returned 200 every day of the outage because it never touches the database. See [deployment — uptime monitoring](../operations/deployment.md#uptime-monitoring).

## Lessons

- **Price every read on the hot path × expected volume**, not just the one being edited.
- **Name columns explicitly** on hot routes — a `select('*')` silently re-admits any large column added later.
- **Know your provider's failure mode at quota.** "Restricted until manually restored" turns a billing event into an outage.
