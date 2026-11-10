/**
 * Bridge between the headless RNTP playback service and the Player screen.
 *
 * `playbackService.js` runs as a registered headless task so the OS can deliver
 * lock-screen / Bluetooth / CarPlay / Android Auto commands even when the React
 * tree is idle.  It shares the JS bundle with the app but has no access to
 * component state, so it can't change chapter on its own.
 *
 * PlayerScreen registers handlers here while it's mounted; the service calls
 * the emitters below.  When nothing is registered (no Player on screen) the
 * emitters return false and the service falls back to a seek, so the buttons
 * are never dead.
 *
 * Kept deliberately dependency-free — the service `require`s this module from a
 * headless context where pulling in React or navigation would be unsafe.
 */

export interface RemoteChapterHandlers {
  /** Advance one chapter. Returns false if there is no next chapter. */
  onNextChapter: () => boolean;
  /** Go back one chapter. Returns false if already on the first. */
  onPreviousChapter: () => boolean;
}

let handlers: RemoteChapterHandlers | null = null;

/** Called by PlayerScreen on mount; pass null on unmount. */
export function setRemoteChapterHandlers(next: RemoteChapterHandlers | null): void {
  handlers = next;
}

/** True when a Player is mounted and able to service chapter commands. */
export function hasRemoteChapterHandlers(): boolean {
  return handlers !== null;
}

/** Returns true when the command was handled — caller should not fall back. */
export function emitRemoteNextChapter(): boolean {
  if (!handlers) return false;
  try {
    return handlers.onNextChapter();
  } catch (error) {
    console.warn('[remoteChapterCommands] next-chapter handler threw:', error);
    return false;
  }
}

/** Returns true when the command was handled — caller should not fall back. */
export function emitRemotePreviousChapter(): boolean {
  if (!handlers) return false;
  try {
    return handlers.onPreviousChapter();
  } catch (error) {
    console.warn('[remoteChapterCommands] previous-chapter handler threw:', error);
    return false;
  }
}
