/**
 * SmartSetupScreen — Voice picker for EPUB conversion.
 *
 * Replaces the old AI-heavy "Author Pro" design with a clean Spotify-style
 * layout: featured voice cards at the top, searchable full list below.
 * Emotional Director and AI text-analysis have been removed — the screen
 * now loads in one API call and the user can start converting immediately.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList, Voice, Chapter } from '../types';
import ScreenWrapper from '../components/ScreenWrapper';
import ConversionLimitModal from '../components/ConversionLimitModal';
import AnonymousLimitModal from '../components/AnonymousLimitModal';
import { computeEpubSourceHash } from '../utils/sourceHash';
import { resolveConversionLimitState } from '../utils/conversionLimit';
import { parseWordCapRejection, presentWordCapRejection } from '../utils/wordCap';
import { track } from '../services/analytics';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useConversion } from '../context/ConversionContext';
import apiService from '../services/api';
import { createPreviewPlayer, AudioPlayerInterface } from '../utils/audioPlayer';
import {
  FEATURED_VOICE_IDS,
  voiceShortName,
  localeFlag,
  localeSearchTerms,
} from '../constants/featuredVoices';

type Nav = StackNavigationProp<RootStackParamList, 'SmartSetup'>;
type RouteP = RouteProp<RootStackParamList, 'SmartSetup'>;

export default function SmartSetupScreen() {
  const navigation = useNavigation<Nav>();
  const { isAnonymous } = useAuth();
  const route = useRoute<RouteP>();
  const { theme } = useTheme();
  const { startConversion } = useConversion();
  const { chapters, ebookTitle, coverUrl, language, imageUploadId } = route.params;

  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  const [search, setSearch] = useState('');
  const [limitModal, setLimitModal] = useState<{ used: number; max: number } | null>(null);
  const [anonymousLimitVisible, setAnonymousLimitVisible] = useState(false);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);

  const previewPlayerRef = useRef<AudioPlayerInterface | null>(null);
  const sourceHashRef = useRef<string | null>(null);

  // ── Load voices ──────────────────────────────────────────────────────────
  useEffect(() => {
    // Pass language to backend so it filters server-side — only voices for
    // the chosen language are returned. No client-side filtering needed.
    apiService.getVoices(language)
      .then(voices => {
        setVoices(voices);
        const featuredIds = FEATURED_VOICE_IDS[language] ?? [];
        const firstFeatured = voices.find(v => featuredIds.includes(v.id));
        setSelectedVoice(firstFeatured?.id ?? voices[0]?.id ?? '');
      })
      .catch(() => {/* voices stay empty; user sees empty state */})
      .finally(() => setLoading(false));
  }, [language]);

  // ── Source hash for retry-dedup ──────────────────────────────────────────
  useEffect(() => {
    const epubFile = (route.params as any)?.epubFile;
    if (epubFile?.uri) {
      computeEpubSourceHash(epubFile.uri, epubFile.file).then(h => {
        sourceHashRef.current = h;
      });
    }
  }, []);

  // ── Cleanup preview player on unmount ────────────────────────────────────
  useEffect(() => {
    return () => {
      previewPlayerRef.current?.unloadAsync();
    };
  }, []);

  // ── Derived data ─────────────────────────────────────────────────────────
  const featuredVoices = useMemo(() => {
    const ids = new Set(FEATURED_VOICE_IDS[language] ?? []);
    return voices.filter(v => ids.has(v.id));
  }, [voices, language]);

  // True when any multilingual voice is present — drives the badge, the
  // explainer line, and the dedicated sort tier. For non-English books these
  // are the only voices that can read mixed-language text, so they must surface
  // regardless of the book's detected language.
  const hasMultilingual = useMemo(() => voices.some(v => v.multilingual), [voices]);

  const filteredVoices = useMemo(() => {
    const q = search.toLowerCase().trim();
    const list = q
      ? voices.filter(v =>
          v.name.toLowerCase().includes(q) ||
          (v.gender ?? '').toLowerCase().includes(q) ||
          (v.multilingual === true && (
            'multilingual'.includes(q) ||
            'mixed language'.includes(q) ||
            'multi-language'.includes(q)
          )) ||
          localeSearchTerms(v.locale).some(term => term.includes(q))
        )
      : voices;
    // Sort into three tiers — Featured, then Multilingual, then the rest —
    // each alphabetical. The multilingual tier keeps mixed-language
    // voices near the top even when the book's home locale differs.
    const featuredIds = new Set(FEATURED_VOICE_IDS[language] ?? []);
    const tier = (v: Voice) =>
      featuredIds.has(v.id) ? 0 : v.multilingual === true ? 1 : 2;
    return [...list].sort((a, b) => {
      const t = tier(a) - tier(b);
      if (t !== 0) return t;
      return a.name.localeCompare(b.name);
    });
  }, [voices, search, language]);

  const estimatedTime = useMemo(() => {
    const words = chapters.reduce<number>(
      (sum, c) => sum + ((c.content ?? '') as string).split(/\s+/).length,
      0,
    );
    const mins = Math.max(1, Math.round(words / 150));
    if (mins < 60) return `~${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
  }, [chapters]);

  const selectedVoiceName = useMemo(() => {
    const v = voices.find(v => v.id === selectedVoice);
    return v ? voiceShortName(v.name) : '';
  }, [selectedVoice, voices]);

  // ── Voice preview ─────────────────────────────────────────────────────────
  const handlePreviewVoice = useCallback(async (voiceId: string) => {
    try {
      if (playingPreview === voiceId) {
        await previewPlayerRef.current?.unloadAsync();
        previewPlayerRef.current = null;
        setPlayingPreview(null);
        return;
      }
      await previewPlayerRef.current?.unloadAsync();
      previewPlayerRef.current = null;
      setPlayingPreview(voiceId);
      const url = await apiService.getVoicePreview(voiceId);
      const player = createPreviewPlayer();
      previewPlayerRef.current = player;
      player.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) setPlayingPreview(null);
      });
      await player.loadAsync(url);
      await player.playAsync();
    } catch {
      setPlayingPreview(null);
    }
  }, [playingPreview]);

  // ── Conversion ────────────────────────────────────────────────────────────
  const handleStartConversion = useCallback(async () => {
    if (converting || !selectedVoice) return;
    setConverting(true);
    try {
      const task = await apiService.convertChapters(
        chapters,
        selectedVoice,
        ebookTitle,
        false,    // Emotional Director — removed from UI, always off
        true,     // generate word timings (karaoke, always on)
        coverUrl,
        sourceHashRef.current,
        language,
        imageUploadId,
      );
      const wordCount = chapters.reduce(
        (sum: number, c: Chapter) => sum + (c.content ?? '').split(/\s+/).length,
        0,
      );
      track('conversion_started', {
        task_id: task.taskId,
        chapter_count: chapters.length,
        voice_id: selectedVoice,
        language,
      });
      startConversion(task.taskId, ebookTitle, selectedVoice);
      navigation.replace('Conversion', {
        taskId: task.taskId,
        epubName: ebookTitle,
        voiceId: selectedVoice,
        wordCount,
      });
    } catch (err: any) {
      setConverting(false);
      const data = err?.response?.data;
      const is403 = err?.response?.status === 403;
      if (is403 && data?.anonymous_limit_reached) {
        // Anonymous trial: device has already converted one book. Show the
        // sign-up wall instead of the monthly-limit modal — the user has no
        // account to "upgrade", they need to create one.
        setAnonymousLimitVisible(true);
      } else if (is403 && data?.limit_reached) {
        // The one hard wall: audiobook library full for this tier.
        const state = await resolveConversionLimitState(data);
        setLimitModal(state);
      } else if (parseWordCapRejection(err)) {
        // The tier word cap.  UploadScreen only guards the global infra
        // ceiling, so a free user's 120k-word book arrives here, at the
        // furthest-in point of the corridor.  The server names the cheapest
        // tier that clears it; hand the user straight to that tier.
        presentWordCapRejection(
          parseWordCapRejection(err)!,
          ((screen: any, params?: any) => navigation.navigate(screen, params)) as any,
          { isAnonymous },
        );
      } else {
        Alert.alert('Conversion Failed', err?.message ?? 'Something went wrong. Please try again.');
      }
    }
  }, [chapters, selectedVoice, ebookTitle, converting, navigation, startConversion, coverUrl, language, imageUploadId, isAnonymous]);

  // ── Sub-components ────────────────────────────────────────────────────────

  const FeaturedCard = ({ voice }: { voice: Voice }) => {
    const isSelected = voice.id === selectedVoice;
    const isPlaying = playingPreview === voice.id;
    const flag = localeFlag(voice.locale);
    const shortName = voiceShortName(voice.name);
    const genderLabel = voice.gender === 'Female' ? 'F' : voice.gender === 'Male' ? 'M' : '';

    const spokenVoice = `${shortName}${voice.gender ? ', ' + voice.gender : ''}${voice.multilingual ? ', multilingual' : ''}`;

    return (
      <TouchableOpacity
        style={[
          s.featCard,
          { backgroundColor: theme.card, borderColor: theme.border },
          isSelected && { borderColor: theme.primary, backgroundColor: theme.primaryLight },
        ]}
        onPress={() => {
          track('voice_selected', { voice_id: voice.id, language, from_featured: true });
          setSelectedVoice(voice.id);
        }}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={spokenVoice}
        accessibilityHint="Selects this narrator for the conversion"
        accessibilityState={{ selected: isSelected }}
      >
        <View style={[s.featIconRing, { backgroundColor: isSelected ? theme.primary + '22' : theme.surface }]} accessibilityElementsHidden importantForAccessibility="no">
          <Text style={s.featMicEmoji}>🎙️</Text>
        </View>
        <Text style={[s.featName, { color: theme.text }]} numberOfLines={1}>{shortName}</Text>
        <Text style={[s.featLocale, { color: theme.textSecondary }]} accessibilityElementsHidden importantForAccessibility="no">
          {flag} {genderLabel}{voice.multilingual ? ' · 🌐' : ''}
        </Text>
        <TouchableOpacity
          style={[s.featPlayBtn, { backgroundColor: isPlaying ? theme.primary : theme.surface }]}
          onPress={() => handlePreviewVoice(voice.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${shortName}'s voice`}
          accessibilityState={{ busy: isPlaying }}
        >
          {isPlaying
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="play" size={16} color={isPlaying ? '#fff' : theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
          }
        </TouchableOpacity>
        {isSelected && (
          <View style={[s.featSelectedBadge, { backgroundColor: theme.primary }]} accessibilityElementsHidden importantForAccessibility="no">
            <Ionicons name="checkmark" size={10} color="#fff" />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderVoiceRow = ({ item }: { item: Voice }) => {
    const isSelected = item.id === selectedVoice;
    const isPlaying = playingPreview === item.id;
    const flag = localeFlag(item.locale);
    const shortName = voiceShortName(item.name);

    const spokenVoice = `${shortName}${item.locale ? ', ' + item.locale : ''}${item.gender ? ', ' + item.gender : ''}${item.multilingual ? ', multilingual' : ''}`;

    return (
      <TouchableOpacity
        style={[
          s.row,
          { backgroundColor: theme.card, borderColor: theme.border },
          isSelected && { borderColor: theme.primary, backgroundColor: theme.primaryLight },
        ]}
        onPress={() => {
          track('voice_selected', { voice_id: item.id, language, from_featured: false });
          setSelectedVoice(item.id);
        }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={spokenVoice}
        accessibilityHint="Selects this narrator for the conversion"
        accessibilityState={{ selected: isSelected }}
      >
        <Text style={s.rowFlag} accessibilityElementsHidden importantForAccessibility="no">{flag}</Text>
        <View style={s.rowInfo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={[s.rowName, { color: theme.text }]} numberOfLines={1}>{shortName}</Text>
          <View style={s.rowMeta}>
            {item.locale ? (
              <View style={[s.chip, { backgroundColor: theme.surface }]}>
                <Text style={[s.chipText, { color: theme.textSecondary }]}>{item.locale}</Text>
              </View>
            ) : null}
            {item.gender ? (
              <View style={[s.chip, { backgroundColor: theme.surface }]}>
                <Text style={[s.chipText, { color: theme.textSecondary }]}>{item.gender}</Text>
              </View>
            ) : null}
            {item.multilingual ? (
              <View style={[s.chip, s.mlChip, { backgroundColor: theme.primaryLight }]}>
                <Ionicons name="globe-outline" size={11} color={theme.primary} />
                <Text style={[s.chipText, s.mlChipText, { color: theme.primary }]}>Multilingual</Text>
              </View>
            ) : null}
          </View>
        </View>
        {/* Play button — always visible */}
        <TouchableOpacity
          style={[s.rowPlayBtn, { backgroundColor: isPlaying ? theme.primary : theme.primaryLight }]}
          onPress={() => handlePreviewVoice(item.id)}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${shortName}'s voice`}
          accessibilityState={{ busy: isPlaying }}
        >
          {isPlaying
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="play" size={16} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
          }
        </TouchableOpacity>
        {isSelected
          ? <Ionicons name="checkmark-circle" size={22} color={theme.success} style={s.rowCheck} accessibilityElementsHidden importantForAccessibility="no" />
          : <View style={s.rowCheckPlaceholder} />
        }
      </TouchableOpacity>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ScreenWrapper applyBottomInset style={[s.root, { backgroundColor: theme.surface }]}>

      {/* Header */}
      <View style={[s.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
        <View style={s.headerMeta}>
          <Text style={[s.headerTitle, { color: theme.text }]} numberOfLines={1} accessibilityRole="header">{ebookTitle}</Text>
          <Text style={[s.headerSub, { color: theme.textSecondary }]}>
            {chapters.length} chapter{chapters.length !== 1 ? 's' : ''} · {estimatedTime}
          </Text>
        </View>
        <View style={[s.headerPill, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
          <Ionicons name="mic" size={14} color={theme.primary} />
        </View>
      </View>

      {loading ? (
        <View style={s.loadingCenter}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[s.loadingText, { color: theme.textSecondary }]}>Loading voices…</Text>
        </View>
      ) : (
        <FlatList
          data={filteredVoices}
          keyExtractor={item => item.id}
          renderItem={renderVoiceRow}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <>
              {/* Featured section */}
              {featuredVoices.length > 0 && (
                <View style={s.section}>
                  <Text style={[s.sectionLabel, { color: theme.textSecondary }]}>FEATURED</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={s.featRow}
                  >
                    {featuredVoices.map(v => <FeaturedCard key={v.id} voice={v} />)}
                  </ScrollView>
                </View>
              )}

              {/* All voices section */}
              <View style={s.section}>
                <Text style={[s.sectionLabel, { color: theme.textSecondary }]}>ALL VOICES</Text>
                {hasMultilingual && (
                  <Text style={[s.sectionHint, { color: theme.textSecondary }]}>
                    🌐 Multilingual voices read text that mixes languages — they switch automatically, sentence by sentence.
                  </Text>
                )}
                <View style={[s.searchBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
                  <Ionicons name="search" size={16} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search by name, accent, “multilingual”…"
                    placeholderTextColor={theme.textSecondary}
                    style={[s.searchInput, { color: theme.text }]}
                    autoCorrect={false}
                    autoCapitalize="none"
                    clearButtonMode="while-editing"
                    accessibilityLabel="Search voices by name or accent"
                  />
                  {search.length > 0 && Platform.OS !== 'ios' && (
                    <TouchableOpacity onPress={() => setSearch('')} accessibilityRole="button" accessibilityLabel="Clear search">
                      <Ionicons name="close-circle" size={16} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </>
          }
          ListEmptyComponent={
            <Text style={[s.empty, { color: theme.textSecondary }]}>
              {search ? `No voices match "${search}"` : 'No voices available for this language.'}
            </Text>
          }
        />
      )}

      {/* Sticky convert footer */}
      <View style={[s.footer, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
        <TouchableOpacity
          style={[
            s.convertBtn,
            { backgroundColor: selectedVoice ? theme.primary : theme.border },
          ]}
          onPress={handleStartConversion}
          disabled={!selectedVoice || converting}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={converting ? 'Starting conversion' : selectedVoiceName ? `Convert with ${selectedVoiceName}` : 'Select a voice first'}
          accessibilityHint={selectedVoice ? 'Starts converting your book to audio' : undefined}
          accessibilityState={{ disabled: !selectedVoice || converting, busy: converting }}
        >
          {converting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="play-circle" size={20} color="#fff" accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={s.convertText}>
                {selectedVoiceName ? `Convert with ${selectedVoiceName}` : 'Select a voice'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <ConversionLimitModal
        visible={!!limitModal}
        used={limitModal?.used ?? 0}
        max={limitModal?.max ?? 0}
        onClose={() => setLimitModal(null)}
        onUpgrade={() => { setLimitModal(null); navigation.navigate('Subscription'); }}
      />

      <AnonymousLimitModal
        visible={anonymousLimitVisible}
        onClose={() => setAnonymousLimitVisible(false)}
        onSignUp={() => {
          setAnonymousLimitVisible(false);
          navigation.navigate('SignUp');
        }}
      />

    </ScreenWrapper>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const FEAT_CARD_W = 120;

const s = StyleSheet.create({
  root: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerMeta: { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSub: { fontSize: 12, marginTop: 1 },
  headerPill: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },

  // Loading
  loadingCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 14 },

  // Sections
  section: { marginBottom: 8 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginBottom: 10 },
  sectionHint: { fontSize: 12, lineHeight: 17, marginHorizontal: 16, marginTop: -4, marginBottom: 12 },

  // Featured cards
  featRow: { paddingHorizontal: 16, gap: 12 },
  featCard: {
    width: FEAT_CARD_W,
    borderRadius: 14,
    borderWidth: 2,
    padding: 12,
    alignItems: 'center',
    gap: 6,
  },
  featIconRing: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  featMicEmoji: { fontSize: 22 },
  featName: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  featLocale: { fontSize: 11, textAlign: 'center' },
  featPlayBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  featSelectedBadge: {
    position: 'absolute', top: 8, right: 8,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },

  // Search
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 10, borderWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },

  // Browse rows
  listContent: { paddingTop: 16, paddingBottom: 24 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 16, marginBottom: 8,
    padding: 12, borderRadius: 12, borderWidth: 1.5,
  },
  rowFlag: { fontSize: 22 },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  chipText: { fontSize: 11 },
  mlChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mlChipText: { fontWeight: '700' },
  rowPlayBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
  },
  rowCheck: { marginLeft: 2 },
  rowCheckPlaceholder: { width: 22, marginLeft: 2 },

  // Empty
  empty: { textAlign: 'center', marginTop: 32, fontSize: 14 },

  // Footer
  footer: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderTopWidth: 1,
  },
  convertBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 14,
  },
  convertText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
