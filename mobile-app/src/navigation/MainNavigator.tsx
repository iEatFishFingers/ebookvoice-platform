import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';

// Import screens
import LibraryScreen from '../screens/LibraryScreen';
import ProfileScreen from '../screens/ProfileScreen';
import UploadScreen from '../screens/UploadScreen';
import BookSearchScreen from '../screens/BookSearchScreen';
import BookDetailScreen from '../screens/BookDetailScreen';
import EbookReviewScreen from '../screens/EbookReviewScreen';
import LanguageSelectionScreen from '../screens/LanguageSelectionScreen';
import VoiceSelectionScreen from '../screens/VoiceSelectionScreen';
import ChapterVoiceSelectionScreen from '../screens/ChapterVoiceSelectionScreen';
import ConversionScreen from '../screens/ConversionScreen';
import PlayerScreen from '../screens/PlayerScreen';
import SettingsScreen from '../screens/SettingsScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import SubscriptionScreen from '../screens/SubscriptionScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import PaymentReturnScreen from '../screens/PaymentReturnScreen';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';
import ForgotPasswordScreen from '../screens/ForgotPasswordScreen';
import { navigationRef } from './navigationRef';
import { takePendingPaywall } from '../utils/wordCap';
// Author Pro screens
import SmartSetupScreen from '../screens/SmartSetupScreen';
import AnalyticsDashboard from '../screens/AnalyticsDashboard';

import { RootStackParamList, MainTabParamList } from '../types';
import { DownloadProvider } from '../context/DownloadContext';

const Stack = createStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

// Shared tab-bar screen options used by both the authenticated and the
// anonymous tab navigators so they look identical apart from tab count.
const useTabScreenOptions = () => {
  const { theme } = useTheme();
  return ({ route }: { route: { name: string } }) => ({
    tabBarIcon: ({ focused, size, color }: { focused: boolean; size: number; color: string }) => {
      let iconName: keyof typeof Ionicons.glyphMap;
      if (route.name === 'Discover') {
        iconName = focused ? 'compass' : 'compass-outline';
      } else if (route.name === 'Library') {
        iconName = focused ? 'library' : 'library-outline';
      } else if (route.name === 'Profile') {
        iconName = focused ? 'person' : 'person-outline';
      } else {
        iconName = 'help-outline';
      }
      return <Ionicons name={iconName} size={size} color={color} />;
    },
    tabBarActiveTintColor: theme.primary,
    tabBarInactiveTintColor: theme.textSecondary,
    headerShown: false,
    tabBarStyle: {
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.card,
    },
    tabBarLabelStyle: {
      fontSize: 12,
      fontWeight: '600' as const,
    },
  });
};

// Authenticated tab navigator: Discover + Library + Profile.
// Library stays the initial route — returning listeners land on their books;
// the Discover tab is one swipe/tap away (and the empty-library CTA points
// straight at it for brand-new users).
const TabNavigator = () => {
  const screenOptions = useTabScreenOptions();
  const { t } = useTranslation();
  return (
    <Tab.Navigator initialRouteName="Library" screenOptions={screenOptions}>
      <Tab.Screen
        name="Discover"
        component={BookSearchScreen}
        options={{
          tabBarLabel: t('nav.discover'),
          tabBarAccessibilityLabel: 'Discover. Search free public-domain books',
        }}
      />
      <Tab.Screen
        name="Library"
        component={LibraryScreen}
        options={{
          tabBarLabel: t('nav.library'),
          tabBarAccessibilityLabel: 'Library. Your audiobooks',
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarLabel: t('nav.profile'),
          tabBarAccessibilityLabel: 'Profile. Your account and settings',
        }}
      />
    </Tab.Navigator>
  );
};

// Anonymous-trial tab navigator: Discover + Library. Lands on Discover —
// trial users have an empty library, so the public-domain catalog is the
// activation hook (signed-in users land on Library instead). Profile is
// account-scoped and unavailable without sign-up.
const AnonymousTabNavigator = () => {
  const screenOptions = useTabScreenOptions();
  const { t } = useTranslation();
  return (
    <Tab.Navigator initialRouteName="Discover" screenOptions={screenOptions}>
      <Tab.Screen
        name="Discover"
        component={BookSearchScreen}
        options={{
          tabBarLabel: t('nav.discover'),
          tabBarAccessibilityLabel: 'Discover. Search free public-domain books',
        }}
      />
      <Tab.Screen
        name="Library"
        component={LibraryScreen}
        options={{
          tabBarLabel: t('nav.library'),
          tabBarAccessibilityLabel: 'Library. Your audiobooks',
        }}
      />
    </Tab.Navigator>
  );
};

// Main Stack Navigator
const MainNavigator = () => {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const { user, loading, isAnonymous } = useAuth();

  // Login/SignUp/ForgotPassword exist in BOTH the cold and anonymous branches,
  // so flipping isAnonymous (via "Try without an account") while on one of them
  // keeps that still-valid route — and on web, navigation linking pins to the
  // current URL across re-renders. Explicitly reset to AnonymousMain when the
  // user opts in from a cold auth screen so they land on the anonymous Library.
  //
  // MUST run before the `if (loading)` early return below — every hook has to
  // be called unconditionally on every render, or the hook order changes when
  // `loading` flips and React throws "change in the order of Hooks".
  useEffect(() => {
    if (!isAnonymous || !navigationRef.isReady()) return;
    const current = navigationRef.getCurrentRoute()?.name;
    if (current === 'Login' || current === 'SignUp' || current === 'ForgotPassword') {
      navigationRef.reset({ index: 0, routes: [{ name: 'AnonymousMain' }] });
    }
  }, [isAnonymous]);

  // Word-cap handoff for a user who was anonymous when they hit the cap:
  // they were sent to sign-up with the suggested tier parked in wordCap.ts.
  // Now that `user` exists and the authenticated stack is mounting, open
  // the paywall on that tier.  The short delay lets the stack swap finish
  // before the navigate, and the ref guard covers the cold-start case.
  // Also above the early return — hook order.
  useEffect(() => {
    if (!user) return;
    const pending = takePendingPaywall();
    if (!pending) return;
    const t = setTimeout(() => {
      if (navigationRef.isReady()) navigationRef.navigate('Subscription', pending);
    }, 400);
    return () => clearTimeout(t);
  }, [user]);

  // Show loading screen while checking auth state
  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.surface }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  // Three-state routing:
  //   user        → full authenticated stack (Main TabNavigator + every screen)
  //   isAnonymous → anonymous trial (AnonymousMain + Upload chain + Player +
  //                 Login/SignUp still reachable so the claim banner works)
  //   neither     → cold-start Login / SignUp / ForgotPassword
  const initialRoute = user ? 'Main' : (isAnonymous ? 'AnonymousMain' : 'Login');

  return (
    <DownloadProvider>
    <Stack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{
        headerStyle: {
          backgroundColor: theme.primary,
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
        cardStyle: { flex: 1 },
      }}
    >
      {user ? (
        // Authenticated routes
        <>
          <Stack.Screen
            name="Main"
            component={TabNavigator}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Upload"
            component={UploadScreen}
            options={{ title: t('nav.upload') }}
          />
          {/* BookSearchScreen lives in the Discover tab (see TabNavigator) —
              it is no longer a stack route. BookDetail stays stack-level so
              it can be pushed from the tab. */}
          <Stack.Screen
            name="BookDetail"
            component={BookDetailScreen}
            options={{ title: t('nav.book_details'), headerShown: false }}
          />
          <Stack.Screen
            name="LanguageSelection"
            component={LanguageSelectionScreen}
            options={{ title: t('nav.book_language') }}
          />
          <Stack.Screen
            name="EbookReview"
            component={EbookReviewScreen}
            options={{ title: t('nav.review_chapters'), headerShown: false }}
          />
          <Stack.Screen
            name="VoiceSelection"
            component={VoiceSelectionScreen}
            options={{ title: t('nav.select_voice') }}
          />
          <Stack.Screen
            name="ChapterVoiceSelection"
            component={ChapterVoiceSelectionScreen}
            options={{ title: t('nav.select_voice') }}
          />
          <Stack.Screen
            name="SmartSetup"
            component={SmartSetupScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="AnalyticsDashboard"
            component={AnalyticsDashboard}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Conversion"
            component={ConversionScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Player"
            component={PlayerScreen}
            options={{ title: t('nav.now_playing'), headerShown: false }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: t('nav.settings') }}
          />
          <Stack.Screen
            name="EditProfile"
            component={EditProfileScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Subscription"
            component={SubscriptionScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Notifications"
            component={NotificationsScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="PaymentReturn"
            component={PaymentReturnScreen}
            options={{ headerShown: false }}
          />
        </>
      ) : isAnonymous ? (
        // Anonymous-trial routes. Discover/Library tabs + Upload chain +
        // Player are the value path; Login/SignUp stay reachable so the claim
        // banner + AnonymousLimitModal can route the user into sign-up at any
        // moment. BookDetail is included so the Discover tab works end-to-end
        // (/gutenberg/search and /extract-gutenberg are optional_auth; the
        // 1-book trial gate still runs at /convert-chapters via SmartSetup).
        // Excluded vs. the authenticated stack: Profile tab, Settings,
        // Subscription, EditProfile, AnalyticsDashboard, CreateEbook,
        // PaymentReturn, Notifications.
        <>
          <Stack.Screen
            name="AnonymousMain"
            component={AnonymousTabNavigator}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Upload"
            component={UploadScreen}
            options={{ title: t('nav.upload') }}
          />
          <Stack.Screen
            name="BookDetail"
            component={BookDetailScreen}
            options={{ title: t('nav.book_details'), headerShown: false }}
          />
          <Stack.Screen
            name="LanguageSelection"
            component={LanguageSelectionScreen}
            options={{ title: t('nav.book_language') }}
          />
          <Stack.Screen
            name="EbookReview"
            component={EbookReviewScreen}
            options={{ title: t('nav.review_chapters'), headerShown: false }}
          />
          {/* VoiceSelection (legacy picker) is INTENTIONALLY EXCLUDED from
              the anonymous stack — SmartSetup is the only voice picker
              reachable from EbookReview in the main flow. Including
              VoiceSelection would require duplicating the anonymous_limit_reached
              403 handler there too; cleaner to keep the surface small. */}
          <Stack.Screen
            name="SmartSetup"
            component={SmartSetupScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Conversion"
            component={ConversionScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Player"
            component={PlayerScreen}
            options={{ title: t('nav.now_playing'), headerShown: false }}
          />
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="SignUp"
            component={SignUpScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="ForgotPassword"
            component={ForgotPasswordScreen}
            options={{ headerShown: false }}
          />
        </>
      ) : (
        // Cold-start unauthenticated routes (deviceId not yet hydrated).
        // The mount effect in AuthContext resolves deviceId within ms of
        // app launch, so users usually only see this branch on a fresh
        // install before SecureStore returns.
        <>
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="SignUp"
            component={SignUpScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="ForgotPassword"
            component={ForgotPasswordScreen}
            options={{ headerShown: false }}
          />
        </>
      )}
    </Stack.Navigator>
    </DownloadProvider>
  );
};

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default MainNavigator;
