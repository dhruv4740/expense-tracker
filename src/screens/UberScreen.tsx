// ─── UberScreen ───────────────────────────────────────────────────────────────
//
// Full list of every Uber-category transaction plus the all-time total spent.
// Reached from the Dashboard's Uber card ("See all →").

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

import { deleteTransaction, insertManual, queryTransactions } from '../db';
import type { TransactionRow } from '../db';
import { DATA_CHANGED } from '../sync';
import { AmountText, Card, EmptyState, Icon, SectionHeader } from '../components';
import { theme } from '../theme';
import { formatDate } from '../dates';

function loadUberRows(): TransactionRow[] {
  return queryTransactions({ categories: ['Uber'] });
}

function fmt(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SplitFareCard() {
  const [totalFare, setTotalFare] = useState('');
  const [splitCount, setSplitCount] = useState('');
  const [youPaid, setYouPaid] = useState('');
  const [youReceived, setYouReceived] = useState('');
  const [timestamp, setTimestamp] = useState(() => Date.now());

  const openDatePicker = useCallback(() => {
    DateTimePickerAndroid.open({
      value: new Date(timestamp),
      mode: 'date',
      maximumDate: new Date(),
      onChange: (event, selected) => {
        if (event.type !== 'set' || !selected) {
          return;
        }
        setTimestamp(prev => {
          const d = new Date(prev);
          d.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
          return d.getTime();
        });
      },
    });
  }, [timestamp]);

  const { fairShare, net } = useMemo(() => {
    const total = parseFloat(totalFare) || 0;
    const n = parseInt(splitCount, 10) || 0;
    const paid = parseFloat(youPaid) || 0;
    const received = parseFloat(youReceived) || 0;
    return {
      fairShare: n > 0 ? total / n : 0,
      net: paid - received,
    };
  }, [totalFare, splitCount, youPaid, youReceived]);

  const reset = useCallback(() => {
    setTotalFare('');
    setSplitCount('');
    setYouPaid('');
    setYouReceived('');
    setTimestamp(Date.now());
  }, []);

  const onSave = useCallback(() => {
    if (net <= 0) {
      Alert.alert(
        'Nothing to record',
        "Your net share is ₹0 or less — you weren't actually out of pocket on this one.",
      );
      return;
    }
    const total = parseFloat(totalFare) || 0;
    const n = parseInt(splitCount, 10) || 0;
    const paid = parseFloat(youPaid) || 0;
    const received = parseFloat(youReceived) || 0;
    const note =
      total > 0 && n > 0
        ? `Split ₹${fmt(total)} ÷ ${n} (₹${fmt(fairShare)} each) · paid ₹${fmt(paid)} · received ₹${fmt(received)}`
        : `Paid ₹${fmt(paid)} · received ₹${fmt(received)}`;

    insertManual({
      amount: net,
      merchant: 'Uber',
      category: 'Uber',
      timestamp,
      type: 'expense',
      counterparty: null,
      account: null,
      note,
      raw_text: null,
    });
    DeviceEventEmitter.emit(DATA_CHANGED);
    reset();
  }, [net, totalFare, splitCount, youPaid, youReceived, fairShare, timestamp, reset]);

  return (
    <Card style={styles.splitCard}>
      <View style={styles.splitHeaderRow}>
        <Text style={styles.splitTitle}>Split a fare</Text>
        <TouchableOpacity style={styles.dateBtn} onPress={openDatePicker}>
          <Icon name="calendar" size={14} color={theme.colors.accent} />
          <Text style={styles.dateBtnText}>{formatDate(timestamp)}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.splitRow}>
        <View style={styles.splitField}>
          <Text style={styles.splitLabel}>Total fare (₹)</Text>
          <TextInput
            style={styles.splitInput}
            value={totalFare}
            onChangeText={setTotalFare}
            keyboardType="decimal-pad"
            placeholder="360"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>
        <View style={styles.splitField}>
          <Text style={styles.splitLabel}>Split between</Text>
          <TextInput
            style={styles.splitInput}
            value={splitCount}
            onChangeText={setSplitCount}
            keyboardType="number-pad"
            placeholder="3"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>
      </View>

      {fairShare > 0 && (
        <Text style={styles.splitHint}>Fair share: ₹{fmt(fairShare)} each</Text>
      )}

      <View style={styles.splitRow}>
        <View style={styles.splitField}>
          <Text style={styles.splitLabel}>You paid (₹)</Text>
          <TextInput
            style={styles.splitInput}
            value={youPaid}
            onChangeText={setYouPaid}
            keyboardType="decimal-pad"
            placeholder="240"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>
        <View style={styles.splitField}>
          <Text style={styles.splitLabel}>You got back (₹)</Text>
          <TextInput
            style={styles.splitInput}
            value={youReceived}
            onChangeText={setYouReceived}
            keyboardType="decimal-pad"
            placeholder="120"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>
      </View>

      <View style={styles.splitFooter}>
        <Text style={styles.splitNetLabel}>Your net share</Text>
        <AmountText amount={Math.max(net, 0)} type="expense" size={theme.font.size.lg} />
      </View>

      <TouchableOpacity style={styles.splitSaveBtn} onPress={onSave} activeOpacity={0.8}>
        <Text style={styles.splitSaveText}>Save as Uber expense</Text>
      </TouchableOpacity>
    </Card>
  );
}

export default function UberScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [rows, setRows] = useState<TransactionRow[]>(() => loadUberRows());

  const reload = useCallback(() => setRows(loadUberRows()), []);
  useFocusEffect(reload);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, reload);
    return () => sub.remove();
  }, [reload]);

  const handlePress = useCallback(
    (item: TransactionRow) => {
      navigation.navigate('EditTransaction', { tx: item });
    },
    [navigation],
  );

  const handleLongPress = useCallback(
    (item: TransactionRow) => {
      Alert.alert(item.merchant ?? 'Transaction', 'What would you like to do?', [
        { text: 'Edit', onPress: () => navigation.navigate('EditTransaction', { tx: item }) },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (item.id != null) {
              deleteTransaction(item.id);
              DeviceEventEmitter.emit(DATA_CHANGED);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [navigation],
  );

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

      <SplitFareCard />

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
            <TouchableOpacity
              style={styles.row}
              onPress={() => handlePress(item)}
              onLongPress={() => handleLongPress(item)}
              activeOpacity={0.7}
            >
              <View style={styles.rowMain}>
                <Text style={styles.merchant} numberOfLines={1}>
                  {item.merchant ?? item.counterparty ?? item.source ?? 'Uber'}
                </Text>
                <Text style={styles.date}>{formatDate(item.timestamp)}</Text>
              </View>
              <AmountText amount={item.amount} type={item.type} size={theme.font.size.md} />
            </TouchableOpacity>
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
  splitCard: {
    margin: theme.spacing.lg,
    marginBottom: 0,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  splitHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.xs,
  },
  splitTitle: {
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textPrimary,
  },
  dateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dateBtnText: {
    fontSize: theme.font.size.xs,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
  },
  splitRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  splitField: {
    flex: 1,
    gap: 4,
  },
  splitLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
  },
  splitInput: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
  },
  splitHint: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  splitFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: theme.spacing.xs,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  splitNetLabel: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
  },
  splitSaveBtn: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
  splitSaveText: {
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.bg,
  },
});
