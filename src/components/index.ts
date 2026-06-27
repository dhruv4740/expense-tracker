// ─── Component barrel — single import point for all shared UI primitives ─────
//
// Usage:
//   import { Card, AmountText, CategoryChip, Icon } from '../components';

export { default as Icon } from './Icon';
export type { IconProps } from './Icon';

export { default as Card } from './Card';
export type { CardProps } from './Card';

export { default as AmountText } from './AmountText';
export type { AmountTextProps } from './AmountText';

export { default as CategoryChip } from './CategoryChip';
export type { CategoryChipProps } from './CategoryChip';

export { default as SectionHeader } from './SectionHeader';
export type { SectionHeaderProps } from './SectionHeader';

export { default as EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { default as ProgressBar } from './ProgressBar';
export type { ProgressBarProps } from './ProgressBar';

export { default as Fab } from './Fab';
export type { FabProps } from './Fab';

// ─── Chart wrappers ──────────────────────────────────────────────────────────

export { default as Donut } from './charts/Donut';
export type { DonutProps, DonutSlice } from './charts/Donut';

export { default as TrendChart } from './charts/TrendChart';
export type { TrendChartProps, TrendPoint } from './charts/TrendChart';

export { default as BarsChart } from './charts/BarsChart';
export type { BarsChartProps, BarItem } from './charts/BarsChart';
