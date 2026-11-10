-- Migration 013: self-hosted Project Gutenberg catalog
-- Run via: Supabase SQL Editor.  Safe to re-run.
--
-- Replaces the dependency on the flaky third-party Gutendex API. We ingest
-- Project Gutenberg's own `pg_catalog.csv` (~75k books) into this table with
-- scripts/ingest_gutenberg_catalog.py and serve /gutenberg/search from it.
-- EPUBs + covers are fetched straight from gutenberg.org, so search + convert
-- depend only on gutenberg.org + Supabase — never on Gutendex.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS gutenberg_books (
  id          integer PRIMARY KEY,          -- Project Gutenberg ebook id
  title       text NOT NULL,
  authors     text,                          -- "Austen, Jane, 1775-1817; ..."
  language     text,                         -- ISO code(s), e.g. "en"
  subjects    text,                          -- "; "-joined LCSH subjects
  bookshelves text,                          -- "; "-joined PG bookshelves
  issued      text,                          -- release date string
  search_text text                           -- lower(title || ' ' || authors)
);

-- Trigram indexes for fast ILIKE search + category filtering.
CREATE INDEX IF NOT EXISTS idx_gutenberg_search   ON gutenberg_books USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gutenberg_subjects ON gutenberg_books USING gin (subjects   gin_trgm_ops);

-- Public read-only catalog. The backend queries via the service-role key (which
-- bypasses RLS anyway); this policy is defensive in case of direct client reads.
ALTER TABLE gutenberg_books ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gutenberg_books are readable by everyone" ON gutenberg_books;
CREATE POLICY "gutenberg_books are readable by everyone"
  ON gutenberg_books FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON gutenberg_books TO anon, authenticated;

-- Verify after ingest:
--   SELECT count(*) FROM gutenberg_books;
--   SELECT id, title, authors FROM gutenberg_books WHERE search_text ILIKE '%sherlock%' LIMIT 5;
