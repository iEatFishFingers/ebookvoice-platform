/**
 * TermsConsentGate
 * ────────────────
 * One-time re-consent prompt for the updated Terms of Service / Privacy Policy.
 *
 * When a signed-in user's accepted Terms version differs from the version the
 * backend currently requires (or they never accepted one — e.g. users who
 * predate this gate), a blocking modal asks them to agree before continuing.
 * Tapping "Agree & Continue" records the acceptance server-side; the prompt
 * then never reappears until the Terms version is bumped again.
 *
 * Why a gate and not a silent doc update: an updated Terms page only binds a
 * user who actually assents to it. This captures that assent (and stores
 * proof: version + timestamp) so the updated Terms — including the arbitration
 * clause — actually apply to existing users.
 *
 * Scope: authenticated, non-anonymous users only. Anonymous trial users have
 * no account yet; they accept at the signup screen when they register.
 *
 * Fails OPEN: any network/profile error simply doesn't show the gate, so a
 * transient backend issue can never lock users out of the app.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import apiService from '../services/api';

const TERMS_URL = 'https://ebook-voice-react.vercel.app/terms';
const PRIVACY_URL = 'https://ebook-voice-react.vercel.app/privacy';

const TermsConsentGate: React.FC = () => {
  const { theme } = useTheme();
  const { user, isAnonymous, loading } = useAuth();

  const [needsConsent, setNeedsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-evaluate whenever the authenticated identity changes.
  useEffect(() => {
    let cancelled = false;

    if (loading || !user || isAnonymous) {
      setNeedsConsent(false);
      return;
    }

    (async () => {
      try {
        const profile = await apiService.getProfile();
        if (cancelled) return;
        const current = profile.termsCurrentVersion;
        // Only gate when the backend actually reports a required version (older
        // backends omit it) and the user's accepted version differs.
        if (current && profile.termsAcceptedVersion !== current) {
          setNeedsConsent(true);
        } else {
          setNeedsConsent(false);
        }
      } catch {
        // Fail open — never block the app on a profile fetch error.
        if (!cancelled) setNeedsConsent(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, isAnonymous, loading]);

  const handleAgree = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiService.acceptTerms();
      setNeedsConsent(false);
    } catch {
      setError('Something went wrong. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!needsConsent) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.backdrop}>
        <View
          style={[styles.card, { backgroundColor: theme.card }]}
          accessibilityViewIsModal
        >
          <View style={[styles.iconCircle, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
            <Ionicons name="document-text-outline" size={28} color={theme.primary} />
          </View>

          <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">We've updated our Terms</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            We've made some changes to our Terms of Service and Privacy Policy.
            Please review and accept them to continue using EbookVoice.
          </Text>

          <View style={styles.links}>
            <Text
              style={[styles.link, { color: theme.primary }]}
              onPress={() => Linking.openURL(TERMS_URL)}
              accessibilityRole="link"
              accessibilityLabel="Read the Terms of Service"
            >
              Terms of Service
            </Text>
            <Text style={[styles.linkDot, { color: theme.textSecondary }]}>•</Text>
            <Text
              style={[styles.link, { color: theme.primary }]}
              onPress={() => Linking.openURL(PRIVACY_URL)}
              accessibilityRole="link"
              accessibilityLabel="Read the Privacy Policy"
            >
              Privacy Policy
            </Text>
          </View>

          {error ? (
            <Text style={[styles.error, { color: theme.error ?? '#dc2626' }]}>{error}</Text>
          ) : null}

          <Pressable
            onPress={handleAgree}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Agree and continue"
            accessibilityState={{ disabled: submitting, busy: submitting }}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: theme.primary, opacity: submitting || pressed ? 0.8 : 1 },
            ]}
          >
            {submitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryBtnText}>Agree & Continue</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  links: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  link: {
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  linkDot: {
    fontSize: 14,
    marginHorizontal: 10,
  },
  error: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  primaryBtn: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});

export default TermsConsentGate;
