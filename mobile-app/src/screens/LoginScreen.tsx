import React, { useState, useEffect, useRef } from 'react';
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
  ActivityIndicator
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

type LoginScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Login'>;
type LoginScreenRouteProp = RouteProp<RootStackParamList, 'Login'>;

const LoginScreen = () => {
  const navigation = useNavigation<LoginScreenNavigationProp>();
  const route = useRoute<LoginScreenRouteProp>();
  const { theme } = useTheme();
  const { signIn, signInWithGoogle, signInWithApple, enableAnonymousMode } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<any>(null);

  // Auto-fill email if passed from SignUp screen
  useEffect(() => {
    if (route.params?.email) {
      setEmail(route.params.email);
    }
  }, [route.params?.email]);

  const handleLogin = async () => {
    if (!email || !password) {
      if (Platform.OS === 'web') {
        alert('Please enter both email and password');
      } else {
        Alert.alert('Missing Information', 'Please enter both email and password');
      }
      return;
    }

    setLoading(true);
    try {
      const { error } = await signIn(email, password);

      if (error) {
        const isUnconfirmed = error.message?.toLowerCase().includes('email not confirmed') ||
          error.message?.toLowerCase().includes('not confirmed');
        const title = 'Login Failed';
        const message = isUnconfirmed
          ? 'Please check your email and click the confirmation link before signing in. Check your spam folder if you don\'t see it.'
          : error.message;
        if (Platform.OS === 'web') {
          alert(`${title}: ${message}`);
        } else {
          Alert.alert(title, message);
        }
      }
      // Navigation will happen automatically via auth state change
    } catch (error) {
      console.error('Login error:', error);
      if (Platform.OS === 'web') {
        alert('An unexpected error occurred. Please try again.');
      } else {
        Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      const { error } = await signInWithGoogle();

      if (error) {
        if (Platform.OS === 'web') {
          alert(`Google Login Failed: ${error.message}`);
        } else {
          Alert.alert('Google Login Failed', error.message);
        }
      }
    } catch (error) {
      console.error('Google login error:', error);
      if (Platform.OS === 'web') {
        alert('An unexpected error occurred. Please try again.');
      } else {
        Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAppleLogin = async () => {
    setLoading(true);
    try {
      const { error, cancelled } = await signInWithApple();
      if (cancelled) return;
      if (error) {
        Alert.alert('Apple Login Failed', error.message);
      }
    } catch (error) {
      console.error('Apple login error:', error);
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
            <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">Welcome Back</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Sign in to continue your audiobook journey.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
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
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                blurOnSubmit={false}
                accessibilityLabel="Email address"
              />
            </View>

            <View style={styles.inputGroup}>
              <Ionicons name="lock-closed-outline" size={20} color={theme.textSecondary} style={styles.inputIcon} accessibilityElementsHidden importantForAccessibility="no" />
              <TextInput
                ref={passwordRef}
                style={[styles.input, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]}
                placeholder="Password"
                placeholderTextColor={theme.textSecondary}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleLogin}
                accessibilityLabel="Password"
              />
            </View>

            <TouchableOpacity
              onPress={() => navigation.navigate('ForgotPassword')}
              accessibilityRole="button"
              accessibilityLabel="Forgot password"
              accessibilityHint="Opens the password reset screen"
            >
              <Text style={[styles.forgotPassword, { color: theme.textSecondary }]}>Forgot Password?</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={handleLogin}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityHint="Signs in with your email and password"
              accessibilityState={{ disabled: loading, busy: loading }}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>Sign In</Text>
              )}
            </TouchableOpacity>
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
                onPress={handleAppleLogin}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
                accessibilityState={{ disabled: loading, busy: loading }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <>
                    <Ionicons name="logo-apple" size={24} color={'#ffffff'} accessibilityElementsHidden importantForAccessibility="no" />
                    <Text style={[styles.socialButtonText, { color: '#ffffff' }]}>Continue with Apple</Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            {Platform.OS !== 'ios' && (
              <TouchableOpacity
                style={[styles.socialButton, { backgroundColor: theme.card, borderColor: theme.border }]}
                onPress={handleGoogleLogin}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Continue with Google"
                accessibilityState={{ disabled: loading, busy: loading }}
              >
                {loading ? (
                  <ActivityIndicator color={theme.primary} />
                ) : (
                  <>
                    <Ionicons name="logo-google" size={24} color={'#DB4437'} accessibilityElementsHidden importantForAccessibility="no" />
                    <Text style={[styles.socialButtonText, { color: theme.text }]}>Continue with Google</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </>

          {/* Anonymous trial CTA — addresses the empty-library deletion
              funnel by letting users taste the product before signup.
              MainNavigator re-renders into AnonymousMain once deviceId is
              set, so no explicit navigation is required here. */}
          <TouchableOpacity
            style={[styles.tryAnonymousButton, { borderColor: theme.border }]}
            onPress={async () => {
              await enableAnonymousMode();
            }}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Try without an account"
            accessibilityHint="Explore the app and convert a book without signing up"
            accessibilityState={{ disabled: loading }}
          >
            <Text style={[styles.tryAnonymousText, { color: theme.text }]}>
              Try without an account
            </Text>
          </TouchableOpacity>

          {/* Sign Up Link */}
          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: theme.textSecondary }]}>Don't have an account? </Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('SignUp')}
              accessibilityRole="button"
              accessibilityLabel="Sign up"
              accessibilityHint="Opens the account creation screen"
            >
              <Text style={[styles.footerLink, { color: theme.primary }]}>Sign Up</Text>
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
  forgotPassword: {
    textAlign: 'right',
    marginBottom: 24,
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
  tryAnonymousButton: {
    width: '100%',
    maxWidth: 400,
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    marginBottom: 8,
  },
  tryAnonymousText: {
    fontSize: 15,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
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

export default LoginScreen;
