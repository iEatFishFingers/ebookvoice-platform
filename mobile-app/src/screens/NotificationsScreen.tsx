import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

type NotificationsScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'Notifications'
>;

interface NotificationSettings {
  conversionComplete: boolean;
  conversionFailed: boolean;
  newFeatures: boolean;
  promotions: boolean;
  weeklyDigest: boolean;
  inAppSounds: boolean;
  vibration: boolean;
  emailNotifications: boolean;
  pushNotifications: boolean;
}

const NotificationsScreen = () => {
  const navigation = useNavigation<NotificationsScreenNavigationProp>();
  const { theme } = useTheme();

  const [settings, setSettings] = useState<NotificationSettings>({
    conversionComplete: true,
    conversionFailed: true,
    newFeatures: true,
    promotions: false,
    weeklyDigest: true,
    inAppSounds: true,
    vibration: true,
    emailNotifications: true,
    pushNotifications: true,
  });

  const handleToggle = async (key: keyof NotificationSettings) => {
    const newSettings = {
      ...settings,
      [key]: !settings[key],
    };

    setSettings(newSettings);

    // Save to AsyncStorage
    try {
      await AsyncStorage.setItem('notification_settings', JSON.stringify(newSettings));
    } catch (error) {
      console.error('Error saving notification settings:', error);
    }
  };

  const handleClearNotifications = () => {
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Are you sure you want to clear all notifications?');
      if (confirmed) {
        alert('All notifications cleared');
      }
    } else {
      Alert.alert(
        'Clear Notifications',
        'Are you sure you want to clear all notifications?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Clear',
            style: 'destructive',
            onPress: () => Alert.alert('Success', 'All notifications cleared'),
          },
        ]
      );
    }
  };

  const renderSettingItem = (
    icon: string,
    title: string,
    description: string,
    settingKey: keyof NotificationSettings
  ) => {
    return (
      <View style={[styles.settingItem, { borderBottomColor: theme.border }]}>
        <View style={styles.settingLeft}>
          <View style={[styles.iconContainer, { backgroundColor: theme.primaryLight }]}>
            <Ionicons name={icon as any} size={20} color={theme.primary} />
          </View>
          <View style={styles.settingText}>
            <Text style={[styles.settingTitle, { color: theme.text }]}>{title}</Text>
            <Text style={[styles.settingDescription, { color: theme.textSecondary }]}>
              {description}
            </Text>
          </View>
        </View>
        <Switch
          value={settings[settingKey]}
          onValueChange={() => handleToggle(settingKey)}
          accessibilityLabel={title}
          accessibilityHint={description}
          trackColor={{ false: theme.border, true: theme.primary }}
          thumbColor="#ffffff"
        />
      </View>
    );
  };

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">Notifications</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
      >
        {/* Conversion Notifications */}
        <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Conversion Updates</Text>
          {renderSettingItem(
            'checkmark-done-circle-outline',
            'Conversion Complete',
            'Get notified when your audiobook conversion is complete',
            'conversionComplete'
          )}
          {renderSettingItem(
            'close-circle-outline',
            'Conversion Failed',
            'Get notified if a conversion fails',
            'conversionFailed'
          )}
        </View>

        {/* General Notifications */}
        <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>General</Text>
          {renderSettingItem(
            'star-outline',
            'New Features',
            'Be the first to know about new features and updates',
            'newFeatures'
          )}
          {renderSettingItem(
            'pricetag-outline',
            'Promotions & Offers',
            'Receive special offers and promotional content',
            'promotions'
          )}
          {renderSettingItem(
            'calendar-outline',
            'Weekly Digest',
            'Get a weekly summary of your activity',
            'weeklyDigest'
          )}
        </View>

        {/* App Behavior */}
        <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>App Behavior</Text>
          {renderSettingItem(
            'volume-high-outline',
            'In-App Sounds',
            'Play sounds for notifications within the app',
            'inAppSounds'
          )}
          {renderSettingItem(
            'phone-portrait-outline',
            'Vibration',
            'Vibrate on notifications',
            'vibration'
          )}
        </View>

        {/* Delivery Methods */}
        <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Delivery Methods</Text>
          {renderSettingItem(
            'mail-outline',
            'Email Notifications',
            'Receive notifications via email',
            'emailNotifications'
          )}
          {renderSettingItem(
            'notifications-outline',
            'Push Notifications',
            'Receive push notifications on this device',
            'pushNotifications'
          )}
        </View>

        {/* Notification History */}
        <View style={[styles.historySection, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.historyHeader}>
            <Ionicons name="time-outline" size={24} color={theme.text} />
            <Text style={[styles.historyTitle, { color: theme.text }]}>Recent Notifications</Text>
          </View>

          <View style={styles.historyList}>
            <View style={[styles.historyItem, { borderBottomColor: theme.border }]}>
              <View style={[styles.historyIcon, { backgroundColor: theme.primaryLight }]}>
                <Ionicons name="checkmark-done" size={16} color={theme.primary} />
              </View>
              <View style={styles.historyContent}>
                <Text style={[styles.historyText, { color: theme.text }]}>
                  Conversion complete: "The Great Gatsby"
                </Text>
                <Text style={[styles.historyTime, { color: theme.textSecondary }]}>2 hours ago</Text>
              </View>
            </View>

            <View style={[styles.historyItem, { borderBottomColor: theme.border }]}>
              <View style={[styles.historyIcon, { backgroundColor: theme.primaryLight }]}>
                <Ionicons name="star" size={16} color={theme.primary} />
              </View>
              <View style={styles.historyContent}>
                <Text style={[styles.historyText, { color: theme.text }]}>
                  New feature: Chapter-based custom ebooks!
                </Text>
                <Text style={[styles.historyTime, { color: theme.textSecondary }]}>1 day ago</Text>
              </View>
            </View>

            <View style={styles.historyItem}>
              <View style={[styles.historyIcon, { backgroundColor: theme.primaryLight }]}>
                <Ionicons name="checkmark-done" size={16} color={theme.primary} />
              </View>
              <View style={styles.historyContent}>
                <Text style={[styles.historyText, { color: theme.text }]}>
                  Conversion complete: "1984"
                </Text>
                <Text style={[styles.historyTime, { color: theme.textSecondary }]}>3 days ago</Text>
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.clearButton, { borderTopColor: theme.border }]}
            onPress={handleClearNotifications}
            accessibilityRole="button"
            accessibilityLabel="Clear all notifications"
          >
            <Ionicons name="trash-outline" size={18} color={theme.error} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.clearButtonText, { color: theme.error }]}>Clear All Notifications</Text>
          </TouchableOpacity>
        </View>

        {/* Info Banner */}
        <View style={[styles.infoBanner, { backgroundColor: theme.primaryLight, borderLeftColor: theme.primary }]}>
          <Ionicons name="information-circle-outline" size={20} color={theme.primary} />
          <Text style={[styles.infoText, { color: theme.text }]}>
            You can change these settings at any time. Some notifications may be required for essential app functionality.
          </Text>
        </View>
      </ScrollView>
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
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  section: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
    padding: 16,
    paddingBottom: 8,
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  settingText: {
    flex: 1,
  },
  settingTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  historySection: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 12,
  },
  historyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
    marginLeft: 12,
  },
  historyList: {
    paddingHorizontal: 16,
  },
  historyItem: {
    flexDirection: 'row',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  historyIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  historyContent: {
    flex: 1,
  },
  historyText: {
    fontSize: 14,
    color: '#1e293b',
    marginBottom: 4,
  },
  historyTime: {
    fontSize: 12,
    color: '#94a3b8',
  },
  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  clearButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ef4444',
    marginLeft: 8,
  },
  infoBanner: {
    flexDirection: 'row',
    backgroundColor: '#ede9fe',
    borderRadius: 12,
    padding: 16,
    marginBottom: 32,
    borderLeftWidth: 4,
    borderLeftColor: '#6366f1',
  },
  infoText: {
    flex: 1,
    marginLeft: 12,
    fontSize: 13,
    lineHeight: 18,
    color: '#1e293b',
  },
});

export default NotificationsScreen;
