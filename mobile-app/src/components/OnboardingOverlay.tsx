/**
 * OnboardingOverlay.tsx
 * =====================
 * Interactive spotlight tutorial. Shows on every app load unless the user
 * permanently opts out via "Don't show this again" on the final step.
 *
 * Flow:
 *   0  Welcome
 *   1  Spotlight: Upload EPUB        → Next only (no "Try it now")
 *   2  Spotlight: Create custom      → Next only (no "Try it now")
 *   3  Choice card                   → Upload EPUB  |  Create Custom
 *   4  Chapter review                → Next
 *   5  Pick your voice               → Next
 *   6  Smart Setup (Author Pro)      → Next
 *   7  Follow Along mode             → Next
 *   8  Converts in background        → Next
 *   9  You're all set!               → Let's Go  (navigates per choice)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Platform,
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

// ── Public API ─────────────────────────────────────────────────────────────────

export const ONBOARDING_KEY = '@onboarding_v1';

export async function checkOnboarding(): Promise<boolean> {
  const val = await AsyncStorage.getItem(ONBOARDING_KEY);
  return val !== 'never';
}

export async function markOnboardingDone(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_KEY, 'never');
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface SpotLayout { x: number; y: number; width: number; height: number; }

interface StepDef {
  type: 'info' | 'spotlight' | 'choice';
  refKey?: 'upload' | 'create';
  icon?: string;
  iconGradient?: readonly [string, string];
  title: string;
  body: string;
  cta: string;
}

// ── Step definitions ───────────────────────────────────────────────────────────

const STEPS: StepDef[] = [
  // 0 — Welcome
  {
    type: 'info',
    icon: 'headset',
    iconGradient: ['#6366f1', '#8b5cf6'],
    title: 'Welcome to EbookVoice',
    body: "Turn any EPUB into a full audiobook with AI voices — in minutes.\n\nTap Start Tour for a quick walkthrough of everything you can do.",
    cta: 'Start Tour',
  },
  // 1 — Spotlight: Upload EPUB (Next only)
  {
    type: 'spotlight',
    refKey: 'upload',
    title: 'Upload your EPUB',
    body: "This  +  button lets you pick any EPUB file from your device.\n\nWe automatically extract all chapters, cover art, and inline images — ready to convert.",
    cta: 'Next step →',
  },
  // 2 — Spotlight: Create custom (Next only)
  {
    type: 'spotlight',
    refKey: 'create',
    title: 'Create a custom audiobook',
    body: "This pencil icon lets you write or paste your own content — scripts, stories, blog posts, anything — and turn it into audio.\n\nPerfect if you don't have an EPUB.",
    cta: 'Next step →',
  },
  // 3 — Choice card
  {
    type: 'choice',
    icon: 'rocket-outline',
    iconGradient: ['#7c3aed', '#6366f1'],
    title: 'Which path do you want to try?',
    body: "Pick one and we'll spotlight exactly what to tap — then guide you through each feature as you go.",
    cta: '',
  },
  // 4 — Spotlight: chosen button (refKey set dynamically)
  {
    type: 'spotlight',
    refKey: 'upload',          // overridden at render time based on choicePath
    title: 'Tap here to begin!',
    body: "We'll walk you through every step — chapter review, voice selection, and more — as you go.\n\nEach screen will highlight the next thing to tap.",
    cta: 'Try it now!',
  },
];

const CHOICE_STEP = 3;
const LAST_STEP   = STEPS.length - 1;

// ── Component props ────────────────────────────────────────────────────────────

interface OnboardingOverlayProps {
  visible: boolean;
  onComplete: () => void;
  onNavigateUpload?: () => void;
  onNavigateCreate?: () => void;
  uploadBtnRef?: React.RefObject<any>;
  createBtnRef?: React.RefObject<any>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const { width: SW, height: SH } = Dimensions.get('window');
const CARD_WIDTH = Math.min(SW - 48, 400);
const BORDER_R   = 22;
const SPOT_PAD   = 14;
const SPOT_R     = 16;
const ARROW_H    = 14;
const DARK       = 'rgba(2,6,23,0.84)';

// ── Component ──────────────────────────────────────────────────────────────────

export default function OnboardingOverlay({
  visible,
  onComplete,
  onNavigateUpload,
  onNavigateCreate,
  uploadBtnRef,
  createBtnRef,
}: OnboardingOverlayProps) {
  // Master kill-switch — never render anything when tutorials are disabled.
  // TUTORIAL_ENABLED is a compile-time constant, so the early return is
  // consistent across all renders (no hooks-rule violation in practice;
  // hooks below either always run or never run for the component's life).
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (!TUTORIAL_ENABLED) return null;

  const { isDarkMode } = useTheme();

  const [step, setStep]           = useState(0);
  const [neverShow, setNeverShow] = useState(false);
  const [choicePath, setChoicePath] = useState<'upload' | 'create' | null>(null);
  const [spotlight, setSpotlight] = useState<SpotLayout | null>(null);

  const fadeAnim     = useRef(new Animated.Value(0)).current;
  const slideAnim    = useRef(new Animated.Value(24)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const spotFade     = useRef(new Animated.Value(0)).current;
  const pulseScale   = useRef(new Animated.Value(1)).current;
  const pulseOpacity = useRef(new Animated.Value(0)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const dotAnims     = useRef(STEPS.map((_, i) => new Animated.Value(i === 0 ? 1 : 0))).current;

  const current = STEPS[step];
  const isLast  = step === LAST_STEP;
  const isSpot  = current.type === 'spotlight';
  const isChoice = current.type === 'choice';

  const cardBg      = isDarkMode ? '#0f172a' : '#ffffff';
  const textPrimary = isDarkMode ? '#f1f5f9' : '#0f172a';
  const textSub     = isDarkMode ? '#94a3b8' : '#64748b';
  const textMuted   = isDarkMode ? '#475569' : '#94a3b8';

  // ── Init on show ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      setStep(0);
      setNeverShow(false);
      setChoicePath(null);
      setSpotlight(null);
      dotAnims.forEach((a, i) => a.setValue(i === 0 ? 1 : 0));
      backdropAnim.setValue(0);
      Animated.timing(backdropAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
      animateCard();
    }
  }, [visible]);

  // ── Measure spotlight target ──────────────────────────────────────────────────

  // On the final spotlight step (step 4), use the path the user chose
  const spotRefKey = (step === LAST_STEP && choicePath) ? choicePath : current.refKey;

  useEffect(() => {
    if (!visible || !isSpot) { setSpotlight(null); return; }
    const ref = spotRefKey === 'upload' ? uploadBtnRef : createBtnRef;
    if (!ref?.current) return;

    const tryMeasure = (attempts = 0) => {
      if (!ref?.current) { if (attempts < 8) setTimeout(() => tryMeasure(attempts + 1), 80); return; }
      ref.current.measureInWindow((x: number, y: number, w: number, h: number) => {
        if (w > 0 && h > 0) {
          setSpotlight({ x, y, width: w, height: h });
          spotFade.setValue(0);
          Animated.timing(spotFade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
        } else if (attempts < 8) {
          setTimeout(() => tryMeasure(attempts + 1), 80);
        }
      });
    };
    setTimeout(() => tryMeasure(), 100);
  }, [step, visible]);

  // ── Animated progress dots ────────────────────────────────────────────────────

  useEffect(() => {
    STEPS.forEach((_, i) => {
      Animated.spring(dotAnims[i], {
        toValue: i === step ? 1 : 0,
        tension: 130, friction: 9,
        useNativeDriver: false,
      }).start();
    });
  }, [step]);

  // ── Pulse ring on welcome step ────────────────────────────────────────────────

  useEffect(() => {
    pulseLoopRef.current?.stop();
    pulseScale.setValue(1);
    pulseOpacity.setValue(0);
    if (step === 0 && visible) {
      const loop = Animated.loop(Animated.parallel([
        Animated.sequence([
          Animated.timing(pulseScale, { toValue: 1.7, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseScale, { toValue: 1,   duration: 1000, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(pulseOpacity, { toValue: 0.4, duration: 500,  useNativeDriver: true }),
          Animated.timing(pulseOpacity, { toValue: 0,   duration: 500,  useNativeDriver: true }),
          Animated.delay(1000),
        ]),
      ]));
      pulseLoopRef.current = loop;
      loop.start();
    }
    return () => pulseLoopRef.current?.stop();
  }, [step, visible]);

  // ── Card entrance ─────────────────────────────────────────────────────────────

  const animateCard = useCallback(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(26);
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 270, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, tension: 90, friction: 11, useNativeDriver: true }),
    ]).start();
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────────

  // ── Analytics: emit tutorial_shown once per step view, so a re-enable
  //    later gives us a clean per-step drop-off funnel in PostHog.
  useEffect(() => {
    if (!visible) return;
    track('tutorial_shown', {
      surface: 'onboarding',
      identifier: STEPS[step]?.title ?? `step_${step}`,
      step_index: step,
    });
  }, [step, visible]);

  const advance = () => {
    // Last-step "Let's Go" → handled by dismiss(navigate), tracked there as
    // tutorial_completed. Regular "Next" → tutorial_step_next.
    track('tutorial_step_next', {
      surface: 'onboarding',
      from_step: step,
      from_step_name: STEPS[step]?.title ?? `step_${step}`,
    });
    Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      setStep(s => s + 1);
      animateCard();
    });
  };

  const dismiss = async (navigate?: 'upload' | 'create') => {
    if (neverShow) await markOnboardingDone();
    // `navigate` truthy means user reached the final "Let's Go" → completion
    // path (and choses which screen to land on). No navigate = user-initiated
    // skip / outside-tap / X — that's a dismissal.
    if (navigate) {
      track('tutorial_completed', {
        surface: 'onboarding',
        identifier: STEPS[step]?.title ?? `step_${step}`,
        navigate_to: navigate,
        never_show_again: neverShow,
      });
    } else {
      track('tutorial_dismissed', {
        surface: 'onboarding',
        identifier: STEPS[step]?.title ?? `step_${step}`,
        step_index: step,
        never_show_again: neverShow,
      });
    }
    Animated.parallel([
      Animated.timing(backdropAnim, { toValue: 0, duration: 260, useNativeDriver: true }),
      Animated.timing(fadeAnim,     { toValue: 0, duration: 210, useNativeDriver: true }),
      Animated.timing(spotFade,     { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      onComplete();
      if (navigate === 'upload') onNavigateUpload?.();
      else if (navigate === 'create') onNavigateCreate?.();
    });
  };

  // On choice card: record path and advance to feature walkthrough
  const handleChoice = (path: 'upload' | 'create') => {
    track('tutorial_step_next', {
      surface: 'onboarding',
      from_step: CHOICE_STEP,
      from_step_name: STEPS[CHOICE_STEP]?.title ?? 'choice',
      choice: path,
    });
    setChoicePath(path);
    Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      setStep(CHOICE_STEP + 1);
      animateCard();
    });
  };


  if (!visible) return null;

  // ── Dots row ─────────────────────────────────────────────────────────────────

  const DotsRow = () => (
    <View style={styles.stepRow}>
      {STEPS.map((_, i) => {
        const w = dotAnims[i].interpolate({ inputRange: [0, 1], outputRange: [6, 20] });
        const o = dotAnims[i].interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] });
        return (
          <Animated.View key={i} style={[
            styles.dot,
            { width: w, opacity: o, backgroundColor: i === step ? '#6366f1' : (isDarkMode ? '#334155' : '#c7d2fe') },
          ]} />
        );
      })}
    </View>
  );

  // ── Spotlight step ────────────────────────────────────────────────────────────

  if (isSpot) {
    const spot     = spotlight ?? { x: SW - 46, y: 14, width: 28, height: 28 };
    const sx       = spot.x - SPOT_PAD;
    const sy       = spot.y - SPOT_PAD;
    const sw       = spot.width  + SPOT_PAD * 2;
    const sh       = spot.height + SPOT_PAD * 2;
    const tooltipTop = sy + sh + ARROW_H + 4;
    const cardLeft   = Math.max(12, Math.min(SW - CARD_WIDTH - 12, (spot.x + spot.width / 2) - CARD_WIDTH / 2));
    const arrowLeft  = Math.max(10, Math.min(CARD_WIDTH - 20, (spot.x + spot.width / 2) - cardLeft - ARROW_H));

    return (
      <Modal transparent visible={visible} animationType="none" statusBarTranslucent>

        {/* Dark surround with spotlight hole */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropAnim }]} pointerEvents="box-none">
          <View style={[styles.darkRect, { top: 0, left: 0, right: 0, height: Math.max(0, sy) }]} pointerEvents="none" />
          <View style={[styles.darkRect, { top: sy + sh, left: 0, right: 0, bottom: 0 }]} pointerEvents="none" />
          <View style={[styles.darkRect, { top: sy, left: 0, width: Math.max(0, sx), height: sh }]} pointerEvents="none" />
          <View style={[styles.darkRect, { top: sy, left: sx + sw, right: 0, height: sh }]} pointerEvents="none" />

          {/* Spotlight highlight ring */}
          <View pointerEvents="none" style={{
            position: 'absolute',
            top: sy, left: sx, width: sw, height: sh,
            borderRadius: SPOT_R,
            borderWidth: 2.5,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99,102,241,0.06)',
          }} />
          <Animated.View pointerEvents="none" style={{
            position: 'absolute',
            top: sy - 4, left: sx - 4, width: sw + 8, height: sh + 8,
            borderRadius: SPOT_R + 4,
            borderWidth: 1.5,
            borderColor: 'rgba(99,102,241,0.35)',
          }} />
        </Animated.View>

        {/* Tapping backdrop skips tour */}
        <Pressable style={StyleSheet.absoluteFill} onPress={() => dismiss()} />

        {/* Tooltip card */}
        <Animated.View
          style={[styles.tooltipWrapper, { top: tooltipTop, left: cardLeft, width: CARD_WIDTH, opacity: spotFade }]}
        >
          <View style={[styles.arrowUp, { left: arrowLeft, borderBottomColor: cardBg }]} />

          <LinearGradient
            colors={['#6366f1', '#8b5cf6', '#a78bfa', '#818cf8']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.gradientBorder}
          >
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <DotsRow />

              <Text style={[styles.tooltipTitle, { color: textPrimary }]}>{current.title}</Text>
              <Text style={[styles.tooltipBody, { color: textSub }]}>{current.body}</Text>

              {isLast ? (
                /* Final spotlight — "Try it now!" navigates to chosen path */
                <TouchableOpacity
                  onPress={() => dismiss(choicePath ?? 'upload')}
                  style={styles.primaryBtnWrapper}
                  activeOpacity={0.88}
                >
                  <LinearGradient
                    colors={choicePath === 'create' ? ['#7c3aed', '#a78bfa'] : ['#059669', '#10b981']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.primaryBtn}
                  >
                    <Text style={styles.primaryBtnText}>{current.cta}</Text>
                    <Ionicons
                      name={choicePath === 'create' ? 'create-outline' : 'cloud-upload-outline'}
                      size={15}
                      color="#fff"
                    />
                  </LinearGradient>
                </TouchableOpacity>
              ) : (
                /* Non-final spotlight steps — "Next step →" advances */
                <TouchableOpacity onPress={advance} style={styles.primaryBtnWrapper} activeOpacity={0.88}>
                  <LinearGradient
                    colors={['#6366f1', '#7c3aed']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.primaryBtn}
                  >
                    <Text style={styles.primaryBtnText}>{current.cta}</Text>
                    <Ionicons name="arrow-forward" size={15} color="#fff" />
                  </LinearGradient>
                </TouchableOpacity>
              )}

              <TouchableOpacity onPress={() => dismiss()} style={styles.skipTourBtn} activeOpacity={0.6}>
                <Text style={[styles.skipTourText, { color: textMuted }]}>Skip tour</Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </Animated.View>

      </Modal>
    );
  }

  // ── Info / choice card ────────────────────────────────────────────────────────

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent>
      <Animated.View style={[styles.backdrop, { opacity: backdropAnim }]} />
      <Pressable style={StyleSheet.absoluteFill} onPress={() => dismiss()} />

      <Animated.View style={[styles.cardWrapper, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
        <LinearGradient
          colors={['#6366f1', '#8b5cf6', '#a78bfa', '#818cf8']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={styles.gradientBorder}
        >
          <View style={[styles.card, { backgroundColor: cardBg }]}>

            <DotsRow />

            {/* Icon */}
            {current.icon && (
              <View style={styles.iconOuter}>
                {step === 0 && (
                  <Animated.View style={[styles.pulseRing, {
                    transform: [{ scale: pulseScale }],
                    opacity: pulseOpacity,
                  }]} />
                )}
                <LinearGradient
                  colors={current.iconGradient as [string, string]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={styles.iconWrapper}
                >
                  <Ionicons name={current.icon as any} size={34} color="#ffffff" />
                </LinearGradient>
              </View>
            )}

            <Text style={[styles.title, { color: textPrimary }]}>{current.title}</Text>
            <Text style={[styles.body, { color: textSub }]}>{current.body}</Text>

            {/* Choice step — two big equal buttons */}
            {isChoice && (
              <View style={styles.choiceRow}>
                <TouchableOpacity
                  onPress={() => handleChoice('upload')}
                  style={styles.choiceBtnWrapper}
                  activeOpacity={0.88}
                >
                  <LinearGradient
                    colors={['#6366f1', '#7c3aed']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.choiceBtn}
                  >
                    <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
                    <Text style={styles.choiceBtnTitle}>Upload EPUB</Text>
                    <Text style={styles.choiceBtnSub}>I have an epub file</Text>
                  </LinearGradient>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleChoice('create')}
                  style={styles.choiceBtnWrapper}
                  activeOpacity={0.88}
                >
                  <LinearGradient
                    colors={['#7c3aed', '#a78bfa']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.choiceBtn}
                  >
                    <Ionicons name="create-outline" size={20} color="#fff" />
                    <Text style={styles.choiceBtnTitle}>Create Custom</Text>
                    <Text style={styles.choiceBtnSub}>I'll write my own text</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            )}

            {/* Regular info step buttons */}
            {!isChoice && (
              <>
                {/* "Don't show again" on final step */}
                {isLast && (
                  <TouchableOpacity onPress={() => setNeverShow(v => !v)} style={styles.neverRow} activeOpacity={0.7}>
                    <Ionicons
                      name={neverShow ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={neverShow ? '#6366f1' : textMuted}
                    />
                    <Text style={[styles.neverText, { color: textMuted }]}>Don't show this again</Text>
                  </TouchableOpacity>
                )}

                <View style={styles.btnRow}>
                  {step > 0 && !isLast && (
                    <TouchableOpacity onPress={() => dismiss()} style={styles.skipBtn} activeOpacity={0.6}>
                      <Text style={[styles.skipBtnText, { color: textMuted }]}>Skip</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={advance}
                    style={[styles.primaryBtnWrapper, step === 0 && { flex: 1 }]}
                    activeOpacity={0.88}
                  >
                    <LinearGradient
                      colors={isLast
                        ? (choicePath === 'create' ? ['#7c3aed', '#a78bfa'] : ['#059669', '#10b981'])
                        : ['#6366f1', '#7c3aed']}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                      style={styles.primaryBtn}
                    >
                      <Text style={styles.primaryBtnText}>{current.cta}</Text>
                      <Ionicons
                        name={isLast
                          ? (choicePath === 'create' ? 'create-outline' : 'cloud-upload-outline')
                          : step === 0 ? 'play-outline' : 'arrow-forward'}
                        size={16}
                        color="#fff"
                      />
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              </>
            )}

          </View>
        </LinearGradient>
      </Animated.View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: DARK,
  },
  darkRect: {
    position: 'absolute',
    backgroundColor: DARK,
  },

  cardWrapper: {
    position: 'absolute',
    top: SH * 0.13,
    left: 0, right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
  },

  gradientBorder: {
    width: CARD_WIDTH,
    borderRadius: BORDER_R + 2,
    padding: 1.5,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 32,
    elevation: 18,
  },
  card: {
    borderRadius: BORDER_R,
    padding: 24,
  },

  tooltipWrapper: {
    position: 'absolute',
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

  stepRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },

  iconOuter: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    width: 76, height: 76,
    marginBottom: 18,
  },
  pulseRing: {
    position: 'absolute',
    width: 76, height: 76,
    borderRadius: 24,
    backgroundColor: 'rgba(99,102,241,0.28)',
  },
  iconWrapper: {
    width: 68, height: 68,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },

  title: {
    fontSize: 21,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'center',
    marginBottom: 20,
  },

  tooltipTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  tooltipBody: {
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 16,
  },

  // Choice buttons
  choiceRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  choiceBtnWrapper: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  choiceBtn: {
    paddingVertical: 16,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 6,
  },
  choiceBtnTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  choiceBtnSub: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    textAlign: 'center',
  },

  // "Don't show again"
  neverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  neverText: {
    fontSize: 13,
  },

  // Buttons
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  skipBtn: {
    paddingVertical: 13,
    paddingHorizontal: 8,
  },
  skipBtnText: {
    fontSize: 15,
  },
  skipTourBtn: {
    alignSelf: 'center',
    marginTop: 10,
    paddingVertical: 6,
  },
  skipTourText: {
    fontSize: 12,
    textAlign: 'center',
  },
  primaryBtnWrapper: {
    flex: 1,
    borderRadius: 13,
    overflow: 'hidden',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    gap: 7,
  },
  primaryBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
});
