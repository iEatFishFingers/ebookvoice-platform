import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useRoute, RouteProp, CommonActions } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

type PaymentReturnScreenRouteProp = RouteProp<RootStackParamList, 'PaymentReturn'>;
type PaymentReturnScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'PaymentReturn'
>;

const PaymentReturnScreen = () => {
  const navigation = useNavigation<PaymentReturnScreenNavigationProp>();
  const route = useRoute<PaymentReturnScreenRouteProp>();
  const { theme } = useTheme();
  const { refreshProfile } = useAuth();
  const [status, setStatus] = useState<'loading' | 'success' | 'cancelled' | 'error'>('loading');

  useEffect(() => {
    const handlePaymentReturn = async () => {
      try {
        // Get the URL parameters
        const params = route.params as any;

        // Check if payment was successful
        if (params?.session_id) {
          // Payment was successful
          setStatus('success');
          // Refresh user profile to get updated subscription info
          await refreshProfile();
        } else if (params?.canceled || route.path?.includes('cancel')) {
          // Payment was cancelled
          setStatus('cancelled');
        } else {
          setStatus('error');
        }
      } catch (error) {
        console.error('Error handling payment return:', error);
        setStatus('error');
      }
    };

    handlePaymentReturn();
  }, [route.params, route.path]);

  const handleContinue = () => {
    if (status === 'success') {
      // Navigate to Main tab navigator with Profile tab selected
      navigation.reset({
        index: 0,
        routes: [
          {
            name: 'Main',
            state: {
              routes: [
                { name: 'Library' },
                { name: 'Upload' },
                { name: 'Profile' }
              ],
              index: 2 // Profile tab (0: Library, 1: Upload, 2: Profile)
            }
          }
        ],
      });
    } else {
      // Navigate back to Subscription screen
      navigation.navigate('Subscription');
    }
  };

  const renderContent = () => {
    switch (status) {
      case 'loading':
        return (
          <View style={styles.contentContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.title, { color: theme.text }]}>
              Processing payment...
            </Text>
            <Text style={[styles.message, { color: theme.textSecondary }]}>
              Please wait while we confirm your subscription.
            </Text>
          </View>
        );

      case 'success':
        return (
          <View style={styles.contentContainer}>
            <View style={[styles.iconContainer, { backgroundColor: theme.successLight }]}>
              <Ionicons name="checkmark-circle" size={80} color={theme.success} />
            </View>
            <Text style={[styles.title, { color: theme.text }]}>
              Payment Successful!
            </Text>
            <Text style={[styles.message, { color: theme.textSecondary }]}>
              Your subscription has been activated. Thank you for subscribing!
            </Text>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={handleContinue}
              accessibilityRole="button"
              accessibilityLabel="View subscription"
            >
              <Text style={styles.buttonText}>View Subscription</Text>
            </TouchableOpacity>
          </View>
        );

      case 'cancelled':
        return (
          <View style={styles.contentContainer}>
            <View style={[styles.iconContainer, { backgroundColor: theme.warningLight }]}>
              <Ionicons name="close-circle" size={80} color={theme.warning} />
            </View>
            <Text style={[styles.title, { color: theme.text }]}>
              Payment Cancelled
            </Text>
            <Text style={[styles.message, { color: theme.textSecondary }]}>
              Your payment was cancelled. No charges were made.
            </Text>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={handleContinue}
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text style={styles.buttonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        );

      case 'error':
        return (
          <View style={styles.contentContainer}>
            <View style={[styles.iconContainer, { backgroundColor: theme.errorLight }]}>
              <Ionicons name="alert-circle" size={80} color={theme.error} />
            </View>
            <Text style={[styles.title, { color: theme.text }]}>
              Something Went Wrong
            </Text>
            <Text style={[styles.message, { color: theme.textSecondary }]}>
              We encountered an error processing your payment. Please try again.
            </Text>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={handleContinue}
              accessibilityRole="button"
              accessibilityLabel="Back to plans"
            >
              <Text style={styles.buttonText}>Back to Subscriptions</Text>
            </TouchableOpacity>
          </View>
        );
    }
  };

  return (
    <ScreenWrapper applyBottomInset style={[styles.container, { backgroundColor: theme.surface }]}>
      {renderContent()}
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  iconContainer: {
    marginBottom: 24,
    borderRadius: 80,
    padding: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
  },
  button: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default PaymentReturnScreen;
