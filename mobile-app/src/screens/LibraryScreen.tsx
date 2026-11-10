import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  Animated,
  Image,
  AppState,
  AppStateStatus,
} from 'react-native';
import * as Linking from 'expo-linking';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { RootStackParamList, Audiobook } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useConversion } from '../context/ConversionContext';
import { useDownload } from '../context/DownloadContext';
import apiService from '../services/api';
import OnboardingOverlay, { checkOnboarding } from '../components/OnboardingOverlay';
import { EPUB_SOURCES } from '../constants/epubSources';
import { track } from '../services/analytics';

type LibraryScreenNavigationProp = StackNavigationProp<RootStackParamList>;

// Fired once ever (per install) the first time a brand-new user reaches their
// library: drop them straight into the sample book playing. "Payoff before
// effort" — hear a book read aloud before being asked to find/convert one.
const FIRST_LISTEN_KEY = '@first_listen_v1';

const LibraryScreen = () => {
  const navigation = useNavigation<LibraryScreenNavigationProp>();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const { loading: authLoading, isAnonymous } = useAuth();
  const { activeConversion, activeConversions } = useConversion();
  const { getDownloadState, downloadAudiobook, deleteDownload } = useDownload();
  const [audiobooks, setAudiobooks] = useState<Audiobook[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Library filter (matches the App Store mockup's All / Recent pills).
  const [libTab, setLibTab] = useState<'All' | 'Recent'>('All');

  // Ref for the interactive tutorial spotlight. The old "create" spotlight
  // target is gone — book search moved to the Discover tab in the tab bar.
  const uploadBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);

  // Show onboarding on first visit
  useEffect(() => {
    checkOnboarding().then(isNew => {
      if (isNew) setShowOnboarding(true);
    });
  }, []);

  // First-launch first-listen: the first time a brand-new user's library loads,
  // send them straight into the sample book (auto-play unless VoiceOver — handled
  // in PlayerScreen). Fires once ever, and ONLY for an empty library — never
  // interrupts an established user who already has converted books.
  const firstListenCheckedRef = useRef(false);
  useEffect(() => {
    if (firstListenCheckedRef.current) return;
    const demo = audiobooks.find(b => b.isDemo);
    if (!demo) return; // library not loaded yet — wait for the sample to arrive
    firstListenCheckedRef.current = true;
    const hasRealBook = audiobooks.some(b => !b.isDemo);
    (async () => {
      const seen = await AsyncStorage.getItem(FIRST_LISTEN_KEY);
      if (seen === 'done') return;
      await AsyncStorage.setItem(FIRST_LISTEN_KEY, 'done');
      if (!hasRealBook) {
        navigation.navigate('Player', { audiobookId: demo.id, autoPlay: true });
      }
    })();
  }, [audiobooks]);

  // Spin animation for the active-conversion banner icon
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const isActive = !!(activeConversion && !activeConversion.complete && activeConversion.queueStatus !== 'queued');
    if (isActive) {
      Animated.loop(
        Animated.timing(spinAnim, { toValue: 1, duration: 1600, useNativeDriver: true }),
      ).start();
    } else {
      spinAnim.stopAnimation();
      spinAnim.setValue(0);
    }
  }, [activeConversion?.complete]);
  const spinStyle = { transform: [{ rotate: spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] };

  // Scanning animation for the indeterminate progress bar (before first poll)
  const scanAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const isUninitialized = !!(activeConversion && !activeConversion.complete && !activeConversion.initialized && activeConversion.queueStatus !== 'queued');
    if (isUninitialized) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scanAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
          Animated.timing(scanAnim, { toValue: 0, duration: 800, useNativeDriver: false }),
        ])
      ).start();
    } else {
      scanAnim.stopAnimation();
      scanAnim.setValue(0);
    }
  }, [activeConversion?.initialized, activeConversion?.complete]);

  // Pulse animation for the banner dot indicator
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const isActive = !!(activeConversion && !activeConversion.complete);
    if (isActive) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.6, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [activeConversion?.complete]);

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    if (mins < 60) {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hours}:${remainingMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const calculateTotalElapsedTime = (audiobook: Audiobook): number => {
    if (!audiobook.chapters || audiobook.chapters.length === 0) {
      return audiobook.currentPosition || 0;
    }

    let totalElapsed = audiobook.currentPosition || 0;
    const currentChapter = audiobook.currentChapter || 0;

    // Add duration of all completed chapters
    for (let i = 0; i < currentChapter && i < audiobook.chapters.length; i++) {
      totalElapsed += audiobook.chapters[i].duration || 0;
    }

    return totalElapsed;
  };

  useFocusEffect(
    React.useCallback(() => {
      if (!authLoading) {
        loadLibrary();
      }
    }, [authLoading])
  );

  // Refresh when app returns to foreground (e.g. user taps a push notification
  // while the Library tab is already active — useFocusEffect won't fire then).
  useEffect(() => {
    const onAppStateChange = (next: AppStateStatus) => {
      if (next === 'active') {
        loadLibrary();
      }
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => sub.remove();
  }, []);

  // Refresh when the user taps a push notification (conversion complete etc.)
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      loadLibrary();
    });
    return () => sub.remove();
  }, []);

  const loadLibrary = async () => {
    try {
      setLoading(true);
      setLoadError(null);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), 15000);
      });

      // Sync with database (AsyncStorage updated inside syncLibrary)
      const library = await Promise.race([
        apiService.syncLibrary(),
        timeoutPromise
      ]);

      setAudiobooks(library);
    } catch (error) {
      console.error('Error loading library:', error);

      // Fall back to local cache
      try {
        const localLibrary = await AsyncStorage.getItem('audiobook_library');
        if (localLibrary) {
          const cached = JSON.parse(localLibrary);
          setAudiobooks(cached);
        } else {
          setLoadError('Unable to load library. Please try again.');
        }
      } catch (localError) {
        console.error('Error loading local cache:', localError);
        setLoadError('Unable to load library. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAudiobook = async (audiobookId: string, title: string) => {
    // Use native confirm on web, Alert.alert on mobile
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(`Are you sure you want to delete "${title}"?`);
      if (confirmed) {
        await deleteAudiobook(audiobookId);
      }
    } else {
      Alert.alert(
        'Delete Audiobook',
        `Are you sure you want to delete "${title}"?`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
          },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              await deleteAudiobook(audiobookId);
            }
          }
        ]
      );
    }
  };

  const deleteAudiobook = async (audiobookId: string) => {
    // Optimistic UI: remove the book from the visible list immediately, then
    // fire the server delete in the background. The server returns as soon
    // as the DB row is gone (Cloudinary cleanup happens server-side in a
    // background thread), so the await typically resolves in <500 ms — but
    // we don't make the user wait for that either.
    const before = audiobooks;
    const removed = before.find(b => String(b.id) === String(audiobookId));
    const optimisticLibrary = before.filter(b => String(b.id) !== String(audiobookId));
    setAudiobooks(optimisticLibrary);
    AsyncStorage.setItem('audiobook_library', JSON.stringify(optimisticLibrary)).catch(() => {});
    deleteDownload(audiobookId).catch(() => {});

    try {
      await apiService.deleteAudiobook(audiobookId);
    } catch (error) {
      console.error('Error deleting audiobook:', error);
      // Rollback: server delete failed, put the book back in the list so the
      // user can retry. Without this the local state would lie about the
      // server state.
      if (removed) {
        const restored = [removed, ...optimisticLibrary];
        setAudiobooks(restored);
        AsyncStorage.setItem('audiobook_library', JSON.stringify(restored)).catch(() => {});
      }
      if (Platform.OS === 'web') {
        alert('Failed to delete audiobook. Please try again.');
      } else {
        Alert.alert('Error', 'Failed to delete audiobook. Please try again.');
      }
    }
  };

  const renderAudiobook = ({ item, index }: { item: Audiobook; index: number }) => {
    const dlState = getDownloadState(item.id);
    const grad = theme.cardGradients[index % theme.cardGradients.length] as [string, string];
    const downloaded = dlState.status === 'downloaded';

    // Spoken description for the whole card (VoiceOver reads this in place of the
    // separate cover/title/progress visuals).
    const statusSpoken =
      item.status === 'processing'
        ? ', converting'
        : item.status === 'completed' && item.progress > 0
        ? `, ${Math.round(item.progress)} percent played`
        : '';
    const cardA11yLabel = `${item.title}${item.author || item.voiceName ? `, ${item.author || item.voiceName}` : ''}${item.isDemo ? ', sample book' : ''}${statusSpoken}`;

    return (
      <TouchableOpacity
        style={styles.gridCard}
        activeOpacity={0.85}
        onPress={() => {
          track('library_book_opened', { audiobook_id: item.id });
          navigation.navigate('Player', { audiobookId: item.id });
        }}
        accessibilityRole="button"
        accessibilityLabel={cardA11yLabel}
        accessibilityHint="Opens the audiobook player"
        // The card is ONE VoiceOver element (RN merges children), so the
        // nested delete/insights/download chips are unreachable by swipe.
        // Expose them as custom rotor actions instead — swipe up/down on
        // the focused card to pick an action, double-tap to run it.
        accessibilityActions={[
          ...(!isAnonymous && !item.isDemo ? [{ name: 'delete', label: `Delete ${item.title}` }] : []),
          ...(Platform.OS !== 'web' && item.status === 'completed' && !downloaded
            ? [{ name: 'download', label: 'Download for offline listening' }] : []),
        ]}
        onAccessibilityAction={(e: any) => {
          const action = e.nativeEvent.actionName;
          if (action === 'delete' && !isAnonymous && !item.isDemo) handleDeleteAudiobook(item.id, item.title);
          else if (action === 'download' && dlState.status !== 'downloading' && !downloaded) downloadAudiobook(item);
        }}
      >
        {/* Cover: real art if present, else the signature duotone gradient */}
        <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gridBg} />
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.gridCover} resizeMode="cover" accessibilityElementsHidden importantForAccessibility="no" />
        ) : (
          <Ionicons name="book" size={30} color="rgba(255,255,255,0.30)" style={styles.gridGlyph} accessibilityElementsHidden importantForAccessibility="no" />
        )}

        {/* Top row: delete (left) + play (right). Anonymous users can't
            delete — the trial gate is row-existence, so deletion would
            reopen unlimited free conversions (backend also enforces 403).
            The shared sample book can't be deleted either (backend 403);
            it shows a "Sample" pill in the delete chip's spot instead. */}
        {item.isDemo ? (
          <View style={[styles.gridChip, styles.gridChipTL, styles.gridSamplePill]} accessibilityElementsHidden importantForAccessibility="no">
            <Text style={styles.gridSampleText}>Sample</Text>
          </View>
        ) : !isAnonymous && (
          <TouchableOpacity
            style={[styles.gridChip, styles.gridChipTL]}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            onPress={(e) => { e.stopPropagation(); handleDeleteAudiobook(item.id, item.title); }}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${item.title}`}
          >
            <Ionicons name="trash-outline" size={14} color="#fff" accessibilityElementsHidden importantForAccessibility="no" />
          </TouchableOpacity>
        )}

        <View style={styles.gridTopRight}>
          {!isAnonymous && (
            <TouchableOpacity
              style={styles.gridChip}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              onPress={(e) => {
                e.stopPropagation();
                navigation.navigate('AnalyticsDashboard', {
                  audiobookId: item.id,
                  audiobookTitle: item.title,
                  audiobookAuthor: item.author,
                  audiobookDescription: item.description,
                  audiobookCoverUrl: item.coverUrl,
                  chapterTitles: (item.chapters ?? []).map((c: any) => c.title ?? ''),
                });
              }}
              accessibilityRole="button"
              accessibilityLabel={`Listening insights for ${item.title}`}
            >
              <Ionicons name="create-outline" size={14} color="#fff" accessibilityElementsHidden importantForAccessibility="no" />
            </TouchableOpacity>
          )}
          {Platform.OS !== 'web' && item.status === 'completed' && (
            <TouchableOpacity
              style={styles.gridChip}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              onPress={(e) => {
                e.stopPropagation();
                if (dlState.status === 'none' || dlState.status === 'failed') downloadAudiobook(item);
              }}
              accessibilityRole="button"
              accessibilityLabel={
                downloaded ? `${item.title} downloaded for offline` :
                dlState.status === 'downloading' ? `Downloading ${item.title}` :
                `Download ${item.title} for offline listening`
              }
              accessibilityState={{ disabled: downloaded || dlState.status === 'downloading', busy: dlState.status === 'downloading' }}
            >
              <Ionicons
                name={downloaded ? 'checkmark-circle' : dlState.status === 'downloading' ? 'cloud-download' : 'cloud-download-outline'}
                size={14}
                color="#fff"
                accessibilityElementsHidden importantForAccessibility="no"
              />
            </TouchableOpacity>
          )}
          <View style={[styles.gridChip, styles.gridPlay]} accessibilityElementsHidden importantForAccessibility="no">
            <Ionicons name="play" size={14} color="#fff" />
          </View>
        </View>

        {/* Bottom overlay: title, author/voice, progress — spoken via the card's
            accessibilityLabel, so hidden from the screen reader to avoid repetition */}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.88)']} style={styles.gridOverlay} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={styles.gridTitle} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.gridAuthor} numberOfLines={1}>{item.author || item.voiceName}</Text>
          {item.status === 'processing' ? (
            <Text style={styles.gridConverting}>Converting…</Text>
          ) : item.status === 'completed' && item.progress > 0 ? (
            <View style={styles.gridProgressTrack}>
              <View style={[styles.gridProgressFill, { width: `${item.progress}%`, backgroundColor: theme.primary }]} />
            </View>
          ) : null}
        </LinearGradient>
      </TouchableOpacity>
    );
  };

  if (loading || authLoading) {
    return (
      <ScreenWrapper style={[styles.container, { backgroundColor: theme.surface }]}>
        <View style={styles.emptyState}>
          <Ionicons name="library-outline" size={48} color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.text }]}>Loading library...</Text>
        </View>
      </ScreenWrapper>
    );
  }

  if (loadError && audiobooks.length === 0) {
    return (
      <ScreenWrapper style={[styles.container, { backgroundColor: theme.surface }]}>
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={64} color={theme.error} />
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Connection Error</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>
            {loadError}
          </Text>
          <TouchableOpacity
            style={[styles.retryButton, { backgroundColor: theme.primary }]}
            onPress={loadLibrary}
          >
            <Ionicons name="refresh-outline" size={20} color="#ffffff" />
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </ScreenWrapper>
    );
  }

  if (audiobooks.length === 0) {
    return (
      <ScreenWrapper style={[styles.container, { backgroundColor: theme.surface }]}>
        {activeConversion && !activeConversion.complete && (
          <TouchableOpacity
            onPress={() => navigation.navigate('Conversion', {
              taskId: activeConversion.taskId,
              epubName: activeConversion.epubName,
              voiceId: activeConversion.voiceId,
            })}
            style={[styles.conversionBanner, { backgroundColor: theme.primary + '12', borderColor: theme.primary + '35' }]}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={`${activeConversion.epubName.replace(/\.epub$/i, '')} is converting${activeConversion.initialized ? `, ${Math.round(activeConversion.progress * 100)} percent done` : ''}`}
            accessibilityHint="Opens the conversion progress screen"
          >
            <View style={styles.conversionBannerRow}>
              {/* Live pulse dot */}
              <View style={styles.liveIndicator}>
                <Animated.View style={[styles.livePulse, {
                  backgroundColor: theme.primary + '30',
                  transform: [{ scale: pulseAnim }],
                }]} />
                <View style={[styles.liveDot, { backgroundColor: theme.primary }]} />
              </View>

              {/* Icon */}
              {activeConversion.queueStatus === 'queued' ? (
                <Ionicons name="time-outline" size={16} color={theme.primary} />
              ) : (
                <Animated.View style={spinStyle}>
                  <Ionicons name="sync-outline" size={16} color={theme.primary} />
                </Animated.View>
              )}

              {/* Title + sub-status */}
              <View style={{ flex: 1 }}>
                <Text style={[styles.conversionBannerText, { color: theme.primary }]} numberOfLines={1}>
                  {activeConversion.epubName.replace(/\.epub$/i, '')}
                </Text>
                <Text style={[styles.conversionBannerSub, { color: theme.primary + 'aa' }]} numberOfLines={1}>
                  {activeConversion.queueStatus === 'queued'
                    ? (activeConversion.queuePosition != null ? `#${activeConversion.queuePosition} in queue — waiting` : 'Queued — waiting to start')
                    : (activeConversion.status ?? 'Converting...')}
                </Text>
              </View>

              {/* % + chevron */}
              <Text style={[styles.conversionBannerPct, { color: theme.primary }]}>
                {activeConversion.queueStatus === 'queued'
                  ? ''
                  : activeConversion.initialized ? `${Math.round(activeConversion.progress * 100)}%` : '...'}
              </Text>
              <Ionicons name="chevron-forward" size={14} color={theme.primary + '80'} />
            </View>

            {/* Progress track */}
            {activeConversion.queueStatus !== 'queued' && (
              <View style={[styles.conversionBannerTrack, { backgroundColor: theme.border }]}>
                {activeConversion.initialized ? (
                  <View style={[styles.conversionBannerFill, {
                    backgroundColor: theme.primary,
                    width: `${Math.max(2, Math.round(activeConversion.progress * 100))}%` as any,
                  }]} />
                ) : (
                  <Animated.View style={[styles.conversionBannerFill, {
                    backgroundColor: theme.primary,
                    width: scanAnim.interpolate({ inputRange: [0, 1], outputRange: ['15%', '55%'] }),
                  }]} />
                )}
              </View>
            )}
          </TouchableOpacity>
        )}
        {/* Empty-library state — restates the value prop AND offers a
            curated list of LEGAL free-EPUB sources for users who don't
            have a book of their own yet. Designed to cut the cold-start
            churn pattern we observed across 2026-05-28/29: 5 of 6 new
            installs left without uploading anything.
            Sources list lives in constants/epubSources.ts — never add
            piracy sites (App Store Guideline 5.2 + brand mission). */}
        <ScrollView
          contentContainerStyle={styles.emptyScroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Claim banner on empty state too — anonymous users hit this
              every cold launch until they convert their first book. */}
          {isAnonymous && (
            <TouchableOpacity
              onPress={() => navigation.navigate('SignUp')}
              style={[styles.claimBanner, { backgroundColor: theme.primary + '15', borderColor: theme.primary + '40', marginBottom: 16 }]}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Sign up to keep your audiobooks forever. Convert more books and access them on any device"
            >
              <Ionicons name="person-add" size={20} color={theme.primary} style={{ marginRight: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.claimBannerTitle, { color: theme.text }]}>
                  Sign up to keep your audiobooks forever
                </Text>
                <Text style={[styles.claimBannerSubtitle, { color: theme.textSecondary }]}>
                  Convert more books and access them on any device
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.primary} />
            </TouchableOpacity>
          )}
          <View style={styles.emptyState}>
            <Ionicons name="library-outline" size={64} color={theme.border} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>{t('library.empty_title')}</Text>
            <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>
              {t('library.empty_subtitle')}
            </Text>
            <View style={styles.buttonRow}>
              {/* "Find a Book" jumps to the Discover tab — present in both
                  the authenticated and anonymous tab navigators. */}
              {/* Find a Book (Discover) is the PRIMARY action — filled — because
                  the in-app public-domain catalog is the path that actually
                  activates users. Upload-your-own is the secondary outline below. */}
              <TouchableOpacity
                style={[styles.uploadButton, { backgroundColor: theme.primary }]}
                onPress={() => {
                  track('library_search_tapped', { source: 'empty_state' });
                  if (isAnonymous) {
                    navigation.navigate('AnonymousMain', { screen: 'Discover' });
                  } else {
                    navigation.navigate('Main', { screen: 'Discover' });
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel="Find a book"
                accessibilityHint="Opens the Discover tab to search free public-domain books"
              >
                <Ionicons name="search-outline" size={20} color="#ffffff" accessibilityElementsHidden importantForAccessibility="no" />
                <Text style={styles.uploadButtonText}>{t('library.find_book')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.createButton, { backgroundColor: theme.card, borderColor: theme.primary }]}
                onPress={() => {
                  track('library_upload_tapped', { source: 'empty_state' });
                  navigation.navigate('Upload');
                }}
                accessibilityRole="button"
                accessibilityLabel="Upload an EPUB"
                accessibilityHint="Pick an EPUB file from your device to convert"
              >
                <Ionicons name="cloud-upload-outline" size={20} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
                <Text style={[styles.createButtonText, { color: theme.primary }]}>{t('library.upload_epub')}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.sourcesSection}>
            <Text style={[styles.sourcesTitle, { color: theme.text }]}>
              Don't have an EPUB yet?
            </Text>
            <Text style={[styles.sourcesSubtitle, { color: theme.textSecondary }]}>
              Here are a few free libraries to get you started:
            </Text>
            {EPUB_SOURCES.map(source => (
              <TouchableOpacity
                key={source.id}
                // Indigo-tinted border matches the conversionBanner pattern;
                // in dark mode theme.card === theme.surface so a neutral
                // theme.border line is barely visible. Using primary+'40'
                // gives a clear ~25% alpha accent in both modes.
                style={[styles.sourceCard, { backgroundColor: theme.card, borderColor: theme.primary + '40' }]}
                accessibilityRole="link"
                accessibilityLabel={`${source.name}. ${source.description}`}
                accessibilityHint="Opens in your browser"
                onPress={() => {
                  track('epub_source_opened', { source: source.id });
                  Linking.openURL(source.url).catch(err => {
                    // Surfacing this isn't worth interrupting the user — if the
                    // OS refuses to open the URL, they'll just see nothing happen.
                    // PostHog will still record the tap so we can spot a pattern.
                    console.warn(`[LibraryScreen] failed to open ${source.url}:`, err);
                  });
                }}
                activeOpacity={0.75}
              >
                <View style={styles.sourceCardText}>
                  <Text style={[styles.sourceName, { color: theme.text }]}>{source.name}</Text>
                  <Text style={[styles.sourceDescription, { color: theme.textSecondary }]}>
                    {source.description}
                  </Text>
                </View>
                <Ionicons name="open-outline" size={20} color={theme.primary} />
              </TouchableOpacity>
            ))}
            <Text style={[styles.sourcesDisclaimer, { color: theme.textSecondary }]}>
              Looking for a specific book? You'll need to source the EPUB yourself.
              EbookVoice converts the books you bring — it doesn't sell or host them.
            </Text>
          </View>
        </ScrollView>
      </ScreenWrapper>
    );
  }

  return (
    <ScreenWrapper style={[styles.container, { backgroundColor: theme.surface }]}>
      <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">My Library</Text>
        <View style={styles.headerButtons}>
          {/* The old header search (pencil) button is gone — book search now
              lives in the Discover tab. The upload button remains. */}
          <TouchableOpacity
            ref={uploadBtnRef}
            onPress={() => {
              track('library_upload_tapped', { source: 'header' });
              navigation.navigate('Upload');
            }}
            accessibilityRole="button"
            accessibilityLabel="Upload an EPUB"
          >
            <Ionicons name="add-circle-outline" size={28} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
          </TouchableOpacity>
        </View>
      </View>
      {/* Anonymous claim banner — shown above any other library content.
          Always invites sign-up because that's the moment we want to capture. */}
      {isAnonymous && (
        <TouchableOpacity
          onPress={() => navigation.navigate('SignUp')}
          style={[styles.claimBanner, { backgroundColor: theme.primary + '15', borderColor: theme.primary + '40' }]}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Sign up to keep your audiobooks forever. Convert more books and access them on any device"
        >
          <Ionicons name="person-add" size={20} color={theme.primary} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.claimBannerTitle, { color: theme.text }]}>
              Sign up to keep your audiobooks forever
            </Text>
            <Text style={[styles.claimBannerSubtitle, { color: theme.textSecondary }]}>
              Convert more books and access them on any device
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={theme.primary} />
        </TouchableOpacity>
      )}
      {activeConversion && !activeConversion.complete && (
        <TouchableOpacity
          onPress={() => navigation.navigate('Conversion', {
            taskId: activeConversion.taskId,
            epubName: activeConversion.epubName,
            voiceId: activeConversion.voiceId,
          })}
          style={[styles.conversionBanner, { backgroundColor: theme.primary + '12', borderColor: theme.primary + '35' }]}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={`${activeConversion.epubName.replace(/\.epub$/i, '')} is converting${activeConversion.initialized ? `, ${Math.round(activeConversion.progress * 100)} percent done` : ''}`}
          accessibilityHint="Opens the conversion progress screen"
        >
          <View style={styles.conversionBannerRow}>
            <View style={styles.liveIndicator}>
              <Animated.View style={[styles.livePulse, {
                backgroundColor: theme.primary + '30',
                transform: [{ scale: pulseAnim }],
              }]} />
              <View style={[styles.liveDot, { backgroundColor: theme.primary }]} />
            </View>
            {activeConversion.queueStatus === 'queued' ? (
              <Ionicons name="time-outline" size={16} color={theme.primary} />
            ) : (
              <Animated.View style={spinStyle}>
                <Ionicons name="sync-outline" size={16} color={theme.primary} />
              </Animated.View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={[styles.conversionBannerText, { color: theme.primary }]} numberOfLines={1}>
                {activeConversion.epubName.replace(/\.epub$/i, '')}
              </Text>
              <Text style={[styles.conversionBannerSub, { color: theme.primary + 'aa' }]} numberOfLines={1}>
                {activeConversion.queueStatus === 'queued'
                  ? (activeConversion.queuePosition != null ? `#${activeConversion.queuePosition} in queue — waiting` : 'Queued — waiting to start')
                  : (activeConversion.status ?? 'Converting...')}
              </Text>
            </View>
            <Text style={[styles.conversionBannerPct, { color: theme.primary }]}>
              {activeConversion.queueStatus === 'queued'
                ? ''
                : activeConversion.initialized ? `${Math.round(activeConversion.progress * 100)}%` : '...'}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={theme.primary + '80'} />
          </View>
          {activeConversion.queueStatus !== 'queued' && (
            <View style={[styles.conversionBannerTrack, { backgroundColor: theme.border }]}>
              {activeConversion.initialized ? (
                <View style={[styles.conversionBannerFill, {
                  backgroundColor: theme.primary,
                  width: `${Math.max(2, Math.round(activeConversion.progress * 100))}%` as any,
                }]} />
              ) : (
                <Animated.View style={[styles.conversionBannerFill, {
                  backgroundColor: theme.primary,
                  width: scanAnim.interpolate({ inputRange: [0, 1], outputRange: ['15%', '55%'] }),
                }]} />
              )}
            </View>
          )}
        </TouchableOpacity>
      )}
      <FlatList
        data={libTab === 'Recent'
          ? [...audiobooks].sort((a, b) => (b.progress || 0) - (a.progress || 0))
          : audiobooks}
        renderItem={renderAudiobook}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.libMetaRow}>
            <Text style={[styles.libCount, { color: theme.textSecondary }]}>
              {audiobooks.length} audiobook{audiobooks.length === 1 ? '' : 's'}
            </Text>
            <View style={styles.libTabs}>
              {(['All', 'Recent'] as const).map((t) => (
                <TouchableOpacity
                  key={t}
                  onPress={() => setLibTab(t)}
                  style={[styles.libTab, libTab === t && { backgroundColor: theme.primary + '28' }]}
                  accessibilityRole="tab"
                  accessibilityLabel={`${t} books`}
                  accessibilityState={{ selected: libTab === t }}
                >
                  <Text style={[styles.libTabText, { color: libTab === t ? theme.accent : theme.textSecondary }]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        }
      />

      <OnboardingOverlay
        visible={showOnboarding}
        onComplete={() => setShowOnboarding(false)}
        onNavigateUpload={() => { setShowOnboarding(false); navigation.navigate('Upload'); }}
        onNavigateCreate={() => { setShowOnboarding(false); navigation.navigate('Main', { screen: 'Discover' }); }}
        uploadBtnRef={uploadBtnRef}
      />
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  list: {
    padding: 16,
    paddingBottom: 100,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  // ── Redesigned library: count + All/Recent pills ──
  libMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    paddingHorizontal: 2,
  },
  libCount: { fontSize: 13, fontWeight: '500' },
  libTabs: { flexDirection: 'row', gap: 4 },
  libTab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  libTabText: { fontSize: 13, fontWeight: '600' },
  // ── Gradient grid cards ──
  gridRow: { justifyContent: 'space-between' },
  gridCard: {
    width: '48%',
    aspectRatio: 0.74,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 12,
    backgroundColor: '#1f1f33',
  },
  gridBg: { ...StyleSheet.absoluteFillObject },
  gridCover: { ...StyleSheet.absoluteFillObject },
  gridGlyph: { position: 'absolute', top: '30%', left: 0, right: 0, textAlign: 'center' },
  gridTopRight: { position: 'absolute', top: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  gridChip: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center', justifyContent: 'center',
  },
  gridChipTL: { position: 'absolute', top: 8, left: 8, zIndex: 2 },
  gridPlay: { backgroundColor: '#6366f1' },
  // "Sample" pill on the shared demo book — same spot as the delete chip,
  // but wider than the 26px circle to fit the word.
  gridSamplePill: { width: undefined, paddingHorizontal: 8, backgroundColor: '#6366f1' },
  gridSampleText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  gridOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 10, paddingTop: 26, paddingBottom: 11,
  },
  gridTitle: { color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 16 },
  gridAuthor: { color: 'rgba(255,255,255,0.72)', fontSize: 11, marginTop: 2 },
  gridConverting: { color: '#fff', fontSize: 10, fontWeight: '600', marginTop: 6 },
  gridProgressTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginTop: 8, overflow: 'hidden' },
  gridProgressFill: { height: '100%', borderRadius: 2 },
  audiobookCard: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Author Pro: card action column (analytics + delete stacked)
  cardActions: {
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 8,
    gap: 8,
  },
  analyticsChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  analyticsChipText: {
    fontSize: 11,
    fontWeight: '600',
  },
  deleteButton: {
    padding: 6,
  },
  downloadButton: {
    padding: 6,
    alignItems: 'center',
  },
  downloadPct: {
    fontSize: 9,
    fontWeight: '700',
    marginTop: 1,
  },
  coverPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  coverImage: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  audiobookInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  audiobookTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  audiobookVoice: {
    fontSize: 14,
    marginBottom: 4,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginTop: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  progressContainer: {
    marginTop: 8,
    width: '100%',
  },
  progressBarBackground: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    width: '100%',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  progressText: {
    fontSize: 11,
    marginTop: 4,
  },
  emptyScroll: {
    // ScrollView needs flexGrow on its content container so a short
    // page (e.g. just the buttons, no sources visible yet on a tiny
    // screen) still vertically centers the hero area instead of
    // hugging the top.
    flexGrow: 1,
    paddingBottom: 32,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingTop: 48,
    paddingBottom: 24,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 20,
  },
  sourcesSection: {
    marginTop: 24,
    marginHorizontal: 16,
    paddingHorizontal: 8,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  sourcesTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  sourcesSubtitle: {
    fontSize: 13,
    marginBottom: 14,
  },
  sourceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    gap: 12,
  },
  sourceCardText: {
    flex: 1,
  },
  sourceName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  sourceDescription: {
    fontSize: 12,
    lineHeight: 16,
  },
  sourcesDisclaimer: {
    fontSize: 11,
    marginTop: 14,
    lineHeight: 16,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 2,
    gap: 8,
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    gap: 8,
  },
  uploadButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  loadingText: {
    fontSize: 16,
    marginTop: 16,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    gap: 8,
    marginTop: 16,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  claimBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  claimBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  claimBannerSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  conversionBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
    gap: 7,
  },
  conversionBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  conversionBannerText: {
    fontSize: 13,
    fontWeight: '700',
  },
  conversionBannerSub: {
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },
  conversionBannerPct: {
    fontSize: 13,
    fontWeight: '800',
    minWidth: 36,
    textAlign: 'right',
  },
  conversionBannerTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  conversionBannerFill: {
    height: '100%',
    borderRadius: 2,
  },
  liveIndicator: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  livePulse: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});

export default LibraryScreen;
