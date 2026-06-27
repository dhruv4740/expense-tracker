import React, { useCallback, useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  FlatList,
  ListRenderItem,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getAll, TransactionRow } from '../db';
import { DATA_CHANGED } from '../sync';

// ─── helpers ────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

function displayName(item: TransactionRow): string {
  return item.merchant ?? item.source ?? 'Unknown';
}

// ─── row component (stable ref via React.memo) ───────────────────────────────

const TransactionRow_ = React.memo(({ item }: { item: TransactionRow }) => (
  <View style={styles.row}>
    <View style={styles.rowLeft}>
      <Text style={styles.merchant} numberOfLines={1}>
        {displayName(item)}
      </Text>
      <Text style={styles.sub}>
        {item.category}  ·  {formatDate(item.timestamp)}
      </Text>
    </View>
    <Text style={[styles.amount, item.type === 'income' ? styles.income : styles.expense]}>
      ₹{item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </Text>
  </View>
));

// ─── screen ──────────────────────────────────────────────────────────────────

export default function TransactionsScreen() {
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);

  // Reload from DB on focus AND whenever a live event inserts a new row.
  const load = useCallback(() => {
    setTransactions(getAll()); // already DESC by timestamp
  }, []);

  useFocusEffect(load);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, load);
    return () => sub.remove();
  }, [load]);

  const keyExtractor = useCallback(
    (item: TransactionRow) => String(item.id),
    [],
  );

  const renderItem = useCallback<ListRenderItem<TransactionRow>>(
    ({ item }) => <TransactionRow_ item={item} />,
    [],
  );

  const ListEmpty = useCallback(
    () => (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No transactions yet</Text>
      </View>
    ),
    [],
  );

  return (
    <FlatList
      data={transactions}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListEmptyComponent={ListEmpty}
      contentContainerStyle={transactions.length === 0 ? styles.emptyContainer : styles.listContent}
      removeClippedSubviews
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={5}
    />
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  listContent: {
    paddingVertical: 8,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
  },
  rowLeft: {
    flex: 1,
    marginRight: 12,
  },
  merchant: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1A1A1A',
  },
  sub: {
    fontSize: 12,
    color: '#757575',
    marginTop: 2,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
  },
  expense: {
    color: '#C62828',
  },
  income: {
    color: '#2E7D32',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#9E9E9E',
  },
});
