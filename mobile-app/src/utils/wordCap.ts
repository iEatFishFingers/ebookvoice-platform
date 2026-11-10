/**
 * wordCap
 * ───────
 * The client half of the word-cap → paywall handoff.
 *
 * When `/convert-chapters` rejects a book with 413 `too_large`, the server
 * already names the cheapest tier that clears it (`suggested_tier`,
 * `suggested_tier_max_words` — `tier_limits.cheapest_tier_for_words`).
 * Until this existed the app ignored both, showed an OK-only alert, and
 * the paywall opened on the generic list with MOST POPULAR on Pro.  The
 * one user who ever reached Apple's payment sheet from this gate picked Pro
 * for a 195k-word book that Starter covered, saw the price, and left.
 *
 * This helper parses the rejection, records it, and presents it with a
 * single action that lands the paywall on the suggested tier pre-selected.
 * Both conversion entry points (SmartSetupScreen, ChapterVoiceSelection-
 * Screen) route through it so the copy and the analytics stay identical.
 */
import { Alert, Platform } from 'react-native';
import { track } from '../services/analytics';
import { RootStackParamList } from '../types';

export interface WordCapRejection {
  message: string;
  wordCount: number | null;
  maxWords: number | null;
  /** Cheapest tier that clears the book, or null when nothing on the ladder does. */
  suggestedTier: string | null;
  /** That tier's cap; null means "any length" (an unlimited tier). */
  suggestedTierMaxWords: number | null;
}

/** Returns the parsed rejection for a 413 `too_large` response, else null. */
export function parseWordCapRejection(err: any): WordCapRejection | null {
  const data = err?.response?.data;
  if (err?.response?.status !== 413 || !data?.too_large) return null;
  return {
    message:
      data.error ??
      'This book has too many words to convert. The limit is about the number of words, not the file size.',
    wordCount: typeof data.word_count === 'number' ? data.word_count : null,
    maxWords: typeof data.max_words === 'number' ? data.max_words : null,
    suggestedTier: typeof data.suggested_tier === 'string' ? data.suggested_tier : null,
    suggestedTierMaxWords:
      typeof data.suggested_tier_max_words === 'number' ? data.suggested_tier_max_words : null,
  };
}

const TIER_NAMES: Record<string, string> = {
  starter: 'Starter',
  pro: 'Pro',
  lifetime: 'Lifetime',
};

export function tierDisplayName(tier: string | null | undefined): string {
  if (!tier) return '';
  return TIER_NAMES[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

type SubscriptionParams = NonNullable<RootStackParamList['Subscription']>;

type Navigate = {
  (screen: 'Subscription', params: SubscriptionParams): void;
  (screen: 'SignUp'): void;
};

// ── Pending handoff across sign-up ───────────────────────────────────────
// The anonymous stack has no Subscription screen (nothing to buy without an
// account).  So an anonymous user who hits the cap is sent to sign-up, and
// the suggestion is parked here so MainNavigator can open the paywall on it
// once `user` exists.  Module-level and short-lived on purpose: it must not
// survive to some unrelated sign-in later.
const PENDING_TTL_MS = 10 * 60 * 1000;
let pendingPaywall: { params: SubscriptionParams; at: number } | null = null;

export function setPendingPaywall(params: SubscriptionParams): void {
  pendingPaywall = { params, at: Date.now() };
}

/** Returns and clears the parked suggestion, or null if none / expired. */
export function takePendingPaywall(): SubscriptionParams | null {
  const p = pendingPaywall;
  pendingPaywall = null;
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p.params;
}

/**
 * Show the rejection and, when a tier would clear the book, offer exactly
 * one path forward: the paywall, opened on that tier — via sign-up first for
 * an anonymous user.  No free workaround is offered here: the server stopped
 * advertising the split trick on 08-23, and the client must not reintroduce
 * it in its own copy.
 */
export function presentWordCapRejection(
  rejection: WordCapRejection,
  navigate: Navigate,
  opts: { isAnonymous?: boolean } = {},
): void {
  track('word_cap_hit', {
    word_count: rejection.wordCount,
    max_words: rejection.maxWords,
    suggested_tier: rejection.suggestedTier,
    anonymous: !!opts.isAnonymous,
  });

  if (!rejection.suggestedTier) {
    // Infra ceiling — nothing to sell.  Just the server's honest message.
    if (Platform.OS === 'web') {
      window.alert(`Book Too Long\n\n${rejection.message}`);
    } else {
      Alert.alert('Book Too Long', rejection.message, [{ text: 'OK' }]);
    }
    return;
  }

  const params: SubscriptionParams = {
    reason: 'word_cap',
    suggestedTier: rejection.suggestedTier,
    suggestedTierMaxWords: rejection.suggestedTierMaxWords,
    wordCount: rejection.wordCount ?? undefined,
  };
  const tierName = tierDisplayName(rejection.suggestedTier);

  // Anonymous: the account is the first step, and the message must say so —
  // the one user who took this path signed up expecting the account alone
  // to lift the limit, and hit the same wall again ten minutes later.
  const anonymous = !!opts.isAnonymous;
  const message = anonymous
    ? `${rejection.message}\n\nCreate a free account to choose ${tierName}.`
    : rejection.message;
  const action = anonymous ? 'Sign up' : `See ${tierName}`;
  const go = () => {
    if (anonymous) {
      setPendingPaywall(params);
      navigate('SignUp');
    } else {
      navigate('Subscription', params);
    }
  };

  if (Platform.OS === 'web') {
    if (window.confirm(`Book Too Long\n\n${message}\n\n${action}?`)) go();
    return;
  }
  Alert.alert(
    'Book Too Long',
    message,
    [
      { text: 'Not now', style: 'cancel' },
      { text: action, onPress: go },
    ],
  );
}
