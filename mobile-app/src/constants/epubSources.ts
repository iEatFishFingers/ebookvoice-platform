/**
 * epubSources.ts
 * ==============
 * Curated list of LEGAL free-EPUB sources to recommend to new users
 * landing on an empty library.
 *
 * Why only legal sources:
 *  - CLAUDE.md mission ("give power back to authors") — recommending a
 *    piracy aggregator would undermine the brand position.
 *  - Apple App Store Guideline 5.2 (Intellectual Property): apps must
 *    not "facilitate illegal use of music, video, or other licensed
 *    media" — apps that direct users to piracy sources are a takedown
 *    risk.
 *
 * When adding new sources, prioritize: (1) public domain or
 * author-direct, (2) globally accessible, (3) one or two clicks to a
 * DRM-free EPUB download.
 *
 * Explicitly excluded:
 *  - OceanofPDF, Z-Library, LibGen, Anna's Archive — piracy.
 *  - Libby / Hoopla / OverDrive — legal but DRM-protected EPUBs that
 *    this app can't read. Recommending them sets false expectations.
 *
 * Single source of truth — used by LibraryScreen's empty state.
 * When we localize the empty state copy later, this is the file to
 * fork per language (or wrap with i18n).
 */

export type EpubSourceId = 'project_gutenberg' | 'standard_ebooks' | 'send_to_kindle';

export interface EpubSource {
  id: EpubSourceId;
  name: string;
  /** One-line tagline used on the card. Keep under ~40 chars for layout. */
  description: string;
  url: string;
}

export const EPUB_SOURCES: EpubSource[] = [
  {
    id: 'project_gutenberg',
    name: 'Project Gutenberg',
    description: '70,000+ free classic books',
    url: 'https://www.gutenberg.org',
  },
  {
    id: 'standard_ebooks',
    name: 'Standard Ebooks',
    description: 'Free, beautifully formatted classics',
    url: 'https://standardebooks.org',
  },
  {
    id: 'send_to_kindle',
    name: 'Send to Kindle',
    description: "Re-download books you've already bought",
    url: 'https://www.amazon.com/sendtokindle',
  },
];
