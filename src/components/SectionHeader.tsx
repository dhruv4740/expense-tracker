// ─── SectionHeader — Uppercase muted small-caps section divider ───────────────

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export interface SectionHeaderProps {
  /** The header text — rendered uppercased. */
  title: string;
  /** Optional right-side element (e.g. a "See all" link or action button). */
  right?: React.ReactNode;
}

/**
 * Lightweight section title row. The title is forced to uppercase so callers
 * can pass natural-case strings and still get consistent small-caps appearance.
 */
const SectionHeader = React.memo(function SectionHeader({
  title,
  right,
}: SectionHeaderProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title.toUpperCase()}</Text>
      {right != null && <View>{right}</View>}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    paddingBottom: theme.spacing.sm,
  },
  title: {
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textMuted,
    letterSpacing: 1.2,
  },
});

export default SectionHeader;
