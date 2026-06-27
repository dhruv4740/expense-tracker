// ─── EmptyState — Centered empty / zero-data placeholder ─────────────────────

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import Icon from './Icon';

export interface EmptyStateProps {
  /** Icon name (from Icon's PATHS map). Defaults to 'list'. */
  icon?: string;
  /** Primary message shown in a larger weight. */
  title: string;
  /** Optional supporting text below the title. */
  subtitle?: string;
}

/**
 * Centred placeholder for screens or sections with no data yet.
 * Uses muted colours so it recedes behind real content when present.
 */
const EmptyState = React.memo(function EmptyState({
  icon = 'list',
  title,
  subtitle,
}: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <Icon name={icon} size={48} color={theme.colors.textMuted} />
      <Text style={styles.title}>{title}</Text>
      {subtitle != null && (
        <Text style={styles.subtitle}>{subtitle}</Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xxl,
    gap: theme.spacing.sm,
  },
  title: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.medium,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  subtitle: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
});

export default EmptyState;
