import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  Linking
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList, User } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

type ProfileScreenNavigationProp = StackNavigationProp<RootStackParamList>;

const ProfileScreen = () => {
  const navigation = useNavigation<ProfileScreenNavigationProp>();
  const { theme } = useTheme();
  const { user, signOut, loading: authLoading } = useAuth();
  const scrollBottomPadding = 80;
  const [profile, setProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState<boolean>(false);

  const fetchProfile = useCallback(async () => {
    if (!user || authLoading) {
      if (!authLoading) setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const profileData = await api.getProfile();
      setProfile(profileData);
    } catch (err) {
      console.error('Error loading profile:', err);
      setError('Failed to load profile data');
    } finally {
      setLoading(false);
    }
  }, [user, authLoading]);

  // Fetch profile when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      fetchProfile();
    }, [fetchProfile])
  );

  const handleLogout = async () => {
    // Show confirmation dialog
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Are you sure you want to log out?');
      if (!confirmed) return;
      await performLogout();
    } else {
      Alert.alert(
        'Log Out',
        'Are you sure you want to log out?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Log Out',
            style: 'destructive',
            onPress: performLogout
          }
        ]
      );
    }
  };

  const performLogout = async () => {
    setLoggingOut(true);
    try {
      const { error } = await signOut();

      if (error) {
        console.error('Logout error:', error);
        if (Platform.OS === 'web') {
          alert('Failed to log out. Please try again.');
        } else {
          Alert.alert('Error', 'Failed to log out. Please try again.');
        }
      }
      // Navigation handled automatically by AuthContext
    } catch (err) {
      console.error('Unexpected logout error:', err);
    } finally {
      setLoggingOut(false);
    }
  };

  const handleManageBilling = async () => {
    try {
      const { url } = await api.createPortalSession();

      const supported = await Linking.canOpenURL(url);

      if (supported) {
        await Linking.openURL(url);
      } else {
        if (Platform.OS === 'web') {
          alert('Unable to open billing portal');
        } else {
          Alert.alert('Error', 'Unable to open billing portal');
        }
      }
    } catch (error: any) {
      console.error('Error opening billing portal:', error);
      if (Platform.OS === 'web') {
        alert(`Failed to open billing portal: ${error.message || 'Unknown error'}`);
      } else {
        Alert.alert(
          'Error',
          `Failed to open billing portal: ${error.message || 'Unknown error'}`
        );
      }
    }
  };

  const baseMenuItems = [
    {
      icon: 'settings-outline',
      title: 'Settings',
      onPress: () => navigation.navigate('Settings'),
    },
    {
      icon: 'person-outline',
      title: 'Edit Profile',
      onPress: () => navigation.navigate('EditProfile')
    },
    {
      icon: 'card-outline',
      // "Plans" not "Subscription" — the screen also sells the one-time
      // Lifetime purchase (non-consumable), which isn't a subscription.
      title: 'Plans',
      onPress: () => navigation.navigate('Subscription')
    },
    {
      icon: 'notifications-outline',
      title: 'Notifications',
      onPress: () => navigation.navigate('Notifications'),
      hidden: true // Hide for now - will be enabled when notifications feature is ready
    },
    {
      icon: 'help-circle-outline',
      title: 'Help & Support',
      onPress: () => {},
      hidden: true // Hide for now - will be enabled when help feature is ready
    },
    {
      icon: 'information-circle-outline',
      title: 'About',
      onPress: () => {},
      hidden: true // Hide for now - will be enabled when about feature is ready
    },
  ];

  // Add Manage Billing (web/Stripe) or Manage Subscription (mobile/IAP) option
  const billingMenuItem = (() => {
    if (Platform.OS !== 'web' && profile?.plan && profile.plan !== 'free') {
      // Mobile users with an active subscription — link to platform subscription settings
      const subscriptionUrl = Platform.OS === 'ios'
        ? 'https://apps.apple.com/account/subscriptions'
        : 'https://play.google.com/store/account/subscriptions';
      return {
        icon: 'wallet-outline',
        title: 'Manage Subscription',
        onPress: () => Linking.openURL(subscriptionUrl),
        badge: profile?.subscriptionCancelAtPeriodEnd ? 'Canceling' : undefined,
        hidden: false,
      };
    }
    if (profile?.stripeCustomerId) {
      return {
        icon: 'wallet-outline',
        title: 'Manage Billing',
        onPress: handleManageBilling,
        badge: profile?.subscriptionCancelAtPeriodEnd ? 'Canceling' : undefined,
        hidden: false,
      };
    }
    return null;
  })();

  const allMenuItems = billingMenuItem
    ? [
        ...baseMenuItems.slice(0, 3),
        billingMenuItem,
        ...baseMenuItems.slice(3),
      ]
    : baseMenuItems;

  // Filter out hidden menu items
  const menuItems = allMenuItems.filter(item => !item.hidden);

  return (
    <ScreenWrapper style={[styles.container, { backgroundColor: theme.surface }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
        {/* Profile Header */}
        {(loading || authLoading) ? (
          <View style={[styles.profileHeader, { backgroundColor: theme.card }]}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.loadingText, { color: theme.textSecondary }]}>
              Loading profile...
            </Text>
          </View>
        ) : error ? (
          <View style={[styles.profileHeader, { backgroundColor: theme.card }]}>
            <Ionicons name="alert-circle" size={48} color={theme.error} />
            <Text style={[styles.userName, { color: theme.error }]}>
              {error}
            </Text>
            <TouchableOpacity
              onPress={fetchProfile}
              style={[styles.retryButton, { backgroundColor: theme.primary }]}
              accessibilityRole="button"
              accessibilityLabel="Retry loading profile"
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.profileHeader, { backgroundColor: theme.card }]}>
            <View style={[styles.avatarContainer, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
              <Ionicons name="person" size={48} color={theme.primary} />
            </View>
            <Text
              style={[styles.userName, { color: theme.text }]}
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
              {profile?.displayName || 'Set Your Name'}
            </Text>
            <Text
              style={[styles.userEmail, { color: theme.textSecondary }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
            >
              {profile?.email || user?.email || 'No email'}
            </Text>
            {profile?.plan && (
              <View style={[styles.planBadge, { backgroundColor: theme.primary }]}>
                <Text style={styles.badgeText}>
                  {profile.plan.charAt(0).toUpperCase() + profile.plan.slice(1)} Plan
                </Text>
              </View>
            )}
            {profile?.subscriptionStatus === 'active' && (
              <View style={[styles.statusBadge, { backgroundColor: theme.success }]}>
                <Ionicons name="checkmark-circle" size={14} color="#ffffff" />
                <Text style={styles.statusText}>Active Subscription</Text>
              </View>
            )}
            {profile?.subscriptionCancelAtPeriodEnd && (
              <View style={[styles.statusBadge, { backgroundColor: theme.warning || '#f59e0b' }]}>
                <Ionicons name="alert-circle" size={14} color="#ffffff" />
                <Text style={styles.statusText}>
                  Cancels {profile.subscriptionCurrentPeriodEnd ? new Date(profile.subscriptionCurrentPeriodEnd).toLocaleDateString() : 'soon'}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Stats */}
        <View style={styles.statsContainer}>
          <View style={[styles.statCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.statValue, { color: theme.text }]}>
              {loading ? '-' : (
                profile?.maxAudiobooks !== null
                  ? `${profile?.audiobookCount || 0}/${profile?.maxAudiobooks}`
                  : `${profile?.audiobookCount || 0}`
              )}
            </Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Audiobooks</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.statValue, { color: theme.text }]}>
              {loading ? '-' : (
                profile?.maxLifetimeConversions == null
                  ? 'Unlimited'
                  : `${profile?.lifetimeConversionsRemaining ?? 0}`
              )}
            </Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Credits Left</Text>
          </View>
        </View>

        {/* Menu Items */}
        <View style={[styles.menuContainer, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {menuItems.map((item, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.menuItem,
                { borderBottomColor: theme.border }
              ]}
              onPress={item.onPress}
              accessibilityRole="button"
              accessibilityLabel={item.title}
            >
              <View style={styles.menuLeft}>
                <Ionicons name={item.icon as keyof typeof Ionicons.glyphMap} size={24} color={theme.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
                <Text style={[styles.menuTitle, { color: theme.text }]}>{item.title}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.border} accessibilityElementsHidden importantForAccessibility="no" />
            </TouchableOpacity>
          ))}
        </View>

        {/* Logout Button */}
        <TouchableOpacity
          style={[styles.logoutButton, {
            backgroundColor: theme.card,
            borderColor: theme.error,
            opacity: loggingOut ? 0.6 : 1
          }]}
          onPress={handleLogout}
          disabled={loggingOut}
          accessibilityRole="button"
          accessibilityLabel={loggingOut ? 'Logging out' : 'Log out'}
          accessibilityState={{ disabled: loggingOut, busy: loggingOut }}
        >
          {loggingOut ? (
            <ActivityIndicator size="small" color={theme.error} />
          ) : (
            <>
              <Ionicons name="log-out-outline" size={20} color={theme.error} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={[styles.logoutText, { color: theme.error }]}>Log Out</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  profileHeader: {
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#ffffff',
  },
  avatarContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  userName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 4,
  },
  userEmail: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 12,
  },
  badge: {
    backgroundColor: '#6366f1',
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  statsContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: '#64748b',
  },
  menuContainer: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  menuLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuTitle: {
    marginLeft: 16,
    fontSize: 16,
    color: '#1e293b',
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    margin: 16,
    padding: 16,
    minHeight: 56,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  logoutText: {
    marginLeft: 8,
    fontSize: 16,
    fontWeight: '600',
    color: '#64748b',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#64748b',
  },
  retryButton: {
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#6366f1',
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  planBadge: {
    marginTop: 12,
    backgroundColor: '#6366f1',
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  statusText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
  },
});

export default ProfileScreen;
