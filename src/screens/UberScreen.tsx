// ─── UberScreen ───────────────────────────────────────────────────────────────
//
// Full list of every Uber-category transaction plus the all-time total spent.
// Reached from the Dashboard's Uber card ("See all →").

import React, { useCallback, useEffect, useState } from 'react';
import { DeviceEventEmitter, FlatList, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { queryTransactions } from '../db';
import type { TransactionRow } from '../db';
import { DATA_CHANGED } from '../sync';
import { AmountText, Card, EmptyState, SectionHeader } from '../components';
import { theme } from '../theme';
import { formatDate } from '../dates';

function loadUberRows(): TransactionRow[] {
  return queryTransactions({ categories: ['Uber'] });
}

export default function UberScreen() {
  const [rows, setRows] = useState<TransactionRow[]>(() => loadUberRows());

  const reload = useCallback(() => setRows(loadUberRows()), []);
  useFocusEffect(reload);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, reload);
    return () => sub.remove();
  }, [reload]);

  // Only actual debits count as "spent" — a stray refund/credit tagged Uber
  // (or a self-transfer) shouldn't inflate the total.
  const total = rows
    .filter(r => r.type === 'expense')
    .reduce((sum, r) => sum + r.amount, 0);

  return (
    <View style={styles.container}>
      <Card style={styles.totalCard}>
        <Text style={styles.totalLabel}>Total spent on Uber</Text>
        <AmountText amount={total} type="expense" size={theme.font.size.xl} />
        <Text style={styles.totalSub}>
          {rows.length} transaction{rows.length !== 1 ? 's' : ''}
        </Text>
      </Card>

      <SectionHeader title="All Uber Transactions" />
      {rows.length === 0 ? (
        <EmptyState
          icon="car"
          title="No Uber transactions"
          subtitle="Uber rides will show up here once captured from SMS or notifications."
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={r => String(r.id)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.merchant} numberOfLines={1}>
                  {item.merchant ?? item.counterparty ?? item.source ?? 'Uber'}
                </Text>
                <Text style={styles.date}>{formatDate(item.timestamp)}</Text>
              </View>
              <AmountText amount={item.amount} type={item.type} size={theme.font.size.md} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  totalCard: {
    margin: theme.spacing.lg,
    marginBottom: 0,
    alignItems: 'center',
    padding: theme.spacing.lg,
    gap: theme.spacing.xs,
  },
  totalLabel: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
  },
  totalSub: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  listContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing.sm,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  merchant: {
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
    color: theme.colors.textPrimary,
  },
  date: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
});
