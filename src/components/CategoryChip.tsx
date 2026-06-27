// ─── CategoryChip — Category pill with icon and label ────────────────────────
//
// Uses CATEGORY_META to derive the category's colour and icon.
// Applies a low-opacity tinted background on the AMOLED surface.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CATEGORY_META, type Category, CATEGORIES } from '../categories';
import { theme } from '../theme';
import Icon from './Icon';

export interface CategoryChipProps {
  /** Category name (string for flexibility; falls back to 'Other' if unknown). */
  category: string;
  /** Render a smaller variant (reduced padding + text). */
  small?: boolean;
}

/** Hex colour → rgba with given opacity (alpha 0..1). */
function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function resolveMeta(category: string) {
  if ((CATEGORIES as string[]).includes(category)) {
    return CATEGORY_META[category as Category];
  }
  return CATEGORY_META['Other'];
}

/**
 * A pill chip displaying a category icon and its label, tinted with the
 * category's brand colour. Handles unknown category names gracefully.
 */
const CategoryChip = React.memo(function CategoryChip({
  category,
  small = false,
}: CategoryChipProps) {
  const meta = resolveMeta(category);

  const chipStyle = {
    backgroundColor: hexAlpha(meta.color, 0.15),
    borderColor: hexAlpha(meta.color, 0.35),
  };

  const label = (CATEGORIES as string[]).includes(category) ? category : 'Other';

  return (
    <View
      style={[
        styles.chip,
        chipStyle,
        small ? styles.chipSmall : undefined,
      ]}
    >
      <Icon
        name={meta.icon}
        size={small ? 12 : 14}
        color={meta.color}
      />
      <Text
        style={[
          styles.label,
          { color: meta.color },
          small ? styles.labelSmall : undefined,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    gap: 4,
  },
  chipSmall: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  label: {
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.medium,
  },
  labelSmall: {
    fontSize: theme.font.size.xs,
  },
});

export default CategoryChip;
