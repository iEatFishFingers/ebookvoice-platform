/**
 * TutorialTooltip.tsx
 * ====================
 * Single-step spotlight tooltip for in-context feature discovery.
 *
 * Shows once per storageKey (persisted in AsyncStorage).
 * Spotlights the targetRef element with the same 4-rect dark-surround
 * technique used in OnboardingOverlay.
 *
 * Usage:
 *   const btnRef = useRef<TouchableOpacity>(null);
 *   ...
 *   <TouchableOpacity ref={btnRef} .../>
 *   <TutorialTooltip
 *     storageKey="@tutorial_upload_area"
 *     targetRef={btnRef}
 *     title="Upload your EPUB here"
 *     body="Tap anywhere in this zone to pick a file from your device."
 *     ctaLabel="Got it!"
 *   />
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../context/ThemeContext';
import { track } from '../services/analytics';
import { TUTORIAL_ENABLED } from '../constants/featureFlags';

// ── Constants ──────────────────────────────────────────────────────────────────

const { width: SW } = Dimensions.get('window');
const CARD_WIDTH = Math.min(SW - 48, 360);
const SPOT_PAD   = 14;
const SPOT_R     = 14;
const ARROW_H    = 13;
const DARK       = 'rgba(2,6,23,0.82)';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SpotLayout { x: number; y: number; width: number; height: number; }

interface TutorialTooltipProps {
  storageKey: string;
  targetRef: React.RefObject<any>;
  title: string;
  body: string;
  ctaLabel?: string;
  /** Extra delay (ms) before measuring the ref — useful on slow renders */
  measureDelay?: number;
  /** Force-show regardless of AsyncStorage (for testing) */
  forceShow?: boolean;
  onDismiss?: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function TutorialTooltip({
  storageKey,
  targetRef,
  title,
  body,
  ctaLabel = 'Got it!',
  measureDelay = 600,
  forceShow = false,
  onDismiss,
}: TutorialTooltipProps) {
  const { isDarkMode } = useTheme();

  const [visible,  setVisible]  = useState(false);
  const [spotlight, setSpotlight] = useState<SpotLayout | null>(null);

  const backdropAnim = useRef(new Animated.Value(0)).current;
  const cardAnim     = useRef(new Animated.Value(0)).current;
  const spotFade     = useRef(new Animated.Value(0)).current;

  const cardBg      = isDarkMode ? '#0f172a' : '#ffffff';
  const textPrimary = isDarkMode ? '#f1f5f9' : '#0f172a';
  const textSub     = isDarkMode ? '#94a3b8' : '#64748b';

  // ── Check if should show ──────────────────────────────────────────────────────

  useEffect(() => {
    // Master kill-switch: when tutorials are disabled, never call show().
    // Component still mounts, hooks still run consistently, but `visible`
    // stays false and the render returns null. Code is kept so we can
    // flip the flag back on later without a code change.
    if (!TUTORIAL_ENABLED) return;
    (async () => {
      if (forceShow) { show(); return; }
      const seen = await AsyncStorage.getItem(storageKey);
      if (seen !== 'seen') show();
    })();
  }, []);

  const show = () => {
    setTimeout(() => {
      const tryMeasure = (attempts = 0) => {
        if (!targetRef.current) {
          if (attempts < 10) setTimeout(() => tryMeasure(attempts + 1), 120);
          return;
        }
        targetRef.current.measureInWindow((x: number, y: number, w: number, h: number) => {
          if (w > 0 && h > 0) {
            setSpotlight({ x, y, width: w, height: h });
            setVisible(true);
            track('tutorial_shown', { surface: 'tooltip', identifier: storageKey });
            Animated.parallel([
              Animated.timing(backdropAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
              Animated.timing(cardAnim,     { toValue: 1, duration: 280, useNativeDriver: true }),
              Animated.timing(spotFade,     { toValue: 1, duration: 240, useNativeDriver: true }),
            ]).start();
          } else if (attempts < 10) {
            setTimeout(() => tryMeasure(attempts + 1), 120);
          }
        });
      };
      tryMeasure();
    }, measureDelay);
  };

  const dismiss = async (via: 'cta' | 'outside') => {
    await AsyncStorage.setItem(storageKey, 'seen');
    // Always 'never_show_again: true' for tooltips — they're once-only per
    // storageKey by design. The `via` distinguishes whether the user read
    // the CTA ('cta') vs swatted the backdrop ('outside') — useful signal
    // for "is the copy actually being engaged with?"
    if (via === 'cta') {
      track('tutorial_completed', {
        surface: 'tooltip', identifier: storageKey, never_show_again: true,
      });
    } else {
      track('tutorial_dismissed', { surface: 'tooltip', identifier: storageKey });
    }
    Animated.parallel([
      Animated.timing(backdropAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(cardAnim,     { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(spotFade,     { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => {
      setVisible(false);
      onDismiss?.();
    });
  };

  if (!visible || !spotlight) return null;

  // ── Layout ────────────────────────────────────────────────────────────────────

  const sx = spotlight.x - SPOT_PAD;
  const sy = spotlight.y - SPOT_PAD;
  const sw = spotlight.width  + SPOT_PAD * 2;
  const sh = spotlight.height + SPOT_PAD * 2;

  // Show tooltip above or below depending on screen position
  const spaceBelow = Dimensions.get('window').height - (sy + sh);
  const showBelow  = spaceBelow > 220;
  const tooltipTop = showBelow ? sy + sh + ARROW_H + 4 : sy - 8;
  const cardLeft   = Math.max(12, Math.min(SW - CARD_WIDTH - 12, (spotlight.x + spotlight.width / 2) - CARD_WIDTH / 2));
  const arrowLeft  = Math.max(10, Math.min(CARD_WIDTH - 20, (spotlight.x + spotlight.width / 2) - cardLeft - ARROW_H));

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent>

      {/* Dark surround with spotlight hole */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropAnim }]} pointerEvents="box-none">
        {/* Top */}
        <View style={[styles.darkRect, { top: 0, left: 0, right: 0, height: Math.max(0, sy) }]} pointerEvents="none" />
        {/* Bottom */}
        <View style={[styles.darkRect, { top: sy + sh, left: 0, right: 0, bottom: 0 }]} pointerEvents="none" />
        {/* Left */}
        <View style={[styles.darkRect, { top: sy, left: 0, width: Math.max(0, sx), height: sh }]} pointerEvents="none" />
        {/* Right */}
        <View style={[styles.darkRect, { top: sy, left: sx + sw, right: 0, height: sh }]} pointerEvents="none" />

        {/* Spotlight ring */}
        <View pointerEvents="none" style={{
          position: 'absolute',
          top: sy, left: sx, width: sw, height: sh,
          borderRadius: SPOT_R,
          borderWidth: 2,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.05)',
        }} />
      </Animated.View>

      {/* Tap backdrop to dismiss */}
      <Pressable style={StyleSheet.absoluteFill} onPress={() => dismiss('outside')} />

      {/* Tooltip card */}
      <Animated.View
        style={[
          styles.tooltipWrapper,
          {
            top: showBelow ? tooltipTop : undefined,
            bottom: showBelow ? undefined : Dimensions.get('window').height - sy + ARROW_H + 4,
            left: cardLeft,
            width: CARD_WIDTH,
            opacity: cardAnim,
            transform: [{ translateY: cardAnim.interpolate({ inputRange: [0, 1], outputRange: [showBelow ? -8 : 8, 0] }) }],
          },
        ]}
      >
        {showBelow && (
          <View style={[styles.arrowUp, { left: arrowLeft, borderBottomColor: cardBg }]} />
        )}

        <LinearGradient
          colors={['#6366f1', '#8b5cf6', '#a78bfa', '#818cf8']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={styles.gradientBorder}
        >
          <View style={[styles.card, { backgroundColor: cardBg }]}>

            <View style={styles.hintRow}>
              <Ionicons name="arrow-up" size={12} color="#6366f1" />
              <Text style={styles.hintText}>Tap the highlighted area or:</Text>
            </View>

            <Text style={[styles.title, { color: textPrimary }]}>{title}</Text>
            <Text style={[styles.body, { color: textSub }]}>{body}</Text>

            <TouchableOpacity onPress={() => dismiss('cta')} style={styles.ctaWrapper} activeOpacity={0.88}>
              <LinearGradient
                colors={['#6366f1', '#7c3aed']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={styles.ctaBtn}
              >
                <Text style={styles.ctaText}>{ctaLabel}</Text>
                <Ionicons name="checkmark" size={15} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </LinearGradient>

        {!showBelow && (
          <View style={[styles.arrowDown, { left: arrowLeft, borderTopColor: cardBg }]} />
        )}
      </Animated.View>

    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  darkRect: {
    position: 'absolute',
    backgroundColor: DARK,
  },
  tooltipWrapper: {
    position: 'absolute',
  },
  gradientBorder: {
    width: CARD_WIDTH,
    borderRadius: 18,
    padding: 1.5,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 16,
  },
  card: {
    borderRadius: 17,
    padding: 20,
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 10,
  },
  hintText: {
    fontSize: 11,
    color: '#6366f1',
    fontWeight: '500',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
    letterSpacing: -0.2,
  },
  body: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  ctaWrapper: {
    borderRadius: 11,
    overflow: 'hidden',
  },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    gap: 6,
  },
  ctaText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  arrowUp: {
    position: 'absolute',
    top: -ARROW_H,
    width: 0, height: 0,
    borderLeftWidth: ARROW_H, borderLeftColor: 'transparent',
    borderRightWidth: ARROW_H, borderRightColor: 'transparent',
    borderBottomWidth: ARROW_H,
    zIndex: 10,
  },
  arrowDown: {
    position: 'absolute',
    bottom: -ARROW_H,
    width: 0, height: 0,
    borderLeftWidth: ARROW_H, borderLeftColor: 'transparent',
    borderRightWidth: ARROW_H, borderRightColor: 'transparent',
    borderTopWidth: ARROW_H,
    zIndex: 10,
  },
});
