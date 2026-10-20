// ─── Donut — Category / summary donut chart ──────────────────────────────────
//
// Wraps gifted-charts PieChart in donut mode. Shows a centre label overlay.
// Renders an EmptyState placeholder when data is empty or all values are zero.

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PieChart } from 'react-native-gifted-charts';
import { theme } from '../../theme';
import EmptyState from '../EmptyState';

export interface DonutSlice {
  value: number;
  color: string;
  label?: string;
}

export interface DonutProps {
  data: DonutSlice[];
  /** Text shown in the donut centre (e.g. total formatted amount). */
  centerValue?: string;
  /** Sub-label below the centre value. */
  centerLabel?: string;
  /** Outer diameter of the donut in dp (default 180). */
  size?: number;
}

/**
 * Donut chart drawn on the Card surface colour (not the screen background) with an optional centre overlay.
 * Falls back to EmptyState when there is no data to display.
 */
const Donut = React.memo(function Donut({
  data,
  centerValue,
  centerLabel,
  size = 180,
}: DonutProps) {
  const total = useMemo(
    () => data.reduce((acc, d) => acc + d.value, 0),
    [data],
  );

  if (data.length === 0 || total === 0) {
    return (
      <EmptyState
        icon="stats"
        title="No data yet"
        subtitle="Transactions will appear here once captured."
      />
    );
  }

  const radius = size / 2;
  const innerRadius = radius * 0.58;

  return (
    <View style={styles.container}>
      <PieChart
        data={data}
        donut
        radius={radius}
        innerRadius={innerRadius}
        backgroundColor="transparent"
        strokeColor={theme.colors.surface}
        strokeWidth={2}
        innerCircleColor={theme.colors.surface}
        centerLabelComponent={() => (
          <View style={styles.centre}>
            {centerValue != null && (
              <Text style={styles.centreValue} numberOfLines={1}>
                {centerValue}
              </Text>
            )}
            {centerLabel != null && (
              <Text style={styles.centreLabel} numberOfLines={1}>
                {centerLabel}
              </Text>
            )}
          </View>
        )}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centreValue: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
  },
  centreLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
});

export default Donut;
