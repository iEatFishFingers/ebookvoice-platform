/**
 * VoiceSelectionScreen.tsx
 * ========================
 * Voice selection step of the EPUB → audio flow.  All voices and karaoke
 * are free for everyone.  The only paid gate is the monthly conversion
 * count, enforced server-side and surfaced via <ConversionLimitModal>.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import TutorialTooltip from '../components/TutorialTooltip';
import ConversionLimitModal from '../components/ConversionLimitModal';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList, Voice } from '../types';
import apiService from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { useConversion } from '../context/ConversionContext';
import { createPreviewPlayer, AudioPlayerInterface } from '../utils/audioPlayer';
import { computeEpubSourceHash } from '../utils/sourceHash';
import { resolveConversionLimitState } from '../utils/conversionLimit';
import { track } from '../services/analytics';

type VoiceSelectionScreenNavigationProp = StackNavigationProp<RootStackParamList, 'VoiceSelection'>;
type VoiceSelectionScreenRouteProp = RouteProp<RootStackParamList, 'VoiceSelection'>;

const VoiceSelectionScreen = () => {
  const navigation = useNavigation<VoiceSelectionScreenNavigationProp>();
  const route = useRoute<VoiceSelectionScreenRouteProp>();
  const { epubFile, editedChapters, language } = route.params;
  const { theme } = useTheme();
  const { startConversion } = useConversion();

  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [loading, setLoading] = useState(true);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const previewSoundRef = useRef<AudioPlayerInterface | null>(null);
  const convertBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);

  // Cached SHA-256 of the source EPUB for retry-doesn't-count dedup.
  // Computed once on mount so handleStartConversion stays fast.
  const sourceHashRef = useRef<string | null>(null);

  // Hard wall when monthly limit is reached.
  const [limitModal, setLimitModal] = useState<{ used: number; max: number } | null>(null);

  useEffect(() => {
    loadVoices();
    if (epubFile?.uri) {
      computeEpubSourceHash(epubFile.uri, (epubFile as any).file).then(h => {
        sourceHashRef.current = h;
      });
    }

    return () => {
      if (previewSoundRef.current) {
        previewSoundRef.current.unloadAsync();
      }
    };
  }, []);

  const loadVoices = async () => {
    try {
      const voiceList = await apiService.getVoices(language);
      setVoices(voiceList);
      if (voiceList.length > 0) {
        setSelectedVoice(voiceList[0]);
      }
    } catch (error) {
      console.error('Error loading voices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleVoiceSelect = (voice: Voice) => {
    track('voice_selected', { voice_id: voice.id, language, from_featured: false });
    setSelectedVoice(voice);
  };

  const handlePreviewVoice = async (voice: Voice) => {
    try {
      // Toggle off if already playing
      if (playingPreview === voice.id) {
        if (previewSoundRef.current) {
          await previewSoundRef.current.unloadAsync();
          previewSoundRef.current = null;
        }
        setPlayingPreview(null);
        return;
      }

      if (previewSoundRef.current) {
        await previewSoundRef.current.unloadAsync();
        previewSoundRef.current = null;
      }

      setPlayingPreview(voice.id);
      const previewUrl = await apiService.getVoicePreview(voice.id);
      const player = createPreviewPlayer();
      previewSoundRef.current = player;

      player.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingPreview(null);
        }
      });

      await player.loadAsync(previewUrl);
      await player.playAsync();
    } catch (error) {
      console.error('Error playing preview:', error);
      setPlayingPreview(null);
    }
  };

  const handleStartConversion = async () => {
    if (!selectedVoice) return;

    try {
      const sourceHash = sourceHashRef.current;

      if (editedChapters && editedChapters.length > 0) {
        const ebookTitle = epubFile.name.replace(/\.epub$/i, '');
        const chapterWordCount = editedChapters.reduce((sum, ch) => {
          const text = ch.content || '';
          return sum + text.split(/\s+/).filter((w) => w.length > 0).length;
        }, 0);

        const task = await apiService.convertChapters(
          editedChapters,
          selectedVoice.id,
          ebookTitle,
          false,          // useEmotionalDirector
          true,           // generateWordTimings — karaoke is free for everyone
          undefined,      // coverUrl
          sourceHash,
          language,
        );

        track('conversion_started', {
          task_id: task.taskId,
          chapter_count: editedChapters.length,
          voice_id: selectedVoice.id,
          language,
        });
        startConversion(task.taskId, epubFile.name, selectedVoice.id);
        navigation.replace('Conversion', {
          taskId: task.taskId,
          epubName: epubFile.name,
          voiceId: selectedVoice.id,
          wordCount: chapterWordCount,
        });
      } else {
        // Fallback: raw EPUB upload (no chapters provided)
        const task = await apiService.uploadAndConvert(epubFile, selectedVoice.id);
        track('conversion_started', { task_id: task.taskId, voice_id: selectedVoice.id, language });
        startConversion(task.taskId, epubFile.name, selectedVoice.id);
        navigation.replace('Conversion', {
          taskId: task.taskId,
          epubName: epubFile.name,
          voiceId: selectedVoice.id,
        });
      }
    } catch (error: any) {
      console.error('Error starting conversion:', error);

      const data = error.response?.data;

      // The one hard wall: the audiobook library is full for this tier.
      // Shown via the upgrade modal so the moment is consistent across screens.
      if (error.response?.status === 403 && data?.limit_reached) {
        const state = await resolveConversionLimitState(data);
        setLimitModal(state);
        return;
      }

      if (Platform.OS === 'web') {
        alert('Error: Failed to start conversion. Please try again.');
      } else {
        Alert.alert('Error', 'Failed to start conversion. Please try again.');
      }
    }
  };

  const renderVoiceItem = ({ item }: { item: Voice }) => {
    const isSelected = selectedVoice?.id === item.id;
    const isPlaying = playingPreview === item.id;

    return (
      <TouchableOpacity
        style={[
          styles.voiceCard,
          { backgroundColor: theme.card, borderColor: theme.border },
          isSelected && { borderColor: theme.primary, backgroundColor: theme.primaryLight },
        ]}
        onPress={() => handleVoiceSelect(item)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}${item.locale ? ', ' + item.locale : ''}. ${item.description ?? ''}`}
        accessibilityState={{ selected: isSelected }}
      >
        <View style={styles.voiceInfo}>
          <View style={styles.voiceHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.voiceName, { color: theme.text }]}>{item.name}</Text>
              {item.locale && (
                <Text style={[styles.voiceLocale, { color: theme.textSecondary }]}>{item.locale}</Text>
              )}
            </View>
            {isSelected && (
              <Ionicons name="checkmark-circle" size={22} color={theme.success} />
            )}
          </View>
          {item.description ? (
            <Text style={[styles.voiceDescription, { color: theme.textSecondary }]}>
              {item.description}
            </Text>
          ) : null}
        </View>

        {/* Preview button */}
        <TouchableOpacity
          style={[
            styles.previewButton,
            { backgroundColor: isPlaying ? theme.primary + '15' : theme.surface },
            isSelected && !isPlaying && { backgroundColor: theme.primaryLight },
          ]}
          onPress={() => handlePreviewVoice(item)}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${item.name}`}
          accessibilityState={{ busy: isPlaying }}
        >
          {isPlaying ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Ionicons name="play-circle-outline" size={28} color={theme.primary} />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.surface }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading voices…</Text>
      </View>
    );
  }

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
      <View style={styles.content}>

        {/* Header */}
        <View style={[styles.headerInfo, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
          <View style={[styles.headerIconWrap, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
            <Ionicons name="mic" size={24} color={theme.primary} />
          </View>
          <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">Choose Your Voice</Text>
          <Text style={[styles.headerSubtitle, { color: theme.textSecondary }]}>
            Tap the play button to preview any voice before choosing
          </Text>
        </View>

        {/* Voice list */}
        <FlatList
          data={voices}
          renderItem={renderVoiceItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />

        {/* Convert button */}
        {selectedVoice && (
          <View style={styles.footer}>
            <TouchableOpacity
              ref={convertBtnRef}
              style={[styles.convertButton, { backgroundColor: theme.primary }]}
              onPress={handleStartConversion}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`Convert with ${selectedVoice.name.split('(')[0].trim()}`}
            >
              <Ionicons name="mic" size={18} color="#ffffff" />
              <Text style={styles.convertButtonText}>
                Convert with {selectedVoice.name.split('(')[0].trim()}
              </Text>
              <Ionicons name="arrow-forward" size={18} color="#ffffff" />
            </TouchableOpacity>
          </View>
        )}
      </View>

      <TutorialTooltip
        storageKey="@tutorial_voiceselection_convert"
        targetRef={convertBtnRef}
        title="Tap here to start narration"
        body={"Select any voice above, then tap this button to kick off the conversion.\n\nIt runs in the background — feel free to browse the app while it works."}
        ctaLabel="Got it!"
        measureDelay={1200}
      />

      <ConversionLimitModal
        visible={limitModal !== null}
        used={limitModal?.used ?? 0}
        max={limitModal?.max ?? 3}
        onClose={() => setLimitModal(null)}
        onUpgrade={() => {
          setLimitModal(null);
          navigation.navigate('Subscription');
        }}
      />
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
  },
  loadingText: { marginTop: 12, fontSize: 16 },
  content: { flex: 1 },

  // Header
  headerInfo: {
    padding: 20,
    borderBottomWidth: 1,
    alignItems: 'center',
  },
  headerIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: '700', marginBottom: 6, textAlign: 'center' },
  headerSubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 19 },

  // Voice list
  list: { padding: 16 },
  voiceCard: {
    flexDirection: 'row',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  voiceInfo: { flex: 1, marginRight: 10 },
  voiceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  voiceName: { fontSize: 15, fontWeight: '600' },
  voiceLocale: { fontSize: 11, marginTop: 1 },
  voiceDescription: { fontSize: 13, lineHeight: 18 },

  // Preview button
  previewButton: {
    width: 48, height: 48,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 24,
  },

  // Footer / convert button
  footer: {
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 8 : 16,
    paddingTop: 8,
  },
  convertButton: {
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  convertButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
  },
});

export default VoiceSelectionScreen;
