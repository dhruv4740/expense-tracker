// ─── DashboardScreen ─────────────────────────────────────────────────────────
//
// Home tab: current-month summary hero, spend trend, category donut, budgets,
// and quick insights (top merchant + biggest expense).
//
// Reload triggers: useFocusEffect + DeviceEventEmitter DATA_CHANGED.

import React, { useCallback, useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { isNotificationAccessGranted, openNotificationAccessSettings } from '../native/NotificationModule';
import {
  getSummary,
  getUberSummary,
  getTopMerchants,
  hasCategoryRows,
  queryTransactions,
  getUncategorizedCount,
} from '../db';
import type { Summary, TransactionRow, UberSummary } from '../db';
import { CATEGORY_META, CATEGORIES } from '../categories';
import type { Category } from '../categories';
import { DATA_CHANGED } from '../sync';
import {
  AmountText,
  Card,
  Donut,
  Icon,
  ProgressBar,
  SectionHeader,
  TrendChart,
} from '../components';
import { theme } from '../theme';
import { monthRange, prevMonthRange, localDayIndexToDate, completedDays, formatDayLabel } from '../dates';
import { computeBudgetStatus } from '../budgets';
import type { BudgetStatus } from '../budgets';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardData {
  summary: Summary;
  prevSummary: Summary;
  topMerchant: { merchant: string; total: number; count: number } | null;
  biggestExpense: TransactionRow | null;
  budgetStatus: BudgetStatus;
  monthLabel: string;
  uncategorizedCount: number;
  /** This-month Uber spend net of reimbursements — same figure the Uber
   * screen shows, computed from the same shared query. */
  uberSummary: UberSummary;
  /** Any Uber-tagged row ever — keeps the card (the only door to the Uber
   * screen and its split calculator) visible in months with no rides yet. */
  uberEverUsed: boolean;
}

// ─── Data loader ──────────────────────────────────────────────────────────────

function loadData(): DashboardData {
  const now = new Date();
  const range = monthRange();
  const summary = getSummary(range);
  const prevSummary = getSummary(prevMonthRange());

  const topMerchants = getTopMerchants(range, 1);
  const topMerchant = topMerchants[0] ?? null;

  const expenses = queryTransactions({ from: range.from, to: range.to, types: ['expense'] });
  const biggestExpense =
    expenses.length > 0
      ? expenses.reduce((max, tx) => (tx.amount > max.amount ? tx : max), expenses[0])
      : null;

  const budgetStatus = computeBudgetStatus();
  const uncategorizedCount = getUncategorizedCount();

  const uberSummary = getUberSummary(range);
  const uberEverUsed = hasCategoryRows('Uber');

  const monthLabel = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return {
    summary,
    prevSummary,
    topMerchant,
    biggestExpense,
    budgetStatus,
    monthLabel,
    uncategorizedCount,
    uberSummary,
    uberEverUsed,
  };
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [data, setData] = useState<DashboardData>(() => loadData());
  const [refreshing, setRefreshing] = useState(false);
  const [notifHealthOk, setNotifHealthOk] = useState(true);

  // View-only category exclude toggle (6d) — non-persistent, screen-local.
  const [excluded, setExcluded] = useState<Set<Category>>(new Set());
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

  const reload = useCallback(() => {
    setData(loadData());
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setData(loadData());
    setRefreshing(false);
  }, []);

  useFocusEffect(reload);

  useFocusEffect(
    useCallback(() => {
      isNotificationAccessGranted()
        .then(ok => setNotifHealthOk(ok))
        .catch(() => setNotifHealthOk(true)); // assume ok if check fails
    }, []),
  );

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, reload);
    return () => sub.remove();
  }, [reload]);

  const {
    summary,
    prevSummary,
    topMerchant,
    biggestExpense,
    budgetStatus,
    monthLabel,
    uncategorizedCount,
    uberSummary,
    uberEverUsed,
  } = data;

  // ── Month-over-month deltas ────────────────────────────────────────────────
  // spentDelta is computed below displayedSpent (uses the excluded-categories
  // view so it never silently disagrees with the number shown on screen).
  const receivedDelta = prevSummary.received > 0
    ? ((summary.received - prevSummary.received) / prevSummary.received) * 100
    : null;

  // ── Category exclude toggle (6d): displayed totals drop excluded categories
  // from the total, donut, and per-day figure. View-only — no data changes.
  const excludedTotal = summary.byCategory
    .filter(bc => excluded.has(bc.category as Category))
    .reduce((sum, bc) => sum + bc.total, 0);
  const displayedSpent = summary.spent - excludedTotal;
  const spentDelta = prevSummary.spent > 0
    ? ((displayedSpent - prevSummary.spent) / prevSummary.spent) * 100
    : null;

  // ── Donut data ──────────────────────────────────────────────────────────────
  const donutData = summary.byCategory
    .filter(bc => bc.total > 0 && !excluded.has(bc.category as Category))
    .map(bc => ({
      value: bc.total,
      color: (CATEGORIES as string[]).includes(bc.category)
        ? CATEGORY_META[bc.category as Category].color
        : '#78909C',
      label: bc.category,
    }));

  const totalSpentFormatted = displayedSpent.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  // ── Per-day spend (6c) ──────────────────────────────────────────────────────
  const monthCompletedDays = completedDays(monthRange());
  const perDayFormatted =
    monthCompletedDays > 0
      ? `₹${Math.round(displayedSpent / monthCompletedDays).toLocaleString('en-IN')}/day`
      : '—';

  // ── Trend data ──────────────────────────────────────────────────────────────
  const trendData = summary.byDay.map(bd => ({
    value: bd.total,
    label: String(localDayIndexToDate(bd.day).getDate()),
    date: formatDayLabel(localDayIndexToDate(bd.day).getTime()),
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
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.colors.accent}
          colors={[theme.colors.accent]}
        />
      }
    >
      {/* ── Capture-health banner ── */}
      {!notifHealthOk && (
        <TouchableOpacity
          style={styles.healthBanner}
          onPress={openNotificationAccessSettings}
          activeOpacity={0.8}
        >
          <Text style={styles.healthBannerText}>
            ⚠️ Notification access revoked — UPI/bank app transactions won't be captured
          </Text>
          <Text style={styles.healthBannerAction}>Fix →</Text>
        </TouchableOpacity>
      )}

      {/* ── Uncategorized review banner ── */}
      {uncategorizedCount > 0 && (
        <TouchableOpacity
          style={styles.reviewBanner}
          onPress={() => navigation.navigate('Review')}
          activeOpacity={0.8}
        >
          <Text style={styles.reviewBannerText}>
            {uncategorizedCount} transaction{uncategorizedCount !== 1 ? 's' : ''} need categorizing
          </Text>
          <Text style={styles.reviewBannerAction}>Review →</Text>
        </TouchableOpacity>
      )}

      {/* ── Hero card ── */}
      <Card style={styles.heroCard}>
        <Text style={styles.heroTitle}>{monthLabel}</Text>
        <View style={styles.heroRow}>
          <View style={styles.heroItem}>
            <Text style={styles.heroLabel}>Spent</Text>
            <AmountText amount={displayedSpent} type="expense" size={theme.font.size.xl} />
            {spentDelta != null && (
              <Text style={[styles.delta, spentDelta > 0 ? styles.deltaUp : styles.deltaDown]}>
                {spentDelta > 0 ? '▲' : '▼'} {Math.abs(spentDelta).toFixed(0)}% vs last mo
              </Text>
            )}
            <Text style={styles.perDay}>{perDayFormatted}</Text>
          </View>
          <View style={styles.heroSep} />
          <View style={styles.heroItem}>
            <Text style={styles.heroLabel}>Received</Text>
            <AmountText amount={summary.received} type="income" size={theme.font.size.xl} />
            {receivedDelta != null && (
              <Text style={[styles.delta, receivedDelta >= 0 ? styles.deltaDown : styles.deltaUp]}>
                {receivedDelta >= 0 ? '▲' : '▼'} {Math.abs(receivedDelta).toFixed(0)}% vs last mo
              </Text>
            )}
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
        {summary.invested > 0 && (
          <Text style={styles.investedCaption}>
            Invested: ₹{summary.invested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            {' '}(not counted as spend)
          </Text>
        )}
        {/* Transfers are excluded from spend and income (the underlying
            expense is the real cost), so surface the figure here rather than
            letting the money disappear from the app entirely. */}
        {Math.abs(summary.transferred) > 0 && (
          <Text style={styles.investedCaption}>
            {summary.transferred > 0 ? 'Lent/paid out' : 'Received back'}: ₹
            {Math.abs(summary.transferred).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            {' '}(not counted as spend)
          </Text>
        )}
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
        {/* Legend — tap a category to hide it from total/donut/per-day (6d) */}
        {summary.byCategory.filter(bc => bc.total > 0).length > 0 && (
          <View style={styles.legend}>
            {summary.byCategory.filter(bc => bc.total > 0).map(bc => {
              const isExcluded = excluded.has(bc.category as Category);
              const color = (CATEGORIES as string[]).includes(bc.category)
                ? CATEGORY_META[bc.category as Category].color
                : '#78909C';
              return (
                <TouchableOpacity
                  key={bc.category}
                  style={[styles.legendItem, isExcluded && styles.legendItemExcluded]}
                  onPress={() => toggleExcluded(bc.category as Category)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.legendDot, { backgroundColor: color }]} />
                  <Text
                    style={[styles.legendLabel, isExcluded && styles.legendTextExcluded]}
                    numberOfLines={1}
                  >
                    {bc.category}
                  </Text>
                  <Text style={[styles.legendAmount, isExcluded && styles.legendTextExcluded]}>
                    ₹{bc.total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        {excluded.size > 0 && (
          <Text style={styles.excludingCaption}>
            excluding {Array.from(excluded).join(', ')}
          </Text>
        )}
      </Card>

      {/* ── Uber (this month, net of reimbursements — same figure as the Uber screen).
           Shown whenever Uber was ever used: this card is the only door to the
           Uber screen, so hiding it in a ride-free month would lock the split
           calculator away right when the month's first ride needs recording. ── */}
      {uberEverUsed && (
        <>
          <SectionHeader title="Uber" />
          <TouchableOpacity
            style={styles.uberCard}
            onPress={() => navigation.navigate('Uber')}
            activeOpacity={0.8}
          >
            <View style={styles.uberLeft}>
              <Icon name="car" size={28} color={CATEGORY_META.Uber.color} />
              <View>
                <Text style={styles.uberLabel}>
                  {uberSummary.rideCount > 0
                    ? `Uber this month (${uberSummary.rideCount} ride${uberSummary.rideCount !== 1 ? 's' : ''})`
                    : 'Uber this month — no rides yet'}
                </Text>
                <AmountText
                  amount={Math.abs(uberSummary.net)}
                  type={uberSummary.net >= 0 ? 'expense' : 'income'}
                  size={theme.font.size.lg}
                />
              </View>
            </View>
            <Icon name="chevron-forward" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </>
      )}

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
  healthBanner: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.warning + '18',
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warning,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  healthBannerText: {
    color: theme.colors.textSecondary,
    fontSize: theme.font.size.xs,
    flex: 1,
    lineHeight: 16,
  },
  healthBannerAction: {
    color: theme.colors.warning,
    fontWeight: theme.font.weight.bold,
    fontSize: theme.font.size.sm,
    marginLeft: theme.spacing.sm,
  },
  reviewBanner: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.accent + '18',
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewBannerText: {
    color: theme.colors.textSecondary,
    fontSize: theme.font.size.sm,
    flex: 1,
  },
  reviewBannerAction: {
    color: theme.colors.accent,
    fontWeight: theme.font.weight.bold,
    fontSize: theme.font.size.sm,
  },
  heroCard: {
    margin: theme.spacing.lg,
    marginBottom: 0,
    padding: theme.spacing.lg,
  },
  investedCaption: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
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
  delta: {
    fontSize: 9,
    marginTop: 2,
    textAlign: 'center',
  },
  deltaUp: {
    color: theme.colors.danger,
  },
  deltaDown: {
    color: theme.colors.credit,
  },
  heroSep: {
    width: 1,
    height: 40,
    backgroundColor: theme.colors.border,
  },
  perDay: {
    fontSize: 9,
    color: theme.colors.textMuted,
    marginTop: 2,
    textAlign: 'center',
  },
  donutCard: {
    alignItems: 'center',
    paddingVertical: theme.spacing.lg,
  },
  uberCard: {
    marginHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  uberLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  uberLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
    marginBottom: 2,
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
