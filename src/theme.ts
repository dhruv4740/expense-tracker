// ─── Theme — TRUE-BLACK AMOLED dark theme ────────────────────────────────────
//
// Single source of truth for colours, spacing, radius, and typography used
// across all screens and components. Import `theme` and `navTheme` here; do
// NOT hard-code raw hex strings in component files.

import { DarkTheme } from '@react-navigation/native';

// ─── Colour palette ──────────────────────────────────────────────────────────

const colors = {
  /** True black — AMOLED pixel-off background. */
  bg: '#000000',
  /** Slightly lifted surface for cards / list rows. */
  surface: '#0E0E0E',
  /** Alternative surface for nested containers / input backgrounds. */
  surfaceAlt: '#161616',
  /** Subtle hairline dividers. */
  border: '#222222',

  textPrimary: '#FFFFFF',
  textSecondary: '#B5B5B5',
  textMuted: '#6E6E6E',

  /** Emerald-green accent — brand colour. */
  accent: '#3DDC84',

  /** Debit / expense amounts. */
  debit: '#FF5C5C',
  /** Credit / income amounts. */
  credit: '#3DDC84',
  /** Self-transfer amounts. */
  self: '#7AA2FF',

  danger: '#FF5C5C',
  warning: '#FFB020',
  success: '#3DDC84',
} as const;

// ─── Spacing scale (px) ──────────────────────────────────────────────────────

const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

// ─── Border-radius scale ──────────────────────────────────────────────────────

const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

// ─── Typography ───────────────────────────────────────────────────────────────

const font = {
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 18,
    xl: 24,
    xxl: 34,
  },
  /**
   * Convenience weight constants. React Native accepts these as `fontWeight`
   * string literals; type them explicitly so strict mode is happy.
   */
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
} as const;

// ─── Composed theme object ────────────────────────────────────────────────────

export const theme = {
  colors,
  spacing,
  radius,
  font,
} as const;

export type Theme = typeof theme;

// ─── React Navigation dark theme ──────────────────────────────────────────────
//
// Extends the library's built-in DarkTheme so NavigationContainer never emits
// white flashes between screens.

export const navTheme: typeof DarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bg,
    text: colors.textPrimary,
    border: colors.border,
    primary: colors.accent,
    notification: colors.accent,
  },
};
