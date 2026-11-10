import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  Linking,
  ActivityIndicator,
  AccessibilityInfo,
  findNodeHandle,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useFocusEffect, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { tierDisplayName } from '../utils/wordCap';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import apiService from '../services/api';
import { track } from '../services/analytics';
import { purchaseTier, restorePurchases, getOfferingPrices } from '../services/purchaseService';

type SubscriptionScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'Subscription'
>;

interface Plan {
  id: string;
  name: string;
  price: string;
  period: string;
  features: string[];
  popular?: boolean;
  current?: boolean;
  comingSoon?: boolean;
}

const SubscriptionScreen = () => {
  const navigation = useNavigation<SubscriptionScreenNavigationProp>();
  const route = useRoute<RouteProp<RootStackParamList, 'Subscription'>>();
  const { theme } = useTheme();
  // Word-cap handoff: the server named the cheapest tier that clears the
  // book, so open on it.  Everything else opens on the generic list.
  const suggestion = route.params?.reason === 'word_cap' && route.params.suggestedTier
    ? route.params
    : null;
  const suggestedTier = suggestion?.suggestedTier ?? null;
  const [selectedPlan, setSelectedPlan] = useState(suggestedTier ?? 'free');
  const scrollRef = useRef<ScrollView>(null);
  const suggestedCardRef = useRef<View>(null);
  const suggestedCardY = useRef<number | null>(null);
  const focusedSuggestionRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<string>('free');
  const [fetchingProfile, setFetchingProfile] = useState(true);
  // Store-fetched prices (mobile only) — overrides hardcoded prices
  const [storePrices, setStorePrices] = useState<Record<string, { priceString: string; period: string }> | null>(null);
  // Fire paywall_viewed once per screen open (after the real tier is known).
  const paywallTrackedRef = React.useRef(false);

  // Fetch RevenueCat offering prices on mobile
  useEffect(() => {
    if (Platform.OS === 'web') return;
    getOfferingPrices().then(prices => {
      if (prices) setStorePrices(prices);
    });
  }, []);

  // Fetch user profile to determine current plan
  useFocusEffect(
    React.useCallback(() => {
      const fetchProfile = async () => {
        try {
          setFetchingProfile(true);
          const profile = await apiService.getProfile();
          setCurrentPlan(profile.plan || 'free');
          if (!paywallTrackedRef.current) {
            paywallTrackedRef.current = true;
            track('paywall_viewed', {
              current_tier: profile.plan || 'free',
              reason: route.params?.reason ?? null,
              suggested_tier: suggestedTier,
            });
          }
        } catch (error) {
          console.error('Error fetching profile:', error);
        } finally {
          setFetchingProfile(false);
        }
      };
      fetchProfile();
    }, [])
  );

  // Land on the suggested card: scroll it into view and hand VoiceOver focus
  // to it, so a screen-reader user hears "Starter plan ... fits your book"
  // first rather than "Free plan, your current plan".  Runs once, after the
  // card reports its layout.
  const focusSuggestedCard = () => {
    if (!suggestedTier || focusedSuggestionRef.current) return;
    const y = suggestedCardY.current;
    const node = suggestedCardRef.current ? findNodeHandle(suggestedCardRef.current) : null;
    if (y == null || !node) return;
    focusedSuggestionRef.current = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: false });
    if (Platform.OS !== 'web') {
      // Let the scroll settle before moving focus, or VoiceOver announces
      // the card at its pre-scroll position.
      setTimeout(() => AccessibilityInfo.setAccessibilityFocus(node), 250);
    }
  };

  const suggestionBannerText = (() => {
    if (!suggestion) return null;
    const name = tierDisplayName(suggestedTier);
    const book = suggestion.wordCount != null
      ? `Your book is about ${suggestion.wordCount.toLocaleString()} words. `
      : '';
    const fits = suggestion.suggestedTierMaxWords == null
      ? `${name} converts books of any length.`
      : `${name} converts books up to ${suggestion.suggestedTierMaxWords.toLocaleString()} words.`;
    return `${book}${fits}`;
  })();

  // June 2026 v3 credit model: every tier gets the full listening experience
  // (all voices, karaoke, background play). Tiers differ ONLY in conversion
  // credits and how long a single book can be.
  const plans: Plan[] = [
    {
      id: 'free',
      name: 'Free',
      price: '£0',
      period: 'forever',
      current: currentPlan === 'free',
      features: [
        '3 conversion credits to start, plus 1 new credit every month',
        'Books up to 120,000 words (a full novel)',
        'All 200+ AI voices in 27 languages',
        'Follow-Along Reader (word-by-word karaoke)',
        'Background play — lock screen, Bluetooth & CarPlay',
      ],
    },
    {
      id: 'starter',
      name: 'Starter',
      price: storePrices?.starter?.priceString ?? '£4.99',
      period: storePrices?.starter?.period ?? 'per month',
      current: currentPlan === 'starter',
      features: [
        '10 conversion credits every month',
        'Books up to 200,000 words',
        'All 200+ AI voices in 27 languages',
        'Follow-Along Reader (word-by-word karaoke)',
        'Priority support',
      ],
    },
    {
      id: 'pro',
      name: 'Pro',
      price: storePrices?.pro?.priceString ?? '£19.99',
      period: storePrices?.pro?.period ?? 'per month',
      popular: true,
      current: currentPlan === 'pro',
      features: [
        'Unlimited conversions',
        'The longest books — up to 500,000 words',
        'All 200+ AI voices in 27 languages',
        'Follow-Along Reader (word-by-word karaoke)',
        '24/7 priority support',
      ],
    },
    // The Lifetime card only renders once the non-consumable package exists
    // in the RevenueCat offering (mobile). One-time purchase, no renewal.
    ...(storePrices?.lifetime
      ? [{
          id: 'lifetime',
          name: 'Lifetime',
          price: storePrices.lifetime.priceString,
          period: storePrices.lifetime.period,
          current: currentPlan === 'lifetime',
          features: [
            'Pay once — everything in Pro, forever',
            'No subscription, no renewals',
            'Unlimited conversions (fair use)',
            'The longest books — up to 500,000 words',
            'All future voices and languages included',
          ],
        } satisfies Plan]
      : []),
  ];

  const handleSubscribe = async (planId: string) => {
    const plan = plans.find(p => p.id === planId);

    if (plan?.current) {
      Alert.alert('Current Plan', 'You are already on this plan');
      return;
    }

    // Downgrade handling: free, or Pro→Starter. Lifetime outranks everything.
    const tierRank: Record<string, number> = { free: 0, starter: 1, pro: 2, lifetime: 3, enterprise: 3 };
    const currentRank = tierRank[currentPlan] ?? 0;
    const targetRank = tierRank[planId] ?? 0;

    if (targetRank < currentRank) {
      Alert.alert(
        'Downgrade',
        Platform.OS === 'web'
          ? 'Please use the Billing Portal from your Profile screen to change or cancel your subscription.'
          : 'To downgrade, manage your subscription in your device\'s subscription settings.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      setLoading(true);
      track('subscription_started', { target_tier: planId });

      if (Platform.OS === 'web') {
        // ── WEB: use Stripe checkout (unchanged) ──
        const response = await apiService.createCheckoutSession(planId);
        const supported = await Linking.canOpenURL(response.url);
        if (supported) {
          await Linking.openURL(response.url);
        } else {
          alert('Unable to open payment page');
        }
      } else {
        // ── MOBILE: use RevenueCat / Apple IAP / Google Play ──
        await purchaseTier(planId);
        // Sync the new entitlement with our backend so Supabase reflects it.
        // If the server returns pending (RC hasn't propagated yet), poll the
        // profile until the webhook updates it — the payment itself succeeded.
        const result = await apiService.syncMobilePurchase(planId);
        const finalTier = result.pending
          ? await pollProfileForTier(planId)
          : result.tier;
        setCurrentPlan(finalTier);
        // Until 2026-09-14 nothing was tracked on success, so a completed
        // purchase and a dismissed sheet were indistinguishable in PostHog
        // (subscription_started fires before the sheet opens).
        track('subscription_confirmed', { tier: finalTier, target_tier: planId });
        Alert.alert('Success', `You are now on the ${plan?.name} plan!`);
      }
    } catch (error: any) {
      track('subscription_cancelled', {
        target_tier: planId,
        reason: error?.userCancelled ? 'user_cancelled' : (error?.message ?? 'error'),
      });
      // RevenueCat throws a specific error code when user cancels — don't show an error
      if (error?.userCancelled) return;
      console.error('Error during purchase:', error);
      Alert.alert('Error', error.message || 'Failed to complete purchase');
    } finally {
      setLoading(false);
    }
  };

  // Poll /api/profile until the tier updates (webhook lands) or we time out.
  // Total window: ~15s (10 attempts × 1.5s). Falls back to whatever profile says.
  const pollProfileForTier = async (expectedTier: string): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const profile = await apiService.getProfile();
        const plan = profile.plan || 'free';
        if (plan === expectedTier) return plan;
      } catch {
        // keep polling — transient errors are fine here
      }
    }
    try {
      const profile = await apiService.getProfile();
      return profile.plan || 'free';
    } catch {
      return expectedTier;
    }
  };

  const handleRestorePurchases = async () => {
    if (Platform.OS === 'web') return;
    try {
      setLoading(true);
      await restorePurchases();
      const result = await apiService.syncMobilePurchase('restore');
      const finalTier = result.pending
        ? await pollProfileForTier(currentPlan)
        : result.tier;
      setCurrentPlan(finalTier);
      Alert.alert('Restored', 'Your purchases have been restored.');
    } catch (error: any) {
      Alert.alert('Error', 'Could not restore purchases. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const renderPlanCard = (plan: Plan) => {
    const isSelected = selectedPlan === plan.id;
    const isCurrent = plan.current;
    const isSuggested = suggestedTier === plan.id && !isCurrent;
    // While a tier has been named for the user's book, MOST POPULAR on Pro
    // is noise that pulls the eye to the wrong card - the one user who ever
    // reached the payment sheet from the word cap picked Pro for a book
    // Starter covered.  The suggestion badge takes its place.
    const showPopular = !!plan.popular && !suggestedTier;

    return (
      <TouchableOpacity
        key={plan.id}
        ref={isSuggested ? suggestedCardRef : undefined}
        onLayout={isSuggested ? (e) => {
          suggestedCardY.current = e.nativeEvent.layout.y;
          focusSuggestedCard();
        } : undefined}
        // accessible={false} is load-bearing: RN Touchables default to
        // accessible={true}, which merges every child into ONE VoiceOver
        // element — making the nested Subscribe button unreachable for
        // screen-reader users (a purchase blocker). With false, the plan
        // text and the Subscribe button are each individually focusable.
        accessible={false}
        style={[
          styles.planCard,
          { backgroundColor: theme.card, borderColor: theme.border },
          isSelected && { borderColor: theme.primary, borderWidth: 2 },
          isCurrent && { borderColor: theme.success, borderWidth: 2 },
          plan.comingSoon && { opacity: 0.85 },
        ]}
        onPress={() => !plan.comingSoon && setSelectedPlan(plan.id)}
        activeOpacity={plan.comingSoon ? 1 : 0.7}
        disabled={plan.comingSoon}
        accessibilityRole="button"
        accessibilityLabel={`${plan.name} plan, ${plan.price} ${plan.period}${isCurrent ? ', your current plan' : ''}${isSuggested ? ', fits your book' : ''}${showPopular ? ', most popular' : ''}`}
        accessibilityHint={`Includes: ${plan.features.join('. ')}`}
        accessibilityState={{ selected: isSelected, disabled: !!plan.comingSoon }}
      >
        {showPopular && (
          <View style={[styles.popularBadge, { backgroundColor: theme.primary }]}>
            <Text style={styles.popularText}>MOST POPULAR</Text>
          </View>
        )}

        {isSuggested && (
          <View style={[styles.popularBadge, { backgroundColor: theme.success }]}>
            <Text style={styles.popularText}>FITS YOUR BOOK</Text>
          </View>
        )}

        {plan.comingSoon && (
          <View style={[styles.comingSoonBadge, { backgroundColor: '#f59e0b' }]}>
            <Ionicons name="time-outline" size={16} color="#ffffff" />
            <Text style={styles.comingSoonText}>COMING SOON</Text>
          </View>
        )}

        {isCurrent && !plan.comingSoon && (
          <View style={[styles.currentBadge, { backgroundColor: theme.success }]}>
            <Ionicons name="checkmark-circle" size={16} color="#ffffff" />
            <Text style={styles.currentText}>CURRENT PLAN</Text>
          </View>
        )}

        <Text style={[styles.planName, { color: theme.text }]}>{plan.name}</Text>
        <View style={styles.priceContainer}>
          <Text style={[styles.price, { color: theme.text }]}>{plan.price}</Text>
          <Text style={[styles.period, { color: theme.textSecondary }]}>/{plan.period}</Text>
        </View>

        <View style={styles.featuresContainer}>
          {plan.features.map((feature, index) => (
            <View key={index} style={styles.featureRow}>
              <Ionicons name="checkmark-circle" size={20} color={theme.primary} />
              <Text style={[styles.featureText, { color: theme.text }]}>{feature}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={[
            styles.subscribeButton,
            { backgroundColor: isCurrent || plan.comingSoon ? theme.border : theme.primary },
            loading && { opacity: 0.7 },
          ]}
          onPress={() => handleSubscribe(plan.id)}
          disabled={isCurrent || loading || plan.comingSoon}
          accessibilityRole="button"
          accessibilityLabel={isCurrent ? `${plan.name} is your current plan` : `Subscribe to ${plan.name}, ${plan.price} ${plan.period}`}
          accessibilityState={{ disabled: isCurrent || loading || !!plan.comingSoon, busy: loading }}
        >
          {loading && !isCurrent && !plan.comingSoon ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={[styles.subscribeButtonText, (isCurrent || plan.comingSoon) && { color: theme.textSecondary }]}>
              {plan.comingSoon ? 'Coming Soon' : isCurrent ? 'Current Plan' : 'Subscribe'}
            </Text>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={theme.text} />
        </TouchableOpacity>
        {/* "Plans", not "Subscription Plans" — Lifetime (one-time purchase)
            sells here too once the RC package goes live. */}
        <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">Plans</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scrollView}
        contentContainerStyle={styles.content}
      >
        {/* Why you're here - only on the word-cap handoff.  Says the same
            thing the rejection said, so the paywall and the error agree. */}
        {suggestionBannerText && (
          <View
            style={[styles.infoBanner, { backgroundColor: theme.primaryLight, borderLeftColor: theme.success }]}
            accessibilityRole="text"
          >
            <Ionicons name="book-outline" size={20} color={theme.success} />
            <Text style={[styles.infoText, { color: theme.text }]}>{suggestionBannerText}</Text>
          </View>
        )}

        {/* Info Banner */}
        <View style={[styles.infoBanner, { backgroundColor: theme.primaryLight, borderLeftColor: theme.primary }]}>
          <Ionicons name="information-circle-outline" size={20} color={theme.primary} />
          <Text style={[styles.infoText, { color: theme.text }]}>
            {/* "Subscriptions can be cancelled" (not "cancel anytime") stays
                accurate when the one-time Lifetime card is visible. */}
            Choose the plan that best fits your needs. Subscriptions can be
            cancelled anytime{storePrices?.lifetime ? '; Lifetime is a single one-time purchase' : ''}.
          </Text>
        </View>

        {/* Plans */}
        <View style={styles.plansContainer}>
          {plans.map(plan => renderPlanCard(plan))}
        </View>

        {/* Auto-Renewal Disclosure — required by Apple App Store */}
        {Platform.OS !== 'web' && (
          <View style={[styles.legalBlock, { borderColor: theme.border }]}>
            <Text style={[styles.legalText, { color: theme.textSecondary }]}>
              {Platform.OS === 'ios'
                ? 'Payment will be charged to your Apple ID account at confirmation of purchase. '
                : 'Payment will be charged to your Google Play account at confirmation of purchase. '}
              Subscription automatically renews unless cancelled at least 24 hours before the end of the
              current period. Your account will be charged for renewal within 24 hours prior to the end
              of the current period. You can manage and cancel your subscriptions by going to your
              account settings on the {Platform.OS === 'ios' ? 'App Store' : 'Google Play Store'} after purchase.
              {storePrices?.lifetime ? ' Lifetime is a one-time purchase — it does not auto-renew and is never charged again.' : ''}
            </Text>
            <View style={styles.legalLinks}>
              <TouchableOpacity onPress={() => Linking.openURL('https://ebook-voice-react.vercel.app/terms')} accessibilityRole="link" accessibilityLabel="Terms of Service">
                <Text style={[styles.legalLinkText, { color: theme.primary }]}>Terms of Service</Text>
              </TouchableOpacity>
              <Text style={[styles.legalSeparator, { color: theme.textSecondary }]}> | </Text>
              <TouchableOpacity onPress={() => Linking.openURL('https://ebook-voice-react.vercel.app/privacy')} accessibilityRole="link" accessibilityLabel="Privacy Policy">
                <Text style={[styles.legalLinkText, { color: theme.primary }]}>Privacy Policy</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* FAQ Section */}
        <View style={[styles.faqSection, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.faqTitle, { color: theme.text }]} accessibilityRole="header">Frequently Asked Questions</Text>

          <View style={styles.faqItem}>
            <Text style={[styles.faqQuestion, { color: theme.text }]}>What is a conversion credit?</Text>
            <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
              Each book you convert to an audiobook uses one credit. Credits top up every month
              and unused credits roll over. Listening never uses credits — your audiobooks are
              yours to play forever.
            </Text>
          </View>

          <View style={styles.faqItem}>
            <Text style={[styles.faqQuestion, { color: theme.text }]}>Can I cancel anytime?</Text>
            <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
              Yes, you can cancel your subscription at any time. You'll continue to have access until the end of your billing period.
            </Text>
          </View>

          <View style={styles.faqItem}>
            <Text style={[styles.faqQuestion, { color: theme.text }]}>What payment methods do you accept?</Text>
            <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
              {Platform.OS === 'ios'
                ? 'Payments are handled securely through your Apple ID.'
                : Platform.OS === 'android'
                  ? 'Payments are handled securely through Google Play.'
                  : 'We accept all major credit cards, PayPal, and Apple Pay.'}
            </Text>
          </View>

          <View style={styles.faqItem}>
            <Text style={[styles.faqQuestion, { color: theme.text }]}>Can I upgrade or downgrade later?</Text>
            <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
              Yes, you can change your plan at any time. Changes take effect immediately.
            </Text>
          </View>
        </View>

        {/* Restore Purchases — required by Apple App Store guidelines */}
        {Platform.OS !== 'web' && (
          <TouchableOpacity
            style={[styles.supportButton, { backgroundColor: theme.card, borderColor: theme.border, marginBottom: 8 }]}
            onPress={handleRestorePurchases}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Restore purchases"
            accessibilityState={{ disabled: loading, busy: loading }}
          >
            <Ionicons name="refresh-outline" size={20} color={theme.primary} />
            <Text style={[styles.supportText, { color: theme.primary }]}>Restore Purchases</Text>
          </TouchableOpacity>
        )}

        {/* Contact Support — opens a pre-addressed email to the support
            inbox (this button previously had no onPress at all). */}
        <TouchableOpacity
          style={[styles.supportButton, { backgroundColor: theme.card, borderColor: theme.border }]}
          onPress={() => Linking.openURL('mailto:support@example.com?subject=EbookVoice%20plan%20question')}
          accessibilityRole="button"
          accessibilityLabel="Need help choosing? Contact support"
          accessibilityHint="Opens your email app addressed to support"
        >
          <Ionicons name="help-circle-outline" size={20} color={theme.primary} accessibilityElementsHidden importantForAccessibility="no" />
          <Text style={[styles.supportText, { color: theme.primary }]}>Need help choosing? Contact Support</Text>
        </TouchableOpacity>
      </ScrollView>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  infoBanner: {
    flexDirection: 'row',
    backgroundColor: '#ede9fe',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    borderLeftWidth: 4,
    borderLeftColor: '#6366f1',
  },
  infoText: {
    flex: 1,
    marginLeft: 12,
    fontSize: 14,
    lineHeight: 20,
    color: '#1e293b',
  },
  plansContainer: {
    marginBottom: 24,
  },
  planCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    position: 'relative',
  },
  popularBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#6366f1',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 12,
  },
  popularText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  currentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#10b981',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
  },
  currentText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginLeft: 4,
  },
  comingSoonBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#f59e0b',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
  },
  comingSoonText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginLeft: 4,
  },
  planName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 8,
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 20,
  },
  price: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  period: {
    fontSize: 16,
    color: '#64748b',
    marginLeft: 4,
  },
  featuresContainer: {
    marginBottom: 20,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  featureText: {
    marginLeft: 12,
    fontSize: 14,
    color: '#1e293b',
    flex: 1,
  },
  subscribeButton: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  subscribeButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  faqSection: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  faqTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 16,
  },
  faqItem: {
    marginBottom: 16,
  },
  faqQuestion: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 4,
  },
  faqAnswer: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
  },
  legalBlock: {
    marginBottom: 24,
    paddingHorizontal: 4,
  },
  legalText: {
    fontSize: 11,
    lineHeight: 16,
  },
  legalLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  legalLinkText: {
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  legalSeparator: {
    fontSize: 12,
  },
  supportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  supportText: {
    marginLeft: 8,
    fontSize: 14,
    fontWeight: '600',
    color: '#6366f1',
  },
});

export default SubscriptionScreen;
