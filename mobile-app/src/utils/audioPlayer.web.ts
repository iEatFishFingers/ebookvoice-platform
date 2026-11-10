/**
 * audioPlayer.web.ts
 * ──────────────────
 * Web-only implementation of the AudioPlayerInterface.
 *
 * Metro picks this file over `audioPlayer.ts` when bundling for web —
 * keeping `react-native-track-player` and `expo-av` (both native-only)
 * out of the web bundle entirely.  Without this split, Metro statically
 * follows RNTP's web entry into `shaka-player`, which we don't want
 * (web stays on plain HTMLAudioElement and there's no need to ship a
 * 1MB media-source-extensions polyfill for MP3 playback).
 *
 * Public API matches `audioPlayer.ts` so callers don't branch on platform.
 *
 * Lock-screen / Bluetooth / CarPlay controls are mobile-only — on web,
 * the user has the browser's built-in media controls and tab controls,
 * which is the standard expectation.
 */

/** Optional metadata for native lock-screen/Bluetooth display.
 *  Ignored on web — the browser shows its own media UI. */
export interface NowPlayingMetadata {
  title?: string;
  artist?: string;
  artwork?: string;
}

export interface AudioPlayerInterface {
  loadAsync: (uri: string, shouldPlay?: boolean, metadata?: NowPlayingMetadata) => Promise<void>;
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

  async loadAsync(uri: string, shouldPlay: boolean = false, _metadata?: NowPlayingMetadata): Promise<void> {
    // Stop and discard the previous element before creating a new one.
    // Without this the old element keeps streaming silently in the background.
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.stopStatusUpdates();
      this.audio = null;
    }

    this.audio = new window.Audio(uri);
    this.audio.preload = 'metadata';
    this.audio.playbackRate = this.currentRate;

    this.audio.addEventListener('timeupdate', () => this.emitStatus());
    this.audio.addEventListener('ended', () => this.emitStatus());
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
        // Start the interval immediately so currentTime stays live even
        // before the user taps Play (needed for karaoke position tracking).
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
      this.audio.currentTime = position / 1000;
      this.emitStatus();
    }
  }

  async setRateAsync(rate: number, shouldCorrectPitch: boolean): Promise<void> {
    this.currentRate = rate;
    if (this.audio) {
      this.audio.playbackRate = rate;
      if (!shouldCorrectPitch) {
        (this.audio as any).preservesPitch = false;
      }
      this.emitStatus();
    }
  }

  async getStatusAsync(): Promise<any> {
    if (!this.audio) {
      return { isLoaded: false, isPlaying: false, positionMillis: 0, durationMillis: 0 };
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
      this.updateInterval = setInterval(() => this.emitStatus(), 100);
    }
  }

  private stopStatusUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

export const createAudioPlayer = (): AudioPlayerInterface => new WebAudioPlayer();
export const createPreviewPlayer = (): AudioPlayerInterface => new WebAudioPlayer();

/** No-op on web — browser handles audio session activation automatically. */
export const enableAudio = async (): Promise<void> => {
  /* intentionally empty */
};
