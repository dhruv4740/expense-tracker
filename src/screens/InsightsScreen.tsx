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
  queryTransactions,
} from '../db';
import type { Summary, TransactionRow } from '../db';
import { CATEGORY_META, CATEGORIES } from '../categories';
import type { Category } from '../categories';
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
import {
  monthRange,
  prevMonthRange,
  last3MonthsRange,
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
}

function loadData(rangeKey: RangeKey): InsightData {
  const range = getRange(rangeKey);
  const summary = getSummary(range);
  const topMerchants = getTopMerchants(range, 10);

  // Frequent merchants: >=3 transactions in range (derived from topMerchants data)
  const frequent = topMerchants.filter(m => m.count >= 3);

  return { summary, topMerchants: topMerchants.slice(0, 5), frequent };
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function InsightsScreen() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('month');
  const [data, setData] = useState<InsightData>(() => loadData('month'));

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
    reload(key);
  }

  const { summary, topMerchants, frequent } = data;

  // ── Donut data ──────────────────────────────────────────────────────────────
  const donutData = summary.byCategory
    .filter(bc => bc.total > 0)
    .sort((a, b) => b.total - a.total)
    .map(bc => ({
      value: bc.total,
      color: (CATEGORIES as string[]).includes(bc.category)
        ? CATEGORY_META[bc.category as Category].color
        : '#78909C',
      label: bc.category,
    }));

  // ── Trend data ──────────────────────────────────────────────────────────────
  const trendData = summary.byDay.map(bd => ({
    value: bd.total,
    label: String(new Date(bd.day * 86_400_000).getDate()),
  }));

  // ── Debit vs Credit bars ────────────────────────────────────────────────────
  const barsData = [
    { label: 'Debit', value: summary.spent, color: theme.colors.debit },
    { label: 'Credit', value: summary.received, color: theme.colors.credit },
  ];

  const totalSpentFormatted = summary.spent.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

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
          centerValue={`₹${totalSpentFormatted}`}
          centerLabel="spent"
          size={180}
        />
        {donutData.length > 0 && (
          <View style={styles.legend}>
            {donutData.map(slice => (
              <View key={slice.label} style={styles.legendItem}>
                <CategoryChip category={slice.label} small />
                <Text style={styles.legendAmt}>
                  ₹{slice.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* ── Spend trend ── */}
      <SectionHeader title="Daily Spend Trend" />
      <Card>
        <TrendChart data={trendData} color={theme.colors.accent} height={160} />
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
                {m.merchant}
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
                  {m.merchant}
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
  legendAmt: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
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
  bottomPad: {
    height: theme.spacing.xxl,
  },
});
