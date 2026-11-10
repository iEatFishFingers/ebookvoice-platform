import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  Image,
  ActivityIndicator,
  Modal,
  FlatList,
  Platform,
  Alert,
  Share,
  Dimensions,
  AppState,
  AppStateStatus,
  AccessibilityInfo,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import TutorialTooltip from '../components/TutorialTooltip';
import { useRoute, RouteProp, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RootStackParamList, Audiobook } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { createAudioPlayer, enableAudio, AudioPlayerInterface, NowPlayingMetadata } from '../utils/audioPlayer';
import { ensureFeatureFlags } from '../services/featureFlags';
import { throttle } from 'lodash';
import apiService from '../services/api';
import { track } from '../services/analytics';
import { setRemoteChapterHandlers } from '../services/remoteChapterCommands';
import { loadWordTimings, primeWordTimings } from '../services/wordTimings';
// Author Pro features
import KaraokeReader, { WordTiming } from '../components/KaraokeReader';
import { FOLLOW_ALONG_MODE_KEY } from './SettingsScreen';
import { useDownload } from '../context/DownloadContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ── Progress-sync cadence ──────────────────────────────────────────────────
// These MUST be throttle intervals, not debounce waits.  onPlaybackStatusUpdate
// fires every 250 ms during playback; a lodash `debounce` restarts its timer on
// every call, so a debounce called faster than its wait NEVER invokes.  That was
// the live bug: 4 h 18 m of driving on 2026-08-10 produced 18 saves, all of them
// landing only in accidental gaps in the status stream, and 1 h 52 m of listening
// recorded 3.4 seconds of position.  `throttle` guarantees an invocation every
// interval regardless of how often it's called.
const PROGRESS_SYNC_INTERVAL_MS = 10000;       // server write cadence
const LOCAL_PROGRESS_SYNC_INTERVAL_MS = 5000;  // AsyncStorage cache (cheap, keep fresher)
// Below this, a position change isn't worth a write.
const PROGRESS_MIN_DELTA_S = 1;
// How long to wait for the server's bookmark before falling back to the local
// cache. The audio load costs more than this, so it's effectively free.
const RESUME_FETCH_TIMEOUT_MS = 2500;

// Playback speed steps.  3x is the ceiling: on iOS both backends run through
// AVAudioTimePitchAlgorithm.timeDomain, Apple's voice-tuned stretcher, and past
// 3x TTS speech stops being intelligible before the algorithm gives out.  The
// VoiceOver audience listens fast — 2x was a stated deal breaker.
const PLAYBACK_SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
// Last-used speed, remembered across books and launches.
const PLAYBACK_SPEED_KEY = '@playback_speed';

type PlayerScreenRouteProp = RouteProp<RootStackParamList, 'Player'>;
type PlayerScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Player'>;

const PlayerScreen = () => {
  const route = useRoute<PlayerScreenRouteProp>();
  const navigation = useNavigation<PlayerScreenNavigationProp>();
  const { audiobookId, initialChapter, autoPlay } = route.params;
  const { theme } = useTheme();
  const { isAnonymous } = useAuth();
  // Anonymous users live under AnonymousMain (no Home tab) — navigating to
  // 'Main' would no-op, leaving them stuck on the Player with no way back.
  const libraryRoot = isAnonymous ? 'AnonymousMain' : 'Main';
  const { getDownloadState, downloadAudiobook } = useDownload();

  const [audiobook, setAudiobook] = useState<Audiobook | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  // Mirror of playbackSpeed for the async player-creation path, which may run
  // before or after the stored preference resolves.
  const playbackSpeedRef = useRef(1.0);
  const [loading, setLoading] = useState(true);
  const [isSeeking, setIsSeeking] = useState(false);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(initialChapter || 0);
  const [showChapterList, setShowChapterList] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const soundRef = useRef<AudioPlayerInterface | null>(null);
  const isAutoPlayingRef = useRef(false);
  const isAdvancingChapterRef = useRef(false);
  const chapterLoadTimeRef = useRef(0);
  const audioLoadedRef = useRef(false);
  const audiobookRef = useRef<Audiobook | null>(null);
  const currentChapterRef = useRef(initialChapter || 0);
  const isSeekingRef = useRef(false);
  // True only between a real touch-down and touch-up on the slider.  A value
  // change that arrives outside that window came from VoiceOver (swipe up /
  // down on the native UISlider) or a keyboard, which never fire
  // onSlidingStart / onSlidingComplete — so those seeks are issued from
  // onValueChange instead, coalesced through this timer.
  const sliderTouchActiveRef = useRef(false);
  const assistiveSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationRef = useRef(0);
  const lastSyncedPositionRef = useRef(0);
  const isPlayingRef = useRef(false);
  // Fire audiobook_played once per player session, the first time playback starts.
  const playTrackedRef = useRef(false);
  // First-launch first-listen: fire the auto-play exactly once, and never when
  // a screen reader is active (VoiceOver users get the manual play button so
  // audio doesn't fight their screen reader).
  const autoPlayFiredRef = useRef(false);

  // ── Author Pro: reading mode ───────────────────────────────────────────
  // 'cover'  → default cover art view
  // 'follow' → karaoke highlighted sync text
  // 'read'   → plain scrollable text (no highlights)
  const [readingMode, setReadingMode] = useState<'cover' | 'follow' | 'read'>('cover');
  const [currentWordTimings, setCurrentWordTimings] = useState<WordTiming[]>([]);
  const [seekToken, setSeekToken] = useState(0);

  // Follow-along is free for everyone now — no paywall, no trial tracking.
  const [followAlongMode, setFollowAlongMode] = useState<'word' | 'phrase'>('word');

  // ── Plain-text read mode scroll refs ──────────────────────────────────
  const plainTextScrollRef = useRef<ScrollView>(null);
  const readingModeToggleRef = useRef<View>(null);
  const plainTextContentHeightRef = useRef(0);
  // Current playback time, read via ref so karaoke/analytics never re-render.
  const currentTimeRef = useRef(0);

  // Interpolation state: lets getPosition() estimate current time between
  // 250 ms status-callback ticks by extrapolating with wall-clock elapsed time.
  // Stored in a ref so karaoke never causes PlayerScreen re-renders.
  const positionStateRef = useRef({ time: 0, wallClock: 0, isPlaying: false, rate: 1 });

  const getPosition = useCallback(() => {
    const s = positionStateRef.current;
    if (!s.isPlaying || s.wallClock === 0) return s.time;
    const elapsed = (Date.now() - s.wallClock) / 1000;
    return s.time + elapsed * s.rate;
  }, []);
  // Write straight through to the server, bypassing the throttle.  Used for the
  // moments where "within 10 seconds" isn't good enough because there may be no
  // next callback at all: app going to background (iOS can suspend or terminate
  // us without warning), leaving the Player, and chapter changes.
  const writeProgressNow = async (
    bookId: string,
    position: number,
    chapter: number,
    explicitSeek = false,
  ) => {
    try {
      await apiService.updateProgress(bookId, position, chapter, explicitSeek);
      lastSyncedPositionRef.current = position;
    } catch (error) {
      console.error('Error syncing progress:', error);
    }
  };

  // Throttled database sync — guaranteed to land every PROGRESS_SYNC_INTERVAL_MS
  // of continuous playback.  See the constant's comment for why this is not a debounce.
  const syncProgressToDatabase = useRef(
    throttle(async (bookId: string, position: number, chapter: number) => {
      try {
        await apiService.updateProgress(bookId, position, chapter);
        lastSyncedPositionRef.current = position;
      } catch (error) {
        console.error('Error syncing progress:', error);
      }
    }, PROGRESS_SYNC_INTERVAL_MS, { leading: false, trailing: true })
  ).current;

  // Throttled local AsyncStorage sync (offline resume + crash recovery).
  const syncLocalProgress = useRef(
    throttle(async (bookId: string, position: number, chapter: number) => {
      try {
        const library = await AsyncStorage.getItem('audiobook_library');
        if (library) {
          const libraryData = JSON.parse(library);
          const bookIndex = libraryData.findIndex((b: Audiobook) => String(b.id) === String(bookId));
          if (bookIndex !== -1) {
            libraryData[bookIndex].currentPosition = position;
            libraryData[bookIndex].currentChapter = chapter;
            await AsyncStorage.setItem('audiobook_library', JSON.stringify(libraryData));
          }
        }
      } catch (error) {
        console.error('Error updating local progress:', error);
      }
    }, LOCAL_PROGRESS_SYNC_INTERVAL_MS, { leading: false, trailing: true })
  ).current;

  // Persist wherever we are right now, immediately and unconditionally.
  // Cancels the in-flight throttles first so a stale queued position can't
  // land after this write and undo it.
  const persistProgressNow = useCallback((explicitSeek = false) => {
    if (!audioLoadedRef.current) return;
    const position = currentTimeRef.current;
    const chapter = currentChapterRef.current;
    if (!Number.isFinite(position) || position < 0) return;
    // Nothing new to say — skip the round-trip.  Also dedupes the
    // inactive→background pair iOS fires when backgrounding.
    if (Math.abs(position - lastSyncedPositionRef.current) < PROGRESS_MIN_DELTA_S && !explicitSeek) return;
    syncProgressToDatabase.cancel();
    syncLocalProgress.cancel();
    void writeProgressNow(audiobookId, position, chapter, explicitSeek);
    void syncLocalProgress(audiobookId, position, chapter);
    syncLocalProgress.flush();
  }, [audiobookId]);

  // Load audiobook data and setup audio
  useEffect(() => {
    loadAudiobook();
    return () => {
      // Sample-engagement telemetry: on leaving the Player for the first-launch
      // demo book, report how far the user actually listened. This is the core
      // "are new users engaging?" signal for the instant-first-listen direction.
      // Read from refs (stable across unmount) BEFORE unloading the audio.
      const bk = audiobookRef.current;
      if (bk?.isDemo) {
        const listened = Math.max(0, Math.round(getPosition()));
        const total = Math.round(durationRef.current || 0);
        track('sample_listened', {
          audiobook_id: bk.id,
          seconds_listened: listened,
          duration_seconds: total,
          percent_complete: total > 0 ? Math.round((listened / total) * 100) : 0,
          completed: total > 0 && listened >= total - 2,
          played: playTrackedRef.current,
        });
      }
      // Force a final sync BEFORE unloading the audio.  Read straight from the
      // refs rather than flushing the throttles: `flush()` only fires if a call
      // is actually pending, so a player left paused for longer than the
      // throttle window would otherwise unmount with nothing queued and lose
      // everything since the last write.
      const finalPosition = currentTimeRef.current;
      if (audioLoadedRef.current && Number.isFinite(finalPosition) && finalPosition > 0) {
        syncProgressToDatabase.cancel();
        syncLocalProgress.cancel();
        void writeProgressNow(audiobookId, finalPosition, currentChapterRef.current);
        void syncLocalProgress(audiobookId, finalPosition, currentChapterRef.current);
        syncLocalProgress.flush();
      }

      // Cleanup audio on unmount
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, [audiobookId]);

  // Keep refs in sync so the onPlaybackStatusUpdate callback can access latest values
  // (the callback is set once and would otherwise capture stale closure values)
  useEffect(() => { audiobookRef.current = audiobook; }, [audiobook]);
  useEffect(() => { isSeekingRef.current = isSeeking; }, [isSeeking]);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // ── Karaoke: invalidate the interpolation anchor while backgrounded ─────
  // The rAF loop that drives KaraokeReader is paused by the OS while the app
  // is in the background.  RNTP keeps audio playing but the wallClock anchor
  // doesn't advance.  When the user returns, the first rAF tick computes
  // `time + (Date.now() - wallClock) * rate` — which can extrapolate minutes
  // into the future and snap karaoke to the last word of the chapter for
  // one frame before the next status callback corrects it.  Setting
  // `wallClock = 0` triggers getPosition()'s short-circuit to return the
  // cached `time` until the next status tick.
  //
  // This is also the last reliable moment to save.  Once iOS suspends or
  // terminates the app there is no further callback, and swipe-to-close from
  // the app switcher happens while already backgrounded — so persisting here
  // is what makes "close the app and come back" keep your place.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        positionStateRef.current = { ...positionStateRef.current, wallClock: 0 };
        persistProgressNow();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [persistProgressNow]);

  // ── Author Pro: load follow-along highlight preference ────────────────
  useEffect(() => {
    AsyncStorage.getItem(FOLLOW_ALONG_MODE_KEY).then(val => {
      if (val === 'phrase') setFollowAlongMode('phrase');
    });
  }, []);

  // ── Restore the last-used playback speed ───────────────────────────────
  // A heavy listener sets 2.5x once and expects every book to open at 2.5x.
  // If the player already exists (this resolved after creation) apply it
  // directly; otherwise player creation reads playbackSpeedRef.
  useEffect(() => {
    AsyncStorage.getItem(PLAYBACK_SPEED_KEY).then(val => {
      const stored = val ? parseFloat(val) : NaN;
      if (!PLAYBACK_SPEEDS.includes(stored) || stored === 1.0) return;
      playbackSpeedRef.current = stored;
      setPlaybackSpeed(stored);
      positionStateRef.current = { ...positionStateRef.current, rate: stored };
      soundRef.current?.setRateAsync(stored, true).catch(() => {});
    }).catch(() => {});
  }, []);

  // ── Scroll plain-text reader to current audio position on entry ────────
  useEffect(() => {
    if (readingMode !== 'read' || !currentWordTimings.length) return;
    // Find which word index corresponds to the current audio position
    const pos = getPosition();
    let lo = 0, hi = currentWordTimings.length - 1, wordIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = currentWordTimings[mid];
      if (pos >= t.start && pos <= t.end) { wordIdx = mid; break; }
      if (pos > t.end) { wordIdx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const fraction = currentWordTimings.length > 1 ? wordIdx / (currentWordTimings.length - 1) : 0;
    // Delay briefly so the ScrollView has rendered and content height is known
    setTimeout(() => {
      const h = plainTextContentHeightRef.current;
      if (h > 0 && plainTextScrollRef.current) {
        const offset = Math.max(0, fraction * h - 200);
        plainTextScrollRef.current.scrollTo({ y: offset, animated: false });
      }
    }, 80);
  }, [readingMode, currentWordTimings]);

  // ── Author Pro: load word timings + image inserts for the current chapter ──
  const [currentImageInserts, setCurrentImageInserts] = useState<
    Array<{ wordIndex: number; url: string }>
  >([]);

  useEffect(() => {
    const book = audiobookRef.current ?? audiobook;
    const chapter = book?.chapters?.[currentChapterIndex];

    // Inline and cheap — apply synchronously.
    setCurrentImageInserts(chapter?.imageInserts ?? []);

    // Drop the outgoing chapter's words right away. Leaving them up while the
    // next chapter's timings resolve would highlight the wrong text against
    // the new audio. Legacy rows still carry them inline, so those show with
    // no gap at all.
    setCurrentWordTimings(chapter?.word_timings ?? []);

    // Timings now live on the CDN and are fetched a chapter at a time, so this
    // is async — and a fast chapter skip can land a stale response after a
    // newer chapter is already playing. `cancelled` drops those.
    let cancelled = false;
    void loadWordTimings(chapter).then(timings => {
      if (cancelled) return;
      console.log(
        '[Follow] ch', currentChapterIndex,
        '| timings:', timings.length ? `${timings.length} entries` : 'NONE',
        '| book.chapters:', book?.chapters?.length ?? 'no chapters',
        '| source:', chapter?.word_timings?.length ? 'inline' : (chapter?.wordTimingsUrl ? 'cdn' : 'none'),
      );
      setCurrentWordTimings(timings);
      // Warm the next chapter so auto-advance doesn't flash unhighlighted text.
      primeWordTimings(book?.chapters?.[currentChapterIndex + 1]);
    });
    // NOTE: currentTimeRef is deliberately NOT reset here. This effect also
    // runs whenever `audiobook` changes — including when the background
    // full-detail fetch resolves a second after entry — and zeroing the ref
    // then would wipe a freshly restored position. Anything reading the ref in
    // that window (a progress write on backgrounding, the is_first_play flag)
    // would see 0 and report the user at the start of a book they're hours
    // into. The reset belongs with the actual chapter swap, in loadChapter().
    return () => {
      cancelled = true;
    };
  }, [currentChapterIndex, audiobook]);

  // Load new chapter when chapter index changes (manual selection from the
  // chapter list, or a lock-screen / CarPlay chapter skip).
  // Does NOT depend on audiobook — only on currentChapterIndex
  useEffect(() => {
    // Skip until the initial audio load is done (loadAudiobook handles first load)
    if (!audioLoadedRef.current) {
      return;
    }

    // Keep the imperative chapter ref aligned with state on EVERY path that
    // changes the chapter.  onPlaybackStatusUpdate (progress writes),
    // handleNextChapter (auto-advance target) and buildMetadata (lock-screen
    // title) all read this ref.  It used to be set only by loadAudiobook and
    // handleNextChapter, so picking a chapter from the list left it pointing at
    // the OLD chapter: progress saved against the wrong chapter, and the next
    // auto-advance computed `oldChapter + 1` and jumped backwards — the
    // "it repeats a chapter I didn't ask it to" bug.
    currentChapterRef.current = currentChapterIndex;

    // Skip if we're auto-playing (handleNextChapter handles it directly)
    if (isAutoPlayingRef.current) {
      isAutoPlayingRef.current = false;
      return;
    }

    const book = audiobookRef.current;
    if (book?.chapters && book.chapters.length > currentChapterIndex) {
      const chapter = book.chapters[currentChapterIndex];
      const dlState = getDownloadState(book.id);
      const localPath = dlState.localChapterPaths?.[currentChapterIndex];
      const audioUri = localPath ?? (chapter.audioUrl?.startsWith('http') ? chapter.audioUrl : null);
      if (audioUri) {
        console.log('Manual chapter selection, loading chapter:', currentChapterIndex + 1, localPath ? '(local)' : '(remote)');
        // autoPlay: true — choosing a chapter is a request to hear it.  This
        // used to load paused, so the chapter list (and now the lock-screen
        // skip buttons) produced silence until the user found Play again.
        loadChapter(audioUri, true, {
          title: chapter.title || book.title || 'EbookVoice',
          artist: book.title || 'EbookVoice',
          artwork: book.coverUrl || undefined,
        });
      } else {
        console.error('Invalid chapter audio URL:', chapter.audioUrl);
      }
    }
  }, [currentChapterIndex]);

  // Check bookmark status when chapter changes
  useEffect(() => {
    if (audiobook) {
      checkBookmarkStatus();
    }
  }, [currentChapterIndex, audiobook]);


  // Build the now-playing metadata for a given book + chapter index.
  // Used by every setupAudio / loadChapter call so the lock-screen card
  // shows real chapter title + book title + cover instead of "EbookVoice".
  const buildMetadata = (book: Audiobook | null | undefined, chapterIndex: number): NowPlayingMetadata => ({
    title: book?.chapters?.[chapterIndex]?.title || book?.title || 'EbookVoice',
    artist: book?.title || 'EbookVoice',
    artwork: book?.coverUrl || undefined,
  });

  /**
   * Resolve where to resume from, consulting both the server and the local
   * AsyncStorage cache and taking whichever is FURTHER through the book.
   *
   * Neither source is reliably authoritative on its own.  The cache is written
   * by a throttled sync and gets overwritten wholesale by `syncLibrary()`, so
   * it can trail the server and knows nothing about listening done on another
   * device.  But the server can also trail the cache — a write that failed on a
   * flaky connection leaves the phone ahead of the row.  Taking the maximum
   * means neither a stale cache nor a missed write can ever hand the user back
   * time they already listened to, which is the failure we're fixing.
   *
   * Only waits a beat for the network: the audio load costs more than this, and
   * the cache is a fine answer when the server is slow or down.
   */
  const resolveResumePoint = async (
    cached: Audiobook,
    detailPromise: Promise<Audiobook | null>,
  ): Promise<{ chapter: number; position: number }> => {
    const local = {
      chapter: cached.currentChapter || 0,
      position: cached.currentPosition || 0,
    };
    const remote = await Promise.race([
      detailPromise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), RESUME_FETCH_TIMEOUT_MS)),
    ]);
    if (!remote) return local;

    const server = {
      chapter: remote.currentChapter ?? local.chapter,
      position: remote.currentPosition ?? local.position,
    };
    if (server.chapter !== local.chapter) {
      return server.chapter > local.chapter ? server : local;
    }
    return server.position >= local.position ? server : local;
  };

  const loadAudiobook = async () => {
    try {
      console.log('🔍 Looking for audiobook with ID:', audiobookId, typeof audiobookId);
      const library = await AsyncStorage.getItem('audiobook_library');
      if (library) {
        const libraryData = JSON.parse(library);
        console.log('📚 Library contains', libraryData.length, 'audiobooks');
        console.log('📚 Library IDs:', libraryData.map((b: any) => ({ id: b.id, type: typeof b.id, title: b.title })));

        // Use String() to normalize comparison in case of type mismatches
        const book = libraryData.find((b: Audiobook) => String(b.id) === String(audiobookId));
        if (book) {
          console.log('✅ Found audiobook:', book.title);
          setAudiobook(book);

          // Library payload no longer includes word_timings/imageInserts (those
          // arrays are heavy and would bloat /api/audiobooks). Fetch the full
          // record; karaoke + inline images light up once this resolves. Audio
          // playback works immediately from the cached metadata, so the user
          // never waits for this — but the same response also carries the
          // authoritative bookmark, so resolveResumePoint below shares this one
          // request rather than issuing a second.
          const detailPromise = apiService
            .getAudiobook(String(audiobookId))
            .catch(err => {
              console.warn('Failed to fetch full audiobook detail:', err);
              return null;
            });
          void detailPromise.then(full => {
            if (!full) return;
            setAudiobook(prev => {
              if (!prev || String(prev.id) !== String(full.id)) return prev;
              return { ...prev, chapters: full.chapters ?? prev.chapters };
            });
          });

          // Determine where to resume. The demo/sample book always starts fresh
          // (chapter 0, position 0) for every user — it's the first-launch
          // listen, and this also neutralises the known shared-row position
          // leak (CLAUDE.md tech debt) on the read side. An explicit
          // initialChapter (deep link) wins over any saved bookmark.
          const resume = book.isDemo
            ? { chapter: 0, position: 0 }
            : await resolveResumePoint(book, detailPromise);
          const startingChapter = book.isDemo
            ? 0
            : (initialChapter !== undefined ? initialChapter : resume.chapter);
          // Only resume mid-chapter when we're landing on the chapter the
          // bookmark actually refers to.
          const startPosition =
            book.isDemo || initialChapter !== undefined || startingChapter !== resume.chapter
              ? 0
              : Math.max(0, resume.position);

          setCurrentChapterIndex(startingChapter);
          currentChapterRef.current = startingChapter;
          lastSyncedPositionRef.current = startPosition;

          // Load the appropriate audio file — prefer local download over remote URL
          if (book.chapters && book.chapters.length > 0) {
            const chapter = book.chapters[startingChapter];
            const dlState = getDownloadState(book.id);
            const localPath = dlState.localChapterPaths?.[startingChapter];
            const audioUri = localPath ?? (chapter.audioUrl?.startsWith('http') ? chapter.audioUrl : null);
            console.log('Loading chapter audio from:', audioUri, localPath ? '(local)' : '(remote)');
            if (audioUri) {
              // The resume point goes INTO the load. It used to be a
              // setTimeout(100) seek fired after loadAsync resolved — which on a
              // moving car's connection ran long before the remote MP3 could
              // accept it, so the seek was dropped and the chapter restarted.
              if (startPosition > 0) console.log('Restoring saved position:', startPosition);
              await setupAudio(audioUri, false, buildMetadata(book, startingChapter), startPosition);
              // Mark initial load as done so chapter-change effect can work
              audioLoadedRef.current = true;
            }
          } else {
            const dlState = getDownloadState(book.id);
            const audioUri = dlState.localFilePath ?? book.filePath;
            console.log('Loading audio from:', audioUri, dlState.localFilePath ? '(local)' : '(remote)');
            if (startPosition > 0) console.log('Restoring saved position:', startPosition);
            await setupAudio(audioUri, false, buildMetadata(book, 0), startPosition);
            // Mark initial load as done
            audioLoadedRef.current = true;
          }
        } else {
          // Book not in local cache — may be a race condition (handleCompletion still saving).
          // Try a fresh sync from the server before giving up.
          console.warn('❌ Audiobook not found locally, attempting library sync...');
          try {
            const synced = await apiService.syncLibrary();
            const syncedBook = synced.find((b: Audiobook) => String(b.id) === String(audiobookId));
            if (syncedBook) {
              console.log('✅ Found audiobook after sync:', syncedBook.title);
              setAudiobook(syncedBook);
              const startingChapter = initialChapter !== undefined ? initialChapter : (syncedBook.currentChapter || 0);
              setCurrentChapterIndex(startingChapter);
              currentChapterRef.current = startingChapter;
              if (syncedBook.chapters && syncedBook.chapters.length > 0) {
                const chapter = syncedBook.chapters[startingChapter];
                const dlState = getDownloadState(syncedBook.id);
                const localPath = dlState.localChapterPaths?.[startingChapter];
                const audioUri = localPath ?? (chapter.audioUrl?.startsWith('http') ? chapter.audioUrl : null);
                if (audioUri) {
                  await setupAudio(audioUri, false, buildMetadata(syncedBook, startingChapter));
                  audioLoadedRef.current = true;
                }
              } else {
                const dlState = getDownloadState(syncedBook.id);
                const audioUri = dlState.localFilePath ?? syncedBook.filePath;
                if (audioUri) {
                  await setupAudio(audioUri, false, buildMetadata(syncedBook, 0));
                  audioLoadedRef.current = true;
                }
              }
              return; // success — finally block still runs
            }
          } catch (syncErr) {
            console.error('Library sync failed:', syncErr);
          }

          console.error('❌ Audiobook not found even after sync:', audiobookId);
          Alert.alert(
            'Audiobook Not Found',
            'This audiobook could not be found in your library. It may still be processing.',
            [
              { text: 'Go to Library', onPress: () => navigation.navigate(libraryRoot as any, { screen: 'Library' } as any) }
            ]
          );
        }
      } else {
        // No local library at all — try a sync before showing an error.
        console.warn('❌ No local library, attempting sync...');
        try {
          const synced = await apiService.syncLibrary();
          const syncedBook = synced.find((b: Audiobook) => String(b.id) === String(audiobookId));
          if (syncedBook) {
            console.log('✅ Found audiobook after sync:', syncedBook.title);
            setAudiobook(syncedBook);
            const startingChapter = initialChapter !== undefined ? initialChapter : (syncedBook.currentChapter || 0);
            setCurrentChapterIndex(startingChapter);
            currentChapterRef.current = startingChapter;
            if (syncedBook.chapters && syncedBook.chapters.length > 0) {
              const chapter = syncedBook.chapters[startingChapter];
              const dlState = getDownloadState(syncedBook.id);
              const localPath = dlState.localChapterPaths?.[startingChapter];
              const audioUri = localPath ?? (chapter.audioUrl?.startsWith('http') ? chapter.audioUrl : null);
              if (audioUri) {
                await setupAudio(audioUri, false, buildMetadata(syncedBook, startingChapter));
                audioLoadedRef.current = true;
              }
            } else {
              const dlState = getDownloadState(syncedBook.id);
              const audioUri = dlState.localFilePath ?? syncedBook.filePath;
              if (audioUri) {
                await setupAudio(audioUri, false, buildMetadata(syncedBook, 0));
                audioLoadedRef.current = true;
              }
            }
            return; // success — finally block still runs
          }
        } catch (syncErr) {
          console.error('Library sync failed:', syncErr);
        }
        console.error('❌ No library data found in AsyncStorage');
        Alert.alert(
          'Library Empty',
          'Your library is empty. Please convert an audiobook first.',
          [
            { text: isAnonymous ? 'Go to Library' : 'Go Home', onPress: () => navigation.navigate(libraryRoot as any, { screen: isAnonymous ? 'Library' : 'Home' } as any) }
          ]
        );
      }
    } catch (error) {
      console.error('Error loading audiobook:', error);
      Alert.alert(
        'Error',
        'Failed to load audiobook. Please try again.',
        [
          { text: 'Go Back', onPress: () => navigation.goBack() }
        ]
      );
    } finally {
      setLoading(false);
    }
  };

  const loadChapter = async (
    audioUrl: string,
    autoPlay: boolean = false,
    metadataOverride?: NowPlayingMetadata,
  ) => {
    try {
      // Drop any queued progress write for the chapter we're leaving.  Its
      // position belongs to the OLD audio but `currentChapterRef` has already
      // moved to the new chapter, so letting it land would save e.g.
      // "chapter 4, position 2400s" — a bookmark that seeks the new chapter
      // 40 minutes in.  The new chapter is persisted explicitly below.
      syncProgressToDatabase.cancel();
      syncLocalProgress.cancel();
      lastSyncedPositionRef.current = 0;

      // Stop the current chapter immediately so it cannot overlap with the
      // incoming one.  Do this before any async work so there is zero window
      // where both audio sources are active.
      if (soundRef.current) {
        try {
          await soundRef.current.stopAsync();
        } catch (_) {
          // Already stopped or unloaded — safe to ignore.
        }
      }

      // Reset states — including durationRef to prevent stale isNearEnd triggers
      setCurrentTime(0);
      currentTimeRef.current = 0; // reset position for karaoke on chapter change
      setDuration(0);
      durationRef.current = 0;
      isPlayingRef.current = false;
      setIsPlaying(false);

      // Reset the karaoke interpolation anchor so getPosition() doesn't keep
      // returning the OLD chapter's end-position (which would make
      // KaraokeReader's binary search land on the last word of the new
      // chapter for ~250 ms while the new audio loads).  Bumping seekToken
      // makes KaraokeReader snap-scroll to the start of the new chapter
      // rather than animating from wherever the old chapter left off.
      positionStateRef.current = {
        time: 0,
        wallClock: 0,
        isPlaying: false,
        rate: positionStateRef.current.rate,
      };
      setSeekToken(t => t + 1);

      // Record load time so onPlaybackStatusUpdate ignores false "chapter finished"
      // events that fire immediately after loading (stale callbacks from old sound)
      chapterLoadTimeRef.current = Date.now();

      console.log('Loading new chapter from:', audioUrl);
      await setupAudio(audioUrl, autoPlay, metadataOverride);

      // Persist the chapter change straight away.  Without this, auto-advancing
      // and then closing the app within the throttle window would resume on the
      // previous chapter — one of the ways the book appeared to "repeat".
      // explicitSeek: position legitimately drops to 0 on a new chapter.
      void writeProgressNow(audiobookId, 0, currentChapterRef.current, true);
    } catch (error) {
      console.error('Error loading chapter:', error);
    }
  };

  const handleNextChapter = async () => {
    const book = audiobookRef.current;
    if (book?.chapters && currentChapterRef.current < book.chapters.length - 1) {
      const nextIndex = currentChapterRef.current + 1;
      console.log(`Moving to next chapter: ${nextIndex + 1} of ${book.chapters.length}`);

      // Update both ref and state
      currentChapterRef.current = nextIndex;
      setCurrentChapterIndex(nextIndex);

      // Set flag to indicate this is an auto-play scenario
      isAutoPlayingRef.current = true;

      // Load and auto-play the next chapter immediately
      const nextChapter = book.chapters[nextIndex];
      const dlState = getDownloadState(book.id);
      const localPath = dlState.localChapterPaths?.[nextIndex];
      const audioUri = localPath ?? (nextChapter.audioUrl?.startsWith('http') ? nextChapter.audioUrl : null);
      if (audioUri) {
        try {
          await loadChapter(audioUri, true, {
            title: nextChapter.title || book.title || 'EbookVoice',
            artist: book.title || 'EbookVoice',
            artwork: book.coverUrl || undefined,
          });
        } catch (error) {
          console.error('Error auto-advancing chapter:', error);
        } finally {
          isAdvancingChapterRef.current = false;
        }
      } else {
        console.error('Invalid next chapter audio URL:', nextChapter.audioUrl);
        isAdvancingChapterRef.current = false;
      }
    } else {
      isAdvancingChapterRef.current = false;
    }
  };

  /**
   * Single entry point for every user-initiated chapter change: the chapter
   * list, and the lock-screen / Bluetooth / CarPlay skip buttons.
   *
   * Setting state drives the [currentChapterIndex] effect, which syncs the ref
   * and loads the chapter with autoPlay.  Returns false when the move isn't
   * possible so the caller (e.g. the remote handler) can fall back.
   */
  const goToChapter = (index: number): boolean => {
    const book = audiobookRef.current;
    const total = book?.chapters?.length ?? 0;
    if (total === 0 || index < 0 || index >= total) return false;

    if (index === currentChapterRef.current) {
      // React bails out of a same-value state update, so the load effect would
      // never fire and the tap would silently do nothing — bad for anyone
      // driving, worse for a VoiceOver user who just heard the button announce
      // itself.  Restart the chapter instead.
      void (async () => {
        try {
          await soundRef.current?.setPositionAsync(0);
          snapKaraokeTo(0);
          await soundRef.current?.playAsync();
          persistProgressNow(true);
        } catch (error) {
          console.error('Error restarting chapter:', error);
        }
      })();
      return true;
    }

    currentChapterRef.current = index;
    setCurrentChapterIndex(index);
    return true;
  };

  // Stable indirection so the remote-command handlers, which are registered
  // once on mount, always call the current render's closure.
  const goToChapterRef = useRef(goToChapter);
  goToChapterRef.current = goToChapter;

  // ── Lock-screen / Bluetooth / CarPlay chapter skip ──────────────────────
  // The headless playback service can't reach component state, so it calls
  // into this registry.  Registered only while the Player is mounted; when it
  // isn't, playbackService falls back to a 30 s nudge.
  useEffect(() => {
    setRemoteChapterHandlers({
      onNextChapter: () => goToChapterRef.current(currentChapterRef.current + 1),
      onPreviousChapter: () => goToChapterRef.current(currentChapterRef.current - 1),
    });
    return () => setRemoteChapterHandlers(null);
  }, []);

  const setupAudio = async (
    audioUrl: string,
    autoPlay: boolean = false,
    metadataOverride?: NowPlayingMetadata,
    startPositionSeconds: number = 0,
  ) => {
    try {
      // Enable audio (mobile only)
      await enableAudio();

      // Reuse existing player if available, otherwise create new one
      // This prevents orphaned Sound objects on mobile
      if (!soundRef.current) {
        // The RNTP-vs-expo-av choice happens at construction and is sticky
        // for the session. Wait (bounded ~2 s, usually instant) for the
        // feature-flag fetch so a cold launch straight into a book doesn't
        // race the fetch and silently lose lock-screen/CarPlay controls.
        await ensureFeatureFlags();
        const player = createAudioPlayer();
        soundRef.current = player;
        // Set up playback status update callback (only needed once per player)
        player.setOnPlaybackStatusUpdate(onPlaybackStatusUpdate);
        // Hand the remembered speed to the backend before the first load so
        // it's applied as part of the load, not as a visible jolt after it.
        if (playbackSpeedRef.current !== 1.0) {
          await player.setRateAsync(playbackSpeedRef.current, true).catch(() => {});
        }
      }

      // Build now-playing metadata for the lock-screen / Bluetooth / CarPlay
      // display.  Caller can override with explicit values; otherwise we try
      // the ref (which can be null on initial load — so callers SHOULD pass
      // metadataOverride whenever they have the book + chapter in scope).
      const book = audiobookRef.current;
      const ch = book?.chapters?.[currentChapterRef.current];
      const metadata: NowPlayingMetadata = metadataOverride ?? {
        title: ch?.title ?? book?.title ?? 'EbookVoice',
        artist: book?.title ?? 'EbookVoice',
        artwork: book?.coverUrl ?? undefined,
      };

      // Load the audio (MobileAudioPlayer handles unloading previous sound internally)
      // Pass autoPlay so expo-av starts playback atomically via shouldPlay, and
      // startPositionSeconds so the resume point is applied by the player at the
      // point it's guaranteed to stick (see AudioPlayerInterface.loadAsync).
      await soundRef.current.loadAsync(audioUrl, autoPlay, metadata, startPositionSeconds);

      // Get initial status
      const status = await soundRef.current.getStatusAsync();
      console.log('[setupAudio] Initial status:', { isLoaded: status.isLoaded, durationMillis: status.durationMillis });
      if (status.isLoaded) {
        setDuration(status.durationMillis ? status.durationMillis / 1000 : 0);
      }

      // Align the UI + karaoke anchor with the position the player actually
      // landed on, rather than assuming the requested one.
      if (startPositionSeconds > 0) {
        const landed = status.isLoaded && status.positionMillis
          ? status.positionMillis / 1000
          : startPositionSeconds;
        setCurrentTime(landed);
        lastSyncedPositionRef.current = landed;
        snapKaraokeTo(landed);
      }
    } catch (error) {
      console.error('Error setting up audio:', error);
    }
  };

  // NOTE: This callback is set ONCE on the audio player, so it must use refs (not state)
  // to access current values. State variables would be stale from the initial closure.
  const onPlaybackStatusUpdate = (status: any) => {
    if (status.isLoaded && !isSeekingRef.current) {
      const currentPosition = status.positionMillis / 1000;
      const trackDuration = status.durationMillis ? status.durationMillis / 1000 : durationRef.current;

      setCurrentTime(currentPosition);
      currentTimeRef.current = currentPosition; // keeps karaoke in sync
      // Update interpolation anchor so getPosition() stays accurate between ticks.
      // rate: expo-av uses `status.rate`; web player uses `status.playbackRate`.
      positionStateRef.current = {
        time: currentPosition,
        wallClock: Date.now(),
        isPlaying: status.isPlaying,
        rate: status.rate ?? status.playbackRate ?? 1,
      };

      // Only call setIsPlaying when the value actually changed — avoids a
      // PlayerScreen re-render on every status tick while play state is stable.
      if (status.isPlaying !== isPlayingRef.current) {
        isPlayingRef.current = status.isPlaying;
        setIsPlaying(status.isPlaying);
      }

      // Update duration if it changed
      if (status.durationMillis && trackDuration !== durationRef.current) {
        setDuration(trackDuration);
      }

      // Sync if position changed significantly
      if (Math.abs(currentPosition - lastSyncedPositionRef.current) > PROGRESS_MIN_DELTA_S) {
        syncProgressToDatabase(audiobookId, currentPosition, currentChapterRef.current);
        syncLocalProgress(audiobookId, currentPosition, currentChapterRef.current);
      }

      // Check if chapter has finished
      // Use didJustFinish as primary indicator, with fallback to position check
      const isNearEnd = trackDuration > 0 && (trackDuration - currentPosition) < 0.5;
      const chapterFinished = status.didJustFinish || (isNearEnd && !status.isPlaying);

      if (chapterFinished) {
        // Guard against double-triggering during async chapter load
        if (isAdvancingChapterRef.current) {
          return;
        }

        // Ignore false "chapter finished" events within 2s of loading a new chapter.
        // On iOS, expo-av can fire stale status updates from the old sound, or the new
        // sound can briefly report 0 duration causing isNearEnd to falsely trigger.
        if (Date.now() - chapterLoadTimeRef.current < 2000) {
          return;
        }

        const book = audiobookRef.current;
        console.log('=== CHAPTER FINISHED ===');
        console.log('Current chapter:', currentChapterRef.current + 1);
        console.log('Total chapters:', book?.chapters?.length || 1);

        // Check if there are more chapters to play
        const hasMoreChapters = book?.chapters && currentChapterRef.current < book.chapters.length - 1;

        if (hasMoreChapters) {
          console.log('Moving to next chapter...');
          isAdvancingChapterRef.current = true;
          handleNextChapter();
        } else {
          console.log('No more chapters - playback complete');
          setIsPlaying(false);
        }
      }
    }
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds === 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handlePlayPause = async () => {
    console.log('[handlePlayPause] Tapped! soundRef:', !!soundRef.current, 'isPlaying:', isPlaying);
    if (!soundRef.current) {
      console.warn('[handlePlayPause] No sound ref - cannot play');
      return;
    }

    try {
      if (isPlaying) {
        console.log('[handlePlayPause] Pausing...');
        await soundRef.current.pauseAsync();
        isPlayingRef.current = false;
        // A pause is very often followed by the user leaving — persist here
        // rather than waiting out the throttle window.
        persistProgressNow();
      } else {
        console.log('[handlePlayPause] Playing...');
        await soundRef.current.playAsync();
        isPlayingRef.current = true;
        if (!playTrackedRef.current) {
          playTrackedRef.current = true;
          track('audiobook_played', {
            audiobook_id: audiobook?.id,
            is_first_play: currentTimeRef.current < 1,
            is_sample: !!audiobook?.isDemo,
          });
        }
      }
      console.log('[handlePlayPause] Done');
    } catch (error) {
      console.error('[handlePlayPause] Error toggling playback:', error);
    }
  };

  // First-launch first-listen: auto-start playback once the audio is loaded
  // (duration > 0), unless a screen reader is active — VoiceOver users tap play
  // themselves so audio never fights their screen reader. Fires exactly once and
  // only when navigated with autoPlay (the first-launch redirect); a normal
  // Player entry has autoPlay undefined, so this is a no-op. Reuses the tested
  // handlePlayPause path so audiobook_played + the playback refs stay consistent.
  useEffect(() => {
    if (!autoPlay || autoPlayFiredRef.current) return;
    if (duration <= 0 || !soundRef.current || isPlayingRef.current) return;
    autoPlayFiredRef.current = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then(screenReaderOn => {
        if (!screenReaderOn && !isPlayingRef.current) handlePlayPause();
      })
      .catch(() => {});
  }, [duration, autoPlay]);

  // After any imperative position change (slider, rewind, forward, chapter
  // load), refresh the interpolation anchor so getPosition() returns the new
  // position immediately — without this, karaoke binary-searches the old
  // position against the new audio for up to 250 ms (RNTP polling cadence)
  // and lights the wrong word.  Bumps seekToken so KaraokeReader resets its
  // scroll snap rather than animating from the old paragraph.
  const snapKaraokeTo = (timeSeconds: number) => {
    currentTimeRef.current = timeSeconds;
    positionStateRef.current = {
      ...positionStateRef.current,
      time: timeSeconds,
      wallClock: Date.now(),
    };
    setSeekToken(t => t + 1);
  };

  const handleRewind = async () => {
    console.log('[handleRewind] Tapped!');
    if (!soundRef.current) return;
    try {
      const status = await soundRef.current.getStatusAsync();
      if (status.isLoaded) {
        const currentPos = status.positionMillis / 1000;
        const newPositionMs = Math.max(0, currentPos - 15) * 1000;
        const newPositionS = newPositionMs / 1000;
        console.log(`Rewinding from ${currentPos}s to ${newPositionS}s`);
        await soundRef.current.setPositionAsync(newPositionMs);
        setCurrentTime(newPositionS);
        snapKaraokeTo(newPositionS);
        // explicitSeek: the user asked to go backwards, so the server's
        // regression guard must not treat this as the drift bug and reject it.
        persistProgressNow(true);
      }
    } catch (error) {
      console.error('Error rewinding:', error);
    }
  };

  const handleForward = async () => {
    console.log('[handleForward] Tapped!');
    if (!soundRef.current) return;
    try {
      const status = await soundRef.current.getStatusAsync();
      if (status.isLoaded) {
        const currentPos = status.positionMillis / 1000;
        const maxDuration = status.durationMillis ? status.durationMillis / 1000 : duration;
        const newPositionMs = Math.min(maxDuration, currentPos + 15) * 1000;
        const newPositionS = newPositionMs / 1000;
        console.log(`Forwarding from ${currentPos}s to ${newPositionS}s`);
        await soundRef.current.setPositionAsync(newPositionMs);
        setCurrentTime(newPositionS);
        snapKaraokeTo(newPositionS);
        persistProgressNow(true);
      }
    } catch (error) {
      console.error('Error forwarding:', error);
    }
  };

  const applySpeed = async (newSpeed: number) => {
    if (!soundRef.current || newSpeed === playbackSpeed) return;
    try {
      await soundRef.current.setRateAsync(newSpeed, true);
      setPlaybackSpeed(newSpeed);
      playbackSpeedRef.current = newSpeed;
      AsyncStorage.setItem(PLAYBACK_SPEED_KEY, String(newSpeed)).catch(() => {});
      // Apply the new rate to the interpolation anchor immediately so
      // getPosition() doesn't extrapolate at the old rate for the 250 ms
      // window before the next status callback arrives.  Re-anchors `time`
      // and `wallClock` so the new rate's elapsed clock starts now.
      //
      // Note: this can't use snapKaraokeTo() because we need to extrapolate
      // the current position at the OLD rate before re-anchoring at the NEW
      // rate — snapKaraokeTo takes a known position as input.
      //
      // The read of positionStateRef happens AFTER the await so we capture
      // any update applied by onPlaybackStatusUpdate during the await
      // window (the status callback runs on the same JS thread but yields
      // happen at await points).
      const cur = positionStateRef.current;
      positionStateRef.current = {
        time: cur.isPlaying && cur.wallClock !== 0
          ? cur.time + ((Date.now() - cur.wallClock) / 1000) * cur.rate
          : cur.time,
        wallClock: Date.now(),
        isPlaying: cur.isPlaying,
        rate: newSpeed,
      };
    } catch (error) {
      console.error('Error changing speed:', error);
    }
  };

  // Tap: advance one step and wrap (sighted users).
  const handleSpeedChange = () => {
    const i = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    void applySpeed(PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length]);
  };

  // VoiceOver swipe up / down on the adjustable chip: step without wrapping,
  // so a fast listener reaches 3x in a few swipes and can't overshoot back
  // to 0.5x.
  const handleSpeedStep = (direction: 1 | -1) => {
    const i = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    const next = Math.min(PLAYBACK_SPEEDS.length - 1, Math.max(0, i + direction));
    void applySpeed(PLAYBACK_SPEEDS[next]);
  };

  const handleSliderValueChange = (value: number) => {
    // Update the UI while dragging
    setCurrentTime(value);
    if (sliderTouchActiveRef.current) return;

    // No touch-down preceded this change: VoiceOver adjusted the native
    // UISlider (each swipe moves 10% of the chapter), and it will never send
    // onSlidingComplete.  Hold the status stream off the slider and seek once
    // the swipes stop, so a run of swipes lands one seek rather than five.
    // Before this, the swipe moved the thumb, nothing sought, and the next
    // status tick snapped it back — which to a VoiceOver user reads as
    // "the slider doesn't work".
    setIsSeeking(true);
    isSeekingRef.current = true;
    if (assistiveSeekTimerRef.current) clearTimeout(assistiveSeekTimerRef.current);
    assistiveSeekTimerRef.current = setTimeout(() => {
      assistiveSeekTimerRef.current = null;
      void handleSliderSlidingComplete(value);
    }, 400);
  };

  const handleSliderSlidingStart = () => {
    sliderTouchActiveRef.current = true;
    if (assistiveSeekTimerRef.current) {
      clearTimeout(assistiveSeekTimerRef.current);
      assistiveSeekTimerRef.current = null;
    }
    setIsSeeking(true);
  };

  const handleSliderSlidingComplete = async (value: number) => {
    sliderTouchActiveRef.current = false;
    if (!soundRef.current) return;
    try {
      await soundRef.current.setPositionAsync(value * 1000);
      snapKaraokeTo(value);
      setIsSeeking(false);
      persistProgressNow(true);
    } catch (error) {
      console.error('Error seeking:', error);
      setIsSeeking(false);
    }
  };

  useEffect(() => () => {
    if (assistiveSeekTimerRef.current) clearTimeout(assistiveSeekTimerRef.current);
  }, []);

  const checkBookmarkStatus = async () => {
    try {
      const bookmarksData = await AsyncStorage.getItem('audiobook_bookmarks');
      if (bookmarksData) {
        const bookmarks = JSON.parse(bookmarksData);
        const bookmarkKey = `${audiobookId}_${currentChapterIndex}`;
        setIsBookmarked(!!bookmarks[bookmarkKey]);
      } else {
        setIsBookmarked(false);
      }
    } catch (error) {
      console.error('Error checking bookmark status:', error);
    }
  };

  const handleBookmark = async () => {
    try {
      const bookmarksData = await AsyncStorage.getItem('audiobook_bookmarks');
      const bookmarks = bookmarksData ? JSON.parse(bookmarksData) : {};
      const bookmarkKey = `${audiobookId}_${currentChapterIndex}`;

      if (isBookmarked) {
        // Remove bookmark
        delete bookmarks[bookmarkKey];
        setIsBookmarked(false);

        if (Platform.OS === 'web') {
          alert('Bookmark removed');
        } else {
          Alert.alert('Bookmark Removed', 'This chapter has been removed from your bookmarks.');
        }
      } else {
        // Add bookmark
        bookmarks[bookmarkKey] = {
          audiobookId,
          audiobookTitle: audiobook?.title,
          chapterIndex: currentChapterIndex,
          chapterTitle: audiobook?.chapters?.[currentChapterIndex]?.title || 'Chapter',
          position: currentTime,
          timestamp: new Date().toISOString(),
        };
        setIsBookmarked(true);

        if (Platform.OS === 'web') {
          alert('Bookmark added');
        } else {
          Alert.alert('Bookmarked', 'This chapter has been added to your bookmarks.');
        }
      }

      await AsyncStorage.setItem('audiobook_bookmarks', JSON.stringify(bookmarks));
    } catch (error) {
      console.error('Error toggling bookmark:', error);
      if (Platform.OS === 'web') {
        alert('Failed to toggle bookmark. Please try again.');
      } else {
        Alert.alert('Error', 'Failed to toggle bookmark. Please try again.');
      }
    }
  };

  const handleShare = async () => {
    try {
      const chapterInfo = audiobook?.chapters?.[currentChapterIndex]
        ? (() => {
            const raw = audiobook.chapters[currentChapterIndex].title || '';
            const decoded = raw.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const display = /^Chapter\s+\d+/i.test(decoded) ? decoded : `Chapter ${currentChapterIndex + 1}: ${decoded}`;
            return ` - ${display}`;
          })()
        : '';

      // Canonical App Store URL — no country code so it redirects to the
      // user's local storefront (e.g. UK → /gb/, US → /us/). If you ever
      // launch on Google Play too, append a separate `Download on Android: …`
      // line after the iOS one.
      const APP_STORE_URL = 'https://apps.apple.com/app/id6760320684';
      const message = `Check out "${audiobook?.title}"${chapterInfo} on EbookVoice!\n\nDownload EbookVoice: ${APP_STORE_URL}`;

      if (Platform.OS === 'web') {
        if (navigator.share) {
          await navigator.share({
            title: audiobook?.title || 'Audiobook',
            text: message,
          });
        } else {
          // Fallback for browsers that don't support Web Share API
          navigator.clipboard.writeText(message);
          alert('Share link copied to clipboard!');
        }
      } else {
        // React Native Share API
        await Share.share({
          message,
          title: audiobook?.title || 'Audiobook',
        });
      }
    } catch (error) {
      // User cancelled share or error occurred
      if (error instanceof Error && error.message !== 'User did not share') {
        console.error('Error sharing:', error);
      }
    }
  };

  if (loading || !audiobook) {
    return (
      <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.card }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading audiobook...</Text>
        </View>
      </ScreenWrapper>
    );
  }

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.card }]}>
      {/* Header with back button */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.navigate(libraryRoot as any, { screen: 'Library' } as any)}
          accessibilityRole="button"
          accessibilityLabel="Back to library"
        >
          <Ionicons name="arrow-back" size={24} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
          <Text style={[styles.backButtonText, { color: theme.text }]}>Library</Text>
        </TouchableOpacity>
      </View>

      {/* Top section: cycles between cover art, karaoke, and plain-text reader */}
      <View style={styles.topSection}>
        {readingMode === 'follow' && currentWordTimings.length > 0 ? (
          /* ── Karaoke / sync-text view ── fills topSection edge-to-edge ── */
          <View style={styles.karaokeContainer}>
            <Pressable onPress={() => setReadingMode('cover')} style={styles.karaokeHeader} accessibilityRole="button" accessibilityHint="Collapses the reading view and returns to the cover">
              <Ionicons name="chevron-down" size={16} color={theme.textSecondary} style={{ alignSelf: 'center' }} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={[styles.karaokeChapterLabel, { color: theme.textSecondary }]} numberOfLines={1}>
                {audiobook.chapters && audiobook.chapters.length > 0
                  ? `Ch. ${currentChapterIndex + 1} · ${(audiobook.chapters[currentChapterIndex]?.title || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/^Chapter\s+\d+:\s*/i, '')}`
                  : audiobook.title}
              </Text>
            </Pressable>
            <KaraokeReader
              wordTimings={currentWordTimings}
              getPosition={getPosition}
              isVisible={true}
              seekToken={seekToken}
              highlightMode={followAlongMode}
              imageInserts={currentImageInserts}
            />
          </View>
        ) : readingMode === 'read' ? (
          /* ── Plain-text reader — no highlights, free scroll ── */
          <View style={styles.karaokeContainer}>
            <Pressable onPress={() => setReadingMode('cover')} style={styles.karaokeHeader} accessibilityRole="button" accessibilityHint="Collapses the reading view and returns to the cover">
              <Ionicons name="chevron-down" size={16} color={theme.textSecondary} style={{ alignSelf: 'center' }} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={[styles.karaokeChapterLabel, { color: theme.textSecondary }]} numberOfLines={1}>
                {audiobook.chapters && audiobook.chapters.length > 0
                  ? `Ch. ${currentChapterIndex + 1} · ${(audiobook.chapters[currentChapterIndex]?.title || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/^Chapter\s+\d+:\s*/i, '')}`
                  : audiobook.title}
              </Text>
            </Pressable>
            <ScrollView
              ref={plainTextScrollRef}
              style={styles.plainTextScroll}
              contentContainerStyle={styles.plainTextContent}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={(_w, h) => {
                plainTextContentHeightRef.current = h;
                const pos = getPosition();
                let lo = 0, hi = currentWordTimings.length - 1, wordIdx = 0;
                while (lo <= hi) {
                  const mid = (lo + hi) >> 1;
                  const t = currentWordTimings[mid];
                  if (pos >= t.start && pos <= t.end) { wordIdx = mid; break; }
                  if (pos > t.end) { wordIdx = mid; lo = mid + 1; }
                  else hi = mid - 1;
                }
                const fraction = currentWordTimings.length > 1 ? wordIdx / (currentWordTimings.length - 1) : 0;
                const offset = Math.max(0, fraction * h - 200);
                plainTextScrollRef.current?.scrollTo({ y: offset, animated: false });
              }}
            >
              {currentWordTimings.length > 0 ? (() => {
                // Split words into ~100-word paragraphs, inserting images at the right positions
                const PARA = 100;
                const words = currentWordTimings.map(t => t.word);
                const elements: React.ReactNode[] = [];
                let paraIdx = 0;
                for (let i = 0; i < words.length; i += PARA) {
                  const chunk = words.slice(i, i + PARA).join(' ');
                  const wordEnd = i + PARA - 1;
                  elements.push(
                    <Text key={`p-${paraIdx}`} style={[styles.plainTextBody, { color: theme.text }]}>{chunk}</Text>
                  );
                  // Insert any images whose wordIndex falls within this paragraph
                  for (const img of currentImageInserts) {
                    if (img.wordIndex >= i && img.wordIndex <= wordEnd) {
                      elements.push(
                        <Image
                          key={`img-${img.wordIndex}`}
                          source={{ uri: img.url }}
                          style={styles.plainTextImage}
                          resizeMode="contain"
                        />
                      );
                    }
                  }
                  paraIdx++;
                }
                return elements;
              })() : (
                <Text style={[styles.plainTextBody, { color: theme.text }]}>
                  Chapter text is not available. Reconvert this audiobook to enable read mode.
                </Text>
              )}
            </ScrollView>
          </View>
        ) : (
          /* ── Cover art view (default) ── */
          <>
            <Pressable
              style={styles.coverContainer}
              onPress={() => {
                if (currentWordTimings.length > 0) setReadingMode('follow');
              }}
              accessibilityRole={currentWordTimings.length > 0 ? 'button' : 'image'}
              accessibilityLabel={currentWordTimings.length > 0 ? 'Cover art. Activate to follow along with the text' : 'Cover art'}
            >
              {audiobook.coverUrl ? (
                <Image
                  source={{ uri: audiobook.coverUrl }}
                  style={styles.coverImage}
                  resizeMode="cover"
                  accessibilityElementsHidden importantForAccessibility="no"
                />
              ) : (
                <View style={[styles.coverPlaceholder, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
                  <Ionicons name="musical-notes" size={80} color={theme.primary} />
                </View>
              )}
              {currentWordTimings.length > 0 && (
                <View style={styles.coverSyncHint} accessibilityElementsHidden importantForAccessibility="no">
                  <Ionicons name="text-outline" size={12} color={theme.primary} />
                  <Text style={[styles.coverSyncHintText, { color: theme.primary }]}>Tap to follow along</Text>
                </View>
              )}
            </Pressable>

            {/* Track Info — centered title + author + chapter */}
            <View style={styles.trackInfo}>
              <View style={styles.titleMarqueeContainer} pointerEvents="none">
                {/* Centered title, truncated cleanly with an ellipsis when long
                    (iOS now-playing pattern). Replaced the old scrolling marquee,
                    which could be caught mid-scroll showing a half-clipped first
                    character. */}
                <Text
                  style={[styles.title, { color: theme.text, textAlign: 'center', width: '100%' }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {audiobook.title}
                </Text>
              </View>
              <Text style={[styles.author, { color: theme.textSecondary }]} numberOfLines={1}>
                Audiobook
              </Text>
              {audiobook.chapters && audiobook.chapters.length > 0 ? (
                <Text style={[styles.chapter, { color: theme.textSecondary }]} numberOfLines={1}>
                  {(() => {
                    const raw = audiobook.chapters[currentChapterIndex]?.title || '';
                    const decoded = raw.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                    return /^Chapter\s+\d+/i.test(decoded) ? decoded : `Chapter ${currentChapterIndex + 1}: ${decoded}`;
                  })()}
                </Text>
              ) : (
                <Text style={[styles.chapter, { color: theme.textSecondary }]} numberOfLines={1}>
                  {audiobook.voiceName || 'AI Voice'}
                </Text>
              )}
            </View>
          </>
        )}
      </View>

      {/* Bottom section: Controls — OUTSIDE any ScrollView for reliable touch handling */}
      <View style={styles.bottomSection}>
        {/* Progress Bar */}
        <View style={styles.progressContainer}>
          <Slider
            style={styles.slider}
            value={duration > 0 ? currentTime : 0}
            minimumValue={0}
            maximumValue={duration > 0 ? duration : 1}
            minimumTrackTintColor={theme.primary}
            maximumTrackTintColor={theme.border}
            thumbTintColor={theme.primary}
            onValueChange={handleSliderValueChange}
            onSlidingStart={handleSliderSlidingStart}
            onSlidingComplete={handleSliderSlidingComplete}
            accessibilityLabel="Playback position"
            accessibilityValue={{ text: `${formatTime(currentTime)} of ${formatTime(duration)}` }}
            accessibilityHint="Swipe up or down to move through the chapter"
          />
          <View style={styles.timeContainer}>
            <Text style={[styles.timeText, { color: theme.textSecondary }]}>{formatTime(currentTime)}</Text>
            <Text style={[styles.timeText, { color: theme.textSecondary }]}>{formatTime(duration)}</Text>
          </View>
        </View>

        {/* Speed chip — moved out of the transport row so [Rewind] [Play]
            [Forward] is naturally centered (classic transport). Still one tap
            to cycle speeds, just no longer breaks the symmetry. */}
        <View style={styles.speedChipRow}>
          <Pressable
            style={[
              styles.speedChip,
              { backgroundColor: theme.primary + '14', borderColor: theme.primary + '40' },
            ]}
            onPress={handleSpeedChange}
            hitSlop={8}
            accessibilityRole="adjustable"
            accessibilityLabel="Playback speed"
            accessibilityValue={{ text: `${playbackSpeed} times` }}
            accessibilityHint="Double tap to cycle through playback speeds"
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'increment') handleSpeedStep(1);
              else if (e.nativeEvent.actionName === 'decrement') handleSpeedStep(-1);
            }}
          >
            <Text style={[styles.speedChipText, { color: theme.primary }]}>{playbackSpeed}x</Text>
          </Pressable>
        </View>

        {/* Controls — classic 3-button transport, centered */}
        <View style={styles.controls}>
          {/* Rewind */}
          <Pressable
            style={styles.controlButton}
            onPress={handleRewind}
            accessibilityRole="button"
            accessibilityLabel="Rewind 15 seconds"
          >
            <Ionicons name="play-back-outline" size={32} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.skipText, { color: theme.textSecondary }]} accessibilityElementsHidden importantForAccessibility="no">15s</Text>
          </Pressable>

          {/* Play/Pause */}
          <Pressable
            style={[styles.playButton, { backgroundColor: theme.primary }]}
            onPress={handlePlayPause}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
          >
            <Ionicons
              name={isPlaying ? 'pause' : 'play'}
              size={40}
              color="#ffffff"
              accessibilityElementsHidden importantForAccessibility="no"
            />
          </Pressable>

          {/* Forward */}
          <Pressable
            style={styles.controlButton}
            onPress={handleForward}
            accessibilityRole="button"
            accessibilityLabel="Skip forward 15 seconds"
          >
            <Ionicons name="play-forward-outline" size={32} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.skipText, { color: theme.textSecondary }]} accessibilityElementsHidden importantForAccessibility="no">15s</Text>
          </Pressable>
        </View>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          {/* Download button — mobile only */}
          {Platform.OS !== 'web' && (() => {
            const dlState = getDownloadState(audiobookId);
            const isDownloading = dlState.status === 'downloading';
            const isDownloaded = dlState.status === 'downloaded';
            return (
              <Pressable
                style={styles.actionButton}
                onPress={() => {
                  if (!isDownloading && !isDownloaded && audiobook) {
                    downloadAudiobook(audiobook);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel={isDownloaded ? 'Saved for offline listening' : isDownloading ? `Downloading, ${Math.round(dlState.progress * 100)} percent` : 'Download for offline listening'}
                accessibilityState={{ disabled: isDownloaded || isDownloading, busy: isDownloading }}
              >
                <Ionicons
                  name={isDownloaded ? 'checkmark-circle' : isDownloading ? 'cloud-download' : 'cloud-download-outline'}
                  size={24}
                  color={isDownloaded || isDownloading ? theme.primary : theme.textSecondary}
                  accessibilityElementsHidden importantForAccessibility="no"
                />
                <Text style={[styles.actionText, { color: isDownloaded || isDownloading ? theme.primary : theme.textSecondary }]}>
                  {isDownloaded ? 'Saved' : isDownloading ? `${Math.round(dlState.progress * 100)}%` : 'Download'}
                </Text>
              </Pressable>
            );
          })()}

          <Pressable
            style={styles.actionButton}
            onPress={handleBookmark}
            accessibilityRole="button"
            accessibilityLabel={isBookmarked ? 'Remove bookmark from this chapter' : 'Bookmark this chapter'}
            accessibilityState={{ selected: isBookmarked }}
          >
            <Ionicons
              name={isBookmarked ? 'bookmark' : 'bookmark-outline'}
              size={24}
              color={isBookmarked ? theme.primary : theme.textSecondary}
              accessibilityElementsHidden importantForAccessibility="no"
            />
            <Text style={[styles.actionText, { color: isBookmarked ? theme.primary : theme.textSecondary }]}>
              Bookmark
            </Text>
          </Pressable>

          {audiobook.chapters && audiobook.chapters.length > 0 && (
            <Pressable
              style={styles.actionButton}
              onPress={() => setShowChapterList(true)}
              accessibilityRole="button"
              accessibilityLabel="Chapters"
              accessibilityHint="Opens the list of chapters to jump between them"
            >
              <Ionicons name="list-outline" size={24} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={[styles.actionText, { color: theme.primary }]}>Chapters</Text>
            </Pressable>
          )}

          <Pressable
            style={styles.actionButton}
            onPress={handleShare}
            accessibilityRole="button"
            accessibilityLabel="Share this audiobook"
          >
            <Ionicons name="share-social-outline" size={24} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.actionText, { color: theme.textSecondary }]}>Share</Text>
          </Pressable>

          {/* Reading mode toggle: cycles cover → follow → read → cover */}
          <View ref={readingModeToggleRef}>
          <Pressable
            style={styles.actionButton}
            onPress={() => {
              if (readingMode === 'cover') {
                if (currentWordTimings.length > 0) {
                  setReadingMode('follow');
                } else {
                  setReadingMode('read');
                }
              } else if (readingMode === 'follow') {
                setReadingMode('read');
              } else {
                setReadingMode('cover');
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={
              readingMode === 'follow' ? 'Switch to plain reading view' :
              readingMode === 'read'   ? 'Switch to cover view' :
                                         'Follow along with the text'
            }
          >
            <Ionicons
              name={
                readingMode === 'follow' ? 'text' :
                readingMode === 'read'   ? 'book-outline' :
                                           'text-outline'
              }
              size={24}
              color={readingMode !== 'cover' ? '#F7C948' : theme.textSecondary}
              accessibilityElementsHidden importantForAccessibility="no"
            />
            <Text style={[styles.actionText, { color: readingMode !== 'cover' ? '#F7C948' : theme.textSecondary }]}>
              {readingMode === 'follow' ? 'Read' : readingMode === 'read' ? 'Cover' : 'Follow'}
            </Text>
          </Pressable>
          </View>
        </View>
      </View>

      {/* Chapter List Modal */}
      {audiobook.chapters && audiobook.chapters.length > 0 && (
        <Modal
          visible={showChapterList}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setShowChapterList(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
              <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
                <Text style={[styles.modalTitle, { color: theme.text }]} accessibilityRole="header">Chapters</Text>
                <TouchableOpacity onPress={() => setShowChapterList(false)} accessibilityRole="button" accessibilityLabel="Close chapter list">
                  <Ionicons name="close" size={28} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
                </TouchableOpacity>
              </View>

              <FlatList
                data={audiobook.chapters}
                keyExtractor={(item) => item.id}
                renderItem={({ item, index }) => (
                  <TouchableOpacity
                    style={[
                      styles.chapterItem,
                      { borderBottomColor: theme.border },
                      index === currentChapterIndex && { backgroundColor: theme.primaryLight },
                    ]}
                    onPress={() => {
                      goToChapter(index);
                      setShowChapterList(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Chapter ${index + 1}, ${item.title}${index === currentChapterIndex ? ', now playing' : ''}`}
                    accessibilityState={{ selected: index === currentChapterIndex }}
                  >
                    <View style={styles.chapterItemContent}>
                      <Text style={[styles.chapterItemNumber, { color: theme.primary }]}>
                        {index + 1}
                      </Text>
                      <View style={styles.chapterItemInfo}>
                        <Text style={[styles.chapterItemTitle, { color: theme.text }]}>
                          {item.title}
                        </Text>
                        {index === currentChapterIndex && (
                          <Ionicons name="volume-high" size={16} color={theme.primary} />
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>
                )}
              />
            </View>
          </View>
        </Modal>
      )}

      <TutorialTooltip
        storageKey="@tutorial_player_reading_mode"
        targetRef={readingModeToggleRef}
        title="Follow along or read the text"
        body={"Tap this button to switch between modes:\n\n• Follow — highlights each word as it's spoken\n• Read — plain scrollable text\n• Cover — album art view\n\nInline images from your ebook appear in both text modes."}
        ctaLabel="Got it!"
        measureDelay={2000}
      />
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 17,
    marginLeft: 8,
    color: '#1e293b',
  },
  topSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Math.min(SCREEN_WIDTH * 0.05, 40),
  },
  bottomSection: {
    paddingHorizontal: Math.min(SCREEN_WIDTH * 0.05, 40),
    paddingBottom: 20,
    alignItems: 'center',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#64748b',
  },
  coverContainer: {
    alignItems: 'center',
    marginBottom: SCREEN_HEIGHT > 700 ? 20 : 10,
    width: '100%',
    maxWidth: 400,
  },
  coverPlaceholder: {
    width: Math.min(SCREEN_WIDTH * 0.5, 220),
    height: Math.min(SCREEN_WIDTH * 0.5, 220),
    maxWidth: 220,
    maxHeight: 220,
    borderRadius: 20,
    backgroundColor: '#ede9fe',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  coverImage: {
    width: Math.min(SCREEN_WIDTH * 0.5, 220),
    height: Math.min(SCREEN_WIDTH * 0.5, 220),
    maxWidth: 220,
    maxHeight: 220,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  trackInfo: {
    alignItems: 'center',
    marginBottom: SCREEN_HEIGHT > 700 ? 15 : 10,
    paddingHorizontal: 10,
    width: '100%',
    maxWidth: 400,
  },
  titleMarqueeContainer: {
    width: '100%',
    overflow: 'hidden',
    height: Math.ceil(Math.min(SCREEN_WIDTH * 0.06, 24) * 1.4),
    marginBottom: 8,
  },
  title: {
    fontSize: Math.min(SCREEN_WIDTH * 0.06, 24),
    fontWeight: 'bold',
    color: '#1e293b',
  },
  author: {
    fontSize: Math.min(SCREEN_WIDTH * 0.04, 16),
    color: '#64748b',
    marginBottom: 4,
    textAlign: 'center',
  },
  chapter: {
    fontSize: Math.min(SCREEN_WIDTH * 0.035, 14),
    color: '#94a3b8',
    textAlign: 'center',
  },
  progressContainer: {
    marginBottom: SCREEN_HEIGHT > 700 ? 10 : 5,
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
  },
  slider: {
    width: '100%',
    height: 40,
  },
  timeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  timeText: {
    fontSize: 12,
    color: '#64748b',
  },
  speedChipRow: {
    alignItems: 'center',
    marginBottom: 8,
  },
  speedChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    // backgroundColor + borderColor applied inline from theme (see render).
  },
  speedChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SCREEN_HEIGHT > 700 ? 20 : 10,
    gap: SCREEN_WIDTH > 400 ? 20 : 10,
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
  },
  controlButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: Math.min(SCREEN_WIDTH * 0.12, 50),
    height: Math.min(SCREEN_WIDTH * 0.12, 50),
    minWidth: 44,
    minHeight: 44,
  },
  speedText: {
    fontSize: Math.min(SCREEN_WIDTH * 0.04, 16),
    fontWeight: '600',
    color: '#6366f1',
  },
  skipText: {
    fontSize: Math.min(SCREEN_WIDTH * 0.025, 10),
    color: '#64748b',
    marginTop: -8,
  },
  playButton: {
    width: Math.min(SCREEN_WIDTH * 0.17, 70),
    height: Math.min(SCREEN_WIDTH * 0.17, 70),
    borderRadius: Math.min(SCREEN_WIDTH * 0.085, 35),
    minWidth: 60,
    minHeight: 60,
    backgroundColor: '#6366f1',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: SCREEN_WIDTH > 400 ? 20 : 10,
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
  },
  actionButton: {
    alignItems: 'center',
    minWidth: 60,
    minHeight: 44,
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  chapterItem: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  chapterItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  chapterItemNumber: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#6366f1',
    width: 40,
  },
  chapterItemInfo: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chapterItemTitle: {
    fontSize: 16,
    color: '#1e293b',
    flex: 1,
  },
  // Author Pro: karaoke container — stretches past topSection's center-align + padding
  karaokeContainer: {
    flex: 1,
    alignSelf: 'stretch',
    // Cancel the topSection's paddingHorizontal so the reader is truly edge-to-edge
    marginHorizontal: -Math.min(SCREEN_WIDTH * 0.05, 40),
  },
  karaokeHeader: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
    alignItems: 'center',
  },
  karaokeChapterLabel: {
    fontSize: 12,
    textAlign: 'center',
    letterSpacing: 0.3,
    marginTop: 2,
  },
  coverSyncHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 10,
  },
  coverSyncHintText: {
    fontSize: 12,
    fontWeight: '500',
  },
  // Plain-text reader
  plainTextScroll: {
    flex: 1,
  },
  plainTextContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 40,
  },
  plainTextBody: {
    fontSize: 17,
    lineHeight: 30,
    // `color` intentionally omitted — applied per-instance from `theme.text`
    // so this works in both light and dark mode.  Don't add a default here.
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 12,
  },
  plainTextImage: {
    width: '100%',
    height: 220,
    borderRadius: 10,
    marginVertical: 16,
  },
});

export default PlayerScreen;
