/**
 * conversionLimit
 * ───────────────
 * Tiny helper used by the screens that initiate a conversion
 * (VoiceSelectionScreen, SmartSetupScreen) to resolve the props for
 * <ConversionLimitModal> when the backend rejects with a 403
 * `limit_reached` (conversion credits used up — the single paid gate).
 *
 * Tries to refresh the profile (so the modal shows the live used/max),
 * but races a 5-second timeout against it — if the server is unreachable
 * (which is often the very reason the conversion failed), fall back to
 * the values the 403 response already carried so the user always sees a
 * modal instead of an unresponsive Convert button.
 */
import apiService from '../services/api';
import { track } from '../services/analytics';

export interface ConversionLimitState {
  used: number;
  max: number;
}

const RESOLVE_TIMEOUT_MS = 5_000;

export async function resolveConversionLimitState(
  responseData: any,
): Promise<ConversionLimitState> {
  // Only reached on a genuine 403 limit_reached (lifetime conversions used up),
  // once per blocked attempt — the clean choke-point for the funnel event.
  track('conversion_limit_reached', {
    current_tier: responseData?.current_tier ?? responseData?.tier,
    conversion_count: responseData?.conversion_count,
    max_lifetime_conversions: responseData?.max_lifetime_conversions,
  });

  // Race a profile refetch against a short timeout.  If the network is
  // already broken, we don't want the user staring at a hung Convert
  // button for the full 15 s axios timeout.
  const profilePromise = apiService.getProfile({ force: true });
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS));

  try {
    const profile = await Promise.race([profilePromise, timeout]);
    if (profile && profile.maxLifetimeConversions != null) {
      return {
        used: profile.conversionCount,
        max: profile.maxLifetimeConversions,
      };
    }
  } catch {
    // Fall through to response-data fallback.
  }

  return {
    used: responseData?.conversion_count ?? 0,
    // Fallback = the free tier's starter credits (the allowance accrues
    // monthly server-side; the 403 body carries the live number).
    max: responseData?.max_lifetime_conversions ?? 3,
  };
}
