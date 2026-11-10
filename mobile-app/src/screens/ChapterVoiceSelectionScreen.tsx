import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { parseWordCapRejection, presentWordCapRejection } from '../utils/wordCap';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList, Voice, Chapter, Audiobook } from '../types';
import apiService from '../services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { createAudioPlayer, AudioPlayerInterface } from '../utils/audioPlayer';

type ChapterVoiceSelectionScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'ChapterVoiceSelection'
>;
type ChapterVoiceSelectionScreenRouteProp = RouteProp<
  RootStackParamList,
  'ChapterVoiceSelection'
>;

const ChapterVoiceSelectionScreen = () => {
  const navigation = useNavigation<ChapterVoiceSelectionScreenNavigationProp>();
  const { isAnonymous } = useAuth();
  const route = useRoute<ChapterVoiceSelectionScreenRouteProp>();
  const { ebookTitle, chapters, language } = route.params;
  const { theme } = useTheme();

  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const [estimatedTime, setEstimatedTime] = useState('');
  const previewSoundRef = useRef<AudioPlayerInterface | null>(null);

  useEffect(() => {
    const totalWords = chapters.reduce((acc, chapter) => {
      return acc + (chapter.content ?? '').trim().split(/\s+/).filter(word => word.length > 0).length;
    }, 0);

    // 250 words per minute
    const totalMinutes = totalWords / 250;
    const estimation = totalMinutes < 1 ? '< 1 min' : `~${Math.ceil(totalMinutes)} min`;

    setEstimatedTime(estimation);
  }, [chapters]);

  useEffect(() => {
    loadVoices();
    return () => {
      // Cleanup preview audio on unmount
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
    setSelectedVoice(voice);
  };

  const handlePreviewVoice = async (voice: Voice) => {
    try {
      setPlayingPreview(voice.id);

      // Stop any currently playing preview
      if (previewSoundRef.current) {
        await previewSoundRef.current.unloadAsync();
        previewSoundRef.current = null;
      }

      // Get preview URL from Flask server
      const previewUrl = await apiService.getVoicePreview(voice.id);

      // Create and load audio player
      const player = createAudioPlayer();
      previewSoundRef.current = player;

      // Set up playback status callback
      player.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingPreview(null);
        }
      });

      // Load and play preview
      await player.loadAsync(previewUrl);
      await player.playAsync();
    } catch (error) {
      console.error('Error playing preview:', error);
      setPlayingPreview(null);
    }
  };

  const handleConvertChapters = async () => {
    if (!selectedVoice) return;

    try {
      // Check limits before conversion
      const profile = await apiService.getProfile();

      // Check audiobook limit
      if (profile.maxAudiobooks !== null &&
          profile.audiobookCount >= profile.maxAudiobooks) {
        const message = `Your ${profile.plan} plan allows ${profile.maxAudiobooks} audiobooks. You currently have ${profile.audiobookCount}.\n\nPlease upgrade your plan or delete existing audiobooks to create more.`;

        if (Platform.OS === 'web') {
          if (window.confirm(`Audiobook Limit Reached\n\n${message}\n\nWould you like to view subscription plans?`)) {
            navigation.navigate('Subscription');
          }
        } else {
          Alert.alert(
            'Audiobook Limit Reached',
            message,
            [
              { text: 'View Plans', onPress: () => navigation.navigate('Subscription') },
              { text: 'OK', style: 'cancel' }
            ]
          );
        }
        return;
      }

    } catch (error) {
      console.error('Error checking limits:', error);
      if (Platform.OS === 'web') {
        alert('Error: Failed to check subscription limits');
      } else {
        Alert.alert('Error', 'Failed to check subscription limits');
      }
      return;
    }

    setConverting(true);

    try {
      // Convert all chapters in one batch using the backend endpoint
      const task = await apiService.convertChapters(
        chapters,
        selectedVoice.id,
        ebookTitle,
        false,         // useEmotionalDirector
        true,          // generateWordTimings
        undefined,     // coverUrl
        undefined,     // sourceHash (not computed in this legacy path)
        language,
      );

      // Poll for completion
      let complete = false;
      let convertedChapters: Chapter[] = [];

      while (!complete) {
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        const status = await apiService.getConversionStatus(task.taskId);

        if (status.complete) {
          complete = true;
          if (status.error) {
            throw new Error(status.error);
          }

          // The backend now saves to the database automatically
          // Chapters are already in the user's library
          convertedChapters = status.chapters || [];
        }
      }

      // Show success message based on platform
      if (Platform.OS === 'web') {
        const goToLibrary = window.confirm('Success! Your custom ebook has been created and added to your library.\n\nClick OK to go to your library.');
        if (goToLibrary) {
          navigation.navigate('Main', { screen: 'Library' } as any);
        }
      } else {
        Alert.alert(
          'Success!',
          'Your custom ebook has been created and added to your library.',
          [
            {
              text: 'Go to Library',
              onPress: () => navigation.navigate('Main', { screen: 'Library' } as any),
            },
          ]
        );
      }
    } catch (error: any) {
      console.error('Error converting chapters:', error);

      // Handle limit error from backend
      // Backend uses 'limit_reached' for audiobook cap and 'conversion_limit_reached' for monthly cap
      const isLimitError =
        error.response?.data?.limit_reached ||
        error.response?.data?.conversion_limit_reached;
      const wordCap = parseWordCapRejection(error);
      if (wordCap) {
        presentWordCapRejection(
          wordCap,
          ((screen: any, params?: any) => navigation.navigate(screen, params)) as any,
          { isAnonymous },
        );
      } else if (error.response?.status === 403 && isLimitError) {
        const message = error.response.data.error;

        if (Platform.OS === 'web') {
          if (window.confirm(`Limit Reached\n\n${message}\n\nWould you like to view subscription plans?`)) {
            navigation.navigate('Subscription');
          }
        } else {
          Alert.alert(
            'Limit Reached',
            message,
            [
              { text: 'View Plans', onPress: () => navigation.navigate('Subscription') },
              { text: 'OK', style: 'cancel' }
            ]
          );
        }
      } else {
        if (Platform.OS === 'web') {
          alert('Conversion Failed: There was an error creating your audiobook. Please try again.');
        } else {
          Alert.alert('Conversion Failed', 'There was an error creating your audiobook. Please try again.');
        }
      }
    } finally {
      setConverting(false);
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
        accessibilityLabel={`${item.name}. ${item.description ?? ''}`}
        accessibilityState={{ selected: isSelected }}
      >
        <View style={styles.voiceInfo}>
          <View style={styles.voiceHeader}>
            <Text style={[styles.voiceName, { color: theme.text }]}>{item.name}</Text>
            {isSelected && (
              <Ionicons name="checkmark-circle" size={24} color={theme.success} />
            )}
          </View>
          <Text style={[styles.voiceDescription, { color: theme.textSecondary }]}>{item.description}</Text>
        </View>

        <TouchableOpacity
          style={[styles.previewButton, { backgroundColor: theme.surface }]}
          onPress={() => handlePreviewVoice(item)}
          disabled={isPlaying}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${item.name}`}
          accessibilityState={{ disabled: isPlaying, busy: isPlaying }}
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
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading voices...</Text>
      </View>
    );
  }

  if (converting) {
    return (
      <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
        <View style={styles.convertingContainer}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.convertingTitle, { color: theme.text }]} accessibilityRole="header" accessibilityLiveRegion="polite">Converting Your Ebook</Text>
          <Text style={[styles.convertingText, { color: theme.textSecondary }]}>
            Converting {chapters.length} chapter{chapters.length > 1 ? 's' : ''}...
          </Text>
          <Text style={[styles.convertingSubtext, { color: theme.textSecondary }]}>
            This may take a few minutes
          </Text>
        </View>
      </ScreenWrapper>
    );
  }

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
      <View style={styles.content}>
        {/* Header Info */}
        <View style={[styles.headerInfo, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
          <Ionicons name="mic-outline" size={32} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
          <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">Choose Your Voice</Text>
          <Text style={[styles.headerSubtitle, { color: theme.textSecondary }]}>
            Select an AI voice for "{ebookTitle}"
          </Text>
          <Text style={[styles.chapterCount, { color: theme.textSecondary }]}>
            {chapters.length} chapter{chapters.length > 1 ? 's' : ''}
          </Text>
          <Text style={[styles.estimationText, { color: theme.primary }]}>
            Estimated time: {estimatedTime}
          </Text>
        </View>

        {/* Voice List */}
        <FlatList
          data={voices}
          renderItem={renderVoiceItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />

        {/* Convert Button */}
        {selectedVoice && (
          <TouchableOpacity
            style={[styles.convertButton, { backgroundColor: theme.primary }]}
            onPress={handleConvertChapters}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Convert with ${selectedVoice.name.split('(')[0]}`}
          >
            <Text style={styles.convertButtonText}>
              Convert with {selectedVoice.name.split('(')[0]}
            </Text>
            <Ionicons name="arrow-forward" size={20} color="#ffffff" />
          </TouchableOpacity>
        )}
      </View>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#64748b',
  },
  convertingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  convertingTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e293b',
    marginTop: 20,
    marginBottom: 8,
  },
  convertingText: {
    fontSize: 16,
    color: '#64748b',
    marginBottom: 4,
  },
  convertingSubtext: {
    fontSize: 14,
    color: '#94a3b8',
  },
  content: {
    flex: 1,
  },
  headerInfo: {
    padding: 20,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e293b',
    marginTop: 12,
    marginBottom: 8,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
  },
  chapterCount: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 4,
  },
  estimationText: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
  list: {
    padding: 16,
  },
  voiceCard: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#e2e8f0',
  },
  voiceInfo: {
    flex: 1,
    marginRight: 12,
  },
  voiceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  voiceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
    flex: 1,
  },
  voiceDescription: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
  },
  previewButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: '#f1f5f9',
  },
  convertButton: {
    backgroundColor: '#6366f1',
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  convertButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    marginRight: 8,
  },
});

export default ChapterVoiceSelectionScreen;
