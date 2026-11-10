/**
 * UploadScreen.tsx
 * ================
 * Step 1 of 3 in the EPUB upload flow.
 * Redesigned with step indicator, polished drop-zone, and plan-aware messaging.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Platform,
  Animated,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useFocusEffect, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import apiService from '../services/api';
import { track } from '../services/analytics';
import { MAX_CONVERSION_WORDS } from '../constants/limits';
import TutorialTooltip from '../components/TutorialTooltip';
import ConversionMeter from '../components/ConversionMeter';
import { useAuth } from '../context/AuthContext';

// Conditionally import DocumentPicker only for mobile
let DocumentPicker: any = null;
if (Platform.OS !== 'web') {
  DocumentPicker = require('expo-document-picker');
}

type UploadScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Upload'>;

// ─── Supported upload formats ──────────────────────────────────────────────────
// EPUB is the gold path; .docx and DAISY (.zip) are additive (many
// accessible-format titles — e.g. BookShare — ship as Word or DAISY, not
// EPUB). The backend routes by extension in /extract-chapters.
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const UNSUPPORTED_FILE_MSG =
  'Please select an EPUB (.epub), Word (.docx) or DAISY (.zip) file';

const isSupportedBookFile = (name: string): boolean => {
  const n = (name || '').toLowerCase();
  return n.endsWith('.epub') || n.endsWith('.docx') || n.endsWith('.zip');
};

const mimeForBookFile = (name: string): string => {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.docx')) return DOCX_MIME;
  if (n.endsWith('.zip')) return 'application/zip';
  return 'application/epub+zip';
};

// ─── Step indicator data ──────────────────────────────────────────────────────

const STEPS = ['Upload', 'Review', 'Convert'];

// ─── Screen ───────────────────────────────────────────────────────────────────

const UploadScreen = () => {
  const navigation = useNavigation<UploadScreenNavigationProp>();
  const route = useRoute<RouteProp<RootStackParamList, 'Upload'>>();
  const { theme } = useTheme();
  const { isAnonymous } = useAuth();

  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  // Guards the auto-extract effect — fires once per mount even if route
  // params re-emit (e.g. focus-driven re-render).
  const autoConsumedRef = useRef(false);
  // Library-capacity meter state — refreshed on every screen focus.
  const [meter, setMeter] = useState<{ used: number; remaining: number | null } | null>(null);

  // Drop-zone pulse animation (idle state)
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeInAnim = useRef(new Animated.Value(0)).current;
  const dropZoneRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);

  useEffect(() => {
    Animated.timing(fadeInAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.04, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1800, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      if (isAnonymous) {
        // Anonymous trial: hardcoded 0-of-1 meter. The /api/profile endpoint
        // is auth-required (no profile row for an anonymous device), so we
        // skip the fetch entirely. The 1-lifetime cap is enforced server-side
        // by row-existence check in _check_anonymous_conversion_gate.
        setMeter({ used: 0, remaining: 1 });
        return;
      }
      // Authenticated: force-refresh profile so the meter reflects any
      // conversion that completed while we were elsewhere.
      apiService.getProfile({ force: true })
        .then(profile => {
          setMeter({
            used: profile.conversionCount,
            // null max = unlimited (Pro) → meter hides itself.
            remaining: profile.maxLifetimeConversions == null
              ? null
              : (profile.lifetimeConversionsRemaining ?? 0),
          });
        })
        .catch(err => console.error('Error loading user profile:', err));
    }, [isAnonymous]),
  );

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const handleFilePick = async () => {
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept =
          '.epub,application/epub+zip,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.zip,application/zip';

        input.onchange = (e: Event) => {
          const target = e.target as HTMLInputElement;
          const file = target.files?.[0];
          if (!file) return;

          if (!isSupportedBookFile(file.name)) {
            alert(UNSUPPORTED_FILE_MSG);
            return;
          }

          // No file-size gate — the only limit is word count, enforced after
          // extraction in handleContinue (and the backend 413 backstop).
          setSelectedFile({
            uri: URL.createObjectURL(file),
            name: file.name,
            mimeType: file.type || mimeForBookFile(file.name),
            size: file.size,
            file,
          });
        };

        input.click();
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: [
            'application/epub+zip',
            'application/epub',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/zip',
            '*/*',
          ],
          copyToCacheDirectory: true,
        });

        if (result.canceled) return;

        const file = result.assets[0];
        if (!isSupportedBookFile(file.name)) {
          Alert.alert('Invalid File', UNSUPPORTED_FILE_MSG);
          return;
        }

        // No file-size gate — the only limit is word count, enforced after
        // extraction in handleContinue (and the backend 413 backstop).
        setSelectedFile(file);
      }
    } catch (err) {
      console.error('Error picking file:', err);
      if (Platform.OS === 'web') {
        alert('Failed to select file. Please try again.');
      } else {
        Alert.alert('Error', 'Failed to select file. Please try again.');
      }
    }
  };

  const handleContinue = async (fileOverride?: any) => {
    // `fileOverride` lets the auto-import effect call this without waiting for
    // setSelectedFile to flush through React state. Manual taps fall through
    // to the state value as before.
    const file = fileOverride ?? selectedFile;
    if (!file) return;

    setUploading(true);
    try {
      const { chapters, coverUrl, language, imageUploadId } = await apiService.extractChapters(file);

      if (!chapters || chapters.length === 0) {
        Alert.alert('Error', 'No chapters found in this file.');
        setUploading(false);
        return;
      }

      // Reject books too large for the converter early — saves the user from
      // picking language + voice for a book the backend will reject anyway.
      // Backend stays the source of truth (see MAX_CONVERSION_WORDS).
      const totalWords = chapters.reduce(
        (sum: number, ch: any) =>
          sum + ((ch.content || '').split(/\s+/).filter((w: string) => w.length > 0).length),
        0,
      );
      if (totalWords > MAX_CONVERSION_WORDS) {
        Alert.alert(
          'Book Too Long',
          `Your book has about ${totalWords.toLocaleString()} words, but the most we can convert right now is ${MAX_CONVERSION_WORDS.toLocaleString()} words (about a very long novel).\n\nThis limit is about the number of words, not the file size — even a small file can hold a lot of text.\n\nYou can split the book into parts and convert each part separately.`,
          [{ text: 'OK' }],
        );
        setUploading(false);
        return;
      }

      track('epub_uploaded', {
        chapter_count: chapters.length,
        detected_language: language,
        file_size_kb: file.size ? Math.round(file.size / 1024) : undefined,
      });

      navigation.navigate('LanguageSelection', {
        epubFile: file,
        extractedChapters: chapters,
        extractedCoverUrl: coverUrl ?? undefined,
        bookLanguage: language,
        imageUploadId: imageUploadId ?? null,
      });
    } catch (error) {
      console.error('Error extracting chapters:', error);
      Alert.alert('Error', 'Failed to extract chapters from this file. Please try a different file.');
    } finally {
      setUploading(false);
    }
  };

  // Auto-extract when arriving with a preselected file (iOS "Open in
  // EbookVoice" handoff). Fires exactly once per mount.
  useEffect(() => {
    const pre =
      route.params && 'preselectedFile' in route.params ? route.params.preselectedFile : undefined;
    if (pre && !autoConsumedRef.current) {
      autoConsumedRef.current = true;
      setSelectedFile(pre);
      handleContinue(pre);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params]);

  return (
    <ScreenWrapper applyBottomInset style={[styles.root, { backgroundColor: theme.surface }]}>
      <Animated.View style={{ flex: 1, opacity: fadeInAnim }}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Step indicator */}
          <View style={styles.stepsRow}>
            {STEPS.map((step, i) => {
              const active = i === 0;
              const done = false;
              return (
                <React.Fragment key={step}>
                  <View style={styles.stepItem}>
                    <View style={[
                      styles.stepDot,
                      { backgroundColor: active ? theme.primary : theme.border },
                      done && { backgroundColor: theme.success },
                    ]}>
                      {done ? (
                        <Ionicons name="checkmark" size={10} color="#ffffff" />
                      ) : (
                        <Text style={[styles.stepDotText, { color: active ? '#ffffff' : theme.textSecondary }]}>
                          {i + 1}
                        </Text>
                      )}
                    </View>
                    <Text style={[
                      styles.stepLabel,
                      { color: active ? theme.primary : theme.textSecondary },
                      active && { fontWeight: '600' },
                    ]}>
                      {step}
                    </Text>
                  </View>
                  {i < STEPS.length - 1 && (
                    <View style={[styles.stepLine, { backgroundColor: theme.border }]} />
                  )}
                </React.Fragment>
              );
            })}
          </View>

          {/* Page title */}
          <Text style={[styles.pageTitle, { color: theme.text }]}>Upload your book</Text>
          <Text style={[styles.pageSubtitle, { color: theme.textSecondary }]}>
            We'll extract the chapters and let you review before converting
          </Text>

          {/* Drop zone */}
          {selectedFile ? (
            /* File selected state */
            <View style={[styles.fileCard, { backgroundColor: theme.card, borderColor: theme.primary }]}>
              <View style={[styles.fileCardIconWrap, { backgroundColor: theme.primaryLight }]}>
                <Ionicons name="document-text" size={32} color={theme.primary} />
              </View>
              <View style={styles.fileCardMeta}>
                <Text style={[styles.fileCardName, { color: theme.text }]} numberOfLines={2}>
                  {selectedFile.name}
                </Text>
                <View style={styles.fileCardBadgeRow}>
                  <View style={[styles.fileCardBadge, { backgroundColor: theme.successLight }]}>
                    <Ionicons name="checkmark-circle" size={12} color={theme.success} />
                    <Text style={[styles.fileCardBadgeText, { color: theme.success }]}>Ready</Text>
                  </View>
                  {selectedFile.size > 0 && (
                    <Text style={[styles.fileCardSize, { color: theme.textSecondary }]}>
                      {formatFileSize(selectedFile.size)}
                    </Text>
                  )}
                </View>
              </View>
              <TouchableOpacity
                style={[styles.fileCardChangeBtn, { borderColor: theme.border }]}
                onPress={handleFilePick}
                accessibilityRole="button"
                accessibilityLabel="Change file"
              >
                <Ionicons name="swap-horizontal-outline" size={16} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
              </TouchableOpacity>
            </View>
          ) : (
            /* Empty drop zone */
            <TouchableOpacity
              ref={dropZoneRef}
              onPress={handleFilePick}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Upload an EPUB, Word or DAISY book. Tap to choose a file"
              accessibilityHint="Opens the file picker"
            >
              <Animated.View
                style={[
                  styles.dropZone,
                  { borderColor: theme.border, backgroundColor: theme.card },
                  { transform: [{ scale: pulseAnim }] },
                ]}
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
              >
                <View style={[styles.dropZoneIconOuter, { backgroundColor: theme.primaryLight }]}>
                  <View style={[styles.dropZoneIconInner, { backgroundColor: theme.primary + '20' }]}>
                    <Ionicons name="cloud-upload" size={36} color={theme.primary} />
                  </View>
                </View>
                <Text style={[styles.dropZoneTitle, { color: theme.text }]}>
                  {Platform.OS === 'web' ? 'Click to browse files' : 'Tap to select a file'}
                </Text>
                <Text style={[styles.dropZoneSub, { color: theme.textSecondary }]}>
                  {`EPUB, Word or DAISY books up to ${MAX_CONVERSION_WORDS.toLocaleString()} words`}
                </Text>
                <View style={[styles.dropZoneFormatBadge, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.dropZoneFormatText, { color: theme.textSecondary }]}>
                    .epub · .docx · .zip (DAISY)
                  </Text>
                </View>
              </Animated.View>
            </TouchableOpacity>
          )}

          {/* Library-capacity meter — invisible for unlimited plans */}
          {meter && (
            <View style={styles.meterCard}>
              <ConversionMeter
                used={meter.used}
                remaining={meter.remaining}
                label={isAnonymous ? 'trial conversion used' : undefined}
              />
            </View>
          )}

          {/* What happens next */}
          <View style={[styles.stepsCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.stepsCardTitle, { color: theme.text, borderBottomColor: theme.border }]}>What happens next</Text>
            <NextStep icon="search-outline" title="Chapter extraction" desc="We parse your book and pull out each chapter" theme={theme} />
            <NextStep icon="create-outline" title="Review & edit" desc="Check the chapters and make any edits before converting" theme={theme} />
            <NextStep icon="mic-outline" title="Voice conversion" desc="Pick a voice and generate your audiobook" theme={theme} last />
          </View>

        </ScrollView>

        {/* Sticky continue button */}
        {selectedFile && (
          <View style={[styles.ctaBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.ctaBtn, { backgroundColor: theme.primary }, uploading && { opacity: 0.7 }]}
              onPress={() => handleContinue()}
              disabled={uploading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={uploading ? 'Extracting chapters' : 'Review chapters'}
              accessibilityHint={uploading ? undefined : 'Extracts the chapters from your book'}
              accessibilityState={{ disabled: uploading, busy: uploading }}
            >
              {uploading ? (
                <>
                  <ActivityIndicator size="small" color="#ffffff" />
                  <Text style={styles.ctaBtnText}>Extracting chapters…</Text>
                </>
              ) : (
                <>
                  <Text style={styles.ctaBtnText}>Review Chapters</Text>
                  <Ionicons name="arrow-forward" size={18} color="#ffffff" />
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
      </Animated.View>

      <TutorialTooltip
        storageKey="@tutorial_upload_dropzone"
        targetRef={dropZoneRef}
        title="Tap here to pick your book"
        body={"Tap anywhere in this zone to open your files.\n\nWe support EPUB, Word (.docx) and DAISY (.zip) books — we'll extract all the chapters automatically, no setup needed."}
        ctaLabel="Got it!"
        measureDelay={800}
      />
    </ScreenWrapper>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────────────

function NextStep({
  icon, title, desc, theme, last,
}: {
  icon: string; title: string; desc: string; theme: any; last?: boolean;
}) {
  return (
    <View style={[nsStyles.row, !last && { borderBottomWidth: 1, borderBottomColor: theme.border }]}>
      <View style={[nsStyles.iconWrap, { backgroundColor: theme.primaryLight }]}>
        <Ionicons name={icon as any} size={15} color={theme.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[nsStyles.title, { color: theme.text }]}>{title}</Text>
        <Text style={[nsStyles.desc, { color: theme.textSecondary }]}>{desc}</Text>
      </View>
    </View>
  );
}

const nsStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  iconWrap: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 13, fontWeight: '600', marginBottom: 1 },
  desc: { fontSize: 12, lineHeight: 17 },
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },

  // Step indicator
  stepsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  stepItem: { alignItems: 'center', gap: 5 },
  stepDot: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  stepDotText: { fontSize: 12, fontWeight: '700' },
  stepLabel: { fontSize: 11, letterSpacing: 0.2 },
  stepLine: { flex: 1, height: 1.5, marginHorizontal: 6, marginBottom: 14 },

  // Page title
  pageTitle: { fontSize: 26, fontWeight: '800', marginBottom: 6 },
  pageSubtitle: { fontSize: 14, lineHeight: 21, marginBottom: 24 },

  // Drop zone
  dropZone: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: 20,
    paddingVertical: 44,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 20,
  },
  dropZoneIconOuter: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
  },
  dropZoneIconInner: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  dropZoneTitle: { fontSize: 17, fontWeight: '700', marginBottom: 6 },
  dropZoneSub: { fontSize: 13, marginBottom: 16 },
  dropZoneFormatBadge: {
    borderRadius: 8, borderWidth: 1,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  dropZoneFormatText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },

  // File selected card
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    marginBottom: 20,
    gap: 12,
  },
  fileCardIconWrap: {
    width: 52, height: 52, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  fileCardMeta: { flex: 1 },
  fileCardName: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  fileCardBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileCardBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  fileCardBadgeText: { fontSize: 11, fontWeight: '600' },
  fileCardSize: { fontSize: 12 },
  fileCardChangeBtn: {
    width: 36, height: 36, borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },

  // Conversion meter slot
  meterCard: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 16,
  },

  // What happens next card
  stepsCard: {
    borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, overflow: 'hidden',
  },
  stepsCardTitle: {
    fontSize: 13, fontWeight: '700', paddingVertical: 14,
    borderBottomWidth: 1,
  },

  // CTA bar
  ctaBar: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 8 : 16,
  },
  ctaBtn: {
    borderRadius: 14, height: 54,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  ctaBtnText: { fontSize: 16, fontWeight: '700', color: '#ffffff' },
});

export default UploadScreen;
