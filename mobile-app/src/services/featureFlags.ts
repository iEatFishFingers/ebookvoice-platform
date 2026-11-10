/**
 * featureFlags
 * ────────────
 * Server-side flags fetched once per app launch.  Currently controls:
 *
 *   rntp_enabled — when true, mobile audio uses react-native-track-player
 *   (lock-screen / Bluetooth / CarPlay controls).  When false, falls back
 *   to expo-av.  Both are compiled into the binary so we can flip the
 *   server-side env FEATURE_RNTP_ENABLED=true/false to roll out (or
 *   roll back) without an app update.
 *
 * Defaults are pinned to the *safe* fallback path so a network failure on
 * launch doesn't break audio.  Two layers keep the real server value in
 * play despite that conservative default:
 *
 *   1. The last successful fetch is persisted to AsyncStorage and hydrated
 *      on the next launch — so a cold start (even offline) resumes from
 *      the last-known server values instead of hard defaults.  A flag flip
 *      on the server reaches offline devices on their next online launch.
 *   2. `ensureFeatureFlags()` lets a consumer await the in-flight fetch
 *      (bounded — never blocks more than ~2 s) before making a decision
 *      that is sticky for the whole session, like selecting the audio
 *      backend at player construction.  Without it, opening a book within
 *      the first second after a cold launch raced the fetch and could pin
 *      the session to expo-av — no lock-screen controls — even though the
 *      server said RNTP.  (Shipped bug, June 2026.)
 *
 * Call `loadFeatureFlags()` once early (App.tsx mount) to kick off the
 * fetch; synchronous consumers read `getFeatureFlags()`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiService from './api';

export interface FeatureFlags {
  rntp_enabled: boolean;
}

const DEFAULTS: FeatureFlags = {
  rntp_enabled: false,  // Safe default: legacy expo-av path
};

const STORAGE_KEY = '@feature_flags_v1';

let cached: FeatureFlags = { ...DEFAULTS };
let inFlight: Promise<void> | null = null;
// True once a fetch has succeeded this session — server values always
// outrank the AsyncStorage hydration, whatever order they resolve in.
let fetchSucceeded = false;
let hydrationStarted = false;

/** Load the last persisted flags. Only applied while no fetch has succeeded. */
const hydrateFromStorage = async (): Promise<void> => {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw && !fetchSucceeded) {
      const parsed = JSON.parse(raw);
      cached = { rntp_enabled: !!parsed?.rntp_enabled };
    }
  } catch {
    // Storage failure → stay on defaults; the network fetch may still win.
  }
};

/**
 * Kick off the flags fetch.  Safe to call multiple times — concurrent
 * calls share the same in-flight promise.  Resolves on success or
 * timeout/failure (silently — the cache keeps last-known values).
 *
 * `inFlight` is cleared on failure so a later call (e.g. after the user
 * comes back online) can retry; on success it's also cleared so a
 * server-side flag flip is picked up by an explicit refresh, if any
 * caller chooses to re-invoke.
 */
export function loadFeatureFlags(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const hydration = hydrateFromStorage();
    try {
      const data = await apiService.getFeatureFlags();
      cached = {
        rntp_enabled: !!data?.rntp_enabled,
      };
      fetchSucceeded = true;
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cached)).catch(() => {});
    } catch (err) {
      // Fetch failed — make sure the last-known persisted values (if any)
      // are in the cache before resolving, so awaiting callers see them.
      await hydration;
      console.warn('[featureFlags] fetch failed, using last-known/defaults:', err);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Synchronous read.  Returns the most recently fetched flags, or
 *  last-known/defaults if `loadFeatureFlags()` hasn't completed yet. */
export function getFeatureFlags(): FeatureFlags {
  return cached;
}

/**
 * Await real flag values before a decision that's sticky for the session
 * (e.g. choosing RNTP vs expo-av at player construction).  Resolves as soon
 * as a fetch has succeeded; otherwise waits for the in-flight fetch but
 * never longer than `maxWaitMs`, so offline playback (downloaded books)
 * starts promptly on last-known/default values.
 */
export async function ensureFeatureFlags(maxWaitMs = 2000): Promise<FeatureFlags> {
  if (!fetchSucceeded) {
    await Promise.race([
      loadFeatureFlags(),
      new Promise<void>(resolve => setTimeout(resolve, maxWaitMs)),
    ]);
  }
  return cached;
}
