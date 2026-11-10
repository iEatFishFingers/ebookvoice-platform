import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import { supabase } from '../context/AuthContext';

type ForgotPasswordNavigationProp = StackNavigationProp<RootStackParamList, 'ForgotPassword'>;

const ForgotPasswordScreen = () => {
  const navigation = useNavigation<ForgotPasswordNavigationProp>();
  const { theme } = useTheme();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleReset = async () => {
    if (!email.trim() || !email.includes('@')) {
      if (Platform.OS === 'web') {
        alert('Please enter a valid email address');
      } else {
        Alert.alert('Invalid Email', 'Please enter a valid email address');
      }
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: Platform.OS === 'web'
          ? `${window.location.origin}/`
          : 'ebookvoice://auth/callback',
      });

      if (error) {
        if (Platform.OS === 'web') {
          alert(`Error: ${error.message}`);
        } else {
          Alert.alert('Error', error.message);
        }
      } else {
        setSent(true);
      }
    } catch (error) {
      console.error('Password reset error:', error);
      if (Platform.OS === 'web') {
        alert('An unexpected error occurred. Please try again.');
      } else {
        Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.inner}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={24} color={theme.text} />
          </TouchableOpacity>

          <View style={styles.header}>
            <Ionicons name="lock-open-outline" size={48} color={theme.primary} style={styles.icon} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">Reset Password</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Enter your email and we'll send you a link to reset your password.
            </Text>
          </View>

          {sent ? (
            <View style={styles.sentContainer}>
              <Ionicons name="checkmark-circle" size={48} color="#22c55e" accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={[styles.sentTitle, { color: theme.text }]} accessibilityRole="header" accessibilityLiveRegion="polite">Email Sent</Text>
              <Text style={[styles.sentSubtitle, { color: theme.textSecondary }]}>
                Check your inbox for a password reset link.
              </Text>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: theme.primary }]}
                onPress={() => navigation.navigate('Login')}
                accessibilityRole="button"
                accessibilityLabel="Back to sign in"
              >
                <Text style={styles.buttonText}>Back to Sign In</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.form}>
              <View style={styles.inputGroup}>
                <Ionicons name="mail-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
                <TextInput
                  style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                  placeholder="Email Address"
                  placeholderTextColor={theme.textSecondary}
                  accessibilityLabel="Email address"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  returnKeyType="done"
                  onSubmitEditing={handleReset}
                  autoFocus
                />
              </View>

              <TouchableOpacity
                style={[styles.button, { backgroundColor: theme.primary }]}
                onPress={handleReset}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Send reset link"
                accessibilityState={{ disabled: loading, busy: loading }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.buttonText}>Send Reset Link</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back to sign in">
                <Text style={[styles.backLink, { color: theme.textSecondary }]}>Back to Sign In</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  inner: {
    flex: 1,
    padding: 24,
  },
  backButton: {
    padding: 4,
    marginBottom: 24,
    alignSelf: 'flex-start',
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  icon: {
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  form: {
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
  },
  inputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  inputIcon: {
    position: 'absolute',
    left: 16,
    zIndex: 1,
  },
  input: {
    flex: 1,
    height: 50,
    borderWidth: 1,
    borderRadius: 12,
    paddingLeft: 48,
    paddingRight: 16,
    fontSize: 16,
  },
  button: {
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  backLink: {
    textAlign: 'center',
    fontSize: 14,
    paddingVertical: 8,
  },
  sentContainer: {
    alignItems: 'center',
    paddingTop: 16,
    gap: 12,
    maxWidth: 400,
    alignSelf: 'center',
    width: '100%',
  },
  sentTitle: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  sentSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
});

export default ForgotPasswordScreen;
