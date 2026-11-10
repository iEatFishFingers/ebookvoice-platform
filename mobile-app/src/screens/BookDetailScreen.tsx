/**
 * BookDetailScreen
 * ────────────────
 * Full metadata for a public-domain book + "Convert to Audiobook". Convert
 * ingests the EPUB through the backend /extract-gutenberg (server-side,
 * gutenberg.org only) and hands the chapters to the normal LanguageSelection →
 * voice → /convert-chapters flow (where the lifetime conversion gate runs).
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity, ActivityIndicator,
  StyleSheet, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import ScreenWrapper from '../components/ScreenWrapper';
import apiService, { GutenbergBook } from '../services/api';
import { MAX_CONVERSION_WORDS } from '../constants/limits';
import { track } from '../services/analytics';

export default function BookDetailScreen({ route, navigation }: any) {
  const { theme } = useTheme();
  const book: GutenbergBook = route.params.book;
  const [converting, setConverting] = useState(false);

  // Funnel: which catalog books get looked at (vs. converted). book_id is
  // the Gutenberg id Render logs print on /extract-gutenberg, so PostHog
  // and server logs cross-reference directly.
  useEffect(() => {
    track('discover_book_viewed', { book_id: book.id, title: book.title });
  }, [book.id]);

  const handleConvert = async () => {
    if (converting) return;
    setConverting(true);
    try {
      const { chapters, coverUrl, language, imageUploadId } = await apiService.extractGutenbergBook(book.id);
      if (!chapters || chapters.length === 0) {
        track('gutenberg_extract_failed', { book_id: book.id, reason: 'no_text' });
        Alert.alert('No text found', 'We couldn’t read any chapters from this book. Please try another.');
        return;
      }
      const totalWords = chapters.reduce(
        (sum: number, ch: any) => sum + ((ch.content || '').split(/\s+/).filter((w: string) => w.length > 0).length),
        0,
      );
      if (totalWords > MAX_CONVERSION_WORDS) {
        track('gutenberg_extract_failed', { book_id: book.id, reason: 'too_long', word_count: totalWords });
        Alert.alert(
          'Book Too Long',
          `This book has about ${totalWords.toLocaleString()} words, but the most we can convert right now is ${MAX_CONVERSION_WORDS.toLocaleString()} words. Please pick a shorter book.`,
          [{ text: 'OK' }],
        );
        return;
      }
      track('gutenberg_convert_started', { book_id: book.id, word_count: totalWords });
      navigation.navigate('LanguageSelection', {
        epubFile: { uri: '', name: book.title, mimeType: 'application/epub+zip', size: 0 },
        extractedChapters: chapters,
        extractedCoverUrl: coverUrl ?? book.coverUrl ?? undefined,
        bookLanguage: language,
        imageUploadId: imageUploadId ?? null,
      });
    } catch (e) {
      track('gutenberg_extract_failed', { book_id: book.id, reason: 'error' });
      const msg = 'Couldn’t prepare this book right now. Please try again.';
      if (Platform.OS === 'web') alert(msg); else Alert.alert('Error', msg);
    } finally {
      setConverting(false);
    }
  };

  return (
    <ScreenWrapper applyBottomInset style={[s.root, { backgroundColor: theme.surface }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: theme.text }]} numberOfLines={1} accessibilityRole="header">Book details</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {/* Cover + title */}
        <View style={s.hero}>
          {book.coverUrl ? (
            <Image source={{ uri: book.coverUrl }} style={s.cover} accessibilityElementsHidden importantForAccessibility="no" />
          ) : (
            <View style={[s.cover, s.coverFallback, { backgroundColor: theme.card }]} accessibilityElementsHidden importantForAccessibility="no">
              <Ionicons name="book" size={36} color={theme.textSecondary} />
            </View>
          )}
          <Text style={[s.title, { color: theme.text }]} accessibilityRole="header">{book.title}</Text>
          <Text style={[s.author, { color: theme.textSecondary }]}>
            {book.authors.join(', ') || 'Unknown author'}{book.authorYears ? `  ·  ${book.authorYears}` : ''}
          </Text>
        </View>

        {/* Meta chips */}
        <View style={s.metaRow}>
          {book.languages.map((l) => (
            <View key={l} style={[s.metaChip, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[s.metaChipText, { color: theme.textSecondary }]}>{l.toUpperCase()}</Text>
            </View>
          ))}
          {typeof book.downloadCount === 'number' && (
            <View
              style={[s.metaChip, { backgroundColor: theme.card, borderColor: theme.border }]}
              accessible
              accessibilityLabel={`${book.downloadCount.toLocaleString()} downloads`}
            >
              <Ionicons name="download-outline" size={12} color={theme.textSecondary} />
              <Text style={[s.metaChipText, { color: theme.textSecondary }]}>{book.downloadCount.toLocaleString()}</Text>
            </View>
          )}
          {book.released ? (
            <View
              style={[s.metaChip, { backgroundColor: theme.card, borderColor: theme.border }]}
              accessible
              accessibilityLabel={`Published ${book.released}`}
            >
              <Ionicons name="calendar-outline" size={12} color={theme.textSecondary} />
              <Text style={[s.metaChipText, { color: theme.textSecondary }]}>{book.released}</Text>
            </View>
          ) : null}
          <View style={[s.metaChip, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Ionicons name="ribbon-outline" size={12} color={theme.textSecondary} />
            <Text style={[s.metaChipText, { color: theme.textSecondary }]}>Public domain</Text>
          </View>
        </View>

        {/* Description */}
        {book.description ? (
          <Text style={[s.description, { color: theme.text }]}>{book.description}</Text>
        ) : (
          <Text style={[s.description, { color: theme.textSecondary }]}>No description available for this book.</Text>
        )}

        {/* Subjects */}
        {book.subjects.length > 0 && (
          <View style={s.subjects}>
            {book.subjects.slice(0, 6).map((sub) => (
              <View key={sub} style={[s.subjectChip, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={[s.subjectText, { color: theme.textSecondary }]} numberOfLines={1}>{sub}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={[s.sourceNote, { color: theme.textSecondary }]}>
          Sourced from Project Gutenberg. Public-domain status can vary by country — see our Terms.
        </Text>
      </ScrollView>

      {/* Convert CTA */}
      <View style={[s.footer, { borderTopColor: theme.border, backgroundColor: theme.surface }]}>
        <TouchableOpacity
          style={[s.convertBtn, { backgroundColor: theme.primary, opacity: converting ? 0.7 : 1 }]}
          onPress={handleConvert}
          disabled={converting}
          accessibilityRole="button"
          accessibilityLabel={`Convert ${book.title} to an audiobook`}
          accessibilityState={{ disabled: converting, busy: converting }}
        >
          {converting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="headset" size={18} color="#fff" />
              <Text style={s.convertText}>Convert to Audiobook</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScreenWrapper>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  content: { padding: 20, paddingBottom: 24 },
  hero: { alignItems: 'center', marginBottom: 16 },
  cover: { width: 120, height: 170, borderRadius: 10, marginBottom: 14 },
  coverFallback: { alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  author: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 18 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 26, borderRadius: 13, borderWidth: 1 },
  metaChipText: { fontSize: 11, fontWeight: '600' },
  description: { fontSize: 15, lineHeight: 22, marginBottom: 18 },
  subjects: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  subjectChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, maxWidth: '100%' },
  subjectText: { fontSize: 12 },
  sourceNote: { fontSize: 11, lineHeight: 16, fontStyle: 'italic' },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  convertBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 14 },
  convertText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
