// ─── ProgressBar — Budget / usage progress indicator ─────────────────────────
//
// Clamps fill 0..max. When value > max the bar caps at 100% and switches to
// danger colour to signal over-budget status.

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { theme } from '../theme';

export interface ProgressBarProps {
  /** Current value (may exceed max). */
  value: number;
  /** Maximum value that represents 100% fill. */
  max: number;
  /** Fill colour (defaults to theme.colors.accent). */
  color?: string;
  /** Track height in dp (default 6). */
  height?: number;
}

/**
 * Animated-free progress bar suitable for budget tracking rows.
 * Over-budget state (value > max) renders a capped full bar in danger red.
 */
const ProgressBar = React.memo(function ProgressBar({
  value,
  max,
  color = theme.colors.accent,
  height = 6,
}: ProgressBarProps) {
  const isOverBudget = max > 0 && value > max;
  const ratio = useMemo(() => {
    if (max <= 0) { return 0; }
    return Math.min(value / max, 1);
  }, [value, max]);

  const fillColor = isOverBudget ? theme.colors.danger : color;

  return (
    <View
      style={[styles.track, { height, borderRadius: height / 2 }]}
    >
      <View
        style={[
          styles.fill,
          {
            width: `${(ratio * 100).toFixed(1)}%` as `${number}%`,
            height,
            borderRadius: height / 2,
            backgroundColor: fillColor,
          },
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  track: {
    width: '100%',
    backgroundColor: theme.colors.surfaceAlt,
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});

export default ProgressBar;
