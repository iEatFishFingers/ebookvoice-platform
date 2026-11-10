# Discover — the self-hosted public-domain catalog

`BookSearchScreen` + `BookDetailScreen` let a new user find and convert a public-domain book without owning an EPUB. It exists because the most common reason a new user never converted anything was simply *having no file to upload*.

## The catalog is self-hosted

An early version used the third-party Gutendex API, which went down mid-build. The catalog is now self-hosted:

- `scripts/ingest_gutenberg_catalog.py` downloads Project Gutenberg's own `pg_catalog.csv` (~75k books) into the **`gutenberg_books`** table (`supabase/migrations/013_gutenberg_catalog.sql`). Re-running it refreshes the catalog.
- `GET /gutenberg/search` (`?q=` or `?topic=`) queries `gutenberg_books` (ILIKE on `search_text` / `subjects`) and returns the `GutenbergBook` shape directly.

The only runtime dependencies are gutenberg.org and the project's own database.

## The convert path and the source-lock

`/extract-gutenberg` takes a **numeric book id** and fetches the EPUB **server-side** from a deterministic gutenberg.org path (host-checked; tries `/cache/epub/{id}/pg{id}-images.epub` and fallbacks), then hands chapters to the normal LanguageSelection → voice → `/convert-chapters` flow.

**The client never supplies a URL.** That source-lock guarantees only public-domain material enters through this path — a client-supplied URL parameter would turn it into a general-purpose fetch-and-narrate proxy.

## Effect

Measured on first-time users before and after Discover shipped:

| | Before | After |
|---|--:|--:|
| Got a book in hand | 27% | 52% |
| Played any audio | 20% | 62% |
| Heard the sample book | 7% | 38% |

## Other entry points

- **Upload formats:** EPUB, Word `.docx`, and DAISY `.zip` (parsers in `security/`).
- **Shared sample book:** new and anonymous users get a pre-converted sample in their library from first launch (migration `014`). See the shared-row caveat in [known limitations](../known-limitations.md).

## BookShare (dormant)

An integration with BookShare (an accessible-books library for print-disabled readers) was built and then disabled for lack of a partner API key. It sits behind a `bookshare_enabled` flag; migration `015_bookshare_tokens.sql` creates its table, which is unused.

## Related

- [Paywall & credits](paywall-and-credits.md) — the credit a conversion consumes
- [Multi-language](multilanguage.md) — the LanguageSelection step after Discover
