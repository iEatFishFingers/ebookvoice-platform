/**
 * LanguageSelectionScreen
 * =======================
 * Inserted between Upload and EbookReview. Asks the user which language the
 * book is in so the downstream voice picker (SmartSetup / VoiceSelection /
 * ChapterVoiceSelection) can be filtered to that language family.
 *
 * The picker pre-selects the EPUB's declared <dc:language> when supported,
 * falls back to English otherwise, and shows a banner when the declared
 * language isn't in our supported set so the user knows we're guessing.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import ScreenWrapper from '../components/ScreenWrapper';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from '../context/LanguageContext';
import { RootStackParamList, Voice } from '../types';
import apiService from '../services/api';
import { track } from '../services/analytics';
import {
  SUPPORTED_LANGUAGES,
  SupportedLanguage,
  DEFAULT_LANGUAGE_CODE,
  resolveSupportedLanguage,
} from '../constants/languages';

type Nav = StackNavigationProp<RootStackParamList, 'LanguageSelection'>;
type RouteP = RouteProp<RootStackParamList, 'LanguageSelection'>;

// Fixed row height (see styles.row) + marginBottom, so getItemLayout /
// scrollToIndex can land precisely on the auto-detected language.
const ITEM_STRIDE = 76;

export default function LanguageSelectionScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteP>();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const { epubFile, extractedChapters, extractedCoverUrl, bookLanguage, imageUploadId } = route.params;

  // Resolve EPUB-declared language to a supported code; fall back to English.
  const resolvedFromEpub = useMemo(() => resolveSupportedLanguage(bookLanguage), [bookLanguage]);
  const unsupportedDeclared = !!bookLanguage && !resolvedFromEpub;

  const [selected, setSelected] = useState<string>(resolvedFromEpub ?? DEFAULT_LANGUAGE_CODE);
  const [search, setSearch] = useState('');
  const [voiceCounts, setVoiceCounts] = useState<Record<string, number> | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(true);

  // Auto-scroll the list to the pre-selected (auto-detected) language so the
  // user can see it's already highlighted — e.g. a Japanese book otherwise
  // sits 10 rows down, looking unselected. Runs once on mount; the detected
  // code is stable, and search hasn't been touched yet, so list index ==
  // SUPPORTED_LANGUAGES index here.
  const listRef = useRef<FlatList<SupportedLanguage>>(null);
  const initialCode = resolvedFromEpub ?? DEFAULT_LANGUAGE_CODE;
  useEffect(() => {
    const index = SUPPORTED_LANGUAGES.findIndex(l => l.code === initialCode);
    if (index <= 0) return; // English (or unknown) is already at the top
    const t = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.35, animated: true });
    }, 300);
    return () => clearTimeout(t);
  }, [initialCode]);

  // Fetch the voice list once so we can show a "N voices" badge per language.
  // Cheap: /api/voices is cached server-side and the payload is ~30 KB.
  useEffect(() => {
    let cancelled = false;
    apiService
      .getVoices()
      .then((voices: Voice[]) => {
        if (cancelled) return;
        const counts: Record<string, number> = {};
        for (const v of voices) {
          const prefix = (v.locale ?? '').toLowerCase().split('-')[0];
          if (prefix) counts[prefix] = (counts[prefix] ?? 0) + 1;
        }
        setVoiceCounts(counts);
      })
      .catch(() => {
        if (!cancelled) setVoiceCounts({});
      })
      .finally(() => !cancelled && setLoadingCounts(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredLanguages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return SUPPORTED_LANGUAGES;
    return SUPPORTED_LANGUAGES.filter(
      lang =>
        lang.englishName.toLowerCase().includes(q) ||
        lang.nativeName.toLowerCase().includes(q) ||
        lang.code.startsWith(q),
    );
  }, [search]);

  const handleContinue = () => {
    track('language_selected', {
      language: selected,
      was_autodetected: selected === resolvedFromEpub,
    });
    navigation.navigate('EbookReview', {
      epubFile,
      extractedChapters,
      extractedCoverUrl,
      language: selected,
      imageUploadId: imageUploadId ?? null,
    });
  };

  const renderItem = ({ item }: { item: SupportedLanguage }) => {
    const isSelected = item.code === selected;
    const count = voiceCounts?.[item.code] ?? 0;
    return (
      <TouchableOpacity
        style={[
          styles.row,
          { backgroundColor: theme.card, borderColor: theme.border },
          isSelected && { borderColor: theme.primary, backgroundColor: theme.primaryLight },
        ]}
        activeOpacity={0.7}
        onPress={() => setSelected(item.code)}
        accessibilityRole="button"
        accessibilityLabel={`${item.nativeName}, ${loadingCounts ? t('lang.voices_loading') : count > 0 ? t('lang.voices_available', { count }) : t('lang.no_voices')}`}
        accessibilityState={{ selected: isSelected }}
      >
        <Text style={styles.flag} accessibilityElementsHidden importantForAccessibility="no">{item.flag}</Text>
        <View style={styles.rowText} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={[styles.rowName, { color: theme.text }]}>{item.nativeName}</Text>
          <Text style={[styles.rowSub, { color: theme.textSecondary }]}>
            {loadingCounts
              ? t('lang.voices_loading')
              : count > 0
                ? t('lang.voices_available', { count })
                : t('lang.no_voices')}
          </Text>
        </View>
        {isSelected && <Ionicons name="checkmark-circle" size={22} color={theme.success} accessibilityElementsHidden importantForAccessibility="no" />}
      </TouchableOpacity>
    );
  };

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
      <View style={styles.content}>
        <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
          <View style={[styles.headerIconWrap, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
            <Ionicons name="language" size={24} color={theme.primary} />
          </View>
          <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">{t('lang.title')}</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {t('lang.subtitle')}
          </Text>
        </View>

        {unsupportedDeclared && (
          <View style={[styles.banner, { backgroundColor: '#fffbeb', borderColor: '#fef3c7' }]}>
            <Ionicons name="warning-outline" size={18} color="#b45309" />
            <Text style={[styles.bannerText, { color: '#b45309' }]}>
              {t('lang.unsupported_banner', { lang: String(bookLanguage) })}
            </Text>
          </View>
        )}

        <View style={[styles.searchBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Ionicons name="search" size={18} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t('lang.search_placeholder')}
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={t('lang.search_placeholder')}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} accessibilityRole="button" accessibilityLabel={t('common.clear_search')}>
              <Ionicons name="close-circle" size={18} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
            </TouchableOpacity>
          )}
        </View>

        {loadingCounts ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={theme.primary} />
          </View>
        ) : null}

        <FlatList
          ref={listRef}
          data={filteredLanguages}
          keyExtractor={item => item.code}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: ITEM_STRIDE, offset: ITEM_STRIDE * index, index })}
          onScrollToIndexFailed={info => {
            listRef.current?.scrollToOffset({ offset: ITEM_STRIDE * info.index, animated: true });
          }}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[styles.empty, { color: theme.textSecondary }]}>
              {t('lang.no_match', { query: search })}
            </Text>
          }
        />

        <TouchableOpacity
          style={[styles.continueBtn, { backgroundColor: theme.primary }]}
          onPress={handleContinue}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('common.continue')}
          accessibilityHint={t('lang.continue_hint')}
        >
          <Text style={styles.continueText}>{t('common.continue')}</Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
      </View>
    </ScreenWrapper>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, padding: 16 },
  header: {
    flexDirection: 'column',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderBottomWidth: 1,
  },
  headerIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 13, marginTop: 4, textAlign: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  loading: { paddingVertical: 8, alignItems: 'center' },
  list: { paddingBottom: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  flag: { fontSize: 26 },
  rowText: { flex: 1 },
  rowName: { fontSize: 16, fontWeight: '600', lineHeight: 20 },
  rowSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 14 },
  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
  },
  continueText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
