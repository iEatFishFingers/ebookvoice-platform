import { Platform } from 'react-native';
import { getFeatureFlags } from '../services/featureFlags';

// Conditionally import expo-av only for mobile
let Audio: any = null;
if (Platform.OS !== 'web') {
  Audio = require('expo-av').Audio;
}

// Conditionally import RNTP only for mobile.  Loading the module is cheap;
// it doesn't initialise the native player until TrackPlayer.setupPlayer()
// is called, which we defer to first use.
//
// Defensive extraction: Metro's CJS↔ESM interop can place named exports
// (`Capability`, `Event`, `State`) on either the module root OR on
// `.default`, depending on whether the imported package emits ESM or CJS.
// Falling back through both keeps the binary working regardless of which
// shape we get.  If any of these end up null, RNTP setup will fail (and
// we log loudly) — better than silently advertising capabilities that
// don't actuate.
let TrackPlayer: any = null;
let RNTPCapability: any = null;
let RNTPEvent: any = null;
let RNTPState: any = null;
if (Platform.OS !== 'web') {
  try {
    const rntp = require('react-native-track-player');
    TrackPlayer  = rntp.default ?? rntp;
    RNTPCapability = rntp.Capability ?? rntp.default?.Capability;
    RNTPEvent      = rntp.Event      ?? rntp.default?.Event;
    RNTPState      = rntp.State      ?? rntp.default?.State;
    if (!TrackPlayer || !RNTPCapability || !RNTPEvent || !RNTPState) {
      console.warn('[audioPlayer] RNTP partial import — lock-screen controls may not work', {
        hasTrackPlayer: !!TrackPlayer,
        hasCapability: !!RNTPCapability,
        hasEvent: !!RNTPEvent,
        hasState: !!RNTPState,
      });
    }
  } catch (err) {
    console.warn('[audioPlayer] RNTP module not available:', err);
  }
}

/** Optional metadata passed to `loadAsync` for lock-screen / Bluetooth /
 *  CarPlay display.  Only RNTPMobileAudioPlayer uses these — the legacy
 *  expo-av and web players ignore them. */
export interface NowPlayingMetadata {
  title?: string;       // e.g. chapter title
  artist?: string;      // e.g. audiobook title
  artwork?: string;     // image URL (Cloudinary cover)
}

export interface AudioPlayerInterface {
  /**
   * @param startPositionSeconds Resume point, applied as part of the load.
   *   Pass it here rather than seeking after `loadAsync` resolves: `loadAsync`
   *   returns once the track is queued, which on a remote MP3 over a mobile
   *   connection is long before it can accept a seek.  Each implementation
   *   applies the position at the point where it is guaranteed to stick.
   */
  loadAsync: (
    uri: string,
    shouldPlay?: boolean,
    metadata?: NowPlayingMetadata,
    startPositionSeconds?: number,
  ) => Promise<void>;
  playAsync: () => Promise<void>;
  pauseAsync: () => Promise<void>;
  stopAsync: () => Promise<void>;
  unloadAsync: () => Promise<void>;
  setPositionAsync: (position: number) => Promise<void>;
  setRateAsync: (rate: number, shouldCorrectPitch: boolean) => Promise<void>;
  getStatusAsync: () => Promise<any>;
  setOnPlaybackStatusUpdate: (callback: (status: any) => void) => void;
}

class WebAudioPlayer implements AudioPlayerInterface {
  private audio: HTMLAudioElement | null = null;
  // Each chapter is a new <audio> element, which starts at 1x — carry the
  // user's rate across loads so it never silently drops back to normal.
  private currentRate = 1;
  private onStatusUpdate: ((status: any) => void) | null = null;
  private updateInterval: any = null;

  async loadAsync(
    uri: string,
    shouldPlay: boolean = false,
    _metadata?: NowPlayingMetadata,
    startPositionSeconds: number = 0,
  ): Promise<void> {
    // Stop and discard the previous element before creating a new one.
    // Without this the old element keeps streaming silently in the background.
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.stopStatusUpdates();
      this.audio = null;
    }

    // Use HTMLAudioElement constructor directly for web
    this.audio = new window.Audio(uri);
    this.audio.preload = 'metadata';
    this.audio.playbackRate = this.currentRate;

    // Set up event listeners
    this.audio.addEventListener('loadedmetadata', () => {
      this.emitStatus();
    });

    this.audio.addEventListener('timeupdate', () => {
      this.emitStatus();
    });

    this.audio.addEventListener('ended', () => {
      this.emitStatus();
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Web audio error:', e);
      this.emitStatus();
    });

    return new Promise((resolve, reject) => {
      if (!this.audio) {
        reject(new Error('Audio element not initialized'));
        return;
      }

      this.audio.addEventListener('loadedmetadata', () => {
        // Apply the resume point now that duration is known — before the first
        // status emit, so nothing downstream ever sees position 0.
        if (startPositionSeconds > 0 && this.audio) {
          const dur = this.audio.duration;
          this.audio.currentTime = Number.isFinite(dur) && dur > 0
            ? Math.min(startPositionSeconds, dur - 1)
            : startPositionSeconds;
        }
        // Start the status interval immediately so currentTime stays live
        // even before the user taps Play (needed for karaoke position tracking)
        this.startStatusUpdates();
        this.emitStatus();
        if (shouldPlay && this.audio) {
          this.audio.play();
        }
        resolve();
      }, { once: true });
      this.audio.addEventListener('error', () => reject(new Error('Failed to load audio')), { once: true });
    });
  }

  async playAsync(): Promise<void> {
    if (this.audio) {
      await this.audio.play();
      this.startStatusUpdates();
      this.emitStatus();
    }
  }

  async pauseAsync(): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      // Keep interval running so karaoke stays in sync after seek-while-paused
      this.emitStatus();
    }
  }

  async stopAsync(): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.emitStatus();
    }
  }

  async unloadAsync(): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
      this.stopStatusUpdates();
    }
  }

  async setPositionAsync(position: number): Promise<void> {
    if (this.audio) {
      this.audio.currentTime = position / 1000; // Convert ms to seconds
      this.emitStatus();
    }
  }

  async setRateAsync(rate: number, shouldCorrectPitch: boolean): Promise<void> {
    this.currentRate = rate;
    if (this.audio) {
      this.audio.playbackRate = rate;
      if (!shouldCorrectPitch) {
        // Web Audio API doesn't have a direct pitch correction toggle
        // preservesPitch is the correct property for this
        (this.audio as any).preservesPitch = false;
      }
      this.emitStatus();
    }
  }

  async getStatusAsync(): Promise<any> {
    if (!this.audio) {
      return {
        isLoaded: false,
        isPlaying: false,
        positionMillis: 0,
        durationMillis: 0,
      };
    }

    return {
      isLoaded: true,
      isPlaying: !this.audio.paused,
      positionMillis: this.audio.currentTime * 1000,
      durationMillis: (this.audio.duration || 0) * 1000,
      didJustFinish: this.audio.ended,
      playbackRate: this.audio.playbackRate,
    };
  }

  setOnPlaybackStatusUpdate(callback: (status: any) => void): void {
    this.onStatusUpdate = callback;
  }

  private emitStatus(): void {
    if (this.onStatusUpdate) {
      this.getStatusAsync().then(status => {
        this.onStatusUpdate!(status);
      });
    }
  }

  private startStatusUpdates(): void {
    if (!this.updateInterval) {
      this.updateInterval = setInterval(() => {
        this.emitStatus();
      }, 100);
    }
  }

  private stopStatusUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

class MobileAudioPlayer implements AudioPlayerInterface {
  private sound: any = null;
  private statusCallback: ((status: any) => void) | null = null;
  // Every chapter is a fresh Audio.Sound, which starts at 1x.  Remember the
  // user's rate so loadAsync can hand it over in the initial status — otherwise
  // the speed silently drops back to normal at each chapter boundary.
  private currentRate = 1;

  async loadAsync(
    uri: string,
    shouldPlay: boolean = false,
    _metadata?: NowPlayingMetadata,
    startPositionSeconds: number = 0,
  ): Promise<void> {
    try {
      console.log('[MobileAudioPlayer] Loading audio from:', uri.substring(0, 80));

      // Unload previous sound if any to prevent resource leaks
      if (this.sound) {
        console.log('[MobileAudioPlayer] Unloading previous sound before loading new one');
        try {
          await this.sound.unloadAsync();
        } catch (e) {
          console.warn('[MobileAudioPlayer] Error unloading previous sound:', e);
        }
        this.sound = null;
      }

      // positionMillis is part of the initial status, so expo-av applies the
      // resume point atomically as the sound is created — no post-load seek to
      // race against buffering.
      const { sound, status } = await Audio.Sound.createAsync(
        { uri },
        {
          shouldPlay,
          staysActiveInBackground: true,
          progressUpdateIntervalMillis: 100,
          positionMillis: Math.max(0, startPositionSeconds) * 1000,
          rate: this.currentRate,
          shouldCorrectPitch: true,
        }
      );
      this.sound = sound;

      console.log('[MobileAudioPlayer] Audio loaded successfully:', {
        isLoaded: status.isLoaded,
        durationMillis: status.isLoaded ? status.durationMillis : 0,
      });

      // Apply any callback that was set before loadAsync was called
      if (this.statusCallback) {
        this.sound.setOnPlaybackStatusUpdate(this.statusCallback);
      }
    } catch (error) {
      console.error('[MobileAudioPlayer] Failed to load audio:', error);
      throw error;
    }
  }

  async playAsync(): Promise<void> {
    if (this.sound) {
      console.log('[MobileAudioPlayer] Playing audio');
      await this.sound.playAsync();
    } else {
      console.warn('[MobileAudioPlayer] playAsync called but no sound loaded');
    }
  }

  async pauseAsync(): Promise<void> {
    if (this.sound) {
      await this.sound.pauseAsync();
    }
  }

  async stopAsync(): Promise<void> {
    if (this.sound) {
      await this.sound.stopAsync();
    }
  }

  async unloadAsync(): Promise<void> {
    if (this.sound) {
      console.log('[MobileAudioPlayer] Unloading audio');
      await this.sound.unloadAsync();
      this.sound = null;
    }
  }

  async setPositionAsync(position: number): Promise<void> {
    if (this.sound) {
      await this.sound.setPositionAsync(position);
    }
  }

  async setRateAsync(rate: number, shouldCorrectPitch: boolean): Promise<void> {
    this.currentRate = rate;
    if (this.sound) {
      await this.sound.setRateAsync(rate, shouldCorrectPitch);
    }
  }

  async getStatusAsync(): Promise<any> {
    if (this.sound) {
      return await this.sound.getStatusAsync();
    }
    return {
      isLoaded: false,
      isPlaying: false,
      positionMillis: 0,
      durationMillis: 0,
    };
  }

  setOnPlaybackStatusUpdate(callback: (status: any) => void): void {
    this.statusCallback = callback;
    if (this.sound) {
      this.sound.setOnPlaybackStatusUpdate(callback);
    }
  }
}

// ─── RNTP-backed mobile audio player ────────────────────────────────────────
//
// Provides the same AudioPlayerInterface contract as MobileAudioPlayer but
// uses react-native-track-player under the hood — gets us lock-screen,
// Bluetooth, CarPlay, Android Auto controls.
//
// RNTP's actual player is a singleton at the native layer; this class is a
// thin per-instance wrapper that translates AudioPlayerInterface calls into
// RNTP commands and translates RNTP events back into the expo-av-shaped
// status object the existing PlayerScreen logic expects.

// ── Resume-seek tuning (RNTP) ───────────────────────────────────────────────
// `TrackPlayer.add()` resolves when the item joins the queue, NOT when it can
// be seeked.  A remote Cloudinary MP3 on a car's mobile connection needs far
// longer, and a seek issued too early is silently discarded — the chapter then
// plays from 0 while the UI shows the restored position, and the next progress
// write overwrites the user's real place.  So: wait for a real duration, seek,
// then verify the player actually moved, and retry if it didn't.
const RNTP_SEEK_READY_TIMEOUT_MS = 8000;
const RNTP_SEEK_POLL_MS = 200;
const RNTP_SEEK_ATTEMPTS = 3;
const RNTP_SEEK_TOLERANCE_S = 2;

const _sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let _rntpSetupPromise: Promise<void> | null = null;

async function _ensureRNTPReady(): Promise<void> {
  if (!TrackPlayer) throw new Error('RNTP module unavailable');
  if (_rntpSetupPromise) return _rntpSetupPromise;

  // Reset the cached promise on failure so a transient setup error
  // (audio session conflict, native module hiccup) doesn't permanently
  // brick audio for the rest of the session.  Next loadAsync gets to retry.
  _rntpSetupPromise = (async () => {
    await TrackPlayer.setupPlayer({
      // Keep audio playing when phone screen turns off / app backgrounds.
      autoHandleInterruptions: true,
    });
    await TrackPlayer.updateOptions({
      capabilities: [
        RNTPCapability.Play,
        RNTPCapability.Pause,
        RNTPCapability.Stop,
        RNTPCapability.SkipToNext,
        RNTPCapability.SkipToPrevious,
        RNTPCapability.JumpForward,
        RNTPCapability.JumpBackward,
        RNTPCapability.SeekTo,
      ],
      compactCapabilities: [
        RNTPCapability.Play,
        RNTPCapability.Pause,
        RNTPCapability.SkipToNext,
      ],
      // Explicitly set jump intervals for iOS arrows (15s is standard)
      forwardJumpInterval: 15,
      backwardJumpInterval: 15,
      // Match the expo-av cadence so karaoke interpolation stays aligned.
      progressUpdateEventInterval: 0.25,
    });
  })().catch(err => {
    _rntpSetupPromise = null;
    throw err;
  });

  return _rntpSetupPromise;
}

class RNTPMobileAudioPlayer implements AudioPlayerInterface {
  // RNTP's native player is a process-wide singleton — `subscriptions`,
  // `loadVersion`, and the suppress logic below operate against shared state.
  // PlayerScreen is the only main-playback consumer; voice previews use
  // `createPreviewPlayer()` which routes around RNTP entirely.  Keep that
  // contract intact: don't construct a second RNTPMobileAudioPlayer
  // alongside an active one.
  private statusCallback: ((status: any) => void) | null = null;
  private subscriptions: Array<{ remove: () => void }> = [];
  private isLoaded = false;
  private currentRate = 1;
  private didJustFinishFlag = false;
  // Monotonic counter incremented on each loadAsync.  PlaybackQueueEnded
  // events captured from a prior load are filtered out, so:
  //   - the synthetic queue-end fired by `reset()` during a chapter swap
  //     is discarded (it's not a real chapter ending)
  //   - a real PlaybackQueueEnded for a very short chapter is NOT
  //     accidentally swallowed (it carries the current loadVersion)
  // Replaces an earlier suppressNextFinish boolean that could swallow
  // genuine end-of-chapter events on chapters under ~2 s.
  private loadVersion = 0;
  private suppressLoadVersion = -1;

  private _wireEvents() {
    if (!TrackPlayer || this.subscriptions.length > 0) return;

    const onProgress = TrackPlayer.addEventListener(
      RNTPEvent.PlaybackProgressUpdated,
      (data: any) => this._emit({
        positionMillis: (data?.position ?? 0) * 1000,
        durationMillis: (data?.duration ?? 0) * 1000,
      }),
    );
    const onState = TrackPlayer.addEventListener(
      RNTPEvent.PlaybackState,
      (_data: any) => this._emit({}),
    );
    const onEnd = TrackPlayer.addEventListener(
      RNTPEvent.PlaybackQueueEnded,
      (_data: any) => {
        // Drop the synthetic end fired by `reset()` during a chapter
        // swap — it carries the OUTGOING loadVersion.  Real chapter
        // ends carry the current loadVersion and pass through.
        if (this.loadVersion === this.suppressLoadVersion) {
          return;
        }
        this.didJustFinishFlag = true;
        this._emit({});
        setTimeout(() => { this.didJustFinishFlag = false; }, 50);
      },
    );

    this.subscriptions.push(onProgress, onState, onEnd);
  }

  private async _emit(extra: any) {
    if (!this.statusCallback || !TrackPlayer) return;
    try {
      const progress = await TrackPlayer.getProgress();
      const state = await TrackPlayer.getPlaybackState();
      const isPlaying = state?.state === RNTPState.Playing;
      this.statusCallback({
        isLoaded: this.isLoaded,
        isPlaying,
        positionMillis: extra.positionMillis ?? (progress?.position ?? 0) * 1000,
        durationMillis: extra.durationMillis ?? (progress?.duration ?? 0) * 1000,
        didJustFinish: this.didJustFinishFlag,
        rate: this.currentRate,
      });
    } catch (err) {
      // Silent — RNTP can transiently fail mid-load; next event will recover.
    }
  }

  /**
   * Seek to a resume point, waiting for the track to be able to accept it and
   * verifying that it stuck.  Bails out if another load supersedes this one.
   */
  private async _seekWhenReady(positionSeconds: number): Promise<void> {
    if (!TrackPlayer || positionSeconds <= 0) return;
    const myVersion = this.loadVersion;
    const deadline = Date.now() + RNTP_SEEK_READY_TIMEOUT_MS;

    // Phase 1 — wait until the track reports a duration.  That's the earliest
    // point RNTP can resolve a seek against real media.
    let duration = 0;
    while (Date.now() < deadline) {
      if (this.loadVersion !== myVersion) return;
      const progress = await TrackPlayer.getProgress().catch(() => null);
      if (progress && progress.duration > 0) {
        duration = progress.duration;
        break;
      }
      await _sleep(RNTP_SEEK_POLL_MS);
    }

    // Clamp inside the media, otherwise the verify below can never pass on a
    // saved position that overruns the chapter (e.g. a re-converted book).
    const target = duration > 0
      ? Math.min(positionSeconds, Math.max(0, duration - 1))
      : positionSeconds;

    // Phase 2 — seek, then confirm.  A seek issued right at the edge of
    // readiness can still be dropped, so check rather than assume.
    for (let attempt = 0; attempt < RNTP_SEEK_ATTEMPTS; attempt++) {
      if (this.loadVersion !== myVersion) return;
      await TrackPlayer.seekTo(target).catch(() => {});
      await _sleep(RNTP_SEEK_POLL_MS);
      const progress = await TrackPlayer.getProgress().catch(() => null);
      if (progress && Math.abs(progress.position - target) <= RNTP_SEEK_TOLERANCE_S) {
        return;
      }
    }
    console.warn('[RNTP] resume seek did not stick — playing from current position', {
      target,
      duration,
    });
  }

  async loadAsync(
    uri: string,
    shouldPlay = false,
    metadata?: NowPlayingMetadata,
    startPositionSeconds: number = 0,
  ): Promise<void> {
    await _ensureRNTPReady();
    this._wireEvents();

    // Suppress the synthetic PlaybackQueueEnded from the outgoing track,
    // not future events.  The version captured here is the OUTGOING load;
    // we bump loadVersion immediately after, so the new load's real
    // queue-end event passes through cleanly.
    this.suppressLoadVersion = this.loadVersion;
    this.loadVersion += 1;

    await TrackPlayer.reset();
    await TrackPlayer.add({
      url: uri,
      title: metadata?.title ?? 'EbookVoice',
      artist: metadata?.artist ?? 'EbookVoice',
      artwork: metadata?.artwork,
    });

    this.isLoaded = true;
    this.didJustFinishFlag = false;

    // Always — not just when the rate differs from 1.  SwiftAudioEx keeps its
    // own `_rate` across loads, but `reset()` above cleared the now-playing
    // info, and the patched native setRate (patches/react-native-track-player)
    // is what republishes MPNowPlayingInfoPropertyDefaultPlaybackRate.  Without
    // it, at any rate above 1x iOS tells AVRCP (non-Apple Bluetooth) headsets
    // the app is fast-forwarding and their play/pause key can only resume.
    // Also honours the every-backend contract (see MobileAudioPlayer) and
    // covers a setRateAsync that arrived before the player was set up.
    try { await TrackPlayer.setRate(this.currentRate); } catch {}

    // Restore BEFORE starting playback so the user never hears the chapter
    // restart from the top.  No-op (and no added latency) when there's no
    // resume point, which is the case for auto-advance and fresh books.
    if (startPositionSeconds > 0) {
      await this._seekWhenReady(startPositionSeconds);
    }

    if (shouldPlay) {
      await TrackPlayer.play();
    }
    // Emit one synthetic status so callers can read initial duration immediately.
    this._emit({});
  }

  async playAsync(): Promise<void> {
    if (!TrackPlayer) return;
    await TrackPlayer.play();
  }

  async pauseAsync(): Promise<void> {
    if (!TrackPlayer) return;
    await TrackPlayer.pause();
  }

  async stopAsync(): Promise<void> {
    if (!TrackPlayer) return;
    await TrackPlayer.seekTo(0);
    await TrackPlayer.pause();
  }

  async unloadAsync(): Promise<void> {
    if (!TrackPlayer) return;
    this.subscriptions.forEach(s => { try { s.remove(); } catch {} });
    this.subscriptions = [];
    try { await TrackPlayer.reset(); } catch {}
    this.isLoaded = false;
  }

  async setPositionAsync(positionMillis: number): Promise<void> {
    if (!TrackPlayer) return;
    await TrackPlayer.seekTo(positionMillis / 1000);
  }

  async setRateAsync(rate: number, _shouldCorrectPitch: boolean): Promise<void> {
    if (!TrackPlayer) return;
    this.currentRate = rate;
    // Before the first loadAsync the native player may not be set up yet;
    // the stored rate is applied by loadAsync in that case.
    if (!this.isLoaded) return;
    await TrackPlayer.setRate(rate);
  }

  async getStatusAsync(): Promise<any> {
    if (!TrackPlayer || !this.isLoaded) {
      return { isLoaded: false, isPlaying: false, positionMillis: 0, durationMillis: 0 };
    }
    try {
      const progress = await TrackPlayer.getProgress();
      const state = await TrackPlayer.getPlaybackState();
      return {
        isLoaded: true,
        isPlaying: state?.state === RNTPState.Playing,
        positionMillis: (progress?.position ?? 0) * 1000,
        durationMillis: (progress?.duration ?? 0) * 1000,
        didJustFinish: false,
        rate: this.currentRate,
      };
    } catch {
      return { isLoaded: false, isPlaying: false, positionMillis: 0, durationMillis: 0 };
    }
  }

  setOnPlaybackStatusUpdate(callback: (status: any) => void): void {
    this.statusCallback = callback;
    this._wireEvents();
  }
}


/**
 * Main player factory.  PlayerScreen uses this for the user's audiobook.
 * Selects RNTP on mobile when the server flag `rntp_enabled` is on,
 * otherwise falls back to the legacy expo-av path.  Web always uses
 * `WebAudioPlayer` (HTMLAudioElement) — RNTP has no web implementation.
 */
export const createAudioPlayer = (): AudioPlayerInterface => {
  if (Platform.OS === 'web') {
    return new WebAudioPlayer();
  }
  if (TrackPlayer && getFeatureFlags().rntp_enabled) {
    return new RNTPMobileAudioPlayer();
  }
  return new MobileAudioPlayer();
};

/**
 * Lightweight player factory for short snippets (voice previews).
 * Always uses expo-av on mobile so a 5-second preview doesn't
 * commandeer the lock-screen / Bluetooth media session that the main
 * audiobook session may be holding.
 */
export const createPreviewPlayer = (): AudioPlayerInterface => {
  if (Platform.OS === 'web') {
    return new WebAudioPlayer();
  }
  return new MobileAudioPlayer();
};

/**
 * Configure the platform audio session.  No-op on web.  When RNTP is in use,
 * `setupPlayer()` handles audio-session activation internally — but the
 * expo-av fallback path still needs `setAudioModeAsync` for background play.
 */
export const enableAudio = async (): Promise<void> => {
  if (Platform.OS === 'web' || !Audio) return;
  // RNTP path: setupPlayer (called lazily on first loadAsync) configures
  // the audio session.  We still call setAudioModeAsync so the legacy
  // expo-av path keeps working — both can coexist harmlessly.
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
    });
  } catch (error) {
    console.error('Error enabling audio:', error);
  }
};
