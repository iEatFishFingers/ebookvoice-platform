/**
 * purchaseService.ts
 *
 * Platform-aware purchase service:
 * - iOS / Android  → RevenueCat (Apple IAP / Google Play Billing)
 * - Web            → Stripe (existing flow, unchanged)
 */

import { Platform } from 'react-native';

// Lazily require RevenueCat only on native — avoids web bundler errors
// because react-native-purchases has native modules that don't exist on web.
const getPurchases = () => {
  if (Platform.OS === 'web') return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('react-native-purchases').default;
};

const IOS_KEY     = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY     || '';
const ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY || '';

// Map our internal tier names → RevenueCat entitlement identifiers
// (must match what you configure in the RevenueCat dashboard).
// Order matters: getActiveTier checks top-to-bottom, so 'lifetime' (the
// one-time purchase, never expires) outranks the subscriptions.
export const ENTITLEMENT_MAP: Record<string, string> = {
  lifetime: 'lifetime',
  pro:      'pro',
  starter:  'starter',
};

// Map our internal tier names → RevenueCat package identifiers
// (must match the package IDs you create in RevenueCat offerings).
// 'lifetime' is a non-consumable; until the package exists in the offering,
// getPackageForTier/getOfferingPrices simply won't return it and the
// Lifetime card stays hidden in SubscriptionScreen.
export const PACKAGE_MAP: Record<string, string> = {
  starter:  'starter_monthly',
  pro:      'pro_monthly',
  lifetime: 'lifetime',
};

/**
 * Call once after the user logs in.
 * Configures the SDK and links their Supabase userId to RevenueCat.
 */
export const initializePurchases = async (userId: string): Promise<void> => {
  if (Platform.OS === 'web') return;
  const Purchases = getPurchases();
  if (!Purchases) return;

  const apiKey = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!apiKey) {
    console.warn('[PurchaseService] RevenueCat API key not set');
    return;
  }

  Purchases.configure({ apiKey });

  // Apple Search Ads attribution. The AdServices token is deterministic,
  // campaign-level, and exempt from App Tracking Transparency (no IDFA), so
  // this needs no ATT prompt. RevenueCat collects the token and attributes
  // subscriptions to ASA campaigns in its dashboard — giving us cost-per-
  // paying-subscriber for free. iOS 14.3+ only.
  if (Platform.OS === 'ios') {
    try {
      Purchases.enableAdServicesAttributionTokenCollection();
    } catch (err) {
      console.warn('[PurchaseService] AdServices attribution unavailable:', err);
    }
  }

  await Purchases.logIn(userId);
};

/**
 * Returns the RevenueCat Offering for the given tier,
 * or null if not found / on web.
 */
export const getPackageForTier = async (tier: string) => {
  if (Platform.OS === 'web') return null;
  const Purchases = getPurchases();
  if (!Purchases) return null;

  try {
    const offerings = await Purchases.getOfferings();
    console.log('[RC] all offerings:', Object.keys(offerings?.all ?? {}));
    console.log('[RC] current offering:', offerings?.current?.identifier);
    console.log('[RC] packages in current:', offerings?.current?.availablePackages?.map((p: any) => ({ id: p.identifier, product: p.product?.identifier })));
    if (!offerings?.current) return null;

    const packageId = PACKAGE_MAP[tier];
    return offerings.current.availablePackages.find(
      (pkg: any) => pkg.identifier === packageId
    ) ?? null;
  } catch (error) {
    console.warn('[PurchaseService] Failed to get package for tier:', error);
    return null;
  }
};

/**
 * Purchase a subscription package via RevenueCat.
 * Returns the updated CustomerInfo on success.
 * Throws on cancellation or error.
 */
export const purchaseTier = async (tier: string) => {
  const Purchases = getPurchases();
  if (!Purchases) throw new Error('In-app purchases are not available on this device');

  const pkg = await getPackageForTier(tier);
  if (!pkg) throw new Error(`No RevenueCat package found for tier: ${tier}`);

  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return customerInfo;
};

/**
 * Restore previous purchases (required by App Store guidelines).
 */
export const restorePurchases = async () => {
  if (Platform.OS === 'web') return null;
  const Purchases = getPurchases();
  if (!Purchases) return null;
  return await Purchases.restorePurchases();
};

/**
 * Get current entitlements for the logged-in user.
 * Returns the active tier name ('free' | 'starter' | 'pro') or 'free' if none.
 */
export const getActiveTier = async (): Promise<string> => {
  if (Platform.OS === 'web') return 'free';
  const Purchases = getPurchases();
  if (!Purchases) return 'free';

  const customerInfo = await Purchases.getCustomerInfo();
  for (const [tier, entitlementId] of Object.entries(ENTITLEMENT_MAP)) {
    if (customerInfo.entitlements.active[entitlementId]) {
      return tier;
    }
  }
  return 'free';
};

/**
 * Fetch current RevenueCat offerings and return localized price info
 * for each tier. Returns null on web or if offerings unavailable.
 */
export const getOfferingPrices = async (): Promise<Record<string, { priceString: string; period: string }> | null> => {
  if (Platform.OS === 'web') return null;
  const Purchases = getPurchases();
  if (!Purchases) return null;

  try {
    const offerings = await Purchases.getOfferings();
    if (!offerings?.current) return null;

    const prices: Record<string, { priceString: string; period: string }> = {};

    for (const [tier, packageId] of Object.entries(PACKAGE_MAP)) {
      const pkg = offerings.current.availablePackages.find(
        (p: any) => p.identifier === packageId
      );
      if (pkg?.product) {
        prices[tier] = {
          priceString: pkg.product.priceString,         // e.g. "$9.99", "£9.99"
          // Non-subscriptions (lifetime) have no subscriptionPeriod.
          period: pkg.product.subscriptionPeriod || (tier === 'lifetime' ? 'one-time' : 'per month'),
        };
      }
    }

    return Object.keys(prices).length > 0 ? prices : null;
  } catch (error) {
    console.warn('[PurchaseService] Failed to fetch offerings:', error);
    return null;
  }
};

/**
 * Log out of RevenueCat when the user signs out.
 */
export const logOutPurchases = async (): Promise<void> => {
  if (Platform.OS === 'web') return;
  const Purchases = getPurchases();
  if (!Purchases) return;
  try {
    await Purchases.logOut();
  } catch {
    // Ignore — user may not have been logged in to RevenueCat
  }
};
