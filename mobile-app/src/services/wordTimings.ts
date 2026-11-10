import { Platform } from 'react-native';
import type { Chapter, WordTiming } from '../types';

/**
 * Per-chapter karaoke timing loader.
 *
 * Timings used to arrive inline on GET /api/audiobooks/<id> — every chapter's
 * array, on every book open. A 40-chapter book pulled 40 arrays to highlight
 * words in chapter 1. They now live on the CDN (migration 016), so we fetch
 * only the chapter being played and keep it.
 *
 * Resolution order:
 *   1. `chapter.word_timings` — a legacy row that still holds them inline
 *   2. memory cache
 *   3. on-disk cache
 *   4. the CDN
 *
 * Timings are immutable once generated — the audio they describe never changes
 * — so nothing here ever needs invalidating.
 */

const CACHE_DIR_NAME = 'word_timings';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Chapters are large once parsed (a 5,000-word chapter is thousands of
 * objects). Hold only the neighbourhood of the current chapter; disk covers
 * the rest and costs one read.
 */
const MAX_MEMORY_ENTRIES = 5;

const memoryCache = new Map<string, WordTiming[]>();
/** De-dupes concurrent loads of the same chapter (effect re-runs, prefetch). */
const inFlight = new Map<string, Promise<WordTiming[]>>();

type LegacyFileSystem = typeof import('expo-file-system/legacy');
let fileSystemPromise: Promise<LegacyFileSystem | null> | null = null;

function getFileSystem(): Promise<LegacyFileSystem | null> {
  if (Platform.OS === 'web') return Promise.resolve(null);
  if (!fileSystemPromise) {
    // Lazy, and matching DownloadContext: web builds and older dev clients
    // without the native module must degrade to memory-only, not crash.
    fileSystemPromise = import('expo-file-system/legacy')
      .then(fs => fs)
      .catch(() => {
        console.warn('[wordTimings] expo-file-system unavailable; memory cache only');
        return null;
      });
  }
  return fileSystemPromise;
}

/** Chapter ids come from the server; keep them safe to use as a filename. */
function cacheKeyFor(chapter: Chapter): string {
  return String(chapter.id ?? `pos-${chapter.position}`).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * A CDN 404 or a captive-portal login page parses as JSON perfectly happily.
 * Only an array of real timing entries counts as a hit — anything else is
 * treated as a miss so we fall through rather than cache garbage.
 */
function isValidTimings(value: unknown): value is WordTiming[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const first = value[0];
  return (
    !!first &&
    typeof first === 'object' &&
    typeof (first as WordTiming).word === 'string' &&
    typeof (first as WordTiming).start === 'number' &&
    typeof (first as WordTiming).end === 'number'
  );
}

function rememberInMemory(key: string, timings: WordTiming[]): void {
  memoryCache.set(key, timings);
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

async function readFromDisk(key: string): Promise<WordTiming[] | null> {
  const FileSystem = await getFileSystem();
  if (!FileSystem) return null;
  try {
    const path = `${FileSystem.cacheDirectory}${CACHE_DIR_NAME}/${key}.json`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(path));
    return isValidTimings(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[wordTimings] disk read failed', err);
    return null;
  }
}

async function writeToDisk(key: string, timings: WordTiming[]): Promise<void> {
  const FileSystem = await getFileSystem();
  if (!FileSystem) return;
  try {
    const dir = `${FileSystem.cacheDirectory}${CACHE_DIR_NAME}/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.writeAsStringAsync(`${dir}${key}.json`, JSON.stringify(timings));
  } catch (err) {
    // The cache directory is best-effort; the OS may reclaim it at any time.
    console.warn('[wordTimings] disk write failed', err);
  }
}

async function fetchFromCdn(url: string): Promise<WordTiming[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[wordTimings] CDN returned ${response.status} for ${url}`);
      return null;
    }
    const parsed = await response.json();
    if (!isValidTimings(parsed)) {
      console.warn('[wordTimings] CDN payload was not a timings array');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[wordTimings] CDN fetch failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one chapter's timings. Returns [] when there are none to be had —
 * the Player treats an empty array as "this chapter has no karaoke", which is
 * already a supported state (voices that emit no WordBoundary events).
 */
export async function loadWordTimings(chapter: Chapter | null | undefined): Promise<WordTiming[]> {
  if (!chapter) return [];

  // Legacy row, or a book converted before the offload: already inline.
  if (chapter.word_timings && chapter.word_timings.length > 0) {
    return chapter.word_timings;
  }

  const url = chapter.wordTimingsUrl;
  if (!url) return [];

  const key = cacheKeyFor(chapter);

  const cached = memoryCache.get(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const load = (async () => {
    const fromDisk = await readFromDisk(key);
    if (fromDisk) {
      rememberInMemory(key, fromDisk);
      return fromDisk;
    }
    const fromCdn = await fetchFromCdn(url);
    if (!fromCdn) return [];
    rememberInMemory(key, fromCdn);
    void writeToDisk(key, fromCdn);
    return fromCdn;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, load);
  return load;
}

/**
 * Warm the cache for a chapter the user is likely to reach next, so
 * auto-advance doesn't briefly show unhighlighted text. Failures are ignored.
 */
export function primeWordTimings(chapter: Chapter | null | undefined): void {
  if (!chapter?.wordTimingsUrl) return;
  if (memoryCache.has(cacheKeyFor(chapter))) return;
  void loadWordTimings(chapter).catch(() => {});
}

/** Test seam / memory-pressure hook. The on-disk cache is left alone. */
export function clearWordTimingsMemoryCache(): void {
  memoryCache.clear();
  inFlight.clear();
}
