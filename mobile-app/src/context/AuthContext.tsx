import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { createClient, Session, User as SupabaseUser, AuthError } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, AppState, AppStateStatus } from 'react-native';
import * as Linking from 'expo-linking';
import 'react-native-url-polyfill/auto';
import { registerForPushNotifications } from '../utils/notifications';
import { initializePurchases, logOutPurchases } from '../services/purchaseService';
import { identifyUser, identifyAnonymous, aliasAnalytics, resetAnalytics, track } from '../services/analytics';
import { getDeviceId } from '../services/deviceId';
import apiService from '../services/api';

// Supabase configuration from environment variables
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

// Persisted marker: has any user ever signed in on this device? Decides the
// cold-start screen for logged-out users — brand-new devices auto-enter the
// anonymous trial (convert straight away); returning devices see Login (with a
// "Try without an account" escape). Set on first SIGNED_IN, never cleared.
const HAS_LOGGED_IN_KEY = '@has_logged_in_before';

// Custom storage adapter for Supabase auth.
// SecureStore has a hard 2048-byte limit — Supabase session objects exceed this,
// so the write silently fails and the refresh token is lost on next launch.
// Using AsyncStorage for all mobile storage avoids this issue while still
// persisting the session across restarts.
const customStorageAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      if (Platform.OS === 'web') {
        return localStorage.getItem(key);
      }
      return await AsyncStorage.getItem(key);
    } catch (error) {
      console.error('Error getting item from storage:', error);
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      if (Platform.OS === 'web') {
        localStorage.setItem(key, value);
        return;
      }
      await AsyncStorage.setItem(key, value);
    } catch (error) {
      console.error('Error setting item in storage:', error);
    }
  },
  removeItem: async (key: string): Promise<void> => {
    try {
      if (Platform.OS === 'web') {
        localStorage.removeItem(key);
        return;
      }
      await AsyncStorage.removeItem(key);
    } catch (error) {
      console.error('Error removing item from storage:', error);
    }
  },
};

// Initialize Supabase client
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: customStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// Refresh gate: when a foreground token refresh is in progress, this holds the promise.
// The API interceptor awaits this to avoid sending requests with stale tokens.
let refreshPromise: Promise<void> | null = null;

export function getRefreshPromise(): Promise<void> | null {
  return refreshPromise;
}

interface AuthContextType {
  user: SupabaseUser | null;
  session: Session | null;
  loading: boolean;
  /**
   * Per-device anonymous identifier (UUID from expo-secure-store). Always set
   * once the mount effect resolves — even when `user` is non-null. Used by:
   *   - MainNavigator to route unauthenticated requests through the anonymous
   *     stack (Library + Upload + Player) when set, or the Login/SignUp stack
   *     when null.
   *   - api.ts interceptor (attaches X-Device-Id to every outbound request).
   *   - claimAnonymousBook flow on sign-in/up.
   * Persistent across sign-out by design — see CLAUDE.md "anonymous trial".
   */
  deviceId: string | null;
  /**
   * Canonical "is this user in anonymous-trial state" derivation. `true` iff
   * we have a device identity (`deviceId`) but no authenticated user. Exposed
   * on the context to keep callers from re-deriving with slightly different
   * conditions across screens.
   */
  isAnonymous: boolean;
  /**
   * Idempotent hook called from LoginScreen's "Try without an account" CTA.
   * In practice the deviceId is already set by the mount effect, so this is
   * a named no-op that exists to make call sites self-documenting and to
   * fire the `anonymous_trial_started` analytics event.
   */
  enableAnonymousMode: () => Promise<void>;
  signUp: (email: string, password: string, firstName: string, lastName: string) => Promise<{ error: AuthError | null; needsEmailConfirmation?: boolean; emailAlreadyExists?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signInWithGoogle: () => Promise<{ error: AuthError | null }>;
  signInWithApple: () => Promise<{ error: AuthError | null; cancelled?: boolean }>;
  signOut: () => Promise<{ error: AuthError | null }>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Has this device ever had a signed-in user (persisted)? + did the user tap
  // "Try without an account" this session? Together these gate anonymous mode:
  // new devices auto-enter it; returning devices must opt in via the button.
  const [hasLoggedInBefore, setHasLoggedInBefore] = useState<boolean>(false);
  const [anonymousOptedIn, setAnonymousOptedIn] = useState<boolean>(false);
  // Gate the navigator until deviceId + the returning-device flag are read, so
  // a returning user doesn't flash the anonymous Library before Login.
  const [bootReady, setBootReady] = useState<boolean>(false);
  const appState = useRef<AppStateStatus>('active');
  const hasBeenBackgrounded = useRef(false);
  const lastForegroundRefresh = useRef(0);
  const googleProfileUpdated = useRef(false);
  // Guards the post-sign-in anonymous-book claim so it fires at most once per
  // mounted provider. Without this, web users who session-restore on every
  // page reload would hit /api/anonymous/claim on every load (the endpoint is
  // idempotent so this is harmless, just wasted bandwidth).
  const anonymousClaimFired = useRef(false);

  // Resolve the per-device anonymous identifier as soon as the provider mounts.
  // Runs in parallel with Supabase session hydration — independent concerns.
  // When the user is later identified, AuthContext aliases this deviceId so
  // PostHog stitches anonymous events into the user profile.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await getDeviceId();
        if (cancelled) return;
        setDeviceId(id);
        // Identify anonymous user in PostHog. If a Supabase session is also
        // restored, the onAuthStateChange handler will re-identify with the
        // user_id and call aliasAnalytics(id) to merge histories.
        if (!user) {
          identifyAnonymous(id);
        }
        // Returning-device check: drives the cold-start screen choice.
        const seen = await customStorageAdapter.getItem(HAS_LOGGED_IN_KEY);
        if (!cancelled && seen === 'true') setHasLoggedInBefore(true);
      } catch (err) {
        console.warn('[AuthContext] anonymous boot failed:', err);
      } finally {
        if (!cancelled) setBootReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let initialSessionHandled = false;

    // Safety timeout: don't hang forever if INITIAL_SESSION never fires
    const timeoutId = setTimeout(() => {
      if (!initialSessionHandled) {
        initialSessionHandled = true;
        console.warn('⚠️ Auth initialization timed out, unblocking app');
        setLoading(false);
      }
    }, 5000);

    // Use onAuthStateChange as the primary session source.
    // The INITIAL_SESSION event fires once Supabase has fully hydrated the
    // stored session from SecureStore/AsyncStorage, avoiding the race condition
    // where getSession() returns null before storage is ready.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, currentSession) => {
        console.log('Auth state changed:', event);
        setSession(currentSession);
        setUser(currentSession?.user ?? null);

        // Unblock the app on the first auth event that confirms session state.
        // INITIAL_SESSION is the canonical event, but some Supabase versions
        // on web fire SIGNED_IN or TOKEN_REFRESHED instead when a stored
        // session already exists.
        if (!initialSessionHandled && (
          event === 'INITIAL_SESSION' ||
          event === 'SIGNED_IN' ||
          event === 'TOKEN_REFRESHED'
        )) {
          initialSessionHandled = true;
          clearTimeout(timeoutId);
          setLoading(false); // Auth is now truly ready
        }

        // Handle Google OAuth profile creation/update — only once per session load
        if (event === 'SIGNED_IN' && currentSession?.user && !googleProfileUpdated.current) {
          const user = currentSession.user;
          const metadata = user.user_metadata;

          // Check if this is a Google OAuth user
          if (metadata?.iss === 'https://accounts.google.com') {
            googleProfileUpdated.current = true;
            track('login_completed', { method: 'google' });
            const firstName = metadata.given_name || '';
            const lastName = metadata.family_name || '';
            const displayName = metadata.full_name || `${firstName} ${lastName}`.trim();

            // Route through the backend API (uses service role key, bypasses RLS).
            // Fire-and-forget with an abort timeout: a slow/cold backend must not
            // block onAuthStateChange from completing or downstream listeners stall.
            const apiUrl = (Platform.OS !== 'web' && process.env.EXPO_PUBLIC_DEV_API_URL)
              ? process.env.EXPO_PUBLIC_DEV_API_URL
              : (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080');
            const controller = new AbortController();
            const abortId = setTimeout(() => controller.abort(), 8000);
            fetch(`${apiUrl}/api/profile`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${currentSession.access_token}`,
              },
              body: JSON.stringify({
                first_name: firstName,
                last_name: lastName,
                display_name: displayName,
                email: user.email || '',
              }),
              signal: controller.signal,
            })
              .then(() => console.log('Updated profile with Google OAuth data'))
              .catch(error => console.error('Error updating profile with Google data:', error))
              .finally(() => clearTimeout(abortId));
          }
        }

        // Initialize RevenueCat for IAP whenever we have a valid session (mobile only).
        // This covers both fresh sign-ins and session restores (INITIAL_SESSION / TOKEN_REFRESHED).
        if (currentSession?.user && Platform.OS !== 'web' &&
            (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          initializePurchases(currentSession.user.id).catch(err =>
            console.warn('Failed to initialize RevenueCat:', err)
          );
          // Same id as RevenueCat.logIn() so subscription events forwarded by
          // the RevenueCat -> PostHog integration line up with in-app behaviour.
          identifyUser(currentSession.user.id, { email: currentSession.user.email });
        }

        // SIGNED_IN: claim any pending anonymous trial book + alias PostHog
        // events. Fire-and-forget — never block the auth flow on these.
        // Pulls the device ID inline (not from state) to avoid a race when
        // sign-in completes before the mount effect has populated deviceId.
        // anonymousClaimFired ref prevents re-firing on web session restores
        // (which emit SIGNED_IN per page reload).
        if (event === 'SIGNED_IN' && currentSession?.user && !anonymousClaimFired.current) {
          anonymousClaimFired.current = true;
          // Mark this device as "returning" so future cold starts show Login
          // (with the anonymous escape) instead of auto-entering the trial.
          setHasLoggedInBefore(true);
          customStorageAdapter.setItem(HAS_LOGGED_IN_KEY, 'true');
          (async () => {
            try {
              const id = await getDeviceId();
              aliasAnalytics(id);
              const result = await apiService.claimAnonymousBook(id);
              if (result.claimed > 0) {
                track('anonymous_book_claimed', { claimed: result.claimed });
              }
            } catch (err) {
              // Claim is best-effort. The user lands on their library either
              // way and a manual library refresh will re-sync.
              console.warn('[AuthContext] anonymous claim failed:', err);
            }
          })();
        }

        // Register push notification token for all sign-ins (mobile only)
        if (event === 'SIGNED_IN' && currentSession?.user && Platform.OS !== 'web') {
          registerForPushNotifications().then(token => {
            if (!token) return;
            const apiUrl = (Platform.OS !== 'web' && process.env.EXPO_PUBLIC_DEV_API_URL)
              ? process.env.EXPO_PUBLIC_DEV_API_URL
              : (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080');
            fetch(`${apiUrl}/api/push-token`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${currentSession.access_token}`,
              },
              body: JSON.stringify({ token }),
            }).catch(err => console.warn('Failed to save push token:', err));
          }).catch(err => console.warn('Failed to register for push notifications:', err));
        }
      }
    );

    return () => {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, []);

  // Handle app state changes (foreground/background) — MOBILE ONLY.
  //
  // On WEB, we skip this entirely. Supabase's `autoRefreshToken: true` already
  // hooks into the browser's `visibilitychange` and `focus` events to refresh
  // tokens automatically. Adding our own manual `refreshSession()` call on web
  // causes a TOKEN ROTATION RACE CONDITION:
  //   1. autoRefreshToken fires → uses refresh token R1 → stores new R2
  //   2. Our AppState handler fires simultaneously → tries R1 again → invalid → SIGNED_OUT
  // The user then sees the login screen after ~1 min of inactivity.
  //
  // On NATIVE (iOS/Android), the OS can kill background JS timers so autoRefreshToken
  // might miss its window. The AppState refresh is genuinely necessary there.
  useEffect(() => {
    if (Platform.OS === 'web') return; // Supabase autoRefreshToken handles web

    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      // Track when the app actually goes to background
      if (nextAppState.match(/inactive|background/)) {
        hasBeenBackgrounded.current = true;
      }

      if (
        hasBeenBackgrounded.current &&
        appState.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // Debounce: skip if we refreshed less than 30 seconds ago.
        const now = Date.now();
        if (now - lastForegroundRefresh.current < 30000) {
          appState.current = nextAppState;
          return;
        }
        lastForegroundRefresh.current = now;

        console.log('App returned to foreground, refreshing session...');

        // Set the refresh gate so API interceptor waits for this to complete.
        // Includes a 10-second timeout so a hanging refreshSession() never blocks the app.
        if (!refreshPromise) {
          refreshPromise = (async () => {
            try {
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Session refresh timed out')), 10000)
              );

              const { data: { session: refreshedSession }, error } = await Promise.race([
                supabase.auth.refreshSession(),
                timeoutPromise,
              ]);

              if (error) {
                console.error('Error refreshing session on app focus:', error);
                // Fall back to the existing cached session — do NOT explicitly call
                // setSession(null)/setUser(null) here. If the session is truly gone,
                // Supabase fires SIGNED_OUT via onAuthStateChange and that handles logout.
                // Explicitly nulling state here causes spurious logouts on transient errors.
                const { data: { session: existingSession } } = await supabase.auth.getSession();
                if (existingSession) {
                  setSession(existingSession);
                  setUser(existingSession.user);
                }
                // If existingSession is null, Supabase already fired SIGNED_OUT — no action needed.
              } else if (refreshedSession) {
                console.log('Session refreshed on app focus');
                setSession(refreshedSession);
                setUser(refreshedSession.user);
              }
            } catch (err) {
              console.error('Foreground session refresh failed/timed out:', err);
              // On timeout, proceed with existing session — don't block or logout
            } finally {
              refreshPromise = null;
            }
          })();
        }

        await refreshPromise;
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    // Handle deep link OAuth callbacks (mobile only)
    // Web OAuth is handled automatically by Supabase via detectSessionInUrl: true
    if (Platform.OS === 'web') return;

    const handleDeepLink = async (event: { url: string }) => {
      const url = event.url;
      console.log('Deep link received:', url);

      if (url.includes('auth/callback')) {
        try {
          // Parse query params from the deep link URL.
          // react-native-url-polyfill (imported at top) makes new URL() work on RN.
          const urlObj = new URL(url);
          const tokenHash = urlObj.searchParams.get('token_hash');
          const type = urlObj.searchParams.get('type');
          const code = urlObj.searchParams.get('code');

          if (tokenHash && type) {
            // Email confirmation / password recovery link — uses token_hash
            const { error } = await supabase.auth.verifyOtp({
              token_hash: tokenHash,
              type: type as any,
            });
            if (error) {
              console.error('verifyOtp error:', error);
            } else {
              console.log('Auth token verified successfully, type:', type);
            }
          } else if (code) {
            // PKCE OAuth code exchange (Google etc.)
            await supabase.auth.exchangeCodeForSession(url);
          } else {
            // Implicit flow — tokens in URL hash; getSession() picks them up
            await supabase.auth.getSession();
          }
        } catch (error) {
          console.error('Error processing auth callback:', error);
          await supabase.auth.getSession();
        }
      }
    };

    // Listen for deep links when app is already open
    const subscription = Linking.addEventListener('url', handleDeepLink);

    // Check if app was opened via deep link
    Linking.getInitialURL().then((url) => {
      if (url) {
        handleDeepLink({ url });
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const signUp = async (email: string, password: string, firstName: string, lastName: string) => {
    try {
      // Set the redirect URL so confirmation emails link back to the app.
      // On web: current origin. On mobile: deep link scheme.
      const emailRedirectTo = Platform.OS === 'web'
        ? `${window.location.origin}/`
        : 'ebookvoice://auth/callback';

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo,
          data: {
            first_name: firstName,
            last_name: lastName,
            display_name: `${firstName} ${lastName}`,
          },
        },
      });

      if (error) {
        console.error('Sign up error:', error);
        return { error };
      }

      // When email confirmation is ON and the email already exists, Supabase
      // returns a fake success with an empty identities array to prevent
      // user enumeration. Detect this and surface it to the UI.
      if (data.user?.identities?.length === 0) {
        return { error: null, emailAlreadyExists: true };
      }

      track('signup_completed', { method: 'email' });

      // If session is null, Supabase requires email confirmation before login
      const needsEmailConfirmation = !data.session;
      return { error: null, needsEmailConfirmation };
    } catch (error) {
      console.error('Unexpected sign up error:', error);
      return { error: error as AuthError };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error('Sign in error:', error);
        return { error };
      }

      track('login_completed', { method: 'email' });
      return { error: null };
    } catch (error) {
      console.error('Unexpected sign in error:', error);
      return { error: error as AuthError };
    }
  };

  const signInWithGoogle = async () => {
    try {
      const redirectTo = Platform.OS === 'web'
        ? `${window.location.origin}/`
        : 'ebookvoice://auth/callback';

      console.log('Initiating Google sign in with redirect:', redirectTo);

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: Platform.OS !== 'web',
        },
      });

      if (error) {
        console.error('Google sign in error:', error);
        return { error };
      }

      // On mobile, open the OAuth URL in the system browser
      if (Platform.OS !== 'web' && data?.url) {
        const supported = await Linking.canOpenURL(data.url);
        if (supported) {
          await Linking.openURL(data.url);
        } else {
          console.error('Cannot open URL:', data.url);
          return { error: new Error('Cannot open authentication URL') as AuthError };
        }
      }

      console.log('Google OAuth initiated successfully');
      return { error: null };
    } catch (error) {
      console.error('Unexpected Google sign in error:', error);
      return { error: error as AuthError };
    }
  };

  const signInWithApple = async (): Promise<{ error: AuthError | null; cancelled?: boolean }> => {
    if (Platform.OS !== 'ios') {
      return { error: new Error('Sign in with Apple is only available on iOS') as AuthError };
    }
    try {
      const AppleAuthentication = require('expo-apple-authentication');
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken) {
        return { error: new Error('Apple did not return an identity token') as AuthError };
      }

      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
      });

      if (error) {
        console.error('Supabase signInWithIdToken error:', error);
        const msg = error.message ?? '';
        const isTransient =
          msg.includes('JSON Parse') ||
          msg.includes('unexpected character') ||
          msg.includes('Failed to fetch') ||
          msg.includes('Network request failed') ||
          msg.includes('NetworkError');
        if (isTransient) {
          return { error: new Error('Sign in is temporarily unavailable. Please try again in a moment.') as AuthError };
        }
        return { error };
      }

      // Apple returns fullName only on FIRST sign-in. If present, persist it to the profile.
      // Fire-and-forget with an abort timeout — never block the login flow on this fetch,
      // because the backend (Render free tier) may be cold-starting (30–60s) and any
      // delay here freezes the post-login UI on iPad/iOS.
      const user = data?.user;
      const fullName = credential.fullName;
      if (user && fullName && (fullName.givenName || fullName.familyName)) {
        // Apple sign-in only runs on iOS (guarded above), so no web check needed.
        const apiUrl = process.env.EXPO_PUBLIC_DEV_API_URL
          || process.env.EXPO_PUBLIC_API_URL
          || 'http://localhost:8080';
        const firstName = fullName.givenName || '';
        const lastName = fullName.familyName || '';
        const accessToken = data.session?.access_token;
        const controller = new AbortController();
        const abortId = setTimeout(() => controller.abort(), 8000);
        fetch(`${apiUrl}/api/profile`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            first_name: firstName,
            last_name: lastName,
            display_name: `${firstName} ${lastName}`.trim(),
            email: user.email || '',
          }),
          signal: controller.signal,
        })
          .catch(e => console.warn('Failed to persist Apple profile name:', e))
          .finally(() => clearTimeout(abortId));
      }

      track('login_completed', { method: 'apple' });
      return { error: null };
    } catch (error: any) {
      // User cancelled the Apple sign-in sheet — surface silently to callers
      if (error?.code === 'ERR_REQUEST_CANCELED') {
        return { error: null, cancelled: true };
      }
      console.error('Apple sign in error:', error);
      return { error: error as AuthError };
    }
  };

  const signOut = async () => {
    try {
      // Clear this device's push token from the user's profile BEFORE the
      // auth session is destroyed — otherwise the backend can't authenticate
      // the DELETE and the token is left dangling on the profile row, which
      // causes notifications for the just-signed-out account to keep arriving
      // on this device after a different user signs in. Best-effort: don't
      // block sign-out if this call fails (e.g. offline).
      if (Platform.OS !== 'web') {
        try {
          const { data: { session: currentSession } } = await supabase.auth.getSession();
          if (currentSession?.access_token) {
            const apiUrl = process.env.EXPO_PUBLIC_DEV_API_URL
              || process.env.EXPO_PUBLIC_API_URL
              || 'http://localhost:8080';
            await fetch(`${apiUrl}/api/push-token`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${currentSession.access_token}` },
            });
          }
        } catch (err) {
          console.warn('Failed to clear push token on sign-out:', err);
        }
      }

      // Log out of RevenueCat before clearing the session (mobile only)
      await logOutPurchases();
      resetAnalytics();

      const { error } = await supabase.auth.signOut();

      if (error) {
        console.error('Sign out error:', error);
        return { error };
      }

      setUser(null);
      setSession(null);
      return { error: null };
    } catch (error) {
      console.error('Unexpected sign out error:', error);
      return { error: error as AuthError };
    }
  };

  const refreshProfile = async () => {
    try {
      // Refresh the current session to get updated user data
      const { data: { session: currentSession }, error } = await supabase.auth.getSession();

      if (error) {
        console.error('Error refreshing profile:', error);
        return;
      }

      if (currentSession) {
        setSession(currentSession);
        setUser(currentSession.user);
        console.log('Profile refreshed successfully');
      }
    } catch (error) {
      console.error('Error refreshing profile:', error);
    }
  };

  const enableAnonymousMode = async (): Promise<void> => {
    // deviceId is already set by the mount effect, but resolve again to
    // tolerate the (rare) race where the user taps the CTA before the
    // mount effect has resolved. getDeviceId() is idempotent + cached.
    const id = await getDeviceId();
    if (!deviceId) {
      setDeviceId(id);
      identifyAnonymous(id);
    }
    // Explicit opt-in: lets a returning device (which would otherwise see
    // Login) enter the anonymous trial for this session.
    setAnonymousOptedIn(true);
    track('anonymous_trial_started', { source: 'login_screen' });
  };

  const value: AuthContextType = {
    user,
    session,
    loading: loading || !bootReady,
    deviceId,
    // Anonymous trial is active when: not signed in, we have a device identity,
    // AND either this is a brand-new device (never signed in) or the user
    // explicitly tapped "Try without an account" this session.
    isAnonymous: !user && !!deviceId && (anonymousOptedIn || !hasLoggedInBefore),
    enableAnonymousMode,
    signUp,
    signIn,
    signInWithGoogle,
    signInWithApple,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
