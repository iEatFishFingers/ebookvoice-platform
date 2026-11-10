/**
 * analytics.ts
 *
 * Thin, typed wrapper around PostHog (product analytics).
 *
 * Design rules:
 *  - Analytics MUST NEVER crash or block the app. Every call no-ops if the
 *    SDK failed to init or the key is missing.
 *  - Mobile only. Web no-ops (PostHog RN has native deps; web would use
 *    posthog-js separately if we ever want it).
 *  - Event names live in the AnalyticsEvent union — the single source of
 *    truth. Add an event here and autocomplete enforces it at every call
 *    site, so we never get "epubUploaded" vs "epub_uploaded" drift.
 *
 * Setup: add EXPO_PUBLIC_POSTHOG_KEY to .env (and optionally
 * EXPO_PUBLIC_POSTHOG_HOST — defaults to the EU cloud for GDPR residency).
 * Without the key the wrapper silently no-ops, so dev builds are unaffected.
 */

import { Platform } from 'react-native';
import * as Application from 'expo-application';
import PostHog from 'posthog-react-native';

const KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY || '';
const HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';

/**
 * Every analytics event in the app. snake_case, past tense, object_action.
 * `platform` is a registered super-property, never part of the name — so
 * Android slots in later with zero renames.
 *
 * NOTE: app-open / install / update / background are captured automatically
 * by PostHog's captureAppLifecycleEvents, so they are intentionally absent.
 */
export type AnalyticsEvent =
  | 'signup_completed'
  | 'login_completed'
  | 'epub_uploaded'
  | 'language_selected'
  | 'voice_selected'
  | 'conversion_started'
  | 'conversion_completed'
  | 'conversion_failed'
  | 'audiobook_played'
  // Sample/demo engagement (2026-07-11). Fires when the user LEAVES the Player
  // on the first-launch sample book (audiobook.isDemo). Tells us whether new
  // users actually listen to the sample or bounce — the core activation signal
  // for the "instant first-listen" direction. Properties:
  //   { audiobook_id, seconds_listened, duration_seconds, percent_complete,
  //     completed: boolean, played: boolean }
  // Pair with audiobook_played { is_sample: true } (the start) to get a
  // start→depth funnel. duration_seconds is the current chapter's length; the
  // demo is a short single-chapter guide so it reads as whole-sample depth.
  | 'sample_listened'
  // Lock-screen / Bluetooth / CarPlay remote-control usage (June 2026). ONE
  // event, broken down by `action`, so we can both (a) confirm the RNTP
  // lock-screen controls actually fire in the field — the whole point of the
  // 06-16 registration fix — and (b) measure real background-listening
  // engagement. Fires from playbackService.js (the RNTP remote handlers).
  // Property: { action: 'play'|'pause'|'stop'|'seek'|'jump_forward'|'jump_backward'|'next'|'previous' }
  | 'lockscreen_control_used'
  | 'conversion_limit_reached'
  // The word cap fired on /convert-chapters (413 too_large).  Properties:
  // { word_count, max_words, suggested_tier } — suggested_tier is the
  // cheapest tier that clears the book, or null at the infra ceiling.  Pair
  // with paywall_viewed { reason: 'word_cap' } to see how many follow through.
  | 'word_cap_hit'
  | 'paywall_viewed'
  | 'subscription_started'
  | 'subscription_confirmed'
  | 'subscription_cancelled'
  // Tutorial system (currently disabled via TUTORIAL_ENABLED flag — events
  // exist so when/if we re-enable, we have a clean baseline to compare
  // engagement against. Each event tagged with surface = 'onboarding' | 'tooltip'
  // and an identifier (step_name or storage_key) so they're queryable per
  // tutorial instance.)
  | 'tutorial_shown'
  | 'tutorial_step_next'
  | 'tutorial_completed'
  | 'tutorial_dismissed'
  // Empty-library activation funnel (added 2026-05-29 to track which
  // free-EPUB sources users actually tap from the empty-library state).
  // Property: { source: EpubSourceId } — see constants/epubSources.ts
  | 'epub_source_opened'
  // External EPUB import via iOS "Open in EbookVoice" (added 2026-06-01).
  // Fires when the OS hands us a file via CFBundleDocumentTypes. Tells us
  // how many users complete the round-trip from epub_source_opened → download
  // → re-open in our app. (iOS strips referrer, so we can't tie to a specific
  // source — only that the external-import path was used at all.)
  // Properties: { cold_launch: boolean, file_size_kb?: number, was_authenticated: boolean }
  | 'epub_opened_externally'
  // Anonymous-trial funnel (added 2026-06-01). Lets us measure how many
  // installs take the no-signup path vs. signing up first, and how many of
  // those eventually claim by signing up.
  // 'anonymous_trial_started' fires when the user taps "Try without an
  // account" on LoginScreen. Property: { source: 'login_screen' }.
  // 'anonymous_book_claimed' fires after a successful sign-in/up moves a
  // device's audiobook(s) to the new user. Property: { claimed: number }.
  | 'anonymous_trial_started'
  | 'anonymous_book_claimed'
  // Settings interactions (added 2026-05-29). High signal-to-noise because
  // a settings tap is a deliberate intent gesture — not navigation noise.
  // Property: { setting: 'dark_mode'|'notifications'|'follow_along_mode'|'tutorial', value: boolean | string }
  | 'setting_toggled'
  // Demand probe for language localization: users tap the "App Language"
  // row in Settings (which only says "English — more coming") and we
  // count it. Tells us whether to invest in i18n before doing it.
  | 'setting_language_probe_tapped'
  // Delete-account tap (the BUTTON tap, before the two confirmation
  // dialogs). Lets us see how many people consider deletion vs how many
  // follow through. Existing path only logged successful deletions.
  | 'setting_delete_account_tapped'
  // Library entry-point tracking. `source` is which surface the user
  // tapped from (header buttons vs empty-state CTAs) so we can tell
  // which path drives most uploads/creates.
  | 'library_book_opened'           // { audiobook_id: string }
  | 'library_upload_tapped'         // { source: 'header'|'empty_state'|'discover_header' }
  | 'library_search_tapped'         // { source: 'empty_state' } — jumps to the Discover tab (the old header button was removed June 2026)
  | 'library_search_category'       // { category } — tapped a category chip
  // Discover-tab funnel (June 2026, when book search became a bottom tab and
  // the anonymous landing screen). Together with the $screen events these
  // give the per-user catalog journey: browse → search → detail → convert.
  // book_id is the Project Gutenberg id — the SAME id Render logs print for
  // /extract-gutenberg, so PostHog timelines cross-reference server logs.
  | 'discover_search_performed'     // { query, category, results_count } — a debounced search/browse actually executed
  | 'discover_book_viewed'          // { book_id, title } — opened BookDetailScreen
  | 'gutenberg_convert_started'     // { book_id, word_count } — convert a public-domain book
  | 'gutenberg_extract_failed';     // { book_id, reason: 'no_text'|'too_long'|'error', word_count? } — convert attempt died before the queue

let client: PostHog | null = null;

/** Call once at app startup (App.tsx). Safe to call more than once. */
export const initAnalytics = (): void => {
  if (client || Platform.OS === 'web' || !KEY) return;
  try {
    client = new PostHog(KEY, {
      host: HOST,
      // Gives us "Application Opened/Installed/Updated/Backgrounded" for free.
      captureAppLifecycleEvents: true,
      // Off by default — EPUB content is sensitive; enable deliberately later,
      // scoped to specific flows, if a funnel step needs investigation.
      enableSessionReplay: false,
    });
    client.register({
      platform: Platform.OS,
      app_version: Application.nativeApplicationVersion ?? 'unknown',
    });
  } catch (e) {
    // Never let analytics break startup.
    console.warn('[Analytics] init failed:', e);
    client = null;
  }
};

/**
 * Tie the anonymous device to the Supabase user id after auth. Use the SAME
 * id we pass to RevenueCat's logIn() so subscription events (forwarded by the
 * RevenueCat -> PostHog integration) line up with in-app behaviour.
 */
export const identifyUser = (userId: string, props?: Record<string, any>): void => {
  client?.identify(userId, props);
};

/**
 * While the user is in the anonymous-trial state, identify with their device
 * UUID as the distinct_id. Call this at app launch before checking auth, so
 * pre-signup events are attributed to the device. After sign-in/up, call
 * identifyUser(supabaseUserId) followed by aliasAnalytics(deviceId) to stitch
 * the device's event history into the new user profile.
 */
export const identifyAnonymous = (deviceId: string): void => {
  client?.identify(deviceId, { is_anonymous: true });
};

/**
 * After identifyUser(userId), alias the prior anonymous device_id to that
 * user. PostHog merges the two persons so pre-signup events show on the
 * user's timeline. Call ONLY after identifyUser — alias() works against the
 * current distinct_id.
 */
export const aliasAnalytics = (alias: string): void => {
  client?.alias(alias);
};

/** Register/refresh super-properties attached to every subsequent event (e.g. subscription_tier). */
export const setUserProps = (props: Record<string, any>): void => {
  client?.register(props);
};

/** Track a funnel/behaviour event. */
export const track = (event: AnalyticsEvent, props?: Record<string, any>): void => {
  client?.capture(event, props);
};

/**
 * Record a screen view (PostHog "$screen" event). Wired once to the
 * NavigationContainer in App.tsx, so every screen transition lands in
 * PostHog with no per-screen instrumentation. This is what makes per-user
 * session timelines readable, and the distinct_id + timestamps line up with
 * Render request logs for cross-referencing.
 */
export const trackScreen = (name: string, props?: Record<string, any>): void => {
  client?.screen(name, props);
};

/** Clear identity on sign-out so the next user starts a fresh anonymous id. */
export const resetAnalytics = (): void => {
  client?.reset();
};
