import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
  Modal
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ScreenWrapper from '../components/ScreenWrapper';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from '../context/LanguageContext';
import { UI_LANGUAGE_OPTIONS } from '../i18n';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { ONBOARDING_KEY } from '../components/OnboardingOverlay';
import { TUTORIAL_ENABLED } from '../constants/featureFlags';
import { track } from '../services/analytics';

export const FOLLOW_ALONG_MODE_KEY = '@follow_along_mode';

const SettingsScreen = () => {
  const { theme, isDarkMode, toggleTheme } = useTheme();
  const { t, language, followSystem, setLanguage, useDeviceLanguage } = useTranslation();
  const { signOut } = useAuth();
  const [notifications, setNotifications] = React.useState(true);
  const [deleting, setDeleting] = React.useState(false);
  const [followAlongMode, setFollowAlongMode] = React.useState<'word' | 'phrase'>('word');
  const [showTutorial, setShowTutorial] = React.useState(true);
  const [langModalVisible, setLangModalVisible] = React.useState(false);

  // Native name of the currently active UI language, for the settings row.
  const activeLangName =
    UI_LANGUAGE_OPTIONS.find(o => o.code === language)?.nativeName ?? 'English';

  React.useEffect(() => {
    AsyncStorage.getItem(FOLLOW_ALONG_MODE_KEY).then(val => {
      if (val === 'phrase') setFollowAlongMode('phrase');
    });
    AsyncStorage.getItem(ONBOARDING_KEY).then(val => {
      setShowTutorial(val !== 'never');
    });
  }, []);

  const toggleTutorial = async () => {
    const next = !showTutorial;
    setShowTutorial(next);
    track('setting_toggled', { setting: 'tutorial', value: next });
    if (next) {
      await AsyncStorage.removeItem(ONBOARDING_KEY);
    } else {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'never');
    }
  };

  const toggleFollowAlongMode = async () => {
    const next = followAlongMode === 'word' ? 'phrase' : 'word';
    setFollowAlongMode(next);
    track('setting_toggled', { setting: 'follow_along_mode', value: next });
    await AsyncStorage.setItem(FOLLOW_ALONG_MODE_KEY, next);
  };

  /**
   * App-language picker. Replaced the 2026-05-29 "demand probe" once i18n
   * shipped. Still fires `setting_language_probe_tapped` on open so the existing
   * PostHog signal (interest in language settings) stays continuous.
   */
  const openLanguagePicker = () => {
    track('setting_language_probe_tapped');
    setLangModalVisible(true);
  };

  const handlePickLanguage = (code: string) => {
    setLanguage(code);
    setLangModalVisible(false);
  };

  const handleUseDeviceLanguage = () => {
    useDeviceLanguage();
    setLangModalVisible(false);
  };

  const handleDeleteAccount = () => {
    console.log('🔘 Delete Account button pressed');
    track('setting_delete_account_tapped');
    // First confirmation
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(
        'Delete Account?\n\nThis will permanently delete:\n• All your audiobooks\n• Your subscription (if active)\n• All account data\n\nThis action cannot be undone.'
      );
      if (confirmed) {
        confirmDelete();
      }
    } else {
      Alert.alert(
        'Delete Account?',
        'This will permanently delete:\n• All your audiobooks\n• Your subscription (if active)\n• All account data\n\nThis action cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', style: 'destructive', onPress: confirmDelete }
        ]
      );
    }
  };

  const confirmDelete = () => {
    // Second confirmation
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(
        'Are you absolutely sure?\n\nYour account and all data will be permanently deleted. This cannot be undone.'
      );
      if (confirmed) {
        performDelete();
      }
    } else {
      Alert.alert(
        'Are you absolutely sure?',
        'Your account and all data will be permanently deleted. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete My Account', style: 'destructive', onPress: performDelete }
        ]
      );
    }
  };

  const performDelete = async () => {
    try {
      setDeleting(true);
      console.log('🗑️ Deleting account...');

      await api.deleteAccount();

      console.log('✅ Account deleted successfully');

      // Success - sign out user
      await signOut();

    } catch (error: any) {
      console.error('❌ Error deleting account:', error);
      setDeleting(false);

      const errorMessage = error.response?.data?.details || error.message || 'Unknown error';

      if (Platform.OS === 'web') {
        alert(`Failed to delete account: ${errorMessage}`);
      } else {
        Alert.alert(
          'Error',
          `Failed to delete account: ${errorMessage}\n\nPlease try again or contact support.`
        );
      }
    }
  };

  const dynamicStyles = {
    container: {
      ...styles.container,
      backgroundColor: theme.surface,
    },
    section: {
      ...styles.section,
      backgroundColor: theme.card,
      borderColor: theme.border,
    },
    sectionTitle: {
      ...styles.sectionTitle,
      color: theme.text,
    },
    settingItem: {
      ...styles.settingItem,
      borderBottomColor: theme.border,
    },
    settingLabel: {
      ...styles.settingLabel,
      color: theme.text,
    },
    infoItem: {
      ...styles.infoItem,
      borderBottomColor: theme.border,
    },
    infoLabel: {
      ...styles.infoLabel,
      color: theme.textSecondary,
    },
    infoValue: {
      ...styles.infoValue,
      color: theme.text,
    },
    dangerSection: {
      ...styles.section,
      backgroundColor: theme.card,
      borderColor: theme.error || '#ef4444',
      borderWidth: 1,
    },
    dangerTitle: {
      ...styles.sectionTitle,
      color: theme.error || '#ef4444',
    },
    deleteButton: {
      ...styles.deleteButton,
      backgroundColor: theme.error || '#ef4444',
    },
    deleteButtonDisabled: {
      ...styles.deleteButton,
      backgroundColor: theme.textSecondary,
      opacity: 0.5,
    },
  };

  return (
    <ScreenWrapper applyBottomInset style={dynamicStyles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
        <View style={dynamicStyles.section}>
          <Text style={dynamicStyles.sectionTitle} accessibilityRole="header">Preferences</Text>
          <View style={dynamicStyles.settingItem}>
            <Text style={dynamicStyles.settingLabel}>Push Notifications</Text>
            <Switch
              value={notifications}
              onValueChange={(v) => {
                setNotifications(v);
                track('setting_toggled', { setting: 'notifications', value: v });
              }}
              accessibilityLabel="Push notifications"
              trackColor={{ false: theme.border, true: theme.primaryLight }}
              thumbColor={notifications ? theme.primary : theme.surface}
            />
          </View>
          <View style={dynamicStyles.settingItem}>
            <Text style={dynamicStyles.settingLabel}>Dark Mode</Text>
            <Switch
              value={isDarkMode}
              onValueChange={(v) => {
                toggleTheme();
                track('setting_toggled', { setting: 'dark_mode', value: v });
              }}
              accessibilityLabel="Dark mode"
              trackColor={{ false: theme.border, true: theme.primaryLight }}
              thumbColor={isDarkMode ? theme.primary : theme.surface}
            />
          </View>
          {/* App-language picker — opens the language modal (see below). */}
          <TouchableOpacity
            style={dynamicStyles.settingItem}
            onPress={openLanguagePicker}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${t('settings.language')}: ${activeLangName}`}
            accessibilityHint="Opens the app language picker."
          >
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={dynamicStyles.settingLabel}>{t('settings.language')}</Text>
              <Text style={[styles.settingSubLabel, { color: theme.textSecondary }]}>
                {followSystem ? `${activeLangName} · ${t('settings.language_system')}` : activeLangName}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
          </TouchableOpacity>
          <View style={dynamicStyles.settingItem}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={dynamicStyles.settingLabel}>Follow-Along Highlight</Text>
              <Text style={[styles.settingSubLabel, { color: theme.textSecondary }]}>
                {followAlongMode === 'word' ? 'Every word (most precise)' : 'Every 3 words (phrase)'}
              </Text>
            </View>
            <Switch
              value={followAlongMode === 'phrase'}
              onValueChange={toggleFollowAlongMode}
              accessibilityLabel="Follow-along highlight"
              accessibilityHint={followAlongMode === 'word' ? 'Currently highlights every word. Turn on to highlight three-word phrases.' : 'Currently highlights three-word phrases. Turn off to highlight every word.'}
              trackColor={{ false: theme.border, true: theme.primaryLight }}
              thumbColor={followAlongMode === 'phrase' ? theme.primary : theme.surface}
            />
          </View>
          {TUTORIAL_ENABLED && (
            <View style={[dynamicStyles.settingItem, { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={dynamicStyles.settingLabel}>Show Tutorial on Launch</Text>
                <Text style={[styles.settingSubLabel, { color: theme.textSecondary }]}>
                  {showTutorial ? 'Tutorial shown each time you open the app' : 'Tutorial permanently hidden'}
                </Text>
              </View>
              <Switch
                value={showTutorial}
                onValueChange={toggleTutorial}
                trackColor={{ false: theme.border, true: theme.primaryLight }}
                thumbColor={showTutorial ? theme.primary : theme.surface}
              />
            </View>
          )}
        </View>

        <View style={dynamicStyles.section}>
          <Text style={dynamicStyles.sectionTitle} accessibilityRole="header">About</Text>
          <View style={dynamicStyles.infoItem}>
            <Text style={dynamicStyles.infoLabel}>Version</Text>
            <Text style={dynamicStyles.infoValue}>1.0.0</Text>
          </View>
        </View>

        {/* Danger Zone */}
        <View style={dynamicStyles.dangerSection}>
          <Text style={dynamicStyles.dangerTitle} accessibilityRole="header">Danger Zone</Text>
          <View style={{ marginTop: 12 }}>
            <View style={styles.dangerWarning}>
              <Ionicons name="warning" size={20} color={theme.error || '#ef4444'} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={[styles.dangerWarningText, { color: theme.textSecondary }]}>
                This action is permanent and cannot be undone.
              </Text>
            </View>
            <TouchableOpacity
              style={deleting ? dynamicStyles.deleteButtonDisabled : dynamicStyles.deleteButton}
              onPress={handleDeleteAccount}
              disabled={deleting}
              accessibilityRole="button"
              accessibilityLabel="Delete account"
              accessibilityHint="Permanently deletes your account, audiobooks and data. Asks for confirmation twice."
              accessibilityState={{ disabled: deleting, busy: deleting }}
            >
              {deleting ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Ionicons name="trash" size={20} color="#ffffff" />
                  <Text style={styles.deleteButtonText}>Delete Account</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={[styles.deleteDescription, { color: theme.textSecondary }]}>
              Deleting your account will permanently remove all your audiobooks, cancel your subscription, and delete all account data.
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* App-language picker modal */}
      <Modal
        visible={langModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLangModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.langModalBackdrop}
          activeOpacity={1}
          onPress={() => setLangModalVisible(false)}
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel')}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={[styles.langModalCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            onPress={() => {}}
          >
            <Text style={[styles.langModalTitle, { color: theme.text }]} accessibilityRole="header">
              {t('settings.language_choose')}
            </Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {/* Match device language */}
              <TouchableOpacity
                style={[styles.langRow, { borderBottomColor: theme.border }]}
                onPress={handleUseDeviceLanguage}
                accessibilityRole="button"
                accessibilityState={{ selected: followSystem }}
              >
                <Ionicons name="phone-portrait-outline" size={22} color={theme.textSecondary} />
                <Text style={[styles.langRowLabel, { color: theme.text }]}>
                  {t('settings.language_system')}
                </Text>
                {followSystem && (
                  <Ionicons name="checkmark" size={22} color={theme.primary} />
                )}
              </TouchableOpacity>

              {UI_LANGUAGE_OPTIONS.map(opt => {
                const selected = !followSystem && opt.code === language;
                return (
                  <TouchableOpacity
                    key={opt.code}
                    style={[styles.langRow, { borderBottomColor: theme.border }]}
                    onPress={() => handlePickLanguage(opt.code)}
                    accessibilityRole="button"
                    accessibilityLabel={`${opt.nativeName} (${opt.englishName})`}
                    accessibilityState={{ selected }}
                  >
                    <Text style={styles.langRowFlag}>{opt.flag}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.langRowLabel, { color: theme.text }]}>{opt.nativeName}</Text>
                      <Text style={[styles.settingSubLabel, { color: theme.textSecondary }]}>{opt.englishName}</Text>
                    </View>
                    {selected && <Ionicons name="checkmark" size={22} color={theme.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={[styles.langModalClose, { borderColor: theme.border }]}
              onPress={() => setLangModalVisible(false)}
              accessibilityRole="button"
            >
              <Text style={[styles.langModalCloseText, { color: theme.primary }]}>{t('common.done')}</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    marginTop: 16,
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    width: '100%',
    maxWidth: 448,
    alignSelf: 'center',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  settingLabel: {
    fontSize: 16,
  },
  settingSubLabel: {
    fontSize: 12,
    marginTop: 2,
  },
  infoItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  infoLabel: {
    fontSize: 16,
  },
  infoValue: {
    fontSize: 16,
    fontWeight: '500',
  },
  dangerWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  dangerWarningText: {
    fontSize: 13,
    flex: 1,
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    gap: 8,
  },
  deleteButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteDescription: {
    fontSize: 12,
    marginTop: 12,
    lineHeight: 18,
  },
  langModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  langModalCard: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  langModalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  langRowFlag: {
    fontSize: 22,
  },
  langRowLabel: {
    fontSize: 16,
    flex: 1,
  },
  langModalClose: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  langModalCloseText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default SettingsScreen;
