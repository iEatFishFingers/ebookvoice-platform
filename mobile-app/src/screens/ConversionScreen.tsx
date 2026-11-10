import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  Animated,
  Easing,
  Dimensions,
} from 'react-native';
import ScreenWrapper from '../components/ScreenWrapper';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useConversion } from '../context/ConversionContext';
import { useAuth } from '../context/AuthContext';

type ConversionScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Conversion'>;
type ConversionScreenRouteProp = RouteProp<RootStackParamList, 'Conversion'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const RING_SIZES = [200, 164, 130];

// ── Animated concentric rings ─────────────────────────────────────────────────
const OrbitalRings = ({ color, active }: { color: string; active: boolean }) => {
  const rot1 = useRef(new Animated.Value(0)).current;
  const rot2 = useRef(new Animated.Value(0)).current;
  const rot3 = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) return;

    const spin = (val: Animated.Value, dur: number) =>
      Animated.loop(
        Animated.timing(val, { toValue: 1, duration: dur, useNativeDriver: true, easing: Easing.linear }),
      );

    spin(rot1, 3200).start();
    spin(rot2, 5600).start();
    spin(rot3, 9000).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.08, duration: 1400, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ])
    ).start();

    return () => { rot1.stopAnimation(); rot2.stopAnimation(); rot3.stopAnimation(); pulse.stopAnimation(); };
  }, [active]);

  const mkRotate = (val: Animated.Value, reverse?: boolean) => ({
    transform: [{
      rotate: val.interpolate({
        inputRange: [0, 1],
        outputRange: reverse ? ['360deg', '0deg'] : ['0deg', '360deg'],
      }),
    }],
  });

  return (
    <View style={s.orbitals}>
      {/* Outermost ring — slow */}
      <Animated.View style={[s.ring, {
        width: RING_SIZES[0], height: RING_SIZES[0], borderRadius: RING_SIZES[0] / 2,
        borderColor: color + '28',
        borderTopColor: color,
        borderRightColor: color + '55',
        ...mkRotate(rot3),
      }]} />
      {/* Mid ring — counter */}
      <Animated.View style={[s.ring, {
        width: RING_SIZES[1], height: RING_SIZES[1], borderRadius: RING_SIZES[1] / 2,
        borderColor: color + '18',
        borderTopColor: color + 'cc',
        borderLeftColor: color + '66',
        ...mkRotate(rot2, true),
      }]} />
      {/* Inner ring — fastest */}
      <Animated.View style={[s.ring, {
        width: RING_SIZES[2], height: RING_SIZES[2], borderRadius: RING_SIZES[2] / 2,
        borderColor: color + '20',
        borderTopColor: color + 'dd',
        borderBottomColor: color + '55',
        ...mkRotate(rot1),
      }]} />
      {/* Pulse glow */}
      <Animated.View style={[s.glowCircle, {
        width: 90, height: 90, borderRadius: 45,
        backgroundColor: color + '12',
        transform: [{ scale: pulse }],
      }]} />
    </View>
  );
};

// ── Audio waveform bars ───────────────────────────────────────────────────────
const WaveBars = ({ color, active }: { color: string; active: boolean }) => {
  const BAR_COUNT = 7;
  const anims = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.25))).current;

  useEffect(() => {
    if (!active) {
      anims.forEach(a => { a.stopAnimation(); a.setValue(0.25); });
      return;
    }
    const loops = anims.map((a, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 120),
          Animated.timing(a, { toValue: 1, duration: 350 + i * 40, useNativeDriver: false, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(a, { toValue: 0.15, duration: 350 + i * 40, useNativeDriver: false, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(a, { toValue: 0.55, duration: 260, useNativeDriver: false, easing: Easing.inOut(Easing.ease) }),
        ])
      )
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [active]);

  return (
    <View style={s.waveBars}>
      {anims.map((anim, i) => (
        <Animated.View key={i} style={[s.waveBar, {
          backgroundColor: color,
          opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.9] }),
          transform: [{ scaleY: anim }],
        }]} />
      ))}
    </View>
  );
};

// ── Dots shimmer for loading/queued ──────────────────────────────────────────
const ShimmerDots = ({ color }: { color: string }) => {
  const anims = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = anims.map((a, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 250),
          Animated.timing(a, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(a, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ])
      )
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);
  return (
    <View style={s.dots}>
      {anims.map((a, i) => (
        <Animated.View key={i} style={[s.dot, { backgroundColor: color, opacity: a }]} />
      ))}
    </View>
  );
};

// ── Main screen ───────────────────────────────────────────────────────────────
const ConversionScreen = () => {
  const navigation = useNavigation<ConversionScreenNavigationProp>();
  const route = useRoute<ConversionScreenRouteProp>();
  const { taskId, epubName, wordCount } = route.params;
  const { theme } = useTheme();
  const { activeConversions, clearConversion, cancelConversion } = useConversion();
  const { isAnonymous } = useAuth();
  // Anonymous users live under the AnonymousMain tab navigator, not Main —
  // navigating to 'Main' from the anonymous stack is a no-op, which is why
  // "Go to Library" / back appeared broken for them.
  const libraryRoot = isAnonymous ? 'AnonymousMain' : 'Main';
  const conv = activeConversions.find(c => c.taskId === taskId) ?? null;

  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
  }, []);

  const isLoading = !conv || !conv.initialized;
  const isComplete = !isLoading && !!conv?.complete;
  const isFailed = !!conv?.error;
  const isQueued = conv?.queueStatus === 'queued';
  const isConverting = !isComplete && !isFailed && !isQueued;

  const progress = isLoading ? 0 : conv.progress;
  const pct = Math.round(progress * 100);
  const status = isLoading ? 'Preparing...' : conv.status ?? 'Working...';
  const bookTitle = epubName.replace(/\.epub$/i, '');

  const fmtMinutes = (mins: number): string => {
    if (mins < 1) return '< 1 min';
    if (mins < 60) return `~${Math.ceil(mins)} min`;
    const h = Math.floor(mins / 60);
    const m = Math.ceil(mins % 60);
    return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
  };

  const getEta = (): string | null => {
    if (progress >= 1) return null;
    if (conv?.etaSeconds != null && conv.etaSeconds > 0) return fmtMinutes(conv.etaSeconds / 60) + ' remaining';
    if (!wordCount || wordCount <= 0) return null;
    // Fallback while the server hasn't published eta_seconds yet (queued, or
    // the first seconds of synthesis). 250 words/min assumed conversion ran at
    // reading speed; measured whole-book throughput 2026-09-11 → 09-14 was
    // 7–28× that. 1,080/min (18 words/s) is the server's own seed rate — the
    // slowest book measured — so a first number is a little pessimistic, not 6×.
    return fmtMinutes((wordCount / 1080) * (1 - progress)) + ' remaining';
  };
  const eta = getEta();

  const getUpfront = (): string | null => {
    if (!wordCount || wordCount <= 0) return null;
    return `Est. ${fmtMinutes(wordCount / 250)}`;
  };

  // Spoken progress for screen-reader users. accessibilityLiveRegion on the
  // header is Android-only — on iOS VoiceOver this screen was silent while
  // converting. Announce quarter milestones + the terminal states without
  // moving focus.
  const lastAnnouncedRef = React.useRef(-1);
  React.useEffect(() => {
    if (isFailed) {
      AccessibilityInfo.announceForAccessibility(`Conversion failed for ${bookTitle}`);
      return;
    }
    if (isComplete) {
      AccessibilityInfo.announceForAccessibility(`${bookTitle} is ready. Your audiobook is in the library`);
      return;
    }
    const milestone = Math.floor(progress * 4); // 0,1,2,3 → 0/25/50/75%
    if (milestone > 0 && milestone > lastAnnouncedRef.current) {
      lastAnnouncedRef.current = milestone;
      AccessibilityInfo.announceForAccessibility(`Converting ${bookTitle}, ${milestone * 25} percent done`);
    }
  }, [isComplete, isFailed, Math.floor(progress * 4)]);

  const handleContinueInBackground = () => navigation.navigate(libraryRoot as any, { screen: 'Library' } as any);
  const handleGoToLibrary = () => { clearConversion(taskId); navigation.navigate(libraryRoot as any, { screen: 'Library' } as any); };
  const handlePlayNow = () => {
    clearConversion(taskId);
    // Reset the stack to [Library, Player] so back from the Player returns to
    // the Library (book kept) instead of walking back up the conversion chain.
    navigation.reset({
      index: 1,
      routes: [
        { name: libraryRoot as any },
        { name: 'Player' as any, params: { audiobookId: conv?.databaseId ?? taskId } },
      ],
    });
  };

  const handleCancel = () => {
    const doCancel = async () => {
      try {
        await cancelConversion(taskId);
        navigation.navigate(libraryRoot as any, { screen: 'Library' } as any);
      } catch {
        if (Platform.OS === 'web') alert('Failed to cancel. Please try again.');
        else Alert.alert('Error', 'Failed to cancel. Please try again.');
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Cancel this conversion?')) doCancel();
    } else {
      Alert.alert('Cancel Conversion', 'Are you sure? Progress will be lost.', [
        { text: 'Keep Going', style: 'cancel' },
        { text: 'Cancel', style: 'destructive', onPress: doCancel },
      ]);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ScreenWrapper applyBottomInset style={[s.root, { backgroundColor: theme.surface }]}>

      {/* Header */}
      <View style={[s.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={s.headerBack}
          onPress={isComplete || isFailed ? handleGoToLibrary : handleContinueInBackground}
          accessibilityRole="button"
          accessibilityLabel={isComplete || isFailed ? 'Go to library' : 'Continue in background'}
        >
          <Ionicons name="arrow-back" size={22} color={theme.text} accessibilityElementsHidden importantForAccessibility="no" />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: theme.text }]} accessibilityRole="header" accessibilityLiveRegion="polite">
          {isFailed ? 'Conversion Failed' : isComplete ? 'Ready!' : isQueued ? 'Queued' : 'Converting'}
        </Text>
        <View style={{ width: 30 }} />
      </View>

      {/* ── Error ── */}
      {isFailed ? (
        <Animated.View style={[s.centeredView, { opacity: fadeAnim }]}>
          <View style={[s.stateIcon, { backgroundColor: (theme.errorLight ?? '#fee2e2') }]}>
            <Ionicons name="alert-circle" size={36} color={theme.error ?? '#ef4444'} />
          </View>
          <Text style={[s.stateTitle, { color: theme.text }]}>Conversion Failed</Text>
          <Text style={[s.stateMsg, { color: theme.textSecondary }]}>{conv?.error}</Text>
          <Btn label="Go to Library" icon="library-outline" onPress={handleGoToLibrary}
            style={[s.btnOutline, { borderColor: theme.border }]} textColor={theme.textSecondary} />
        </Animated.View>

      /* ── Complete ── */
      ) : isComplete ? (
        <Animated.View style={[s.centeredView, { opacity: fadeAnim }]}>
          <View style={[s.successRing, { borderColor: (theme.success ?? '#22c55e') + '40' }]}>
            <View style={[s.stateIcon, { backgroundColor: (theme.successLight ?? '#dcfce7') }]}>
              <Ionicons name="checkmark-circle" size={36} color={theme.success ?? '#22c55e'} />
            </View>
          </View>
          <Text style={[s.stateTitle, { color: theme.text }]}>Audiobook Ready</Text>
          <Text style={[s.bookNameText, { color: theme.primary }]} numberOfLines={2}>{bookTitle}</Text>
          <Text style={[s.stateMsg, { color: theme.textSecondary }]}>Your audiobook is ready to play</Text>
          <Btn label="Play Now" icon="play-circle" onPress={handlePlayNow}
            style={{ backgroundColor: theme.primary }} textColor="#fff" />
          <Btn label="Go to Library" icon="library-outline" onPress={handleGoToLibrary}
            style={[s.btnOutline, { borderColor: theme.primary }]} textColor={theme.primary} />
        </Animated.View>

      /* ── Queued ── */
      ) : isQueued ? (
        <Animated.View style={[s.centeredView, { opacity: fadeAnim }]}>
          <View style={[s.orbitalsWrap, { marginBottom: 28 }]}>
            <OrbitalRings color={theme.primary} active={true} />
            <View style={s.centerPct}>
              <Ionicons name="time-outline" size={28} color={theme.primary} />
            </View>
          </View>
          <Text style={[s.stateTitle, { color: theme.text }]}>In Queue</Text>
          <Text style={[s.bookNameText, { color: theme.primary }]} numberOfLines={2}>{bookTitle}</Text>
          {conv?.queuePosition != null && (
            <View style={[s.queueBadge, { backgroundColor: theme.primaryLight }]}>
              <Text style={[s.queueBadgeText, { color: theme.primary }]}>
                #{conv.queuePosition} in queue
              </Text>
            </View>
          )}
          <Text style={[s.stateMsg, { color: theme.textSecondary }]}>
            Conversion starts automatically when a slot opens
          </Text>
          {getUpfront() && (
            <Text style={[s.eta, { color: theme.textSecondary }]}>{getUpfront()}</Text>
          )}
          <ShimmerDots color={theme.primary} />
          <Btn label="Continue in Background" icon="arrow-forward-circle-outline" onPress={handleContinueInBackground}
            style={[s.btnOutline, { borderColor: theme.border, marginTop: 20 }]} textColor={theme.textSecondary} />
          <Btn label="Cancel" icon="close-circle-outline" onPress={handleCancel}
            style={[s.btnOutline, { borderColor: (theme.error ?? '#ef4444') + '80' }]} textColor={theme.error ?? '#ef4444'} />
        </Animated.View>

      /* ── Converting ── */
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={{ opacity: fadeAnim, alignItems: 'center', width: '100%' }}>

            {/* Book pill */}
            <View style={[s.bookPill, { backgroundColor: theme.primaryLight }]}>
              <Ionicons name="book-outline" size={12} color={theme.primary} />
              <Text style={[s.bookPillText, { color: theme.primary }]} numberOfLines={1}>{bookTitle}</Text>
            </View>

            {/* Orbital animation */}
            <View style={[s.orbitalsWrap, { marginBottom: 20 }]}>
              <OrbitalRings color={theme.primary} active={isConverting} />
              {/* Center circle with progress */}
              <View style={[s.centerPct, { backgroundColor: theme.card, borderColor: theme.border }]}>
                {isLoading ? (
                  <ShimmerDots color={theme.primary} />
                ) : (
                  <>
                    <Text style={[s.pctNum, { color: theme.primary }]}>{pct}</Text>
                    <Text style={[s.pctSymbol, { color: theme.primary + 'aa' }]}>%</Text>
                  </>
                )}
              </View>
            </View>

            {/* Progress track */}
            <View style={[s.progressTrack, { backgroundColor: theme.border }]}>
              <Animated.View style={[s.progressFill, {
                backgroundColor: theme.primary,
                width: `${pct}%` as any,
              }]} />
            </View>

            {/* Status text */}
            <Text style={[s.statusText, { color: theme.text }]} numberOfLines={2}>
              {status}
            </Text>
            {eta && (
              <Text style={[s.eta, { color: theme.textSecondary }]}>{eta}</Text>
            )}

            {/* Wave bars */}
            <View style={[s.waveWrap, { borderColor: theme.border, backgroundColor: theme.card }]}>
              <WaveBars color={theme.primary} active={isConverting} />
              <Text style={[s.waveLabel, { color: theme.textSecondary }]}>Synthesising audio</Text>
            </View>

            {/* Info card */}
            <View style={[s.infoCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Ionicons name="information-circle-outline" size={18} color={theme.primary} />
              <Text style={[s.infoText, { color: theme.textSecondary }]}>
                Converting your ebook to natural speech. Long books can take up to several hours — you can leave this screen and the conversion keeps going.
              </Text>
            </View>

            {/* Actions */}
            <Btn label="Continue in Background" icon="arrow-forward-circle-outline"
              onPress={handleContinueInBackground}
              style={[s.btnOutline, { borderColor: theme.border }]} textColor={theme.textSecondary} />
            <Text style={[s.bgNote, { color: theme.textSecondary }]}>
              Conversion keeps running when you leave
            </Text>
            <Btn label="Cancel Conversion" icon="close-circle-outline" onPress={handleCancel}
              style={[s.btnOutline, { borderColor: (theme.error ?? '#ef4444') + '60', marginTop: 8 }]}
              textColor={theme.error ?? '#ef4444'} />
          </Animated.View>
        </ScrollView>
      )}
    </ScreenWrapper>
  );
};

// ── Reusable button ───────────────────────────────────────────────────────────
const Btn = ({
  label, icon, onPress, style, textColor,
}: {
  label: string; icon?: any; onPress: () => void;
  style?: any; textColor: string;
}) => (
  <TouchableOpacity style={[s.btn, style]} onPress={onPress} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={label}>
    {icon && <Ionicons name={icon} size={16} color={textColor} accessibilityElementsHidden importantForAccessibility="no" />}
    <Text style={[s.btnText, { color: textColor }]}>{label}</Text>
  </TouchableOpacity>
);

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerBack: { padding: 4, marginRight: 8 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' },

  // Centered layouts
  centeredView: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  stateIcon: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  successRing: {
    padding: 8, borderRadius: 50, borderWidth: 2, marginBottom: 20,
  },
  stateTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
  bookNameText: {
    fontSize: 16, fontWeight: '600', textAlign: 'center',
    marginBottom: 10, paddingHorizontal: 12,
  },
  stateMsg: { fontSize: 14, textAlign: 'center', lineHeight: 21, marginBottom: 24, opacity: 0.8 },

  queueBadge: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, marginBottom: 12,
  },
  queueBadgeText: { fontSize: 13, fontWeight: '700' },

  // Orbital rings
  orbitalsWrap: {
    width: RING_SIZES[0] + 4, height: RING_SIZES[0] + 4,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 16,
  },
  orbitals: {
    position: 'absolute', width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
  },
  ring: {
    position: 'absolute', borderWidth: 2.5,
  },
  glowCircle: { position: 'absolute' },

  centerPct: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', alignContent: 'center',
    borderWidth: 1.5, elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12, shadowRadius: 8,
  },
  pctNum: { fontSize: 28, fontWeight: '800', lineHeight: 34 },
  pctSymbol: { fontSize: 13, fontWeight: '700', marginTop: 8 },

  // In-progress scroll
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 48, paddingTop: 16, alignItems: 'center' },

  bookPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
    maxWidth: SCREEN_WIDTH - 64, marginBottom: 4,
  },
  bookPillText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },

  // Progress track
  progressTrack: {
    height: 4, borderRadius: 2, width: SCREEN_WIDTH - 64,
    marginTop: 20, marginBottom: 14, overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 2, minWidth: 4 },

  statusText: { fontSize: 14, fontWeight: '500', textAlign: 'center', marginBottom: 4, paddingHorizontal: 12 },
  eta: { fontSize: 12, textAlign: 'center', opacity: 0.65, marginBottom: 4 },

  // Wave bars
  waveWrap: {
    alignItems: 'center', borderRadius: 16, borderWidth: 1,
    paddingVertical: 16, paddingHorizontal: 24, width: '100%',
    marginTop: 18, marginBottom: 16, gap: 8,
  },
  waveBars: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 36 },
  waveBar: { width: 4, height: 36, borderRadius: 2, transformOrigin: 'bottom' },
  waveLabel: { fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', fontWeight: '600' },

  // Info card
  infoCard: {
    flexDirection: 'row', gap: 10, borderRadius: 14, borderWidth: 1,
    padding: 14, width: '100%', marginBottom: 16, alignItems: 'flex-start',
  },
  infoText: { flex: 1, fontSize: 13, lineHeight: 19 },

  // Buttons
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingVertical: 14, paddingHorizontal: 24, borderRadius: 14,
    marginBottom: 10, width: '100%', maxWidth: 340,
  },
  btnOutline: { borderWidth: 1, backgroundColor: 'transparent' },
  btnText: { fontSize: 15, fontWeight: '600' },

  bgNote: { fontSize: 12, textAlign: 'center', opacity: 0.6, marginTop: -4, marginBottom: 4 },

  // Shimmer dots
  dots: { flexDirection: 'row', gap: 6, marginTop: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});

export default ConversionScreen;
