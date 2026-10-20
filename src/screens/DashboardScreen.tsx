// ─── DashboardScreen ─────────────────────────────────────────────────────────
//
// Home tab, kept deliberately short: month switcher, one hero card (Spent +
// From family / Out of pocket / Earned), at most two action banners, the
// By Category donut (tap a category → Transactions filtered to it), a compact
// Uber row and any budget at ≥80%. Trends and insights live on Insights.
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
  getUnsettledRides,
  hasCategoryRows,
  getUncategorizedCount,
} from '../db';
import type { Summary, UberSummary } from '../db';
import { CATEGORY_META, CATEGORIES } from '../categories';
import type { Category } from '../categories';
import { DATA_CHANGED } from '../sync';
import { AmountText, Card, Donut, Icon, MonthSwitcher, ProgressBar, SectionHeader } from '../components';
import { monthRef } from '../components/MonthSwitcher';
import { theme } from '../theme';
import { monthRange } from '../dates';
import { computeBudgetStatus } from '../budgets';
import { outOfPocket } from '../netting';
import DashboardBanners from './DashboardBanners';
import type { BudgetStatus } from '../budgets';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardData {
  summary: Summary;
  budgetStatus: BudgetStatus;
  uncategorizedCount: number;
  /** Net Uber spend for the month — same figure the Uber screen shows. */
  uberSummary: UberSummary;
  /** Rides with money still owed back. */
  uberWaiting: number;
  /** Any Uber-tagged row ever — keeps the row (the only door to the Uber
   * screen) visible in months with no rides yet. */
  uberEverUsed: boolean;
}

const BUDGET_WARN = 0.8;

// ─── Data loader ──────────────────────────────────────────────────────────────

function loadData(offset: number): DashboardData {
  const ref = monthRef(offset);
  const range = monthRange(ref);
  return {
    summary: getSummary(range),
    budgetStatus: computeBudgetStatus(ref),
    uncategorizedCount: getUncategorizedCount(),
    uberSummary: getUberSummary(range),
    uberWaiting: getUnsettledRides(range).length,
    uberEverUsed: hasCategoryRows('Uber'),
  };
}

function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function catColor(category: string): string {
  return (CATEGORIES as string[]).includes(category)
    ? CATEGORY_META[category as Category].color
    : '#78909C';
}

function Figure({ label, amount }: { label: string; amount: number }) {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={styles.figureValue}>{rupees(amount)}</Text>
    </View>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<DashboardData>(() => loadData(0));
  const [refreshing, setRefreshing] = useState(false);
  const [notifHealthOk, setNotifHealthOk] = useState(true);

  const reload = useCallback(() => {
    setData(loadData(offset));
  }, [offset]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    reload();
    setRefreshing(false);
  }, [reload]);

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

  const { summary, budgetStatus, uncategorizedCount, uberSummary, uberWaiting, uberEverUsed } = data;

  const cats = summary.byCategory.filter(bc => bc.total > 0);
  const donutData = cats.map(bc => ({
    value: bc.total,
    color: catColor(bc.category),
    label: bc.category,
  }));

  const openCategory = (category: string) =>
    navigation.navigate('Tabs', {
      screen: 'Transactions',
      params: {
        category,
        datePreset: offset === 0 ? 'month' : 'lastmonth',
        nonce: Date.now(),
      },
    });

  // Budgets at ≥80% only, one compact line each.
  const hot: { label: string; spent: number; limit: number }[] = [];
  if (budgetStatus.overall != null) {
    hot.push({ label: 'Overall', ...budgetStatus.overall });
  }
  for (const cb of budgetStatus.categories) {
    hot.push({ label: cb.category, spent: cb.spent, limit: cb.limit });
  }
  const hotBudgets = hot.filter(b => b.spent >= b.limit * BUDGET_WARN);

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
      <MonthSwitcher offset={offset} onChange={setOffset} />

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

      {/* ── Transfer / repayment banners (max 2) ── */}
      <DashboardBanners />

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
        <Text style={styles.heroLabel}>Spent</Text>
        <AmountText amount={summary.spent} type="expense" size={theme.font.size.xxl} />
        <View style={styles.figures}>
          <Figure label="From family" amount={summary.fromFamily} />
          <Figure label="Out of pocket" amount={outOfPocket(summary.spent, summary.fromFamily)} />
          <Figure label="Earned" amount={summary.earned} />
          {summary.invested > 0 && <Figure label="Invested" amount={summary.invested} />}
        </View>
      </Card>

      {/* ── By category: tap a row to see its transactions ── */}
      {cats.length > 0 && (
        <>
          <SectionHeader title="By Category" />
          <Card style={styles.donutCard}>
            <Donut
              data={donutData}
              centerValue={rupees(summary.spent)}
              centerLabel="spent"
              size={170}
            />
            <View style={styles.legend}>
              {cats.map(bc => (
                <TouchableOpacity
                  key={bc.category}
                  style={styles.legendItem}
                  onPress={() => openCategory(bc.category)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.legendDot, { backgroundColor: catColor(bc.category) }]} />
                  <Text style={styles.legendLabel} numberOfLines={1}>
                    {bc.category}
                  </Text>
                  <Text style={styles.legendAmount}>{rupees(bc.total)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Card>
        </>
      )}

      {/* ── Uber: one tappable row (the only door to the Uber screen) ── */}
      {uberEverUsed && (
        <TouchableOpacity
          style={styles.uberRow}
          onPress={() => navigation.navigate('Uber')}
          activeOpacity={0.8}
        >
          <Icon name="car" size={20} color={CATEGORY_META.Uber.color} />
          <Text style={styles.uberText} numberOfLines={1}>
            Uber · {rupees(uberSummary.net)}
            {uberWaiting > 0 ? ` · ${uberWaiting} waiting for repayment` : ''}
          </Text>
          <Icon name="chevron-forward" size={16} color={theme.colors.textMuted} />
        </TouchableOpacity>
      )}

      {/* ── Budgets at ≥80% ── */}
      {hotBudgets.length > 0 && (
        <Card style={styles.budgetCard}>
          {hotBudgets.map(b => {
            const over = b.spent > b.limit;
            return (
              <View key={b.label} style={styles.budgetRow}>
                <View style={styles.budgetHeader}>
                  <Text style={styles.budgetLabel}>{b.label}</Text>
                  <Text style={[styles.budgetAmt, over ? styles.overBudget : undefined]}>
                    {rupees(b.spent)} / {rupees(b.limit)}
                  </Text>
                </View>
                <ProgressBar
                  value={b.spent}
                  max={b.limit}
                  color={over ? theme.colors.danger : theme.colors.warning}
                  height={4}
                />
              </View>
            );
          })}
        </Card>
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
    alignItems: 'center',
  },
  heroLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  },
  figures: {
    flexDirection: 'row',
    marginTop: theme.spacing.md,
    width: '100%',
  },
  figure: {
    flex: 1,
    alignItems: 'center',
  },
  figureLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  figureValue: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
    marginTop: 2,
  },
  donutCard: {
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
  },
  legend: {
    width: '100%',
    marginTop: theme.spacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
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
  uberRow: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  uberText: {
    flex: 1,
    fontSize: theme.font.size.sm,
    color: theme.colors.textPrimary,
  },
  budgetCard: {
    marginTop: theme.spacing.lg,
  },
  budgetRow: {
    marginBottom: theme.spacing.sm,
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
  bottomPad: {
    height: theme.spacing.xxl,
  },
});
