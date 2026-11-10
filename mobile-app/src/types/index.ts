// Type definitions for EbookVoice Mobile App

export interface Voice {
  id: string;
  name: string;
  description: string;
  preview: string;
  locale?: string;      // e.g., "en-US", "en-GB"
  gender?: string;      // "Male" | "Female"
  status?: string;      // "active" | "deprecated"
  multilingual?: boolean; // true for MultilingualNeural voices — read mixed-language text in one stream
}

export interface Audiobook {
  id: string;
  title: string;
  author?: string;
  description?: string;
  voiceId: string;
  voiceName: string;
  filePath: string;
  coverUrl?: string;
  duration: number;
  createdAt: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  currentPosition: number;
  chapters?: Chapter[];
  currentChapter?: number;
  isCustom?: boolean;
  // Shared sample book — visible to every identity (incl. anonymous),
  // never deletable, progress not persisted server-side.
  isDemo?: boolean;
}

export type QueueStatus = 'queued' | 'processing' | 'done' | 'failed';

export type DownloadStatus = 'none' | 'downloading' | 'downloaded' | 'failed';

export interface DownloadState {
  status: DownloadStatus;
  progress: number; // 0–1
  localFilePath?: string;                  // single-file books
  localChapterPaths?: Record<number, string>; // chapter index → local path
  totalChapters?: number;
  downloadedChapters?: number;
}

export interface ConversionTask {
  taskId: string;
  status: string;
  progress: number;
  audioUrl?: string;
  error?: string;
  complete: boolean;
  chapters?: Chapter[];
  // Queue fields
  queueStatus: QueueStatus;
  queuePosition: number | null;
  title?: string;
  conversionType?: 'epub' | 'chapters' | 'text';
  /** Server-computed seconds remaining (based on actual chapter conversion times). */
  etaSeconds?: number;
  /** Database UUID assigned after the audiobook is saved — differs from taskId. */
  databaseId?: string;
}

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName: string;
  avatar?: string;
  plan: 'free' | 'starter' | 'pro' | 'lifetime' | 'enterprise';
  /** Lifetime successful conversions (the live paid gate, June 2026 v3). */
  conversionCount: number;
  maxConversions: number;
  /** Current accrued credit allowance (grows monthly: free 3 + 1/mo,
   *  starter 10 + 10/mo). null = unlimited (pro/lifetime). */
  maxLifetimeConversions: number | null;
  /** Credits left before the upgrade wall. null = unlimited. */
  lifetimeConversionsRemaining: number | null;
  /** Per-book word cap for this tier. null = uncapped (global limit only). */
  maxConversionWords?: number | null;
  audiobookCount: number;
  maxAudiobooks: number | null;
  monthlyConversionCount: number;
  maxMonthlyConversions: number | null;
  /** Remaining conversions this calendar month. null = unlimited (Pro/Enterprise). */
  monthlyConversionsRemaining: number | null;
  conversionResetAt?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'inactive';
  subscriptionCurrentPeriodEnd?: string;
  subscriptionCancelAtPeriodEnd?: boolean;
  karaokeTrialUsed?: boolean;
  /** Terms version this user last accepted (null if never). Re-consent gate. */
  termsAcceptedVersion?: string | null;
  /** Current Terms version required by the backend. Gate prompts if it differs. */
  termsCurrentVersion?: string;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface ImageInsert {
  wordIndex: number;
  url: string;
}

export interface Chapter {
  id: string;
  title: string;
  content?: string;
  audioUrl?: string;
  duration: number;
  position: number;
  /**
   * Karaoke timings, inline. Populated for chapters converted before the CDN
   * offload (migration 016); NULL afterwards, where `wordTimingsUrl` carries
   * them instead. Resolve either shape with `loadWordTimings()` rather than
   * reading this directly.
   */
  word_timings?: WordTiming[];
  /** CDN location of this chapter's timings. Immutable once written. */
  wordTimingsUrl?: string;
  imageInserts?: ImageInsert[];
}

export type RootStackParamList = {
  /**
   * Tab navigator wrapper for the authenticated state (Discover / Library /
   * Profile). Accepts `{ screen }` params so stack-level screens can jump to
   * a specific tab, e.g. `navigate('Main', { screen: 'Discover' })`.
   */
  Main: { screen: keyof MainTabParamList } | undefined;
  /**
   * Tab navigator wrapper for the anonymous trial state. Identical screens
   * to `Main` but with a reduced tab set (Discover + Library — no Profile)
   * and Discover as the landing tab. Used by MainNavigator when `user` is
   * null AND `deviceId` is set.
   */
  AnonymousMain: { screen: Exclude<keyof MainTabParamList, 'Profile'> } | undefined;
  /**
   * Upload screen. Normally invoked with no params and the user picks an EPUB
   * via DocumentPicker. When invoked with `preselectedFile` (from the iOS
   * "Open in EbookVoice" handoff via PendingImportContext), the screen
   * auto-extracts that file and moves on to LanguageSelection without
   * requiring a second tap.
   */
  Upload:
    | undefined
    | {
        preselectedFile: {
          uri: string;
          name: string;
          mimeType: string;
          size: number;
        };
      };
  BookDetail: { book: any };
  /**
   * Step between Upload and EbookReview that asks the user to confirm/pick
   * the book's language. The voice picker downstream is filtered to this
   * language. `bookLanguage` is the EPUB-declared <dc:language> (ISO 639-1)
   * from /extract-chapters, used to pre-select; may be null when the EPUB
   * doesn't declare one or declares an unsupported language.
   */
  LanguageSelection: {
    epubFile: {
      uri: string;
      name: string;
      mimeType: string;
      size: number;
    };
    extractedChapters: Chapter[];
    extractedCoverUrl?: string;
    bookLanguage: string | null;
    /** Token for the background image upload started by /extract-chapters. Null when book has no images. */
    imageUploadId: string | null;
  };
  EbookReview: {
    epubFile: {
      uri: string;
      name: string;
      mimeType: string;
      size: number;
    };
    extractedChapters: Chapter[];
    extractedCoverUrl?: string;
    /** ISO 639-1 code chosen on LanguageSelection (e.g. "en", "es"). */
    language: string;
    /** Token for the background image upload started by /extract-chapters. Null when book has no images. */
    imageUploadId: string | null;
  };
  VoiceSelection: {
    epubFile: {
      uri: string;
      name: string;
      mimeType: string;
      size: number;
    };
    editedChapters?: Chapter[];
    /** ISO 639-1 code — voice list is filtered to this language. */
    language: string;
  };
  ChapterVoiceSelection: {
    ebookTitle: string;
    chapters: Chapter[];
    /** ISO 639-1 code — voice list is filtered to this language. */
    language: string;
  };
  /** Author Pro: smart setup screen — replaces ChapterVoiceSelection in the flow */
  SmartSetup: {
    ebookTitle: string;
    chapters: Chapter[];
    availableVoices: Voice[];
    coverUrl?: string;
    /** ISO 639-1 code — voice list and AI suggestions are filtered to this language. */
    language: string;
    /** Token for the background image upload started by /extract-chapters. Null when book has no images. */
    imageUploadId: string | null;
  };
  /** Audiobook edit screen — cover art, metadata, and analytics */
  AnalyticsDashboard: {
    audiobookId: string;
    audiobookTitle: string;
    audiobookAuthor?: string;
    audiobookDescription?: string;
    audiobookCoverUrl?: string;
    chapterTitles: string[];
  };
  Conversion: {
    taskId: string;
    epubName: string;
    voiceId: string;
    wordCount?: number;
  };
  Player: {
    audiobookId: string;
    initialChapter?: number;
    // Set by the first-launch first-listen redirect. When true, the Player
    // begins playback automatically once audio is loaded — but ONLY if a
    // screen reader is off, so VoiceOver users get a manual play button
    // instead of audio fighting their screen reader.
    autoPlay?: boolean;
  };
  Settings: undefined;
  EditProfile: undefined;
  // Opened from the word-cap rejection with the tier the server says
  // clears the book, so the paywall lands on it pre-selected rather than on
  // the generic list.  All optional: every other entry point passes nothing.
  Subscription: {
    reason?: 'word_cap';
    suggestedTier?: string;
    /** null = that tier converts any length. */
    suggestedTierMaxWords?: number | null;
    wordCount?: number;
  } | undefined;
  Notifications: undefined;
  PaymentReturn: {
    session_id?: string;
    canceled?: string;
  } | undefined;
  Login: { email?: string } | undefined;
  SignUp: undefined;
  ForgotPassword: undefined;
};

export type MainTabParamList = {
  /** In-app public-domain library search (BookSearchScreen). */
  Discover: undefined;
  Library: undefined;
  Profile: undefined;
};
