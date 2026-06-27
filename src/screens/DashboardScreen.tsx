// ─── DashboardScreen ─────────────────────────────────────────────────────────
//
// Home tab: current-month summary hero, spend trend, category donut, budgets,
// and quick insights (top merchant + biggest expense).
//
// Reload triggers: useFocusEffect + DeviceEventEmitter DATA_CHANGED.

import React, { useCallback, useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
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
  Donut,
  ProgressBar,
  SectionHeader,
  TrendChart,
} from '../components';
import { theme } from '../theme';
import { monthRange } from '../dates';
import { computeBudgetStatus } from '../budgets';
import type { BudgetStatus } from '../budgets';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardData {
  summary: Summary;
  topMerchant: { merchant: string; total: number; count: number } | null;
  biggestExpense: TransactionRow | null;
  budgetStatus: BudgetStatus;
}

// ─── Data loader ──────────────────────────────────────────────────────────────

function loadData(): DashboardData {
  const range = monthRange();
  const summary = getSummary(range);

  const topMerchants = getTopMerchants(range, 1);
  const topMerchant = topMerchants[0] ?? null;

  const expenses = queryTransactions({ from: range.from, to: range.to, types: ['expense'] });
  const biggestExpense =
    expenses.length > 0
      ? expenses.reduce((max, tx) => (tx.amount > max.amount ? tx : max), expenses[0])
      : null;

  const budgetStatus = computeBudgetStatus();

  return { summary, topMerchant, biggestExpense, budgetStatus };
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const [data, setData] = useState<DashboardData>(() => loadData());

  const reload = useCallback(() => {
    setData(loadData());
  }, []);

  useFocusEffect(reload);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, reload);
    return () => sub.remove();
  }, [reload]);

  const { summary, topMerchant, biggestExpense, budgetStatus } = data;

  // ── Donut data ──────────────────────────────────────────────────────────────
  const donutData = summary.byCategory
    .filter(bc => bc.total > 0)
    .map(bc => ({
      value: bc.total,
      color: (CATEGORIES as string[]).includes(bc.category)
        ? CATEGORY_META[bc.category as Category].color
        : '#78909C',
      label: bc.category,
    }));

  const totalSpentFormatted = summary.spent.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  // ── Trend data ──────────────────────────────────────────────────────────────
  const trendData = summary.byDay.map(bd => ({
    value: bd.total,
    label: String(new Date(bd.day * 86_400_000).getDate()),
  }));

  // ── Over-budget check ───────────────────────────────────────────────────────
  const overallOver =
    budgetStatus.overall != null &&
    budgetStatus.overall.spent > budgetStatus.overall.limit;
  const anyOver =
    overallOver ||
    budgetStatus.categories.some(c => c.spent > c.limit);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Hero card ── */}
      <Card style={styles.heroCard}>
        <Text style={styles.heroTitle}>This Month</Text>
        <View style={styles.heroRow}>
          <View style={styles.heroItem}>
            <Text style={styles.heroLabel}>Spent</Text>
            <AmountText amount={summary.spent} type="expense" size={theme.font.size.xl} />
          </View>
          <View style={styles.heroSep} />
          <View style={styles.heroItem}>
            <Text style={styles.heroLabel}>Received</Text>
            <AmountText amount={summary.received} type="income" size={theme.font.size.xl} />
          </View>
          <View style={styles.heroSep} />
          <View style={styles.heroItem}>
            <Text style={styles.heroLabel}>Net</Text>
            <AmountText
              amount={Math.abs(summary.net)}
              type={summary.net >= 0 ? 'income' : 'expense'}
              size={theme.font.size.xl}
            />
          </View>
        </View>
      </Card>

      {/* ── Spend trend ── */}
      <SectionHeader title="Daily Spend" />
      <Card>
        <TrendChart data={trendData} color={theme.colors.accent} height={160} />
      </Card>

      {/* ── Category donut ── */}
      <SectionHeader title="By Category" />
      <Card style={styles.donutCard}>
        <Donut
          data={donutData}
          centerValue={`₹${totalSpentFormatted}`}
          centerLabel="spent"
          size={200}
        />
        {/* Legend */}
        {donutData.length > 0 && (
          <View style={styles.legend}>
            {donutData.map(slice => (
              <View key={slice.label} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: slice.color }]} />
                <Text style={styles.legendLabel} numberOfLines={1}>
                  {slice.label}
                </Text>
                <Text style={styles.legendAmount}>
                  ₹{slice.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* ── Budget section ── */}
      {(budgetStatus.overall != null || budgetStatus.categories.length > 0) && (
        <>
          <SectionHeader title="Budgets" />
          {anyOver && (
            <View style={styles.warningBanner}>
              <Text style={styles.warningText}>
                {overallOver ? 'Overall budget exceeded!' : 'Some categories are over budget!'}
              </Text>
            </View>
          )}
          <Card>
            {budgetStatus.overall != null && (
              <View style={styles.budgetRow}>
                <View style={styles.budgetHeader}>
                  <Text style={styles.budgetLabel}>Overall</Text>
                  <Text
                    style={[
                      styles.budgetAmt,
                      overallOver ? styles.overBudget : undefined,
                    ]}
                  >
                    ₹{budgetStatus.overall.spent.toLocaleString('en-IN', { maximumFractionDigits: 0 })} / ₹{budgetStatus.overall.limit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </Text>
                </View>
                <ProgressBar
                  value={budgetStatus.overall.spent}
                  max={budgetStatus.overall.limit}
                  color={overallOver ? theme.colors.danger : theme.colors.accent}
                  height={8}
                />
              </View>
            )}
            {budgetStatus.categories.map(cb => {
              const isOver = cb.spent > cb.limit;
              return (
                <View key={cb.category} style={styles.budgetRow}>
                  <View style={styles.budgetHeader}>
                    <Text style={styles.budgetLabel}>{cb.category}</Text>
                    <Text style={[styles.budgetAmt, isOver ? styles.overBudget : undefined]}>
                      ₹{cb.spent.toLocaleString('en-IN', { maximumFractionDigits: 0 })} / ₹{cb.limit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </Text>
                  </View>
                  <ProgressBar
                    value={cb.spent}
                    max={cb.limit}
                    color={
                      isOver
                        ? theme.colors.danger
                        : (CATEGORIES as string[]).includes(cb.category)
                        ? CATEGORY_META[cb.category as Category].color
                        : theme.colors.accent
                    }
                    height={6}
                  />
                </View>
              );
            })}
          </Card>
        </>
      )}

      {/* ── Quick insights ── */}
      <SectionHeader title="Quick Insights" />
      <Card>
        <View style={styles.insightRow}>
          <View style={styles.insightItem}>
            <Text style={styles.insightLabel}>Top Merchant</Text>
            <Text style={styles.insightValue} numberOfLines={1}>
              {topMerchant != null ? topMerchant.merchant : '—'}
            </Text>
            {topMerchant != null && (
              <Text style={styles.insightSub}>
                {topMerchant.count} txn · ₹{topMerchant.total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </Text>
            )}
          </View>
          <View style={styles.insightDivider} />
          <View style={styles.insightItem}>
            <Text style={styles.insightLabel}>Biggest Expense</Text>
            {biggestExpense != null ? (
              <>
                <Text style={styles.insightValue} numberOfLines={1}>
                  {biggestExpense.merchant ?? biggestExpense.source ?? 'Unknown'}
                </Text>
                <AmountText
                  amount={biggestExpense.amount}
                  type="expense"
                  size={theme.font.size.sm}
                />
              </>
            ) : (
              <Text style={styles.insightValue}>—</Text>
            )}
          </View>
        </View>
      </Card>

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
  heroCard: {
    margin: theme.spacing.lg,
    marginBottom: 0,
    padding: theme.spacing.lg,
  },
  heroTitle: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    fontWeight: theme.font.weight.medium,
    marginBottom: theme.spacing.md,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  heroItem: {
    flex: 1,
    alignItems: 'center',
  },
  heroLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  },
  heroSep: {
    width: 1,
    height: 40,
    backgroundColor: theme.colors.border,
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
    gap: theme.spacing.sm,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    flex: 1,
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
  },
  legendAmount: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
  },
  warningBanner: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.warning + '22',
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warning,
    padding: theme.spacing.md,
    borderRadius: theme.radius.sm,
  },
  warningText: {
    color: theme.colors.warning,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.medium,
  },
  budgetRow: {
    marginBottom: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  budgetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  budgetLabel: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
  },
  budgetAmt: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  overBudget: {
    color: theme.colors.danger,
  },
  insightRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  insightItem: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  insightDivider: {
    width: 1,
    height: 60,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing.md,
  },
  insightLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    fontWeight: theme.font.weight.medium,
  },
  insightValue: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.semibold,
  },
  insightSub: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  bottomPad: {
    height: theme.spacing.xxl,
  },
});
