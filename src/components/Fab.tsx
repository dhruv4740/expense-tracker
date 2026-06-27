// ─── Fab — Floating Action Button ────────────────────────────────────────────
//
// Positioned bottom-right, accent background, circular, with elevation shadow.

import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
import Icon from './Icon';

export interface FabProps {
  /** Icon name (default 'add'). */
  icon?: string;
  /** Press handler. */
  onPress: () => void;
}

/**
 * Floating action button that anchors to the bottom-right corner.
 * Wrap the parent container in `position: 'relative'` or use within a Screen
 * that has `flex: 1` so the absolute positioning resolves correctly.
 */
const Fab = React.memo(function Fab({ icon = 'add', onPress }: FabProps) {
  return (
    <TouchableOpacity
      style={styles.fab}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Floating action button"
    >
      <Icon name={icon} size={26} color="#000000" />
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    bottom: theme.spacing.xl,
    right: theme.spacing.xl,
    width: 56,
    height: 56,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: theme.colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
});

export default Fab;
