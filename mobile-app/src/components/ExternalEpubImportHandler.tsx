/**
 * ExternalEpubImportHandler
 * =========================
 * Headless component (renders nothing) that listens for incoming EPUB files
 * handed to the app via iOS's "Open in EbookVoice" share sheet
 * (CFBundleDocumentTypes registration in app.json).
 *
 * Lifecycle:
 *   - Mounts once near the root, inside AuthProvider + PendingImportProvider.
 *   - On mount: checks Linking.getInitialURL() (cold-launch case).
 *   - Also subscribes to Linking 'url' events (warm-launch / foreground hand-off).
 *   - For each .epub URL, copies the file out of the iOS Inbox to the app's
 *     cache directory (the Inbox URI becomes stale fast), then sets it as the
 *     PendingImport so MainNavigator can pick it up on the next render.
 *
 * Auth boundary: this component intentionally does NOT navigate. The
 * PendingImport stays held while the user signs in, and MainNavigator resumes
 * the import the moment `user` becomes truthy.
 *
 * Web: no-op. iOS only ships the document-type registration today (per
 * CLAUDE.md "we are iOS only at the moment").
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
// NOTE: expo-file-system v19 moved cacheDirectory/copyAsync/getInfoAsync to
// the /legacy entry point; the root export's new File/Directory API doesn't
// have them, which silently broke this import handler (caught 2026-06-10).
import * as FileSystem from 'expo-file-system/legacy';
import { usePendingImport } from '../context/PendingImportContext';
import { useAuth } from '../context/AuthContext';
import { track } from '../services/analytics';
import { navigationRef } from '../navigation/navigationRef';

const isEpubUrl = (url: string | null): url is string => {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.startsWith('file://') && lower.endsWith('.epub');
};

const ExternalEpubImportHandler = () => {
  const { pendingFile, setPending, clearPending } = usePendingImport();
  const { user } = useAuth();
  // Track auth state in a ref so the URL callback can read the current value
  // without re-subscribing every time auth changes.
  const wasAuthenticatedRef = useRef<boolean>(!!user);
  useEffect(() => {
    wasAuthenticatedRef.current = !!user;
  }, [user]);

  // Auto-resume: as soon as we have BOTH a pending file AND an authenticated
  // user, route them into Upload with the file pre-loaded. UploadScreen's
  // auto-extract effect (`route.params.preselectedFile`) takes it from there.
  // Sign-in-then-resume falls out for free: the file stays in PendingImport
  // while the user is on Login/SignUp, and this effect fires the moment auth
  // succeeds.
  useEffect(() => {
    if (user && pendingFile && navigationRef.isReady()) {
      navigationRef.navigate('Upload', { preselectedFile: pendingFile });
      clearPending();
    }
  }, [user, pendingFile, clearPending]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const handleIncomingUrl = async (url: string | null, opts: { cold: boolean }) => {
      if (!isEpubUrl(url)) return;

      try {
        // Decode in case iOS percent-encoded spaces (common on share-sheet handoff).
        const sourceUri = decodeURI(url);
        const originalName = sourceUri.split('/').pop() || 'imported.epub';

        // Copy out of the OS-managed inbox into our cache so the file stays
        // readable after the OS purges the inbox copy.
        const destUri = `${FileSystem.cacheDirectory}imported_${Date.now()}_${originalName}`;
        await FileSystem.copyAsync({ from: sourceUri, to: destUri });

        const info = await FileSystem.getInfoAsync(destUri);
        const size = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;

        setPending({
          uri: destUri,
          name: originalName,
          mimeType: 'application/epub+zip',
          size,
        });

        track('epub_opened_externally', {
          cold_launch: opts.cold,
          file_size_kb: size > 0 ? Math.round(size / 1024) : undefined,
          was_authenticated: wasAuthenticatedRef.current,
        });
      } catch (err) {
        // Never crash on a bad incoming URL — just drop it silently. The user
        // can still upload the file manually via the picker.
        console.warn('[ExternalEpubImport] Failed to import incoming URL:', err);
      }
    };

    // Cold-launch case: app was killed, OS launched us with the file URL.
    Linking.getInitialURL().then(url => handleIncomingUrl(url, { cold: true }));

    // Warm case: app was already running, OS hands us the file via an event.
    const sub = Linking.addEventListener('url', ({ url }) =>
      handleIncomingUrl(url, { cold: false }),
    );
    return () => sub.remove();
  }, [setPending]);

  return null;
};

export default ExternalEpubImportHandler;
