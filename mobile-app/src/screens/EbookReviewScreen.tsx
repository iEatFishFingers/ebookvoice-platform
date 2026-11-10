import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Alert,
  Platform,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useRoute, RouteProp, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList, Chapter } from '../types';
import { useTheme } from '../context/ThemeContext';
import CoverArtPicker from '../components/CoverArtPicker';
import TutorialTooltip from '../components/TutorialTooltip';

type EbookReviewScreenRouteProp = RouteProp<RootStackParamList, 'EbookReview'>;
type EbookReviewScreenNavigationProp = StackNavigationProp<RootStackParamList, 'EbookReview'>;

interface ChapterWithExtras extends Chapter {
  bookmarked?: boolean;
}

/**
 * Strip file-path-like strings from chapter content.
 * Catches paths like /app/public/task/{uuid}/{uuid}.pdf that leak from
 * PDF-to-EPUB conversion tools.
 */
const cleanChapterContent = (content?: string): string => {
  if (!content) return '';
  // Remove file path patterns (e.g. /app/public/task/68ed633d.../2a3a0bdb-...pdf)
  let cleaned = content.replace(
    /\/?(?:app\/|public\/|task\/)[\w./-]*\.(?:pdf|epub|html|xhtml|txt)\b/gi,
    ''
  );
  // Clean up double spaces and leading/trailing whitespace
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned;
};

const EbookReviewScreen = () => {
  const route = useRoute<EbookReviewScreenRouteProp>();
  const navigation = useNavigation<EbookReviewScreenNavigationProp>();
  const { theme } = useTheme();
  const { epubFile, extractedChapters, extractedCoverUrl, language, imageUploadId } = route.params;

  const [coverUrl, setCoverUrl] = useState<string | null>(extractedCoverUrl ?? null);
  const [chapters, setChapters] = useState<ChapterWithExtras[]>(
    extractedChapters.map(ch => ({
      ...ch,
      content: cleanChapterContent(ch.content),
      bookmarked: false,
    }))
  );
  const [editingChapter, setEditingChapter] = useState<ChapterWithExtras | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [editedContent, setEditedContent] = useState('');
  const proceedBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);

  const handleToggleBookmark = (chapterIndex: number) => {
    setChapters(prev =>
      prev.map((ch, idx) =>
        idx === chapterIndex ? { ...ch, bookmarked: !ch.bookmarked } : ch
      )
    );
  };

  const handleDeleteChapter = (chapterId: string) => {
    const chapter = chapters.find(ch => ch.id === chapterId);

    if (!chapter) {
      console.log('Chapter not found:', chapterId);
      return;
    }

    console.log('Attempting to delete chapter:', chapter.title, 'ID:', chapterId);

    // Platform-specific confirmation
    const confirmDelete = Platform.OS === 'web'
      ? window.confirm(`Are you sure you want to delete "${chapter.title}"?\n\nThis cannot be undone.`)
      : false; // Will use Alert.alert for mobile

    if (Platform.OS === 'web') {
      if (confirmDelete) {
        console.log('Delete confirmed for chapter:', chapterId);
        console.log('Current chapters before delete:', chapters.length);

        // Filter out the deleted chapter
        const remainingChapters = chapters.filter(ch => ch.id !== chapterId);
        console.log('Remaining chapters after filter:', remainingChapters.length);

        // Renumber all chapters sequentially
        const renumberedChapters = remainingChapters.map((ch, index) => ({
          ...ch,
          id: String(index + 1),
          position: index,
        }));

        console.log('Renumbered chapters:', renumberedChapters.map(ch => ({ id: ch.id, title: ch.title })));

        setChapters(renumberedChapters);
      }
    } else {
      // Mobile: Use Alert.alert
      Alert.alert(
        'Delete Chapter',
        `Are you sure you want to delete "${chapter.title}"?\n\nThis cannot be undone.`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => console.log('Delete cancelled'),
          },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              console.log('Delete confirmed for chapter:', chapterId);
              const remainingChapters = chapters.filter(ch => ch.id !== chapterId);
              const renumberedChapters = remainingChapters.map((ch, index) => ({
                ...ch,
                id: String(index + 1),
                position: index,
              }));
              setChapters(renumberedChapters);
            },
          },
        ]
      );
    }
  };

  const handleEditChapter = (chapter: Chapter) => {
    setEditingChapter(chapter);
    setEditedTitle(chapter.title ?? '');
    setEditedContent(chapter.content ?? '');
    setShowEditModal(true);
  };

  const handleSaveEdit = () => {
    if (!editingChapter) return;

    if (!editedTitle.trim()) {
      if (Platform.OS === 'web') {
        alert('Error: Chapter title cannot be empty');
      } else {
        Alert.alert('Error', 'Chapter title cannot be empty');
      }
      return;
    }

    if (!editedContent.trim()) {
      if (Platform.OS === 'web') {
        alert('Error: Chapter content cannot be empty');
      } else {
        Alert.alert('Error', 'Chapter content cannot be empty');
      }
      return;
    }

    setChapters(
      chapters.map(ch =>
        ch.id === editingChapter.id
          ? { ...ch, title: editedTitle, content: editedContent }
          : ch
      )
    );

    setShowEditModal(false);
    setEditingChapter(null);
  };

  const handleCancelEdit = () => {
    setShowEditModal(false);
    setEditingChapter(null);
  };

  const handleProceed = () => {
    if (chapters.length === 0) {
      if (Platform.OS === 'web') {
        alert('Error: You must keep at least one chapter');
      } else {
        Alert.alert('Error', 'You must keep at least one chapter');
      }
      return;
    }

    // Derive a clean title from the epub filename (strip extension + underscores)
    const ebookTitle = epubFile?.name
      ? epubFile.name.replace(/\.epub$/i, '').replace(/[_-]+/g, ' ').trim()
      : 'My Audiobook';

    // Author Pro: SmartSetup gives AI voice suggestions + Emotional Director + Karaoke
    navigation.navigate('SmartSetup', {
      ebookTitle,
      chapters,
      availableVoices: [],
      coverUrl: coverUrl ?? undefined,
      language,
      imageUploadId: imageUploadId ?? null,
    });
  };

  const getWordCount = (text: string) => {
    return text.split(/\s+/).filter(w => w.length > 0).length;
  };

  const getTotalWords = () => {
    return chapters.reduce((sum, ch) => sum + getWordCount(ch.content ?? ''), 0);
  };

  const getEstimatedTime = () => {
    const totalMinutes = getTotalWords() / 250;
    if (totalMinutes < 1) return '< 1 min';
    return `~${Math.ceil(totalMinutes)} min`;
  };

  const renderChapterItem = ({ item, index }: { item: ChapterWithExtras; index: number }) => {
    return (
      <View style={[styles.chapterCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.chapterHeader}>
          <View style={[styles.chapterNumber, { backgroundColor: theme.primaryLight }]}>
            <Text style={[styles.chapterNumberText, { color: theme.primary }]}>
              {index + 1}
            </Text>
          </View>
          <View style={styles.chapterInfo}>
            <Text style={[styles.chapterTitle, { color: theme.text }]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={[styles.chapterStats, { color: theme.textSecondary }]}>
              {getWordCount(item.content || '')} words
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => handleToggleBookmark(index)}
            style={styles.bookmarkButton}
            accessibilityRole="button"
            accessibilityLabel={item.bookmarked ? `Remove bookmark from ${item.title}` : `Bookmark ${item.title}`}
            accessibilityState={{ selected: item.bookmarked }}
          >
            <Ionicons
              name={item.bookmarked ? 'bookmark' : 'bookmark-outline'}
              size={24}
              color={item.bookmarked ? theme.primary : theme.textSecondary}
              accessibilityElementsHidden importantForAccessibility="no"
            />
          </TouchableOpacity>
        </View>

        <Text style={[styles.chapterPreview, { color: theme.textSecondary }]} numberOfLines={3}>
          {item.content}
        </Text>

        <View style={styles.chapterActions}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: theme.primaryLight }]}
            onPress={() => handleEditChapter(item)}
            accessibilityRole="button"
            accessibilityLabel={`Edit chapter ${item.title}`}
          >
            <Ionicons name="create-outline" size={18} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.actionButtonText, { color: theme.primary }]}>Edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: theme.errorLight }]}
            onPress={() => handleDeleteChapter(item.id)}
            accessibilityRole="button"
            accessibilityLabel={`Delete chapter ${item.title}`}
          >
            <Ionicons name="trash-outline" size={18} color={theme.error} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.actionButtonText, { color: theme.error }]}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">Review Chapters</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Cover Art */}
      <View style={[styles.coverSection, { borderBottomColor: theme.border }]}>
        <CoverArtPicker coverUrl={coverUrl} onCoverChange={setCoverUrl} size={96} />
        <View style={styles.coverMeta}>
          <Text style={[styles.coverLabel, { color: theme.text }]}>Cover Art</Text>
          <Text style={[styles.coverHint, { color: theme.textSecondary }]}>
            {coverUrl
              ? 'Tap the cover to change it'
              : 'Optional — add a cover to make your audiobook stand out'}
          </Text>
        </View>
      </View>

      {/* Summary */}
      <View style={[styles.summary, { backgroundColor: theme.primaryLight }]}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>Chapters</Text>
          <Text style={[styles.summaryValue, { color: theme.primary }]}>{chapters.length}</Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>Total Words</Text>
          <Text style={[styles.summaryValue, { color: theme.primary }]}>{getTotalWords()}</Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>Est. Time</Text>
          <Text style={[styles.summaryValue, { color: theme.primary }]}>{getEstimatedTime()}</Text>
        </View>
      </View>


      {/* Chapters List */}
      <FlatList
        data={chapters}
        renderItem={renderChapterItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={64} color={theme.textSecondary} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              No chapters remaining
            </Text>
            <Text style={[styles.emptySubtext, { color: theme.textSecondary }]}>
              Add at least one chapter to continue
            </Text>
          </View>
        }
      />

      {/* Proceed Button */}
      {chapters.length > 0 && (
        <View style={[styles.footer, { borderTopColor: theme.border, backgroundColor: theme.card }]}>
          <TouchableOpacity
            ref={proceedBtnRef}
            style={[styles.proceedButton, { backgroundColor: theme.primary }]}
            onPress={handleProceed}
            accessibilityRole="button"
            accessibilityLabel="Continue to voice selection"
            accessibilityHint="Continues to choose a narrator voice"
          >
            <Text style={styles.proceedButtonText}>Continue to Voice Selection</Text>
            <Ionicons name="arrow-forward" size={20} color="#ffffff" accessibilityElementsHidden importantForAccessibility="no" />
          </TouchableOpacity>
        </View>
      )}

      {/* Edit Modal */}
      <Modal
        visible={showEditModal}
        animationType="slide"
        transparent={true}
        onRequestClose={handleCancelEdit}
      >
        {/* KeyboardAvoidingView shrinks the modal when the keyboard opens so
            the action buttons and scroll area always stay above the keyboard. */}
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior="padding"
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 40}
        >
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]} accessibilityRole="header">Edit Chapter</Text>
              <TouchableOpacity onPress={handleCancelEdit} accessibilityRole="button" accessibilityLabel="Cancel editing">
                <Ionicons name="close" size={28} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
              </TouchableOpacity>
            </View>

            {/* Modal body: fixed title input + scrollable content area.
                The ScrollView (not the TextInput) owns the scroll gesture so
                iOS renders the full text — using scrollEnabled={true} on a
                multiline TextInput causes UITextView to lazy-render and drop
                content beyond ~10k characters on iOS. */}
            <View style={styles.modalBody}>
              {/* Title Input */}
              <Text style={[styles.label, { color: theme.text }]}>Chapter Title</Text>
              <TextInput
                style={[
                  styles.titleInput,
                  {
                    backgroundColor: theme.background,
                    color: theme.text,
                    borderColor: theme.border,
                  },
                ]}
                value={editedTitle}
                onChangeText={setEditedTitle}
                placeholder="Enter chapter title"
                placeholderTextColor={theme.textSecondary}
                returnKeyType="next"
              />

              {/* Content Input — outer ScrollView handles scrolling so iOS
                  renders all text regardless of length. scrollEnabled={false}
                  on TextInput forces auto-grow (no internal UIScrollView),
                  which prevents the iOS content-disappearing bug on long chapters. */}
              <Text style={[styles.label, { color: theme.text }]}>Chapter Content</Text>
              <ScrollView
                style={styles.contentScrollView}
                nestedScrollEnabled={true}
                keyboardShouldPersistTaps="handled"
              >
                <TextInput
                  style={[
                    styles.contentInput,
                    {
                      backgroundColor: theme.background,
                      color: theme.text,
                      borderColor: theme.border,
                    },
                  ]}
                  value={editedContent}
                  onChangeText={setEditedContent}
                  placeholder="Enter chapter content"
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  textAlignVertical="top"
                  scrollEnabled={false}
                />
                <Text style={[styles.wordCount, { color: theme.textSecondary, backgroundColor: theme.card }]}>
                  {getWordCount(editedContent)} words
                </Text>
              </ScrollView>
            </View>

            {/* Modal Actions */}
            <View style={[styles.modalActions, { borderTopColor: theme.border }]}>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: theme.border }]}
                onPress={handleCancelEdit}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: theme.primary }]}
                onPress={handleSaveEdit}
                accessibilityRole="button"
                accessibilityLabel="Save changes"
              >
                <Text style={[styles.modalButtonText, { color: '#ffffff' }]}>Save Changes</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <TutorialTooltip
        storageKey="@tutorial_review_proceed"
        targetRef={proceedBtnRef}
        title="Review chapters, then continue"
        body={"Edit or delete any chapters you don't want narrated — table of contents, copyright pages, etc.\n\nWhen you're happy, tap here to pick a voice."}
        ctaLabel="Got it!"
        measureDelay={1000}
      />
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  coverSection: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 16,
    borderBottomWidth: 1,
  },
  coverMeta: {
    flex: 1,
  },
  coverLabel: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  coverHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    padding: 16,
    margin: 16,
    borderRadius: 12,
    backgroundColor: '#ede9fe',
  },
  summaryItem: {
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#6366f1',
  },
  summaryDivider: {
    width: 1,
    height: 40,
    backgroundColor: '#c7d2fe',
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  chapterCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chapterHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  chapterNumber: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ede9fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  chapterNumberText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#6366f1',
  },
  chapterInfo: {
    flex: 1,
  },
  chapterTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 4,
  },
  chapterStats: {
    fontSize: 12,
    color: '#64748b',
  },
  chapterPreview: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
    marginBottom: 12,
  },
  chapterActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 6,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  proceedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
  },
  proceedButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#94a3b8',
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
    height: '80%',
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
  modalBody: {
    flex: 1,
    padding: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 8,
  },
  titleInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#1e293b',
    marginBottom: 20,
  },
  contentScrollView: {
    flex: 1,
  },
  contentInput: {
    minHeight: 300,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#1e293b',
    textAlignVertical: 'top',
  },
  wordCount: {
    alignSelf: 'flex-end',
    marginTop: 6,
    marginBottom: 8,
    fontSize: 12,
    color: '#64748b',
    backgroundColor: '#ffffff',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  modalActions: {
    flexDirection: 'row',
    padding: 20,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  bookmarkButton: {
    padding: 4,
    marginLeft: 8,
  },
});

export default EbookReviewScreen;
