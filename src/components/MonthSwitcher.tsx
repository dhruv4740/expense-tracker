// ‹ October 2026 › — shared by Dashboard and Uber. `offset` 0 = this month,
// -1 = last month, etc. Never goes into the future.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { theme } from '../theme';

export interface MonthSwitcherProps {
  offset: number;
  onChange: (offset: number) => void;
}

/** Date inside the month `offset` months from now (day 1, so no overflow). */
export function monthRef(offset: number): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
}

export default function MonthSwitcher({ offset, onChange }: MonthSwitcherProps) {
  const label = monthRef(offset).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return (
    <View style={styles.row}>
      <TouchableOpacity hitSlop={12} onPress={() => onChange(offset - 1)}>
        <Text style={styles.arrow}>‹</Text>
      </TouchableOpacity>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity hitSlop={12} disabled={offset >= 0} onPress={() => onChange(offset + 1)}>
        <Text style={[styles.arrow, offset >= 0 && styles.off]}>›</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
  },
  arrow: { color: theme.colors.accent, fontSize: 28, paddingHorizontal: theme.spacing.sm },
  off: { opacity: 0.2 },
});
