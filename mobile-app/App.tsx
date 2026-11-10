import React, { useEffect, useRef } from 'react';
import { StyleSheet, View, Platform, Text, TextInput } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { navigationRef } from './src/navigation/navigationRef';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import MainNavigator from './src/navigation/MainNavigator';
import { ThemeProvider } from './src/context/ThemeContext';
import { LanguageProvider } from './src/context/LanguageContext';
import { AuthProvider } from './src/context/AuthContext';
import { ConversionProvider } from './src/context/ConversionContext';
import { PendingImportProvider } from './src/context/PendingImportContext';
import ExternalEpubImportHandler from './src/components/ExternalEpubImportHandler';
import TermsConsentGate from './src/components/TermsConsentGate';
import WebContainer from './src/components/WebContainer';
import { loadFeatureFlags } from './src/services/featureFlags';
import { initAnalytics, trackScreen } from './src/services/analytics';

// Disable system font scaling globally so Android font size settings
// don't overflow our layouts on any device (OnePlus, Samsung, etc.)
(Text as any).defaultProps = (Text as any).defaultProps || {};
(Text as any).defaultProps.allowFontScaling = false;
(TextInput as any).defaultProps = (TextInput as any).defaultProps || {};
(TextInput as any).defaultProps.allowFontScaling = false;

// ── RNTP lock-screen / Bluetooth / CarPlay control wiring ──────────────────
// registerPlaybackService MUST run during JS bundle init (before the app
// mounts, and on a headless background launch) so the OS can route remote
// media commands into playbackService.js's handlers. This lives HERE — in the
// module Expo's AppEntry actually loads — and NOT in index.js: `package.json`
// main = node_modules/expo/AppEntry.js, which imports ./App and calls
// registerRootComponent(App); index.js is never executed, so the registration
// that used to live there never took effect. THAT is why the lock-screen
// buttons rendered but did nothing through every prior fix attempt. Do not
// move this back to index.js. Skipped on web (RNTP has no web implementation).
if (Platform.OS !== 'web') {
  try {
    const rntp = require('react-native-track-player');
    const RNTPlayer = rntp.default ?? rntp;
    if (RNTPlayer?.registerPlaybackService) {
      RNTPlayer.registerPlaybackService(() => require('./src/services/playbackService'));
      console.log('[App] RNTP playback service registered');
    } else {
      console.warn('[App] RNTP loaded but registerPlaybackService missing — lock-screen controls will not work');
    }
  } catch (err) {
    console.warn('[App] RNTP service registration skipped:', err);
  }
}

const prefix = Linking.createURL('/');

// Use View for web, GestureHandlerRootView for mobile
const RootContainer = Platform.OS === 'web' ? View : GestureHandlerRootView;

const App = () => {
  // Kick off remote feature-flag fetch as early as possible so the audio
  // backend selector has live values before PlayerScreen mounts.
  useEffect(() => {
    initAnalytics();
    loadFeatureFlags();
  }, []);

  // Automatic per-screen analytics: every navigation transition emits a
  // PostHog $screen event (deduped — tab/stack re-renders of the same route
  // don't double-fire). See trackScreen() in services/analytics.ts.
  const currentScreenRef = useRef<string | undefined>(undefined);
  const onNavReady = () => {
    currentScreenRef.current = navigationRef.getCurrentRoute()?.name;
    if (currentScreenRef.current) trackScreen(currentScreenRef.current);
  };
  const onNavStateChange = () => {
    const routeName = navigationRef.getCurrentRoute()?.name;
    if (routeName && routeName !== currentScreenRef.current) {
      currentScreenRef.current = routeName;
      trackScreen(routeName);
    }
  };

  const linking = {
    prefixes: [prefix, 'ebookvoice://', 'http://localhost:8081', 'https://localhost:8081'],
    config: {
      screens: {
        PaymentReturn: {
          path: 'payment/:result',
          parse: {
            result: (result: string) => result,
          },
        },
      },
    },
  };

  return (
    <SafeAreaProvider>
      <RootContainer style={styles.container}>
        <WebContainer maxWidth={480}>
          <LanguageProvider>
          <AuthProvider>
            <PendingImportProvider>
              <ThemeProvider>
                <ConversionProvider>
                  <ExternalEpubImportHandler />
                  <NavigationContainer
                    ref={navigationRef}
                    linking={linking}
                    onReady={onNavReady}
                    onStateChange={onNavStateChange}
                  >
                    <MainNavigator />
                  </NavigationContainer>
                  <TermsConsentGate />
                </ConversionProvider>
              </ThemeProvider>
            </PendingImportProvider>
          </AuthProvider>
          </LanguageProvider>
        </WebContainer>
      </RootContainer>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
