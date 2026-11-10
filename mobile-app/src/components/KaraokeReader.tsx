/**
 * KaraokeReader.tsx
 * ================
 * Renders the chapter's word timing array as an interactive karaoke panel.
 *
 * Virtualisation
 * --------------
 * Words are grouped into "paragraphs" of PARA_SIZE words each.  FlatList
 * renders only the visible window (~10-15 items), so even 16 000-word
 * chapters stay light in memory.
 *
 * Smart re-render gating
 * ----------------------
 * Each paragraph is a React.memo component with a custom arePropsEqual
 * comparator.  When the active chunk changes, only the 1-2 paragraphs whose
 * word range overlaps the old or new chunk boundary actually do DOM work;
 * every other visible paragraph bails out immediately.
 *
 * Position polling
 * ----------------
 * getPosition() reads a ref inside the player — no prop changes, no parent
 * re-renders, no karaoke overhead propagated upward.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../context/ThemeContext';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  View,
  Platform,
} from 'react-native';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Words per FlatList item. */
const PARA_SIZE = 30;

/** Estimated pixel height per paragraph item (used by getItemLayout). */
const ITEM_HEIGHT = 150;

/**
 * How many word-index steps must pass before triggering a re-center scroll.
 * At ~3 words/sec, stride 8 ≈ re-center every 2–3 s in both modes.
 */
const SCROLL_STRIDE = 8;

/**
 * Legacy audiobooks (converted before the word-level backend change) stored
 * 3-word phrase chunks directly.  Detected at runtime by checking for spaces
 * in the timing entries.  These are always rendered as-is (1 entry = 1 chunk).
 */
const LEGACY_CHUNK_WORDS = 1;   // already chunked — don't re-group
const WORD_MODE_WORDS     = 1;   // highlight one word at a time
const PHRASE_MODE_WORDS   = 3;   // highlight three words at a time

const SENTENCE_END = /[.!?]/;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WordTiming {
  word: string;
  start: number; // seconds
  end: number;   // seconds
}

export interface ImageInsert {
  wordIndex: number;
  url: string;
}

interface Paragraph {
  id: number;         // = startIndex (stable key)
  startIndex: number;
  words: WordTiming[];
}

// Mixed list item — either a text paragraph or an inline image
type ListItem =
  | { type: 'para'; id: number; startIndex: number; words: WordTiming[] }
  | { type: 'img';  id: string; url: string };

interface ParagraphItemProps {
  startIndex: number;
  words: WordTiming[];
  chunkStart: number;
  chunkEnd: number;
}

interface KaraokeReaderProps {
  wordTimings: WordTiming[];
  /** Reads current audio position in seconds from a ref — never causes re-renders. */
  getPosition: () => number;
  isVisible: boolean;
  /** Incremented by the player on each seek — forces the list to snap to the new position. */
  seekToken?: number;
  /**
   * 'word'   → highlight one word at a time (default, most precise).
   * 'phrase' → highlight 3-word phrases (softer, less distracting).
   * Has no effect on legacy audiobooks that already store phrase chunks.
   */
  highlightMode?: 'word' | 'phrase';
  /** Inline images extracted from the EPUB, keyed to word positions. */
  imageInserts?: ImageInsert[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildChunks(wordTimings: WordTiming[], maxWords: number): Array<[number, number]> {
  const chunks: Array<[number, number]> = [];
  let chunkStart = 0;
  let count = 0;
  for (let i = 0; i < wordTimings.length; i++) {
    count++;
    if (SENTENCE_END.test(wordTimings[i].word) || count >= maxWords) {
      chunks.push([chunkStart, i]);
      chunkStart = i + 1;
      count = 0;
    }
  }
  if (chunkStart < wordTimings.length) {
    chunks.push([chunkStart, wordTimings.length - 1]);
  }
  return chunks;
}

// ── ParagraphItem ─────────────────────────────────────────────────────────────
//
// Custom arePropsEqual: a paragraph only re-renders when the active chunk
// range overlaps its word range (either entering or leaving).  Every other
// visible paragraph bails out immediately — the comparator is just 4 integer
// comparisons, essentially free.

const ParagraphItem = React.memo(
  ({ startIndex, words, chunkStart, chunkEnd }: ParagraphItemProps) => {
    // Theme-aware word colors.  ParagraphItem subscribes to ThemeContext so
    // it re-renders on light/dark switch — rare enough that the React.memo
    // perf benefit is unaffected for the hot path (chunk transitions).
    const { theme } = useTheme();
    const upcomingColor = theme.text + '59';   // ~35% alpha — dim but visible
    const pastColor     = theme.text + '99';   // ~60% alpha — readable history
    // Active word now sits in a filled brand-indigo pill (matches the App Store
    // ss4 mockup), so its text is white in both light and dark mode for max
    // contrast against the pill. The pill background + radius are applied inline
    // because they depend on theme; crucially we add NO padding/margin/fontSize
    // here, so the pill hugs the glyphs without reflowing the paragraph.
    // One accessible element per paragraph: without this, VoiceOver/braille
    // users face thousands of single-word elements per chapter. Grouping
    // reads ~30 words per swipe — and keeps the text reachable on a braille
    // display (deaf-blind readers follow the book through this panel).
    const paragraphText = useMemo(() => words.map(w => w.word).join(' '), [words]);
    return (
      <View style={styles.paragraph} accessible accessibilityLabel={paragraphText}>
        {words.map((timing, localIdx) => {
          const gi = startIndex + localIdx;
          const isActive = chunkStart >= 0 && gi >= chunkStart && gi <= chunkEnd;
          const isPast = gi < chunkStart;
          const color = isActive ? '#ffffff' : isPast ? pastColor : upcomingColor;
          return (
            <Text
              key={localIdx}
              style={[
                styles.word,
                { color },
                isActive && [styles.wordActive, { backgroundColor: theme.primary }],
              ]}
            >
              {timing.word}{' '}
            </Text>
          );
        })}
      </View>
    );
  },
  (prev, next) => {
    // Same chunk — nothing changed for any paragraph.
    if (prev.chunkStart === next.chunkStart && prev.chunkEnd === next.chunkEnd) return true;
    const paraLast = prev.startIndex + prev.words.length - 1;
    const oldOverlaps = prev.chunkEnd >= prev.startIndex && prev.chunkStart <= paraLast;
    const newOverlaps = next.chunkEnd >= prev.startIndex && next.chunkStart <= paraLast;
    // arePropsEqual=true → skip re-render; false → re-render
    return !oldOverlaps && !newOverlaps;
  },
);

// ── KaraokeReader ─────────────────────────────────────────────────────────────

/** Estimated pixel height for an inline image item. */
const IMAGE_ITEM_HEIGHT = 220;

const ImageItem = React.memo(({ url }: { url: string }) => (
  <View style={styles.imageContainer} accessible accessibilityRole="image" accessibilityLabel="Illustration from the book">
    <Image
      source={{ uri: url }}
      style={styles.inlineImage}
      resizeMode="contain"
    />
  </View>
));

export default function KaraokeReader({
  wordTimings,
  getPosition,
  isVisible,
  seekToken,
  highlightMode = 'word',
  imageInserts = [],
}: KaraokeReaderProps) {
  const { theme } = useTheme();
  const flatListRef = useRef<FlatList<ListItem>>(null);
  const containerHeightRef = useRef(500); // measured on layout; default safe value
  const contentHeightRef = useRef(0);    // actual FlatList content height from onContentSizeChange

  // Active chunk boundaries — written by the interval, read by renderItem.
  const chunkStartRef = useRef(-1);
  const chunkEndRef = useRef(-1);
  // Tracks which SCROLL_STRIDE bucket was last scrolled-to; -1 = never.
  const lastScrollKeyRef = useRef(-1);
  // True when a corrective snap should fire on the next onContentSizeChange.
  // Needed because FlatList content hasn't rendered yet when the initial tick()
  // fires, so contentHeightRef is 0 and the first scroll offset undershoots.
  const pendingSnapRef = useRef(false);

  // Changing extraData makes FlatList call renderItem for all visible items,
  // but the ParagraphItem memo then gates actual DOM work to 1-2 items.
  const [extraData, setExtraData] = useState({ cs: -1, ce: -1 });

  // ── Determine chunk size ───────────────────────────────────────────────────
  // Legacy audiobooks (pre-word-level backend) stored 3-word phrase chunks.
  // Detect them by checking for spaces in the timing entries; if found, treat
  // each entry as its own chunk (already grouped).
  // New audiobooks store one word per entry — apply the user's highlightMode.
  const maxChunkWords = useMemo(() => {
    const sample = wordTimings.slice(0, Math.min(20, wordTimings.length));
    const isLegacyChunkFormat = sample.some(t => t.word.includes(' '));
    if (isLegacyChunkFormat) return LEGACY_CHUNK_WORDS;
    return highlightMode === 'phrase' ? PHRASE_MODE_WORDS : WORD_MODE_WORDS;
  }, [wordTimings, highlightMode]);

  // ── Pre-computed structures (rebuild only when wordTimings / imageInserts changes) ──
  const paragraphs = useMemo<Paragraph[]>(() => {
    const result: Paragraph[] = [];
    for (let i = 0; i < wordTimings.length; i += PARA_SIZE) {
      result.push({ id: i, startIndex: i, words: wordTimings.slice(i, i + PARA_SIZE) });
    }
    return result;
  }, [wordTimings]);

  // Mixed list: paragraph items interleaved with image items.
  // Images are inserted after the paragraph whose word range contains their wordIndex.
  const listItems = useMemo<ListItem[]>(() => {
    if (!imageInserts.length) {
      return paragraphs.map(p => ({ type: 'para' as const, ...p }));
    }

    // Map each image to the paragraph index it belongs after
    const imgsByPara = new Map<number, ImageInsert[]>();
    for (const img of imageInserts) {
      const paraIdx = Math.floor(img.wordIndex / PARA_SIZE);
      const bucket = imgsByPara.get(paraIdx) ?? [];
      bucket.push(img);
      imgsByPara.set(paraIdx, bucket);
    }

    const items: ListItem[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      items.push({ type: 'para', id: p.id, startIndex: p.startIndex, words: p.words });
      const imgs = imgsByPara.get(i);
      if (imgs) {
        for (const img of imgs) {
          items.push({ type: 'img', id: `img-${i}-${img.url}`, url: img.url });
        }
      }
    }
    return items;
  }, [paragraphs, imageInserts]);

  // Cumulative offsets for getItemLayout — O(1) lookup per index
  const itemOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const item of listItems) {
      offsets.push(acc);
      acc += item.type === 'img' ? IMAGE_ITEM_HEIGHT : ITEM_HEIGHT;
    }
    offsets.push(acc); // total height sentinel
    return offsets;
  }, [listItems]);

  const { chunks, wordToChunk } = useMemo(() => {
    const ch = buildChunks(wordTimings, maxChunkWords);
    const map = new Int32Array(wordTimings.length).fill(-1);
    ch.forEach(([s, e], ci) => {
      for (let i = s; i <= e; i++) map[i] = ci;
    });
    return { chunks: ch, wordToChunk: map };
  }, [wordTimings, maxChunkWords]);

  // ── Internal position polling ─────────────────────────────────────────────
  useEffect(() => {
    if (!isVisible || !wordTimings.length) return;

    // Reset state when the chapter's word list changes OR when a seek happens.
    // Resetting lastScrollKeyRef ensures the FlatList scrolls to the new position
    // even when the seek lands in the same SCROLL_STRIDE bucket it was already in.
    chunkStartRef.current = -1;
    chunkEndRef.current = -1;
    lastScrollKeyRef.current = -1;

    // The first scroll after a seek or chapter change snaps instantly to center
    // so the user immediately sees where they are. Subsequent scrolls during
    // normal playback animate smoothly to keep the highlighted phrase centered.
    let snapNext = true;

    const tick = () => {
      const pos = getPosition();

      // Binary search O(log n)
      let lo = 0, hi = wordTimings.length - 1, wordIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = wordTimings[mid];
        if (pos >= t.start && pos <= t.end) { wordIdx = mid; break; }
        if (pos > t.end) { wordIdx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (wordIdx < 0) return;

      const ci = wordToChunk[wordIdx];
      if (ci < 0) return;
      const [cs, ce] = chunks[ci];

      if (cs === chunkStartRef.current && ce === chunkEndRef.current) return;

      chunkStartRef.current = cs;
      chunkEndRef.current = ce;
      setExtraData({ cs, ce });

      // Re-center every SCROLL_STRIDE chunks so the highlighted phrase stays
      // visible near the middle of the reader even during long paragraphs.
      // Snap (animated=false) on the first scroll after a seek/chapter change;
      // smooth animation for normal playback.
      const scrollKey = Math.floor(cs / SCROLL_STRIDE);
      if (scrollKey !== lastScrollKeyRef.current) {
        lastScrollKeyRef.current = scrollKey;
        const isSnap = snapNext;
        snapNext = false;
        // Proportional scroll: maps the active chunk's position in the word
        // array to an offset in the actual rendered content, then adjusts so
        // the active line lands at the vertical center of the container.
        // Uses measured content height (onContentSizeChange) for accuracy;
        // falls back to ITEM_HEIGHT estimate before the first measure fires.
        const totalContent = contentHeightRef.current || listItems.length * ITEM_HEIGHT;
        const fraction = wordTimings.length > 1 ? cs / (wordTimings.length - 1) : 0;
        const offset = Math.max(
          0,
          fraction * totalContent - containerHeightRef.current * 0.5,
        );
        flatListRef.current?.scrollToOffset({ offset, animated: !isSnap });
      }
    };

    // rAF loop: runs at display refresh rate (~60 fps) so highlights land within
    // one frame (~16 ms) of the word boundary rather than up to 100 ms late.
    // Most frames are cheap no-ops (binary search + two integer comparisons).
    let rafId: number;
    const loop = () => {
      tick();
      rafId = requestAnimationFrame(loop);
    };
    // Fire once immediately so the view snaps on seek without waiting for rAF.
    tick();
    // Request a corrective snap once onContentSizeChange fires with the real
    // content height — the tick() above may have used 0 (FlatList not yet laid out).
    pendingSnapRef.current = true;
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isVisible, wordTimings, getPosition, wordToChunk, chunks, maxChunkWords, seekToken, listItems]);

  // ── FlatList callbacks ────────────────────────────────────────────────────

  // Stable renderItem — handles both paragraph and image list items.
  const renderItem = useCallback(({ item }: { item: ListItem }) => {
    if (item.type === 'img') {
      return <ImageItem url={item.url} />;
    }
    return (
      <ParagraphItem
        startIndex={item.startIndex}
        words={item.words}
        chunkStart={chunkStartRef.current}
        chunkEnd={chunkEndRef.current}
      />
    );
  }, []);

  const keyExtractor = useCallback((item: ListItem) => String(item.id), []);

  // getItemLayout uses precomputed cumulative offsets for O(1) lookup.
  // Image items use IMAGE_ITEM_HEIGHT; paragraph items use ITEM_HEIGHT.
  const getItemLayout = useCallback(
    (_: any, index: number) => {
      const item = listItems[index];
      const length = item?.type === 'img' ? IMAGE_ITEM_HEIGHT : ITEM_HEIGHT;
      return { length, offset: itemOffsets[index] ?? 0, index };
    },
    [listItems, itemOffsets],
  );

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const totalContent = contentHeightRef.current || listItems.length * ITEM_HEIGHT;
      const fraction = listItems.length > 1 ? info.index / (listItems.length - 1) : 0;
      const offset = Math.max(0, fraction * totalContent - containerHeightRef.current * 0.5);
      flatListRef.current?.scrollToOffset({ offset, animated: false });
    },
    [listItems.length],
  );

  if (!isVisible || !wordTimings.length) return null;

  return (
    <View style={[styles.wrapper, { backgroundColor: theme.background }]} onLayout={(e) => { containerHeightRef.current = e.nativeEvent.layout.height; }}>
      <FlatList
        ref={flatListRef}
        data={listItems}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        getItemLayout={getItemLayout}
        onScrollToIndexFailed={onScrollToIndexFailed}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        onContentSizeChange={(_w, h) => {
          contentHeightRef.current = h;
          // Fire the corrective snap now that we have the real content height.
          if (pendingSnapRef.current && chunkStartRef.current >= 0) {
            pendingSnapRef.current = false;
            const cs = chunkStartRef.current;
            const fraction = wordTimings.length > 1 ? cs / (wordTimings.length - 1) : 0;
            const offset = Math.max(0, fraction * h - containerHeightRef.current * 0.5);
            flatListRef.current?.scrollToOffset({ offset, animated: false });
          }
        }}
        maxToRenderPerBatch={5}
        updateCellsBatchingPeriod={100}
        windowSize={5}
        initialNumToRender={8}
      />
      <View style={[styles.fadeTop, { backgroundColor: theme.background + 'D9' }]} pointerEvents="none" />
      <View style={[styles.fadeBottom, { backgroundColor: theme.background + 'D9' }]} pointerEvents="none" />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    // backgroundColor applied inline from theme.background (see render) so the
    // panel is light in light mode and dark in dark mode.
    position: 'relative',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 120,
  },
  paragraph: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    minHeight: ITEM_HEIGHT,
    alignContent: 'flex-start',
  },
  word: {
    fontSize: 18,
    lineHeight: 34,
    // `color` intentionally omitted — applied per-instance from theme so
    // light mode shows dark words on light bg.  See ParagraphItem.
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  // wordPast and wordActive's *color* now also live on ParagraphItem's
  // inline style.  wordActive keeps its fontWeight bump here.
  wordActive: {
    fontWeight: '700',
    borderRadius: 6,
    // backgroundColor (brand indigo) is applied inline from theme.primary.
    // No fontSize/padding change — the pill hugs the glyphs so the paragraph
    // never reflows on highlight. No textShadow — iOS renders blur shadows via
    // Core Graphics; very expensive when many words activate/deactivate per second.
  },
  fadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 32,
    // backgroundColor applied inline from theme.background (~85% alpha).
    pointerEvents: 'none',
  },
  fadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 64,
    // backgroundColor applied inline from theme.background (~85% alpha).
    pointerEvents: 'none',
  },
  imageContainer: {
    width: '100%',
    height: IMAGE_ITEM_HEIGHT,
    marginVertical: 12,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineImage: {
    width: '100%',
    height: IMAGE_ITEM_HEIGHT,
  },
});
