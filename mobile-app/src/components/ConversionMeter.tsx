/**
 * ConversionMeter
 * ───────────────
 * Subtle "X of Y conversion credits used" indicator.
 *
 * Shown on UploadScreen so the user feels the credit limit approaching
 * organically before they hit it.  Renders nothing for unlimited
 * (Pro/Lifetime) plans — they don't need a meter that always shows "∞".
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

interface Props {
  used: number;
  remaining: number | null;  // null = unlimited
  /** Optional label override; defaults to "conversion credits used" */
  label?: string;
}

const ConversionMeter: React.FC<Props> = ({ used, remaining, label }) => {
  const { theme } = useTheme();

  // Unlimited plan → nothing to display.
  if (remaining === null) return null;

  const total = used + remaining;
  const fraction = total > 0 ? Math.min(1, used / total) : 0;
  const isExhausted = remaining === 0;
  const isLow = remaining > 0 && remaining <= Math.max(1, Math.floor(total * 0.2));

  const accent = isExhausted ? theme.error : isLow ? theme.warning : theme.primary;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${used} of ${total} ${label ?? 'conversion credits used'}`}
    >
      <View style={styles.row}>
        <Ionicons
          name={isExhausted ? 'lock-closed-outline' : 'flash-outline'}
          size={14}
          color={accent}
        />
        <Text style={[styles.label, { color: theme.textSecondary }]}>
          {used} of {total} {label ?? 'conversion credits used'}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: theme.border }]}>
        <View style={[styles.fill, { width: `${fraction * 100}%`, backgroundColor: accent }]} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
  },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});

export default ConversionMeter;
