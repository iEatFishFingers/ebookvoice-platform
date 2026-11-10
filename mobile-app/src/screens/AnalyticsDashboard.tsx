/**
 * AudiobookEdit (AnalyticsDashboard.tsx)
 * =======================================
 * Edit screen for an audiobook — cover art, title, author, description,
 * and a statistics placeholder for when community listening is launched.
 *
 * Designed for indie authors: refined, warm, and purposeful.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StackScreenProps } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import ScreenWrapper from '../components/ScreenWrapper';
import CoverArtPicker from '../components/CoverArtPicker';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import apiService from '../services/api';

type Props = StackScreenProps<RootStackParamList, 'AnalyticsDashboard'>;

export default function AudiobookEdit({ route, navigation }: Props) {
  const {
    audiobookId,
    audiobookTitle,
    audiobookAuthor,
    audiobookDescription,
    audiobookCoverUrl,
  } = route.params;

  const { theme } = useTheme();

  const [title, setTitle] = useState(audiobookTitle ?? '');
  const [author, setAuthor] = useState(audiobookAuthor ?? '');
  const [description, setDescription] = useState(audiobookDescription ?? '');
  const [coverUrl, setCoverUrl] = useState<string | null>(audiobookCoverUrl ?? null);
  const [saving, setSaving] = useState(false);

  const isDirty =
    title !== (audiobookTitle ?? '') ||
    author !== (audiobookAuthor ?? '') ||
    description !== (audiobookDescription ?? '') ||
    coverUrl !== (audiobookCoverUrl ?? null);

  const handleSave = async () => {
    if (!title.trim()) {
      if (Platform.OS === 'web') {
        alert('Title cannot be empty.');
      } else {
        Alert.alert('Validation', 'Title cannot be empty.');
      }
      return;
    }
    setSaving(true);
    try {
      await apiService.updateAudiobookMetadata(audiobookId, {
        title: title.trim(),
        author: author.trim() || undefined,
        description: description.trim() || undefined,
        coverUrl,
      });
      navigation.goBack();
    } catch {
      const msg = 'Could not save changes. Please try again.';
      if (Platform.OS === 'web') {
        alert(msg);
      } else {
        Alert.alert('Error', msg);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenWrapper applyBottomInset style={[s.root, { backgroundColor: theme.surface }]}>

      {/* Header */}
      <View style={[s.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity style={s.headerBack} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={22} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: theme.text }]} accessibilityRole="header">Edit Audiobook</Text>
        <TouchableOpacity
          style={[s.saveBtn, { backgroundColor: isDirty ? theme.primary : theme.border }]}
          onPress={handleSave}
          disabled={saving || !isDirty}
          accessibilityRole="button"
          accessibilityLabel="Save changes"
          accessibilityState={{ disabled: saving || !isDirty, busy: saving }}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── Cover Art ── */}
          <View style={[s.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[s.sectionLabel, { color: theme.textSecondary }]}>COVER ART</Text>
            <View style={s.coverRow}>
              <CoverArtPicker coverUrl={coverUrl} onCoverChange={setCoverUrl} size={120} />
              <View style={s.coverHints}>
                <Text style={[s.coverHintTitle, { color: theme.text }]}>Your audiobook cover</Text>
                <Text style={[s.coverHintBody, { color: theme.textSecondary }]}>
                  Square images work best (1:1 ratio). Tap the cover to upload a new one. Max 5 MB — JPG, PNG, or WebP.
                </Text>
                {coverUrl && (
                  <View style={[s.coverBadge, { backgroundColor: theme.primaryLight }]}>
                    <Ionicons name="checkmark-circle" size={13} color={theme.primary} />
                    <Text style={[s.coverBadgeText, { color: theme.primary }]}>Cover set</Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* ── Book Details ── */}
          <View style={[s.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[s.sectionLabel, { color: theme.textSecondary }]}>BOOK DETAILS</Text>

            <Text style={[s.fieldLabel, { color: theme.text }]}>Title</Text>
            <TextInput
              style={[s.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
              value={title}
              onChangeText={setTitle}
              placeholder="Audiobook title"
              placeholderTextColor={theme.textSecondary}
              maxLength={200}
              returnKeyType="next"
            />

            <Text style={[s.fieldLabel, { color: theme.text }]}>Author</Text>
            <TextInput
              style={[s.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
              value={author}
              onChangeText={setAuthor}
              placeholder="Your name or pen name"
              placeholderTextColor={theme.textSecondary}
              maxLength={200}
              returnKeyType="next"
            />

            <Text style={[s.fieldLabel, { color: theme.text }]}>Description</Text>
            <TextInput
              style={[s.textarea, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
              value={description}
              onChangeText={setDescription}
              placeholder="A short blurb about your story…"
              placeholderTextColor={theme.textSecondary}
              multiline
              maxLength={2000}
              textAlignVertical="top"
            />
            <Text style={[s.charCount, { color: theme.textSecondary }]}>
              {description.length}/2000
            </Text>
          </View>

          {/* ── Statistics placeholder ── */}
          <View style={[s.section, s.statsPlaceholder, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <View style={[s.statsIcon, { backgroundColor: theme.primaryLight }]}>
              <Ionicons name="bar-chart-outline" size={24} color={theme.primary} />
            </View>
            <Text style={[s.statsTitle, { color: theme.text }]}>Listener Statistics</Text>
            <Text style={[s.statsBody, { color: theme.textSecondary }]}>
              Analytics will be available here once your audiobook is shared with the community. Track plays, completion rates, and listener engagement.
            </Text>
            <View style={[s.comingSoonBadge, { backgroundColor: theme.primaryLight }]}>
              <Text style={[s.comingSoonText, { color: theme.primary }]}>Coming Soon</Text>
            </View>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenWrapper>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerBack: { padding: 4, marginRight: 8 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 10,
    minWidth: 60,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 12, paddingBottom: 48 },

  // Sections
  section: {
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 14,
  },

  // Cover row
  coverRow: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'flex-start',
  },
  coverHints: {
    flex: 1,
    paddingTop: 4,
  },
  coverHintTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
  },
  coverHintBody: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  coverBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  coverBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },

  // Form fields
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 14,
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 110,
  },
  charCount: {
    fontSize: 11,
    textAlign: 'right',
    marginTop: 4,
  },

  // Stats placeholder
  statsPlaceholder: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 10,
  },
  statsIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  statsTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  statsBody: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  comingSoonBadge: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  comingSoonText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});
