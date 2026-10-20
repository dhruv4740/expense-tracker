// ─── InsightsScreen ──────────────────────────────────────────────────────────
//
// Insights tab: range selector, category donut + legend, trend chart, debit vs
// credit bars, top merchants, and frequent merchants (>=3 txns in range).
//
// Reload triggers: useFocusEffect + DeviceEventEmitter DATA_CHANGED.

import React, { useCallback, useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import {
  getSummary,
  getTopMerchants,
  getRecurring,
} from '../db';
import type { Summary, RecurringEntry } from '../db';
import { CATEGORY_META, CATEGORIES, GROUP_META, GROUPS, groupOf } from '../categories';
import type { Category, CategoryGroup } from '../categories';
import { DATA_CHANGED } from '../sync';
import {
  AmountText,
  BarsChart,
  Card,
  CategoryChip,
  Donut,
  EmptyState,
  SectionHeader,
  TrendChart,
} from '../components';
import { theme } from '../theme';
import { displayMerchant } from '../merchantDisplay';
import {
  monthRange,
  prevMonthRange,
  last3MonthsRange,
  localDayIndexToDate,
  completedDays,
  formatDayLabel,
} from '../dates';
import type { Range } from '../db';

// ─── Types ────────────────────────────────────────────────────────────────────

type RangeKey = 'month' | 'lastmonth' | '3months';

const RANGE_OPTIONS: { label: string; value: RangeKey }[] = [
  { label: 'This month', value: 'month' },
  { label: 'Last month', value: 'lastmonth' },
  { label: 'Last 3 months', value: '3months' },
];

function getRange(key: RangeKey): Range {
  switch (key) {
    case 'month':
      return monthRange();
    case 'lastmonth':
      return prevMonthRange();
    case '3months':
      return last3MonthsRange();
  }
}

interface InsightData {
  summary: Summary;
  topMerchants: { merchant: string; total: number; count: number }[];
  frequent: { merchant: string; total: number; count: number }[];
  recurring: RecurringEntry[];
}

function loadData(rangeKey: RangeKey): InsightData {
  const range = getRange(rangeKey);
  const summary = getSummary(range);
  const topMerchants = getTopMerchants(range, 10);

  // Frequent merchants: >=3 transactions in range (derived from topMerchants data)
  const frequent = topMerchants.filter(m => m.count >= 3);

  // Recurring: use last-3-months range for better detection regardless of current selector
  const recurringRange = rangeKey === '3months' ? range : getRange('3months');
  const recurring = getRecurring(recurringRange, 2);

  return { summary, topMerchants: topMerchants.slice(0, 5), frequent, recurring };
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function InsightsScreen() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('month');
  const [data, setData] = useState<InsightData>(() => loadData('month'));

  // View-only category exclude toggle (6d) — non-persistent, screen-local.
  const [excluded, setExcluded] = useState<Set<Category>>(new Set());

  // Group donut drill-down: null shows all groups; set shows that group's
  // categories. Reset whenever the range changes so a stale drill doesn't
  // silently apply to different data.
  const [drillGroup, setDrillGroup] = useState<CategoryGroup | null>(null);
  const toggleExcluded = useCallback((cat: Category) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }, []);

  const reload = useCallback((key: RangeKey) => {
    setData(loadData(key));
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload(rangeKey);
    }, [reload, rangeKey]),
  );

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, () =>
      reload(rangeKey),
    );
    return () => sub.remove();
  }, [reload, rangeKey]);

  function handleRangeChange(key: RangeKey) {
    setRangeKey(key);
    setDrillGroup(null);
    reload(key);
  }

  const { summary, topMerchants, frequent, recurring } = data;

  // ── Category exclude toggle (6d) ────────────────────────────────────────────
  const excludedTotal = summary.byCategory
    .filter(bc => excluded.has(bc.category as Category))
    .reduce((sum, bc) => sum + bc.total, 0);
  const displayedSpent = summary.spent - excludedTotal;

  // ── Group totals (for the top-level group donut) ───────────────────────────
  const groupTotals = new Map<CategoryGroup, number>();
  for (const bc of summary.byCategory) {
    if (bc.total <= 0) {
      continue;
    }
    const g = groupOf(bc.category);
    groupTotals.set(g, (groupTotals.get(g) ?? 0) + bc.total);
  }
  const groupData = GROUPS
    .filter(g => (groupTotals.get(g) ?? 0) > 0)
    .map(g => ({ group: g, total: groupTotals.get(g) as number }));

  // ── Donut data — group level, or drilled into one group's categories ───────
  const donutData = drillGroup == null
    ? groupData.map(g => ({
        value: g.total,
        color: GROUP_META[g.group].color,
        label: g.group,
      }))
    : summary.byCategory
        .filter(
          bc =>
            bc.total > 0 &&
            groupOf(bc.category) === drillGroup &&
            !excluded.has(bc.category as Category),
        )
        .sort((a, b) => b.total - a.total)
        .map(bc => ({
          value: bc.total,
          color: (CATEGORIES as string[]).includes(bc.category)
            ? CATEGORY_META[bc.category as Category].color
            : '#78909C',
          label: bc.category,
        }));

  const donutCenterTotal = drillGroup == null
    ? displayedSpent
    : summary.byCategory
        .filter(bc => groupOf(bc.category) === drillGroup && !excluded.has(bc.category as Category))
        .reduce((sum, bc) => sum + bc.total, 0);
  const donutCenterFormatted = donutCenterTotal.toLocaleString('en-IN', {
    maximumFractionDigits: 0,
  });

  // ── Trend data ──────────────────────────────────────────────────────────────
  const trendData = summary.byDay.map(bd => ({
    value: bd.total,
    label: String(localDayIndexToDate(bd.day).getDate()),
    date: formatDayLabel(localDayIndexToDate(bd.day).getTime()),
  }));

  // ── Debit vs Credit bars ────────────────────────────────────────────────────
  const barsData = [
    { label: 'Debit', value: displayedSpent, color: theme.colors.debit },
    { label: 'Credit', value: summary.received, color: theme.colors.credit },
  ];

  // ── Per-day spend (6c) — "Last month" counts every day; the current month
  // counts only completed days. ─────────────────────────────────────────────
  const rangeCompletedDays = completedDays(getRange(rangeKey));
  const perDayFormatted =
    rangeCompletedDays > 0
      ? `₹${Math.round(displayedSpent / rangeCompletedDays).toLocaleString('en-IN')}/day`
      : '—';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Range selector ── */}
      <View style={styles.segmentRow}>
        {RANGE_OPTIONS.map(opt => (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.segment,
              rangeKey === opt.value ? styles.segmentActive : undefined,
            ]}
            onPress={() => handleRangeChange(opt.value)}
          >
            <Text
              style={[
                styles.segmentText,
                rangeKey === opt.value ? styles.segmentTextActive : undefined,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Category donut + legend ── */}
      <SectionHeader title="By Category" />
      <Card style={styles.donutCard}>
        <Donut
          data={donutData}
          centerValue={`₹${donutCenterFormatted}`}
          centerLabel={drillGroup ?? 'spent'}
          size={180}
        />
        {drillGroup != null && (
          <TouchableOpacity
            style={styles.backLink}
            onPress={() => setDrillGroup(null)}
            activeOpacity={0.6}
          >
            <Text style={styles.backLinkText}>‹ All groups</Text>
          </TouchableOpacity>
        )}
        {drillGroup == null ? (
          // Tap a group to drill into its categories.
          groupData.length > 0 && (
            <View style={styles.legend}>
              {groupData.map(g => (
                <TouchableOpacity
                  key={g.group}
                  style={styles.legendItem}
                  onPress={() => setDrillGroup(g.group)}
                  activeOpacity={0.6}
                >
                  <View style={styles.legendGroupLeft}>
                    <View style={[styles.groupDot, { backgroundColor: GROUP_META[g.group].color }]} />
                    <Text style={styles.legendGroupLabel}>{g.group}</Text>
                  </View>
                  <Text style={styles.legendAmt}>
                    ₹{g.total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )
        ) : (
          // Tap a category to hide it from total/donut/per-day (6d).
          summary.byCategory.filter(bc => bc.total > 0 && groupOf(bc.category) === drillGroup).length > 0 && (
            <View style={styles.legend}>
              {summary.byCategory
                .filter(bc => bc.total > 0 && groupOf(bc.category) === drillGroup)
                .map(bc => {
                  const isExcluded = excluded.has(bc.category as Category);
                  return (
                    <TouchableOpacity
                      key={bc.category}
                      style={[styles.legendItem, isExcluded && styles.legendItemExcluded]}
                      onPress={() => toggleExcluded(bc.category as Category)}
                      activeOpacity={0.6}
                    >
                      <CategoryChip category={bc.category} small />
                      <Text style={[styles.legendAmt, isExcluded && styles.legendTextExcluded]}>
                        ₹{bc.total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
            </View>
          )
        )}
        {excluded.size > 0 && (
          <Text style={styles.excludingCaption}>
            excluding {Array.from(excluded).join(', ')}
          </Text>
        )}
        {summary.invested > 0 && (
          <Text style={styles.investedCaption}>
            Invested: ₹{summary.invested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            {' '}(not counted as spend)
          </Text>
        )}
      </Card>

      {/* ── Spend trend ── */}
      <SectionHeader title="Daily Spend Trend" />
      <Card>
        <TrendChart data={trendData} color={theme.colors.accent} height={160} />
        <Text style={styles.perDayCaption}>{perDayFormatted}</Text>
      </Card>

      {/* ── Debit vs Credit ── */}
      <SectionHeader title="Debit vs Credit" />
      <Card>
        <BarsChart data={barsData} height={160} />
      </Card>

      {/* ── Top merchants ── */}
      <SectionHeader title="Top Merchants" />
      <Card>
        {topMerchants.length === 0 ? (
          <EmptyState icon="wallet" title="No merchants" />
        ) : (
          topMerchants.map((m, i) => (
            <View key={`${m.merchant}-${i}`} style={styles.merchantRow}>
              <View style={styles.merchantIdx}>
                <Text style={styles.merchantIdxText}>{i + 1}</Text>
              </View>
              <Text style={styles.merchantName} numberOfLines={1}>
                {displayMerchant(m.merchant)}
              </Text>
              <View style={styles.merchantRight}>
                <Text style={styles.merchantCount}>{m.count} txn</Text>
                <AmountText
                  amount={m.total}
                  type="expense"
                  size={theme.font.size.sm}
                />
              </View>
            </View>
          ))
        )}
      </Card>

      {/* ── Frequent merchants ── */}
      {frequent.length > 0 && (
        <>
          <SectionHeader title="Frequent Merchants (≥3)" />
          <Card>
            {frequent.map((m, i) => (
              <View key={`freq-${m.merchant}-${i}`} style={styles.merchantRow}>
                <Text style={styles.merchantName} numberOfLines={1}>
                  {displayMerchant(m.merchant)}
                </Text>
                <View style={styles.merchantRight}>
                  <Text style={styles.merchantCount}>{m.count} txn</Text>
                  <AmountText
                    amount={m.total}
                    type="expense"
                    size={theme.font.size.sm}
                  />
                </View>
              </View>
            ))}
          </Card>
        </>
      )}

      {/* ── Recurring & subscriptions ── */}
      {recurring.length > 0 && (
        <>
          <SectionHeader title="Recurring & Subscriptions" />
          <Card>
            {recurring.map((r, i) => (
              <View key={`rec-${r.merchant}-${i}`} style={styles.merchantRow}>
                <View style={styles.recurringTag}>
                  <Text style={styles.recurringTagText}>↺</Text>
                </View>
                <Text style={styles.merchantName} numberOfLines={1}>
                  {displayMerchant(r.merchant)}
                </Text>
                <View style={styles.merchantRight}>
                  <Text style={styles.merchantCount}>
                    {r.count}× · ~{r.avgIntervalDays}d
                  </Text>
                  <AmountText
                    amount={r.amount}
                    type="expense"
                    size={theme.font.size.sm}
                  />
                </View>
              </View>
            ))}
          </Card>
        </>
      )}

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  content: {
    paddingBottom: theme.spacing.xxl,
  },
  segmentRow: {
    flexDirection: 'row',
    margin: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: theme.colors.accent + '33',
  },
  segmentText: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    fontWeight: theme.font.weight.medium,
  },
  segmentTextActive: {
    color: theme.colors.accent,
  },
  donutCard: {
    alignItems: 'center',
    paddingVertical: theme.spacing.lg,
  },
  legend: {
    width: '100%',
    marginTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  legendGroupLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  groupDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendGroupLabel: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textPrimary,
  },
  backLink: {
    marginTop: theme.spacing.sm,
  },
  backLinkText: {
    fontSize: theme.font.size.sm,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
  },
  legendAmt: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
  },
  legendItemExcluded: {
    opacity: 0.4,
  },
  legendTextExcluded: {
    textDecorationLine: 'line-through',
  },
  excludingCaption: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  investedCaption: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
  perDayCaption: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing.sm,
  },
  merchantIdx: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  merchantIdxText: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    fontWeight: theme.font.weight.bold,
  },
  merchantName: {
    flex: 1,
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
  },
  merchantRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  merchantCount: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  recurringTag: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.accent + '22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recurringTagText: {
    fontSize: 12,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.bold,
  },
  bottomPad: {
    height: theme.spacing.xxl,
  },
});
