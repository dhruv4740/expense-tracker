// ─── BarsChart — Category / period comparison bar chart ──────────────────────
//
// Wraps gifted-charts BarChart with dark theme and per-bar colour support.
// Shows EmptyState when data is empty or all values are zero.

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { BarChart } from 'react-native-gifted-charts';
import { theme } from '../../theme';
import EmptyState from '../EmptyState';

export interface BarItem {
  label: string;
  value: number;
  /** Bar fill colour (defaults to theme.colors.accent). */
  color?: string;
}

export interface BarsChartProps {
  data: BarItem[];
  /** Chart height in dp (default 180). */
  height?: number;
}

/**
 * Bar chart for comparing category totals or period-over-period spend.
 * Each bar can carry its own colour; falls back to accent for uncoloured bars.
 */
const BarsChart = React.memo(function BarsChart({
  data,
  height = 180,
}: BarsChartProps) {
  const hasData = useMemo(
    () => data.length > 0 && data.some(d => d.value > 0),
    [data],
  );

  if (!hasData) {
    return (
      <EmptyState
        icon="stats"
        title="No comparison data"
        subtitle="Category totals will appear here once transactions are captured."
      />
    );
  }

  const chartData = useMemo(
    () =>
      data.map(item => ({
        value: item.value,
        label: item.label,
        frontColor: item.color ?? theme.colors.accent,
        topLabelComponent: undefined,
      })),
    [data],
  );

  return (
    <View style={styles.container}>
      <BarChart
        data={chartData}
        height={height}
        barBorderRadius={theme.radius.sm}
        backgroundColor={theme.colors.bg}
        rulesColor={theme.colors.border}
        rulesType="solid"
        yAxisColor="transparent"
        xAxisColor={theme.colors.border}
        xAxisLabelTextStyle={{
          color: theme.colors.textMuted,
          fontSize: theme.font.size.xs,
        }}
        yAxisTextStyle={{
          color: theme.colors.textMuted,
          fontSize: theme.font.size.xs,
        }}
        noOfSections={4}
        hideYAxisText
        isAnimated
        adjustToWidth
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});

export default BarsChart;
