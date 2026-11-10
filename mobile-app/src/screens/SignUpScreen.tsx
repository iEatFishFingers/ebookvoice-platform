import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  ActivityIndicator,
  Linking
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

type SignUpScreenNavigationProp = StackNavigationProp<RootStackParamList, 'SignUp'>;

const SignUpScreen = () => {
  const navigation = useNavigation<SignUpScreenNavigationProp>();
  const { theme } = useTheme();
  const { signUp, signInWithGoogle, signInWithApple } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignUp = async () => {
    if (!firstName || !lastName || !email || !password || !confirmPassword) {
      if (Platform.OS === 'web') {
        alert('Please fill in all fields');
      } else {
        Alert.alert('Missing Information', 'Please fill in all fields');
      }
      return;
    }

    if (password !== confirmPassword) {
      if (Platform.OS === 'web') {
        alert('Passwords do not match!');
      } else {
        Alert.alert('Password Mismatch', 'Passwords do not match!');
      }
      return;
    }

    if (password.length < 8) {
      if (Platform.OS === 'web') {
        alert('Password must be at least 8 characters long');
      } else {
        Alert.alert('Weak Password', 'Password must be at least 8 characters long');
      }
      return;
    }

    setLoading(true);
    try {
      const { error, needsEmailConfirmation, emailAlreadyExists } = await signUp(email, password, firstName, lastName);

      if (error) {
        if (Platform.OS === 'web') {
          alert(`Sign Up Failed: ${error.message}`);
        } else {
          Alert.alert('Sign Up Failed', error.message);
        }
      } else if (emailAlreadyExists) {
        // Email already registered — Supabase returns fake success to hide this
        const message = 'An account with this email already exists. Please sign in, or tap "Forgot Password" if you\'ve lost access.';
        if (Platform.OS === 'web') {
          alert(message);
          navigation.navigate('Login', { email });
        } else {
          Alert.alert('Email Already Registered', message, [
            { text: 'Sign In', onPress: () => navigation.navigate('Login', { email }) },
            { text: 'Cancel', style: 'cancel' },
          ]);
        }
      } else if (needsEmailConfirmation) {
        // Email confirmation is required — user must verify before signing in
        const message = 'We\'ve sent a confirmation email to ' + email + '. Please check your inbox (and spam folder) and click the link to activate your account, then sign in.';
        if (Platform.OS === 'web') {
          alert(message);
          navigation.navigate('Login', { email });
        } else {
          Alert.alert('Check Your Email', message, [
            { text: 'OK', onPress: () => navigation.navigate('Login', { email }) }
          ]);
        }
      } else {
        // Sign up successful and session is active (email confirmation disabled).
        // The SIGNED_IN event has already fired in AuthContext and the navigator
        // will switch to the main app automatically — do NOT navigate to Login here,
        // as it will no longer exist in the navigation stack.
        if (Platform.OS === 'web') {
          alert('Account created successfully! Welcome aboard.');
        } else {
          Alert.alert('Welcome!', 'Your account has been created successfully.');
        }
      }
    } catch (error) {
      console.error('Sign up error:', error);
      if (Platform.OS === 'web') {
        alert('An unexpected error occurred. Please try again.');
      } else {
        Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    setLoading(true);
    try {
      const { error } = await signInWithGoogle();

      if (error) {
        if (Platform.OS === 'web') {
          alert(`Google Sign Up Failed: ${error.message}`);
        } else {
          Alert.alert('Google Sign Up Failed', error.message);
        }
      }
    } catch (error) {
      console.error('Google sign up error:', error);
      if (Platform.OS === 'web') {
        alert('An unexpected error occurred. Please try again.');
      } else {
        Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAppleSignUp = async () => {
    setLoading(true);
    try {
      const { error, cancelled } = await signInWithApple();
      if (cancelled) return;
      if (error) {
        Alert.alert('Apple Sign Up Failed', error.message);
      }
    } catch (error) {
      console.error('Apple sign up error:', error);
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
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
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">Create Account</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Start your audiobook journey with us today.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Ionicons name="person-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
              <TextInput
                style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                placeholder="First Name"
                placeholderTextColor={theme.textSecondary}
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                accessibilityLabel="First name"
              />
            </View>

            <View style={styles.inputGroup}>
              <Ionicons name="person-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
              <TextInput
                style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                placeholder="Last Name"
                placeholderTextColor={theme.textSecondary}
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
                accessibilityLabel="Last name"
              />
            </View>

            <View style={styles.inputGroup}>
              <Ionicons name="mail-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
              <TextInput
                style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                placeholder="Email Address"
                placeholderTextColor={theme.textSecondary}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                accessibilityLabel="Email address"
              />
            </View>

            <View style={styles.inputGroup}>
              <Ionicons name="lock-closed-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
              <TextInput
                style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                placeholder="Password"
                placeholderTextColor={theme.textSecondary}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                accessibilityLabel="Password"
                accessibilityHint="At least 8 characters"
              />
            </View>

            <View style={styles.inputGroup}>
              <Ionicons name="lock-closed-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
              <TextInput
                style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                placeholder="Confirm Password"
                placeholderTextColor={theme.textSecondary}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                accessibilityLabel="Confirm password"
              />
            </View>

            <TouchableOpacity
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={handleSignUp}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Create account"
              accessibilityHint="Creates your account with the details above"
              accessibilityState={{ disabled: loading, busy: loading }}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>Create Account</Text>
              )}
            </TouchableOpacity>

            <Text style={[styles.consentText, { color: theme.textSecondary }]}>
              By creating an account, you agree to our{' '}
              <Text
                style={{ color: theme.primary, textDecorationLine: 'underline' }}
                onPress={() => Linking.openURL('https://ebook-voice-react.vercel.app/terms')}
                accessibilityRole="link"
                accessibilityLabel="Terms of Service"
                accessibilityHint="Opens the Terms of Service in your browser"
              >
                Terms of Service
              </Text>
              {' '}and{' '}
              <Text
                style={{ color: theme.primary, textDecorationLine: 'underline' }}
                onPress={() => Linking.openURL('https://ebook-voice-react.vercel.app/privacy')}
                accessibilityRole="link"
                accessibilityLabel="Privacy Policy"
                accessibilityHint="Opens the Privacy Policy in your browser"
              >
                Privacy Policy
              </Text>.
            </Text>
          </View>

          {/* Social Login */}
          <>
            <View style={styles.dividerContainer}>
              <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
              <Text style={[styles.dividerText, { color: theme.textSecondary }]}>OR</Text>
              <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
            </View>

            {Platform.OS === 'ios' && (
              <TouchableOpacity
                style={[styles.socialButton, { backgroundColor: '#000000', borderColor: '#000000' }]}
                onPress={handleAppleSignUp}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Sign up with Apple"
                accessibilityState={{ disabled: loading, busy: loading }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <>
                    <Ionicons name="logo-apple" size={24} color={'#ffffff'} accessibilityElementsHidden importantForAccessibility="no" />
                    <Text style={[styles.socialButtonText, { color: '#ffffff' }]}>Sign Up with Apple</Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            {Platform.OS !== 'ios' && (
              <TouchableOpacity
                style={[styles.socialButton, { backgroundColor: theme.card, borderColor: theme.border }]}
                onPress={handleGoogleSignUp}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Sign up with Google"
                accessibilityState={{ disabled: loading, busy: loading }}
              >
                {loading ? (
                  <ActivityIndicator color={theme.primary} />
                ) : (
                  <>
                    <Ionicons name="logo-google" size={24} color={'#DB4437'} accessibilityElementsHidden importantForAccessibility="no" />
                    <Text style={[styles.socialButtonText, { color: theme.text }]}>Sign Up with Google</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </>

          {/* Sign In Link */}
          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: theme.textSecondary }]}>Already have an account? </Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('Login')}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityHint="Opens the sign in screen"
            >
              <Text style={[styles.footerLink, { color: theme.primary }]}>Sign In</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
    width: '100%',
    maxWidth: 400,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
  },
  form: {
    width: '100%',
    maxWidth: 400,
  },
  inputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
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
    marginBottom: 24,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  consentText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 14,
    paddingHorizontal: 8,
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    width: '100%',
    maxWidth: 400,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    marginHorizontal: 16,
    fontSize: 14,
  },
  socialButton: {
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    width: '100%',
    maxWidth: 400,
  },
  socialButtonText: {
    fontSize: 16,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 40,
    width: '100%',
    maxWidth: 400,
  },
  footerText: {
    fontSize: 14,
  },
  footerLink: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default SignUpScreen;
