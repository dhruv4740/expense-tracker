// ─── TrendChart — Daily / weekly spend trend line ────────────────────────────
//
// Wraps gifted-charts LineChart in area/curved mode with dark styling.
// Shows EmptyState when there is no data or all values are zero.

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { theme } from '../../theme';
import EmptyState from '../EmptyState';

export interface TrendPoint {
  value: number;
  label?: string;
  /** Preformatted date shown in the tap tooltip, e.g. "12 Jul". Falls back to `label`. */
  date?: string;
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
        pointerConfig={{
          pointerStripHeight: height,
          pointerStripColor: theme.colors.border,
          pointerStripWidth: 1,
          pointerColor: color,
          radius: 5,
          activatePointersOnLongPress: false,
          autoAdjustPointerLabelPosition: true,
          pointerLabelWidth: 100,
          pointerLabelHeight: 40,
          pointerLabelComponent: (items: TrendPoint[]) => {
            const point = items[0];
            return (
              <View style={styles.tooltip}>
                <Text style={styles.tooltipDate}>{point?.date ?? point?.label ?? ''}</Text>
                <Text style={styles.tooltipValue}>
                  ₹{Math.round(point?.value ?? 0).toLocaleString('en-IN')}
                </Text>
              </View>
            );
          },
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  tooltip: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    alignItems: 'center',
  },
  tooltipDate: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  tooltipValue: {
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
  },
});

export default TrendChart;
