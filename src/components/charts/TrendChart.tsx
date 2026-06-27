// ─── TrendChart — Daily / weekly spend trend line ────────────────────────────
//
// Wraps gifted-charts LineChart in area/curved mode with dark styling.
// Shows EmptyState when there is no data or all values are zero.

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { theme } from '../../theme';
import EmptyState from '../EmptyState';

export interface TrendPoint {
  value: number;
  label?: string;
}

export interface TrendChartProps {
  data: TrendPoint[];
  /** Line + area colour (default theme.colors.accent). */
  color?: string;
  /** Chart height in dp (default 180). */
  height?: number;
}

/**
 * Curved area line chart for spend trend over time.
 * Minimal clutter: no Y-axis labels, subtle dark gridlines.
 */
const TrendChart = React.memo(function TrendChart({
  data,
  color = theme.colors.accent,
  height = 180,
}: TrendChartProps) {
  const hasData = useMemo(
    () => data.length > 0 && data.some(d => d.value > 0),
    [data],
  );

  if (!hasData) {
    return (
      <EmptyState
        icon="trending-up"
        title="No trend data"
        subtitle="Spend trend will show here once transactions are captured."
      />
    );
  }

  return (
    <View style={styles.container}>
      <LineChart
        data={data}
        height={height}
        curved
        areaChart
        color={color}
        startFillColor={color}
        endFillColor={theme.colors.bg}
        startOpacity={0.35}
        endOpacity={0}
        thickness={2}
        hideDataPoints={data.length > 15}
        dataPointsColor={color}
        dataPointsRadius={3}
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
        adjustToWidth
        isAnimated
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});

export default TrendChart;
