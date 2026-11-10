/**
 * ConversionLimitModal
 * ────────────────────
 * The single hard wall in the app: shown when a user tries to start a
 * conversion but has used all their accrued conversion credits (June 2026
 * v3 model: credits top up monthly — free 1/mo, starter 10/mo).  Tapping
 * "Upgrade" navigates to SubscriptionScreen; "Not now" dismisses — a new
 * credit arrives on its own next month.
 *
 * No other paywall in the app.  Listening, karaoke, voice catalog,
 * SmartSetup — all free for everyone.  This modal exists at the one moment
 * the user is asking for *more* conversions than their tier provides.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

interface Props {
  visible: boolean;
  used: number;
  max: number;
  /** Reserved for future per-tier copy; intentionally unused in the body
   *  text right now to avoid surfacing tier names like "free" — Apple's
   *  2.3.7 review has flagged that word in the past, and this modal can
   *  appear in marketing screenshots. */
  plan?: string;
  onClose: () => void;
  onUpgrade: () => void;
}

const ConversionLimitModal: React.FC<Props> = ({ visible, used, max, onClose, onUpgrade }) => {
  const { theme } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          style={[styles.card, { backgroundColor: theme.card }]}
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
        >
          <View style={[styles.iconCircle, { backgroundColor: theme.primaryLight }]} accessibilityElementsHidden importantForAccessibility="no">
            <Ionicons name="rocket-outline" size={28} color={theme.primary} />
          </View>

          <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
            You're out of conversion credits
          </Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            You've used {used} of {max} credits. A new credit arrives next
            month, or upgrade to convert more right away — your audiobooks
            always stay in your library.
          </Text>

          <Pressable
            onPress={onUpgrade}
            accessibilityRole="button"
            accessibilityLabel="See upgrade options"
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: theme.primary, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={styles.primaryBtnText}>See upgrade options</Text>
          </Pressable>

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Not now, close this message"
            style={({ pressed }) => [styles.secondaryBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.secondaryBtnText, { color: theme.textSecondary }]}>Not now</Text>
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
    marginBottom: 24,
  },
  primaryBtn: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '500',
  },
});

export default ConversionLimitModal;
