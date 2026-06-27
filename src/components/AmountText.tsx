// ─── AmountText — Formatted currency display ──────────────────────────────────
//
// Renders an INR amount with sign prefix and semantic colour:
//   expense → red  (debit colour)
//   income  → green (credit colour)
//   self    → blue  (self-transfer colour)

import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { theme } from '../theme';

export interface AmountTextProps {
  /** Raw numeric amount (always positive; sign is derived from `type`). */
  amount: number;
  type: 'expense' | 'income' | 'self';
  /** Font size in dp (defaults to theme.font.size.md). */
  size?: number;
  style?: StyleProp<TextStyle>;
}

const SIGN: Record<AmountTextProps['type'], string> = {
  expense: '-',
  income: '+',
  self: '±',
};

const COLOR: Record<AmountTextProps['type'], string> = {
  expense: theme.colors.debit,
  income: theme.colors.credit,
  self: theme.colors.self,
};

/**
 * Displays a ₹-formatted amount with the appropriate sign and colour based on
 * the transaction type. Memoised so list rows stay cheap.
 */
const AmountText = React.memo(function AmountText({
  amount,
  type,
  size = theme.font.size.md,
  style,
}: AmountTextProps) {
  const formatted = amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <Text
      style={[
        {
          fontSize: size,
          fontWeight: theme.font.weight.semibold,
          color: COLOR[type],
        },
        style,
      ]}
    >
      {SIGN[type]}₹{formatted}
    </Text>
  );
});

export default AmountText;
