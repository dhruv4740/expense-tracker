// ─── Card — Rounded surface container ────────────────────────────────────────

import React from 'react';
import { StyleSheet, View, type ViewStyle, type StyleProp } from 'react-native';
import { theme } from '../theme';

export interface CardProps {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * Opaque rounded surface that lifts content off the true-black background.
 * Use as a wrapper for any grouped content block.
 */
const Card = React.memo(function Card({ style, children }: CardProps) {
  return <View style={[styles.card, style]}>{children}</View>;
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
});

export default Card;
