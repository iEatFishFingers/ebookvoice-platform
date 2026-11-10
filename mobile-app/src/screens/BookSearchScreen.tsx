/**
 * BookSearchScreen — the "Discover" tab
 * ─────────────────────────────────────
 * The in-app public-domain library: search Project Gutenberg
 * and browse by category. Tap a book → BookDetailScreen → convert.
 *
 * Lives as the Discover tab root in TabNavigator (no back button — the tab
 * bar is the way out). SOURCE-LOCK: search hits our self-hosted catalog
 * (display only); the actual EPUB ingestion goes through the backend
 * /extract-gutenberg (server-side, gutenberg.org only). See CLAUDE.md.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AccessibilityInfo, View, Text, TextInput, FlatList, TouchableOpacity, Image,
  ActivityIndicator, StyleSheet, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from '../context/LanguageContext';
import ScreenWrapper from '../components/ScreenWrapper';
import apiService, { GutenbergBook } from '../services/api';
import { track } from '../services/analytics';

// Display category → Gutendex `topic` (matches subjects + bookshelves).
// `label` is the STABLE English name (kept for analytics + logic); `key` is the
// i18n key used for the visible chip text.
const CATEGORIES: { label: string; key: string; topic: string; icon: string }[] = [
  { label: 'Fiction',   key: 'discover.cat_fiction',   topic: 'fiction',   icon: 'book-outline' },
  { label: 'Romance',   key: 'discover.cat_romance',   topic: 'love',      icon: 'heart-outline' },
  { label: 'Religion',  key: 'discover.cat_religion',  topic: 'religion',  icon: 'flower-outline' },
  { label: 'Education', key: 'discover.cat_education', topic: 'education', icon: 'school-outline' },
  { label: 'History',   key: 'discover.cat_history',   topic: 'history',   icon: 'time-outline' },
  { label: 'Adventure', key: 'discover.cat_adventure', topic: 'adventure', icon: 'compass-outline' },
  { label: 'Mystery',   key: 'discover.cat_mystery',   topic: 'detective', icon: 'search-outline' },
  { label: 'Children',  key: 'discover.cat_children',  topic: 'children',  icon: 'happy-outline' },
  { label: 'Poetry',    key: 'discover.cat_poetry',    topic: 'poetry',    icon: 'musical-notes-outline' },
  { label: 'Science',   key: 'discover.cat_science',   topic: 'science',   icon: 'flask-outline' },
];

const DEBOUNCE_MS = 350;

export default function BookSearchScreen({ navigation }: any) {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0]);
  const [books, setBooks] = useState<GutenbergBook[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const runSearch = useCallback(async (q: string, category: typeof CATEGORIES[0]) => {
    const myReq = ++reqId.current;
    setLoading(true);
    try {
      const results = q.trim().length > 0
        ? await apiService.searchGutenbergBooks(q)
        : await apiService.getGutenbergBooksByCategory(category.topic);
      if (myReq === reqId.current) {
        setBooks(results);
        // Funnel: one event per executed (debounced) search/browse. `query`
        // empty means category browse. results_count tells us where the
        // catalog comes up empty — demand we don't serve yet.
        track('discover_search_performed', {
          query: q.trim(),
          category: q.trim().length > 0 ? undefined : category.label,
          results_count: results.length,
        });
        // The debounced search updates silently — tell screen-reader users
        // what happened (VoiceOver announces this without moving focus).
        AccessibilityInfo.announceForAccessibility(
          results.length === 0
            ? t('discover.announce_none')
            : t('discover.announce_count', { count: results.length }),
        );
      }
    } catch (e) {
      if (myReq === reqId.current) setBooks([]);
    } finally {
      if (myReq === reqId.current) setLoading(false);
    }
  }, [t]);

  // Live, debounced search as the user types (and category browse when empty).
  useEffect(() => {
    const t = setTimeout(() => runSearch(query, activeCategory), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, activeCategory, runSearch]);

  const onPickCategory = (c: typeof CATEGORIES[0]) => {
    setQuery('');
    setActiveCategory(c);
    track('library_search_category', { category: c.label });
  };

  const renderBook = ({ item }: { item: GutenbergBook }) => (
    <TouchableOpacity
      style={[s.bookRow, { borderColor: theme.border }]}
      activeOpacity={0.7}
      onPress={() => navigation.navigate('BookDetail', { book: item })}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}${item.authors[0] ? ', by ' + item.authors[0] : ''}`}
    >
      {item.coverUrl ? (
        <Image source={{ uri: item.coverUrl }} style={s.cover} />
      ) : (
        <View style={[s.cover, s.coverFallback, { backgroundColor: theme.card }]}>
          <Ionicons name="book" size={22} color={theme.textSecondary} />
        </View>
      )}
      <View style={s.bookMeta}>
        <Text style={[s.bookTitle, { color: theme.text }]} numberOfLines={2}>{item.title}</Text>
        <Text style={[s.bookAuthor, { color: theme.textSecondary }]} numberOfLines={1}>
          {item.authors.join(', ') || t('discover.unknown_author')}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.textSecondary} />
    </TouchableOpacity>
  );

  return (
    <ScreenWrapper style={[s.root, { backgroundColor: theme.surface }]}>
      {/* Header — tab root, so no back button. The upload shortcut keeps
          "bring your own EPUB" one tap away from the catalog. */}
      <View style={s.header}>
        <Text style={[s.headerTitle, { color: theme.text }]} accessibilityRole="header">{t('nav.discover')}</Text>
        <TouchableOpacity
          onPress={() => {
            track('library_upload_tapped', { source: 'discover_header' });
            navigation.navigate('Upload');
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t('discover.a11y_upload')}
          accessibilityHint={t('discover.a11y_upload_hint')}
        >
          <Ionicons name="add-circle-outline" size={28} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      <View style={[s.searchBar, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Ionicons name="search" size={18} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('discover.search_placeholder')}
          placeholderTextColor={theme.textSecondary}
          style={[s.searchInput, { color: theme.text }]}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('discover.a11y_search')}
        />
        {query.length > 0 && (
          <TouchableOpacity
            onPress={() => setQuery('')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('discover.a11y_clear')}
          >
            <Ionicons name="close-circle" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Category chips (hidden while searching) */}
      {query.trim().length === 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catStrip} contentContainerStyle={s.catStripContent}>
          {CATEGORIES.map((c) => {
            const active = c.label === activeCategory.label;
            return (
              <TouchableOpacity
                key={c.label}
                onPress={() => onPickCategory(c)}
                style={[s.chip, { backgroundColor: active ? theme.primary : theme.card, borderColor: active ? theme.primary : theme.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('discover.a11y_category', { label: t(c.key) })}
                accessibilityState={{ selected: active }}
              >
                <Ionicons name={c.icon as any} size={14} color={active ? '#fff' : theme.textSecondary} />
                <Text style={[s.chipText, { color: active ? '#fff' : theme.text }]}>{t(c.key)}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Results */}
      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={theme.primary} accessibilityLabel="Searching for books" /></View>
      ) : books.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="library-outline" size={40} color={theme.textSecondary} />
          <Text style={[s.emptyText, { color: theme.textSecondary }]}>
            {query.trim().length > 0 ? t('discover.no_results') : t('discover.no_category')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={books}
          keyExtractor={(b) => String(b.id)}
          renderItem={renderBook}
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </ScreenWrapper>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  searchBar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, paddingHorizontal: 12, height: 44, borderRadius: 12, borderWidth: 1, gap: 8 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  // Firm height + no flex-shrink: with only maxHeight, the surrounding flex
  // column squeezes the horizontal ScrollView on web and the chips render
  // half-clipped under the search bar.
  catStrip: { marginTop: 12, height: 44, flexGrow: 0, flexShrink: 0 },
  catStripContent: { paddingHorizontal: 16, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 34, borderRadius: 17, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '600' },
  list: { padding: 16, gap: 4 },
  bookRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  cover: { width: 44, height: 60, borderRadius: 6 },
  coverFallback: { alignItems: 'center', justifyContent: 'center' },
  bookMeta: { flex: 1 },
  bookTitle: { fontSize: 15, fontWeight: '600' },
  bookAuthor: { fontSize: 13, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyText: { fontSize: 14, textAlign: 'center' },
});
