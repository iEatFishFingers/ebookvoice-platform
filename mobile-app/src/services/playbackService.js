/**
 * RNTP playback service.
 *
 * Registered once at app startup via TrackPlayer.registerPlaybackService.
 * Required so the OS can route lock-screen / Bluetooth / CarPlay / Android
 * Auto media commands into the JS player even when the React Native bridge
 * is paused.
 *
 * Uses defensive RNTP module extraction — `Event` and `TrackPlayer` may
 * sit on either the module root OR `module.default` depending on how
 * Metro's CJS↔ESM interop emits the require.  If an extraction fails we
 * log loudly so it's obvious in the dev-client console; without this
 * defence, an `undefined.RemotePlay` would silently kill all listeners
 * and lock-screen buttons would render fine but never actuate.
 */
module.exports = async function () {
  const RNTP = require('react-native-track-player');
  const TrackPlayer = RNTP && (RNTP.default || RNTP);
  const Event = (RNTP && RNTP.Event) || (RNTP && RNTP.default && RNTP.default.Event);

  if (!TrackPlayer || !Event) {
    console.error('[playbackService] RNTP imports failed — lock-screen buttons will not work', {
      hasTrackPlayer: !!TrackPlayer,
      hasEvent: !!Event,
      moduleKeys: RNTP ? Object.keys(RNTP) : null,
    });
    return;
  }

  // PostHog: record which lock-screen / Bluetooth / CarPlay control was used.
  // Defensive require so a bundling/interop hiccup in the headless task can
  // never crash playback. `track` itself no-ops if PostHog isn't initialised
  // (e.g. a cold headless launch before the app has mounted), so the audio
  // controls always work regardless of analytics. One event, broken down by
  // `action`, lets the owner chart real lock-screen usage in PostHog.
  let trackControl = () => {};
  try {
    const analytics = require('./analytics');
    const track = analytics.track || (analytics.default && analytics.default.track);
    if (typeof track === 'function') {
      trackControl = (action) => {
        try { track('lockscreen_control_used', { action }); } catch (e) {}
      };
    }
  } catch (e) {
    console.warn('[playbackService] analytics unavailable for lock-screen events:', e);
  }

  // Chapter navigation bridge. The Player registers handlers here while it's
  // mounted; if it isn't (or there's no chapter in that direction) we fall back
  // to a seek so the button always does something. Defensive require for the
  // same reason as analytics above — a headless-context interop hiccup must
  // never take out playback.
  let remoteNextChapter = () => false;
  let remotePreviousChapter = () => false;
  try {
    const remote = require('./remoteChapterCommands');
    if (typeof remote.emitRemoteNextChapter === 'function') {
      remoteNextChapter = remote.emitRemoteNextChapter;
    }
    if (typeof remote.emitRemotePreviousChapter === 'function') {
      remotePreviousChapter = remote.emitRemotePreviousChapter;
    }
  } catch (e) {
    console.warn('[playbackService] chapter bridge unavailable:', e);
  }

  console.log('[playbackService] starting — registering remote handlers');

  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    console.log('[playbackService] RemotePlay');
    trackControl('play');
    await TrackPlayer.play();
  });
  TrackPlayer.addEventListener(Event.RemotePause, async () => {
    console.log('[playbackService] RemotePause');
    trackControl('pause');
    await TrackPlayer.pause();
  });
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log('[playbackService] RemoteStop');
    trackControl('stop');
    TrackPlayer.stop();
  });
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => {
    console.log('[playbackService] RemoteSeek →', position);
    trackControl('seek');
    TrackPlayer.seekTo(position);
  });
  TrackPlayer.addEventListener(Event.RemoteJumpForward, ({ interval }) => {
    console.log('[playbackService] RemoteJumpForward', interval);
    trackControl('jump_forward');
    TrackPlayer.seekBy(interval || 15);
  });
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, ({ interval }) => {
    console.log('[playbackService] RemoteJumpBackward', interval);
    trackControl('jump_backward');
    TrackPlayer.seekBy(-(interval || 15));
  });
  // Next / previous mean CHAPTER for an audiobook — that's what the buttons say
  // to a driver and to VoiceOver. They used to be wired to ±30 s, which left the
  // app with no chapter navigation at all from the lock screen or CarPlay.
  // The ±15 s nudge lives on JumpForward/JumpBackward above, where iOS expects it.
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    trackControl('next');
    if (remoteNextChapter()) {
      console.log('[playbackService] RemoteNext → next chapter');
      return;
    }
    // No Player mounted, or already on the last chapter.
    console.log('[playbackService] RemoteNext → no next chapter, nudging +30 s');
    TrackPlayer.seekBy(30);
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    trackControl('previous');
    if (remotePreviousChapter()) {
      console.log('[playbackService] RemotePrevious → previous chapter');
      return;
    }
    console.log('[playbackService] RemotePrevious → no previous chapter, nudging -30 s');
    TrackPlayer.seekBy(-30);
  });

  console.log('[playbackService] all remote handlers registered');
};
