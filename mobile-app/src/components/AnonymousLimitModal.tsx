/**
 * AnonymousLimitModal
 * ───────────────────
 * Shown when an anonymous trial user attempts a second conversion. Sibling
 * of ConversionLimitModal — same shape, different copy + CTA destination.
 *
 * Tapping "Create Account" navigates to SignUp. On any successful sign-in
 * or sign-up, AuthContext fires claimAnonymousBook() so the trial book is
 * preserved into the new library automatically.
 *
 * No "used / max" props: anonymous users always have a fixed 1-of-1 ceiling.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSignUp: () => void;
}

const AnonymousLimitModal: React.FC<Props> = ({ visible, onClose, onSignUp }) => {
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
            <Ionicons name="person-add-outline" size={28} color={theme.primary} />
          </View>

          <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
            Ready to convert more books?
          </Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            You've used your trial conversion. Create an account to convert more
            books and keep your audiobooks forever — your trial book will be
            saved to your library.
          </Text>

          <Pressable
            onPress={onSignUp}
            accessibilityRole="button"
            accessibilityLabel="Create an account"
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: theme.primary, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={styles.primaryBtnText}>Create Account</Text>
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

export default AnonymousLimitModal;
