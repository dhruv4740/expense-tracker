// ─── FriendsDuesScreen ────────────────────────────────────────────────────────
//
// Who owes you what: per friend, Σ owed_amount on split rows minus the
// repayments linked to them (settles_id children). Tap a friend to see the
// history. Pure maths lives in ledger.ts.

import React, { useCallback, useState } from 'react';
import { DeviceEventEmitter, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { getLedgerRows } from '../db';
import { buildLedger, totalOutstanding } from '../ledger';
import type { FriendBalance } from '../ledger';
import { DATA_CHANGED } from '../sync';
import { formatDate } from '../dates';
import { displayMerchant } from '../merchantDisplay';
import { Card, EmptyState } from '../components';
import { theme } from '../theme';

function fmt(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export default function FriendsDuesScreen() {
  const [ledger, setLedger] = useState<FriendBalance[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setLedger(
      buildLedger(getLedgerRows().filter(r => r.id != null).map(r => ({ ...r, id: r.id as number }))),
    );
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
      const sub = DeviceEventEmitter.addListener(DATA_CHANGED, load);
      return () => sub.remove();
    }, [load]),
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={ledger}
        keyExtractor={b => b.name}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          ledger.length > 0 ? (
            <Text style={styles.total}>Total owed to you: {fmt(totalOutstanding(ledger))}</Text>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon="person"
            title="Nobody owes you anything"
            subtitle="Split an Uber ride (Uber screen, Split) and pick a friend to start tracking."
          />
        }
        renderItem={({ item: b }) => (
          <Card>
            <TouchableOpacity
              style={styles.head}
              onPress={() => setOpen(open === b.name ? null : b.name)}
              activeOpacity={0.7}
            >
              <View style={styles.headMain}>
                <Text style={styles.name}>{b.name}</Text>
                <Text style={styles.sub}>
                  owed {fmt(b.owed)} · repaid {fmt(b.repaid)}
                </Text>
              </View>
              <Text style={[styles.amt, b.outstanding <= 0 && styles.settled]}>
                {b.outstanding > 0 ? fmt(b.outstanding) : 'settled'}
              </Text>
            </TouchableOpacity>
            {open === b.name &&
              b.entries.map(e => (
                <View key={`${e.kind}-${e.row.id}`} style={styles.entry}>
                  <Text style={styles.entryText} numberOfLines={1}>
                    {formatDate(e.row.timestamp)} ·{' '}
                    {e.kind === 'owed'
                      ? `${displayMerchant(e.row.merchant ?? null) ?? 'Split'} (fare ${fmt(e.row.amount)})`
                      : `repaid${e.row.counterparty ? ` by ${e.row.counterparty}` : ''}`}
                  </Text>
                  <Text style={[styles.entryAmt, e.delta < 0 && styles.settled]}>
                    {e.delta < 0 ? '−' : '+'}
                    {fmt(Math.abs(e.delta))}
                  </Text>
                </View>
              ))}
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  list: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xl, gap: theme.spacing.sm },
  total: {
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textPrimary,
    marginVertical: theme.spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm },
  headMain: { flex: 1, gap: 2 },
  name: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium, color: theme.colors.textPrimary },
  sub: { fontSize: theme.font.size.xs, color: theme.colors.textMuted },
  amt: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold, color: theme.colors.warning },
  settled: { color: theme.colors.textMuted },
  entry: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  entryText: { flex: 1, fontSize: theme.font.size.sm, color: theme.colors.textSecondary },
  entryAmt: { fontSize: theme.font.size.sm, color: theme.colors.textPrimary },
});
