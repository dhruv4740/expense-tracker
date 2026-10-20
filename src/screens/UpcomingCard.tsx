// "Coming up": autopay notices and recurring payments due this week / month.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, SectionHeader } from '../components';
import { startOfDay, sumAmounts } from '../upcoming';
import { safeToSpend, safeToSpendLine } from '../safeToSpend';
import type { UpcomingItem } from '../upcoming';
import { theme } from '../theme';

const DAY = 86_400_000;
const MAX_ROWS = 5;

function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** "₹X left · ~₹Y/day": this month's income minus spend minus autopays still due. */
export function SafeToSpendCard({
  fromFamily,
  earned,
  spent,
  items,
  now,
}: {
  fromFamily: number;
  earned: number;
  spent: number;
  items: UpcomingItem[];
  now: number;
}) {
  const d = new Date(now);
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const committed = sumAmounts(items.filter(i => i.dueTs < monthEnd));
  const s = safeToSpend({ fromFamily, earned, spent, committed }, now);
  return (
    <Card>
      <Text style={styles.sub}>Safe to spend</Text>
      <Text style={[styles.big, s.left < 0 && styles.over]}>{safeToSpendLine(s)}</Text>
      {committed > 0 ? <Text style={styles.sub}>after {rupees(committed)} of autopays still due</Text> : null}
    </Card>
  );
}

export default function UpcomingCard({ items, now }: { items: UpcomingItem[]; now: number }) {
  if (items.length === 0) {
    return null;
  }
  const weekEnd = startOfDay(now) + 7 * DAY;
  const monthEnd = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1).getTime();
  const week = items.filter(i => i.dueTs < weekEnd);
  const month = items.filter(i => i.dueTs < monthEnd);
  return (
    <>
      <SectionHeader title="Coming up" />
      <Card>
        <Text style={styles.totals}>
          {rupees(sumAmounts(week))} this week · {rupees(sumAmounts(month))} this month
        </Text>
        {items.slice(0, MAX_ROWS).map(i => (
          <View key={`${i.merchant}-${i.dueTs}`} style={styles.row}>
            <View style={styles.main}>
              <Text style={styles.name} numberOfLines={1}>
                {i.merchant}
              </Text>
              <Text style={styles.sub}>
                {dayLabel(i.dueTs)}
                {i.source === 'recurring' ? ' · recurring' : ' · autopay'}
                {i.investment ? ' · investment' : ''}
              </Text>
              {i.priceIncrease ? (
                <Text style={styles.warn}>
                  Price up {i.priceIncrease.pct}% (was {rupees(i.priceIncrease.from)})
                </Text>
              ) : null}
            </View>
            <Text style={styles.amt}>{rupees(i.amount)}</Text>
          </View>
        ))}
        {items.length > MAX_ROWS ? <Text style={styles.sub}>+{items.length - MAX_ROWS} more</Text> : null}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  big: { fontSize: theme.font.size.lg, fontWeight: theme.font.weight.semibold, color: theme.colors.textPrimary },
  over: { color: theme.colors.danger },
  totals: { fontSize: theme.font.size.sm, color: theme.colors.textSecondary, marginBottom: theme.spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  main: { flex: 1, gap: 2 },
  name: { fontSize: theme.font.size.md, color: theme.colors.textPrimary },
  sub: { fontSize: theme.font.size.xs, color: theme.colors.textMuted },
  warn: { fontSize: theme.font.size.xs, color: theme.colors.warning },
  amt: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold, color: theme.colors.textPrimary },
});
