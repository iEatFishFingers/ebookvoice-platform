import axios, { AxiosInstance } from 'axios';
import { Platform } from 'react-native';
import { Voice, ConversionTask, Audiobook, User } from '../types';
import { supabase, getRefreshPromise } from '../context/AuthContext';
import { Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDeviceId } from './deviceId';

// Shared promise for interceptor-initiated refreshes to prevent duplicate refresh calls
let interceptorRefreshPromise: Promise<Session | null> | null = null;

/** A public-domain book from our self-hosted Project Gutenberg catalog.
 *  The backend (/gutenberg/search) returns this shape directly. */
export interface GutenbergBook {
  id: number;
  title: string;
  authors: string[];
  authorYears?: string;
  description?: string;
  subjects: string[];
  languages: string[];
  coverUrl?: string;
  downloadCount?: number;
  released?: string;         // Gutenberg "issued" date
  hasEpub: boolean;
}

/**
 * Check if a JWT token is expired or about to expire.
 * Returns true if expired or expiring within the buffer window.
 */
function isTokenExpiredOrExpiring(token: string, bufferSeconds: number = 30): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const expiresAt = payload.exp * 1000;
    return Date.now() >= expiresAt - (bufferSeconds * 1000);
  } catch {
    return true; // If we can't decode, treat as expired
  }
}

// Determine the correct API URL based on platform
const getApiBaseUrl = () => {
  if (!__DEV__) {
    return process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080';
  }

  // Development environment
  // If a custom dev API URL is set, use it ONLY for physical mobile devices (not web)
  if (process.env.EXPO_PUBLIC_DEV_API_URL && Platform.OS !== 'web') {
    return process.env.EXPO_PUBLIC_DEV_API_URL;
  }

  // Default URLs for emulators/simulators/web
  if (Platform.OS === 'android') {
    // Android emulator uses special IP to access host machine
    return 'http://10.0.2.2:8080';
  } else if (Platform.OS === 'ios') {
    // iOS simulator can use localhost
    return 'http://localhost:8080';
  } else {
    // Web/other platforms use localhost
    return 'http://localhost:8080';
  }
};

const API_BASE_URL = getApiBaseUrl();

/** TTL for the in-memory `getProfile()` cache. Multiple screens fetch
 *  on mount; one round-trip per minute is plenty. */
const PROFILE_CACHE_TTL_MS = 60 * 1000;

class APIService {
  private api: AxiosInstance;
  private _profileCache: { data: User; fetchedAt: number } | null = null;

  constructor() {
    this.api = axios.create({
      baseURL: API_BASE_URL,
      timeout: 15000, // 15 seconds
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Paths that require a valid auth token. Defined outside the try block so
    // the catch clause can also access them for safe rejection.
    //
    // NOTE: /api/audiobooks is intentionally NOT in this list — anonymous
    // trial users access their library via X-Device-Id (see deviceId.ts).
    // The backend's @optional_auth on those endpoints branches on whichever
    // identity is present.
    const authRequiredPaths = [
      '/api/profile',
      '/api/account',
      '/api/create-checkout-session',
      '/api/create-portal-session',
    ];

    // Add request interceptor to attach authentication token + device ID.
    // The X-Device-Id header is attached to EVERY outbound request (not just
    // anonymous ones) so the backend can use it for analytics/tracking even
    // for authenticated users, and so the immediate post-sign-in window
    // (where AuthContext is mid-claim) doesn't drop the header.
    this.api.interceptors.request.use(
      async (config) => {
        try {
          // 0. Attach device ID. getDeviceId() uses an in-memory cache after
          // the first call, so this is ~0.1ms per request after warmup.
          try {
            const deviceId = await getDeviceId();
            config.headers['X-Device-Id'] = deviceId;
          } catch {
            // Never let device-id failure block the request.
          }

          // 1. Wait for any foreground refresh (from AuthContext) to complete first.
          // Use a 5-second timeout as safety net so API calls are never blocked forever.
          const pendingRefresh = getRefreshPromise();
          if (pendingRefresh) {
            try {
              await Promise.race([
                pendingRefresh,
                new Promise<void>((resolve) => setTimeout(resolve, 5000)),
              ]);
            } catch {
              // Timeout or error — proceed with existing token
            }
          }

          // 2. Get current session
          const { data: { session }, error } = await supabase.auth.getSession();

          if (error) {
            console.error('Supabase getSession error:', error);
          }

          if (session?.access_token) {
            // 3. Check if token is expired or about to expire
            if (isTokenExpiredOrExpiring(session.access_token)) {
              // Deduplicate: reuse in-flight interceptor refresh if one exists
              if (!interceptorRefreshPromise) {
                interceptorRefreshPromise = (async () => {
                  try {
                    const { data: { session: newSession }, error: refreshError } =
                      await supabase.auth.refreshSession();
                    if (refreshError || !newSession) {
                      console.error('Interceptor token refresh failed');
                      return null;
                    }
                    return newSession;
                  } catch (refreshException) {
                    // refreshSession() itself threw (network error, Supabase down, etc.)
                    // Return null so the caller falls through to the "no token" rejection path
                    // instead of propagating and being swallowed by the outer catch.
                    console.error('Token refresh threw exception:', refreshException);
                    return null;
                  } finally {
                    interceptorRefreshPromise = null;
                  }
                })();
              }

              const refreshedSession = await interceptorRefreshPromise;
              if (refreshedSession?.access_token) {
                config.headers.Authorization = `Bearer ${refreshedSession.access_token}`;
                return config;
              }
              // Refresh failed — fall through to no-token handling below
            } else {
              // Token is still valid, attach it
              config.headers.Authorization = `Bearer ${session.access_token}`;
              return config;
            }
          }

          // No valid token available
          const requiresAuth = authRequiredPaths.some(path => config.url?.includes(path));
          if (requiresAuth) {
            return Promise.reject(new Error('No authentication token available'));
          }
        } catch (error) {
          console.error('Error in auth interceptor:', error);
          // CRITICAL: never silently send auth-required requests without credentials.
          // Reject so the error surfaces as a library/UI error instead of a 401
          // that the user can't explain.
          const requiresAuth = authRequiredPaths.some(path => config.url?.includes(path));
          if (requiresAuth) {
            return Promise.reject(new Error('Authentication error — please sign in again'));
          }
        }

        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor: safety net for 401s that slip through the request interceptor.
    // Waits for any foreground refresh before retrying.
    this.api.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          try {
            // Wait for any foreground refresh first (with 5s timeout safety net)
            const pendingRefresh = getRefreshPromise();
            if (pendingRefresh) {
              try {
                await Promise.race([
                  pendingRefresh,
                  new Promise<void>((resolve) => setTimeout(resolve, 5000)),
                ]);
              } catch {
                // Timeout — proceed with refresh attempt anyway
              }
            }

            const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();

            if (refreshError || !session?.access_token) {
              console.error('Failed to refresh session after 401');
              return Promise.reject(error);
            }

            originalRequest.headers.Authorization = `Bearer ${session.access_token}`;
            return this.api(originalRequest);
          } catch (refreshError) {
            console.error('Error during token refresh:', refreshError);
            return Promise.reject(error);
          }
        }

        return Promise.reject(error);
      }
    );
  }

  /**
   * Get list of available voices
   */
  async getVoices(lang?: string): Promise<Voice[]> {
    try {
      const params = lang ? { lang } : undefined;
      const response = await this.api.get('/api/voices', { params });

      if (response.data && response.data.voices) {
        return response.data.voices;
      }

      return this.getFallbackVoices();
    } catch (error) {
      console.error('Error fetching voices from API:', error);
      return this.getFallbackVoices();
    }
  }

  /**
   * Get fallback voice list (used when API is unavailable)
   */
  private getFallbackVoices(): Voice[] {
    return [
      {
        id: 'en-GB-SoniaNeural',
        name: 'Sonia (UK Female - Storytelling)',
        description: 'Natural British voice, perfect for storytelling',
        preview: 'preview_url',
        locale: 'en-GB',
        gender: 'Female',
        status: 'active',
      },
      {
        id: 'en-US-TonyNeural',
        name: 'Tony (US Male - Mature Narrator)',
        description: 'Deep, authoritative American voice',
        preview: 'preview_url',
        locale: 'en-US',
        gender: 'Male',
        status: 'active',
      },
      {
        id: 'en-US-DavisNeural',
        name: 'Davis (US Male - Smooth Narrator)',
        description: 'Smooth, professional narration',
        preview: 'preview_url',
        locale: 'en-US',
        gender: 'Male',
        status: 'active',
      },
      {
        id: 'en-US-AndrewNeural',
        name: 'Andrew (US Male - Expressive)',
        description: 'Dynamic and expressive delivery',
        preview: 'preview_url',
        locale: 'en-US',
        gender: 'Male',
        status: 'active',
      },
      {
        id: 'en-US-EmmaNeural',
        name: 'Emma (US Female - Cheerful)',
        description: 'Warm, friendly female voice',
        preview: 'preview_url',
        locale: 'en-US',
        gender: 'Female',
        status: 'active',
      },
    ];
  }

  /**
   * Preview a voice
   */
  async getVoicePreview(voiceId: string): Promise<string> {
    try {
      // Return the full URL to the preview endpoint
      // The Flask server will generate/cache the preview audio
      return `${API_BASE_URL}/preview?voice=${encodeURIComponent(voiceId)}`;
    } catch (error) {
      console.error('Error getting voice preview:', error);
      throw error;
    }
  }

  /**
   * Extract chapters from EPUB file. Also returns coverUrl extracted from the EPUB (may be null).
   */
  /**
   * Build the `file` part for a multipart upload on web. Prefers the original
   * File object captured at pick time (name/extension intact); otherwise fetches
   * the blob URI and re-wraps it with a guaranteed-valid filename. The backend
   * validates uploads by filename extension, and the browser otherwise defaults
   * a nameless blob to "blob" (no extension) — which the EPUB validator rejects
   * with 400 "File must have .epub extension".
   */
  private async buildWebFilePart(
    src: any,
    fallbackName: string,
    fallbackType: string,
  ): Promise<File> {
    if (src?.file instanceof File) {
      return src.file;
    }
    const blob = await (await fetch(src.uri)).blob();
    const name = typeof src?.name === 'string' && src.name ? src.name : fallbackName;
    return new File([blob], name, { type: src?.mimeType || src?.type || fallbackType });
  }

  async extractChapters(epubFile: any): Promise<{ chapters: any[]; coverUrl: string | null; language: string | null; imageUploadId: string | null }> {
    try {
      const formData = new FormData();

      if (Platform.OS === 'web') {
        const file = await this.buildWebFilePart(epubFile, 'book.epub', 'application/epub+zip');
        formData.append('file', file);
      } else {
        formData.append('file', {
          uri: epubFile.uri,
          type: epubFile.mimeType || epubFile.type || 'application/epub+zip',
          name: epubFile.name,
        } as any);
      }

      // Longer timeout than the global 15s default: image-heavy EPUBs upload
      // to Cloudinary during this call. Uploads are parallelised (max 30 images,
      // 8 concurrent) but still need headroom. 2 minutes is generous but safe.
      const response = await this.api.post('/extract-chapters', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120_000,
      });

      return {
        chapters: response.data.chapters,
        coverUrl: response.data.coverUrl ?? null,
        language: response.data.language ?? null,
        imageUploadId: response.data.imageUploadId ?? null,
      };
    } catch (error) {
      console.error('Error extracting chapters:', error);
      throw error;
    }
  }

  // ── Public-domain book library (self-hosted Project Gutenberg catalog) ──────
  // Search/browse go through OUR backend (/gutenberg/search), which queries our
  // own gutenberg_books table — fast and always up (no dependency on the flaky
  // Gutendex API). The backend returns the GutenbergBook shape directly. EPUB
  // ingestion is /extract-gutenberg (server-side from gutenberg.org). See CLAUDE.md.

  /** Live search the public-domain catalog (fires as the user types). */
  async searchGutenbergBooks(query: string): Promise<GutenbergBook[]> {
    const res = await this.api.get('/gutenberg/search', { params: { q: query.trim() } });
    return (res.data?.books ?? []) as GutenbergBook[];
  }

  /** Browse the public-domain catalog by category/topic. */
  async getGutenbergBooksByCategory(topic: string): Promise<GutenbergBook[]> {
    const res = await this.api.get('/gutenberg/search', { params: { topic } });
    return (res.data?.books ?? []) as GutenbergBook[];
  }

  /**
   * Ingest a public-domain book by id: the backend fetches the EPUB server-side
   * from Project Gutenberg and extracts chapters (same shape as extractChapters).
   * The convert step then runs through the normal /convert-chapters gate.
   */
  async extractGutenbergBook(bookId: number): Promise<{
    chapters: any[]; coverUrl: string | null; language: string | null;
    imageUploadId: string | null; bookId: number;
  }> {
    const response = await this.api.post('/extract-gutenberg', { book_id: bookId }, { timeout: 120_000 });
    return {
      chapters: response.data.chapters,
      coverUrl: response.data.coverUrl ?? null,
      language: response.data.language ?? null,
      imageUploadId: response.data.imageUploadId ?? null,
      bookId: response.data.bookId ?? bookId,
    };
  }

  /**
   * Upload a cover art image to Cloudinary via the backend. Returns the CDN URL.
   */
  async uploadCoverArt(imageFile: { uri: string; name: string; type: string }): Promise<string> {
    try {
      const formData = new FormData();

      if (Platform.OS === 'web') {
        const file = await this.buildWebFilePart(imageFile, 'cover.jpg', 'image/jpeg');
        formData.append('file', file);
      } else {
        formData.append('file', {
          uri: imageFile.uri,
          type: imageFile.type,
          name: imageFile.name,
        } as any);
      }

      const response = await this.api.post('/api/cover-upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return response.data.coverUrl;
    } catch (error) {
      console.error('Error uploading cover art:', error);
      throw error;
    }
  }

  /**
   * Update audiobook metadata: title, author, description, coverUrl.
   */
  async updateAudiobookMetadata(
    audiobookId: string,
    metadata: { title?: string; author?: string; description?: string; coverUrl?: string | null }
  ): Promise<void> {
    try {
      await this.api.put(`/api/audiobooks/${audiobookId}/metadata`, metadata);
    } catch (error) {
      console.error('Error updating audiobook metadata:', error);
      throw error;
    }
  }

  /**
   * Upload EPUB and start conversion
   */
  async uploadAndConvert(
    epubFile: any,
    voiceId: string,
  ): Promise<ConversionTask> {
    try {
      const formData = new FormData();

      // Handle different platforms
      if (Platform.OS === 'web') {
        const file = await this.buildWebFilePart(epubFile, 'book.epub', 'application/epub+zip');
        formData.append('file', file);
      } else {
        // On mobile (React Native), use the uri/type/name format
        formData.append('file', {
          uri: epubFile.uri,
          type: epubFile.mimeType || epubFile.type || 'application/epub+zip',
          name: epubFile.name,
        } as any);
      }

      formData.append('voice', voiceId);

      const response = await this.api.post('/convert', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      return {
        taskId: response.data.task_id,
        status: 'processing',
        queueStatus: 'queued' as const,
        queuePosition: null,
        progress: 5,
        complete: false,
      };
    } catch (error) {
      console.error('Error uploading file:', error);
      throw error;
    }
  }

  /**
   * Convert multiple chapters to audio
   */
  async convertChapters(
    chapters: any[],
    voiceId: string,
    ebookTitle?: string,
    /** Author Pro: wrap each chapter in SSML based on detected emotion */
    useEmotionalDirector = false,
    /** Author Pro: extract word-level timings for karaoke mode */
    generateWordTimings = true,
    /** Cover art CDN URL to store with the audiobook */
    coverUrl?: string | null,
    /** SHA-256 of first 64KB of source EPUB. Backend uses this for monthly
     *  retry-doesn't-count dedup; omit for non-EPUB sources (e.g. custom text). */
    sourceHash?: string | null,
    /** ISO 639-1 book language picked at upload. Persisted on the audiobook row. */
    language?: string | null,
    /** Token from /extract-chapters referencing the background image upload job. */
    imageUploadId?: string | null,
  ): Promise<ConversionTask> {
    try {
      const body: Record<string, any> = {
        chapters,
        voice: voiceId,
        title: ebookTitle,
        use_emotional_director: useEmotionalDirector,
        generate_word_timings: generateWordTimings,
        cover_url: coverUrl ?? null,
      };
      if (sourceHash) body.source_hash = sourceHash;
      if (language) body.language = language;
      if (imageUploadId) body.image_upload_id = imageUploadId;

      const response = await this.api.post('/convert-chapters', body);

      // Conversion will increment the monthly counter on completion — drop the
      // cached profile so the next read sees the updated remaining count.
      this.invalidateProfileCache();

      return {
        taskId: response.data.task_id,
        status: 'processing',
        queueStatus: 'queued' as const,
        queuePosition: null,
        progress: 5,
        complete: false,
      };
    } catch (error) {
      console.error('Error converting chapters:', error);
      throw error;
    }
  }

  /**
   * Poll conversion status
   */
  async getConversionStatus(taskId: string): Promise<ConversionTask> {
    try {
      const response = await this.api.get(`/status/${taskId}`);

      // Make audio URL absolute if it's relative
      let audioUrl = response.data.audio_url;
      if (audioUrl && !audioUrl.startsWith('http')) {
        audioUrl = `${API_BASE_URL}${audioUrl}`;
      }

      // Also transform chapter URLs to be absolute
      const chapters = response.data.chapters?.map((ch: any) => ({
        ...ch,
        audioUrl: ch.audioUrl && !ch.audioUrl.startsWith('http')
          ? `${API_BASE_URL}/${ch.audioUrl.replace(/^\//, '')}`
          : ch.audioUrl
      }));

      return {
        taskId,
        status: response.data.status,
        progress: response.data.progress,
        audioUrl: audioUrl,
        error: response.data.error,
        complete: response.data.complete,
        chapters,
        queueStatus: response.data.queue_status ?? 'processing',
        queuePosition: response.data.queue_position ?? null,
        title: response.data.title,
        conversionType: response.data.conversion_type,
        etaSeconds: response.data.eta_seconds ?? undefined,
        databaseId: response.data.database_id ?? undefined,
      };
    } catch (error) {
      console.error('Error getting conversion status:', error);
      throw error;
    }
  }

  /**
   * Fetch all active (queued/processing) and recently completed conversions
   * for the current user. Called by ConversionContext on app resume.
   */
  async getActiveConversions(): Promise<ConversionTask[]> {
    try {
      const response = await this.api.get('/api/conversions/active');
      return (response.data.conversions as any[]).map(c => {
        const audioUrl = c.audio_url && !c.audio_url.startsWith('http')
          ? `${API_BASE_URL}${c.audio_url}` : c.audio_url;
        return {
          taskId: c.id,
          status: c.status,
          progress: c.progress ?? 0,
          audioUrl: audioUrl ?? undefined,
          error: c.error ?? undefined,
          complete: c.complete ?? false,
          chapters: c.chapters ?? undefined,
          queueStatus: c.queue_status ?? 'processing',
          queuePosition: c.queue_position ?? null,
          title: c.title,
          conversionType: c.conversion_type,
          etaSeconds: c.eta_seconds ?? undefined,
        };
      });
    } catch (error) {
      console.error('Error fetching active conversions:', error);
      throw error;
    }
  }

  /**
   * Cancel a queued or in-progress conversion.
   */
  async cancelConversion(taskId: string): Promise<void> {
    await this.api.post(`/api/conversions/${taskId}/cancel`);
  }

  /**
   * Convert text to audio (for custom chapters)
   */
  async convertText(text: string, voiceId: string): Promise<ConversionTask> {
    try {
      const response = await this.api.post('/convert-text', {
        text,
        voice: voiceId,
      });

      return {
        taskId: response.data.task_id,
        status: 'processing',
        queueStatus: 'queued' as const,
        queuePosition: null,
        progress: 5,
        complete: false,
      };
    } catch (error) {
      console.error('Error converting text:', error);
      throw error;
    }
  }

  /**
   * Download converted audiobook
   */
  async downloadAudiobook(taskId: string): Promise<string> {
    try {
      // Return the download URL
      return `${API_BASE_URL}/download/${taskId}`;
    } catch (error) {
      console.error('Error downloading audiobook:', error);
      throw error;
    }
  }

  /**
   * Get user's audiobook library from database
   */
  /**
   * Fetch a single audiobook with full karaoke data (wordTimingsUrl +
   * image_inserts). Used by the Player so karaoke can highlight as audio plays.
   * /api/audiobooks (the library list) intentionally omits these for performance.
   *
   * `?timings=url` asks the server NOT to inline the timing arrays: it returns
   * each chapter's CDN url instead, and `loadWordTimings()` fetches just the
   * chapter being played. Without it the server hydrates every chapter's
   * timings into this one response — which is what older binaries rely on, so
   * the parameter is opt-in rather than the server's default.
   */
  async getAudiobook(audiobookId: string): Promise<Audiobook | null> {
    try {
      const response = await this.api.get(`/api/audiobooks/${audiobookId}`, {
        params: { timings: 'url' },
      });
      return response.data?.audiobook ?? null;
    } catch (error) {
      console.error('Error fetching audiobook detail:', error);
      return null;
    }
  }

  async getLibrary(): Promise<Audiobook[]> {
    try {
      const response = await this.api.get('/api/audiobooks');
      const audiobooks = response.data.audiobooks;

      // Validate chapter audio URLs — log warnings for non-HTTPS URLs
      for (const book of audiobooks) {
        if (book.chapters) {
          for (const ch of book.chapters) {
            if (ch.audioUrl && !ch.audioUrl.startsWith('http')) {
              console.warn(`Invalid chapter URL for "${book.title}" ch "${ch.title}":`, ch.audioUrl);
            }
          }
        }
      }

      return audiobooks;
    } catch (error) {
      console.error('Error fetching library:', error);
      throw error;
    }
  }

  /**
   * Update audiobook playback progress.
   *
   * @param explicitSeek true when the user deliberately moved the playhead
   *   (slider, ±15 s, chapter change).  The server rejects large unexplained
   *   backwards jumps to protect the bookmark from client-side drift, and this
   *   flag is how a genuine rewind opts out of that guard.
   */
  async updateProgress(
    audiobookId: string,
    currentPosition: number,
    currentChapter?: number,
    explicitSeek?: boolean
  ): Promise<void> {
    try {
      await this.api.put(`/api/audiobooks/${audiobookId}/progress`, {
        currentPosition,
        currentChapter,
        explicitSeek: !!explicitSeek,
      });
    } catch (error) {
      console.error('Error updating progress:', error);
      throw error;
    }
  }

  /**
   * Delete audiobook from library
   */
  async deleteAudiobook(audiobookId: string): Promise<void> {
    try {
      await this.api.delete(`/api/audiobooks/${audiobookId}`);
    } catch (error) {
      console.error('Error deleting audiobook:', error);
      throw error;
    }
  }

  /**
   * Sync local library with database
   * Returns merged library (database is source of truth)
   */
  async syncLibrary(): Promise<Audiobook[]> {
    try {
      const remoteLibrary = await this.getLibrary();
      await AsyncStorage.setItem('audiobook_library', JSON.stringify(remoteLibrary));
      return remoteLibrary;
    } catch (error) {
      console.error('Error syncing library:', error);
      // Fall back to local cache if sync fails
      const localLibraryData = await AsyncStorage.getItem('audiobook_library');
      return localLibraryData ? JSON.parse(localLibraryData) : [];
    }
  }

  /**
   * Get user profile.
   *
   * Returns the in-memory cached value if the last fetch was less than
   * `PROFILE_CACHE_TTL_MS` ago.  Multiple screens call this on mount; the
   * cache eliminates the duplicate round-trips without needing a context.
   * Bypass the cache by passing `{force: true}`, or invalidate after writes
   * via `invalidateProfileCache()`.
   */
  async getProfile(opts: { force?: boolean } = {}): Promise<User> {
    const now = Date.now();
    if (
      !opts.force &&
      this._profileCache &&
      now - this._profileCache.fetchedAt < PROFILE_CACHE_TTL_MS
    ) {
      return this._profileCache.data;
    }

    try {
      const response = await this.api.get('/api/profile');
      const profileData = response.data.profile;
      const max = profileData.maxMonthlyConversions;
      const used = profileData.monthlyConversionCount ?? 0;
      const remaining =
        profileData.monthlyConversionsRemaining !== undefined
          ? profileData.monthlyConversionsRemaining
          : max == null
            ? null
            : Math.max(0, max - used);

      const user: User = {
        id: profileData.id,
        email: profileData.email,
        firstName: profileData.firstName,
        lastName: profileData.lastName,
        displayName: profileData.displayName,
        avatar: profileData.avatar,
        plan: profileData.plan,
        conversionCount: profileData.conversionCount,
        maxConversions: profileData.maxConversions,
        maxLifetimeConversions: profileData.maxLifetimeConversions ?? null,
        lifetimeConversionsRemaining: profileData.lifetimeConversionsRemaining ?? null,
        maxConversionWords: profileData.maxConversionWords ?? null,
        audiobookCount: profileData.audiobookCount,
        maxAudiobooks: profileData.maxAudiobooks,
        monthlyConversionCount: used,
        maxMonthlyConversions: max,
        monthlyConversionsRemaining: remaining,
        conversionResetAt: profileData.conversionResetAt,
        stripeCustomerId: profileData.stripeCustomerId,
        stripeSubscriptionId: profileData.stripeSubscriptionId,
        subscriptionStatus: profileData.subscriptionStatus,
        subscriptionCurrentPeriodEnd: profileData.subscriptionCurrentPeriodEnd,
        subscriptionCancelAtPeriodEnd: profileData.subscriptionCancelAtPeriodEnd,
        karaokeTrialUsed: profileData.karaokeTrialUsed ?? false,
        termsAcceptedVersion: profileData.termsAcceptedVersion ?? null,
        termsCurrentVersion: profileData.termsCurrentVersion,
      };

      this._profileCache = { data: user, fetchedAt: now };
      return user;
    } catch (error) {
      console.error('Error fetching profile:', error);
      throw error;
    }
  }

  /**
   * Drop the cached profile so the next `getProfile()` call refetches.
   * Call after any action that changes plan or conversion count
   * (purchase, conversion completion, manual upgrade, etc).
   */
  invalidateProfileCache(): void {
    this._profileCache = null;
  }

  /**
   * Fetch remote feature flags.  No auth required — these are
   * intentionally public so a logged-out app can still read them on launch.
   * Returns `{}` on any network/server failure so callers can treat
   * "no response" as "use defaults" rather than crash.
   */
  /**
   * Register this device's Expo push token. Goes through the shared axios
   * instance so it carries X-Device-Id (always) and the bearer token (when
   * signed in) — the server scopes the token to the account if there is one,
   * otherwise to the anonymous device, so an anonymous trial's
   * "Audiobook Ready" push can be delivered.
   */
  async savePushToken(token: string): Promise<void> {
    await this.api.post('/api/push-token', { token }, { timeout: 8000 });
  }

  async getFeatureFlags(): Promise<{ rntp_enabled?: boolean }> {
    try {
      const response = await this.api.get('/api/feature-flags', { timeout: 4000 });
      return response.data ?? {};
    } catch (error) {
      console.warn('[api] /api/feature-flags unreachable; using defaults');
      return {};
    }
  }

  /**
   * Record that the user has accepted the current Terms / Privacy version.
   * Called by the re-consent gate. Invalidates the profile cache so the next
   * read reflects the new accepted version and the gate stays dismissed.
   */
  async acceptTerms(): Promise<void> {
    await this.api.post('/api/profile/accept-terms');
    this.invalidateProfileCache();
  }

  /**
   * Update user profile (display name, email)
   */
  async updateProfile(data: { first_name?: string; last_name?: string; display_name?: string; email?: string }): Promise<void> {
    try {
      await this.api.put('/api/profile', data);
    } catch (error) {
      console.error('Error updating profile:', error);
      throw error;
    }
  }

  /**
   * Create Stripe checkout session for subscription purchase
   */
  async createCheckoutSession(tier: string): Promise<{ url: string; session_id: string }> {
    try {
      const response = await this.api.post('/api/create-checkout-session', { tier, platform: Platform.OS });
      return response.data;
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw error;
    }
  }

  /**
   * Create Stripe billing portal session for subscription management
   */
  async createPortalSession(): Promise<{ url: string }> {
    try {
      const response = await this.api.post('/api/create-portal-session', { platform: Platform.OS });
      return response.data;
    } catch (error) {
      console.error('Error creating portal session:', error);
      throw error;
    }
  }

  /**
   * Sync a RevenueCat mobile purchase with our backend.
   * Called after a successful IAP purchase or restore on iOS/Android.
   *
   * Returns { tier, pending }. `pending: true` means the purchase is valid
   * but RC hasn't propagated yet; the webhook will sync server-side and the
   * client should poll /api/profile to pick up the new tier.
   */
  async syncMobilePurchase(tier: string): Promise<{ tier: string; pending: boolean }> {
    // By the time this is called, Apple/Google has already captured payment.
    // This endpoint is a best-effort fast path; the RevenueCat webhook is the
    // authoritative sync. Any failure here (network, 5xx, misconfig, Supabase
    // write error, RC REST race) must NOT surface as a user-facing error —
    // we degrade to the pending path so the caller polls /api/profile until
    // the webhook lands.
    try {
      const response = await this.api.post('/api/sync-mobile-purchase', { tier, platform: Platform.OS });
      const data = response.data || {};
      return {
        tier: data.tier || tier,
        pending: data.pending === true,
      };
    } catch (error: any) {
      console.warn('[syncMobilePurchase] fast-path failed, falling back to webhook + poll:', error?.response?.status, error?.message);
      return { tier, pending: true };
    }
  }

  /**
   * Delete user account and all associated data
   * This will delete:
   * - All audiobooks and chapters
   * - All audio files from Cloudinary
   * - Active Stripe subscriptions
   * - User profile
   */
  async deleteAccount(): Promise<void> {
    try {
      const response = await this.api.delete('/api/account', {
        data: { confirmation: 'DELETE_MY_ACCOUNT' },
      });
      return response.data;
    } catch (error) {
      console.error('Error deleting account:', error);
      throw error;
    }
  }

  /**
   * Transfer ownership of a device's anonymous trial audiobook to the
   * authenticated user. Idempotent — returns claimed:0 if nothing to claim.
   * Called by AuthContext immediately after any successful sign-in/sign-up.
   * Errors are swallowed by the caller (fire-and-forget) so a failed claim
   * never blocks the post-sign-in flow.
   */
  async claimAnonymousBook(deviceId: string): Promise<{ success: boolean; claimed: number }> {
    const response = await this.api.post('/api/anonymous/claim', { device_id: deviceId });
    return response.data;
  }

  /**
   * Update API base URL (for settings)
   */
  updateBaseURL(url: string) {
    this.api.defaults.baseURL = url;
  }

  // ── Author Pro: Analytics ──────────────────────────────────────────────────

  /**
   * Fetch listening heatmap data for an audiobook the caller owns.
   * chapterIndex filters to a single chapter when provided.
   */
  async getHeatmap(audiobookId: string, chapterIndex?: number) {
    const params = chapterIndex !== undefined ? `?chapter_index=${chapterIndex}` : '';
    const response = await this.api.get(`/analytics/heatmap/${audiobookId}${params}`);
    return response.data;
  }

  /**
   * Fetch high-level analytics summary (total listeners, avg completion,
   * most-replayed segment, biggest drop-off point).
   */
  async getAnalyticsSummary(audiobookId: string) {
    const response = await this.api.get(`/analytics/summary/${audiobookId}`);
    return response.data;
  }
}

export default new APIService();
