/**
 * deviceId.ts
 * ===========
 * Single source of truth for the per-device anonymous identifier.
 *
 * Generated lazily on first call, persisted in expo-secure-store (mobile)
 * or localStorage (web). Returned through an in-memory cache after the
 * first read so the axios interceptor doesn't hit SecureStore on every
 * outbound request (one call per app launch is plenty).
 *
 * The ID is a UUID v4 generated with Math.random() — NOT a security token.
 * It's a pseudonymous identifier the backend uses to scope an anonymous
 * trial's audiobook + conversion task rows. The 1-lifetime-conversion gate
 * is a friction control, not a security barrier; abuse via reinstall +
 * fresh UUID is an accepted threat model.
 *
 * Sent as the X-Device-Id header on every outbound API request (see
 * services/api.ts). Backend's optional_auth decorator reads it into
 * request.device_id.
 *
 * NEVER throws — SecureStore errors degrade to a session-scoped in-memory
 * ID. Analytics / anonymous-mode still work within that session.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'ebookvoice_device_id';

let cachedDeviceId: string | null = null;

const generateUuidV4 = (): string => {
  // RFC 4122 v4-shaped string. Not cryptographically random — uses Math.random()
  // which is fine for a non-secret device identifier (we're not signing anything).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const readWeb = (): string | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(DEVICE_ID_KEY)
      : null;
  } catch {
    return null;
  }
};

const writeWeb = (id: string): void => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch {
    // Quota / privacy mode — caller already has the value in memory.
  }
};

export const getDeviceId = async (): Promise<string> => {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    if (Platform.OS === 'web') {
      const existing = readWeb();
      if (existing) {
        cachedDeviceId = existing;
        return existing;
      }
      const fresh = generateUuidV4();
      writeWeb(fresh);
      cachedDeviceId = fresh;
      return fresh;
    }

    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
    const fresh = generateUuidV4();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, fresh);
    cachedDeviceId = fresh;
    return fresh;
  } catch (err) {
    // SecureStore failure — fall back to a session-scoped ID so the app keeps
    // working. The ID won't persist across app launches but anonymous mode
    // still functions within the session.
    console.warn('[deviceId] persistent store failed, using session-only ID:', err);
    const sessionOnly = generateUuidV4();
    cachedDeviceId = sessionOnly;
    return sessionOnly;
  }
};

/** Synchronous accessor for code paths that have already awaited getDeviceId. */
export const getCachedDeviceId = (): string | null => cachedDeviceId;
