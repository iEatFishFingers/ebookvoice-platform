"""
ingest_gutenberg_catalog.py
===========================
Populate the self-hosted Project Gutenberg catalog.

Downloads Project Gutenberg's own `pg_catalog.csv` (~75k books, always up even
when the third-party Gutendex API is down) and upserts the EPUB-having text
books into the Supabase `gutenberg_books` table (see migration 013). The
backend then serves /gutenberg/search from this table instead of Gutendex.

Run once to populate, then periodically (e.g. weekly cron) to stay fresh.

Usage:
    python scripts/ingest_gutenberg_catalog.py

Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env (same as the backend).
"""
import os
import sys
import csv
import tempfile

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
URL = os.environ.get('SUPABASE_URL')
KEY = os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_KEY')
if not URL or not KEY:
    sys.exit('[ERROR] SUPABASE_URL + SUPABASE_SERVICE_KEY required in .env')
sb = create_client(URL, KEY)

CATALOG_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv'
BATCH = 500


def main():
    print('[1/3] downloading pg_catalog.csv from gutenberg.org ...')
    with tempfile.NamedTemporaryFile(mode='wb', suffix='.csv', delete=False) as tmp:
        path = tmp.name
        r = requests.get(CATALOG_URL, timeout=180, stream=True)
        r.raise_for_status()
        for chunk in r.iter_content(chunk_size=1 << 16):
            tmp.write(chunk)

    print('[2/3] parsing + upserting (Text books with EPUBs only) ...')
    batch, total = [], 0
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            # Only "Text" entries have EPUBs (skip Sound/Dataset/etc.).
            if (row.get('Type') or '').strip() != 'Text':
                continue
            try:
                bid = int(row['Text#'])
            except (ValueError, KeyError, TypeError):
                continue
            title = (row.get('Title') or '').strip()
            if not title:
                continue
            authors = (row.get('Authors') or '').strip()
            batch.append({
                'id': bid,
                'title': title[:1000],
                'authors': authors[:1000],
                'language': (row.get('Language') or '').strip()[:50],
                'subjects': (row.get('Subjects') or '').strip(),
                'bookshelves': (row.get('Bookshelves') or '').strip(),
                'issued': (row.get('Issued') or '').strip()[:50],
                'search_text': f'{title} {authors}'.lower()[:2000],
            })
            if len(batch) >= BATCH:
                sb.table('gutenberg_books').upsert(batch).execute()
                total += len(batch)
                print(f'    upserted {total} ...', end='\r', flush=True)
                batch = []
    if batch:
        sb.table('gutenberg_books').upsert(batch).execute()
        total += len(batch)

    os.unlink(path)
    print(f'\n[3/3] done — {total} books now in gutenberg_books.')


if __name__ == '__main__':
    main()
