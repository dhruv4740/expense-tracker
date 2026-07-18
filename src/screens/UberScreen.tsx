// ─── UberScreen ───────────────────────────────────────────────────────────────
//
// Current-month Uber transactions, plus average-per-day stats (this month and
// this ISO week, Monday–Sunday). Reached from the Dashboard's Uber card.

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

import {
  deleteTransaction,
  getUberSummary,
  insertManual,
  queryTransactions,
  updateTransaction,
} from '../db';
import type { TransactionRow, UberSummary } from '../db';
import { DATA_CHANGED } from '../sync';
import { AmountText, Card, EmptyState, Icon, SectionHeader } from '../components';
import { theme } from '../theme';
import { formatDate, monthRange } from '../dates';

/** Local midnight for `d` (or now). */
function dayStart(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday 00:00 of the week containing `d` (getDay(): 0=Sun..6=Sat). */
function weekStart(d: Date = new Date()): Date {
  const start = dayStart(d);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

const RECENT_CREDITS_DAYS = 14;
const RECENT_CREDITS_LIMIT = 5;

interface UberData {
  monthRows: TransactionRow[];
  summary: UberSummary;
  weekSummary: UberSummary;
  recentCredits: TransactionRow[];
}

function loadUberData(): UberData {
  const { from, to } = monthRange();
  const monthRows = queryTransactions({ categories: ['Uber'], from, to });
  const summary = getUberSummary({ from, to });

  // The current week can start in the previous calendar month (e.g. today is
  // the 1st/2nd and Monday fell in the prior month) — query it independently
  // of the month filter above rather than trying to derive it from monthRows.
  const weekFrom = weekStart().getTime();
  const weekSummary = getUberSummary({ from: weekFrom, to: Date.now() });

  // Recent incoming payments not already tagged Uber — lets you tag a
  // friend's pay-back in one tap instead of hunting for it in Transactions.
  const creditsFrom = Date.now() - RECENT_CREDITS_DAYS * 86_400_000;
  const recentCredits = queryTransactions({ types: ['income'], from: creditsFrom, to: Date.now() })
    .filter(r => r.category !== 'Uber')
    .slice(0, RECENT_CREDITS_LIMIT);

  return { monthRows, summary, weekSummary, recentCredits };
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
  const [showAdjust, setShowAdjust] = useState(false);

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
    setShowAdjust(false);
  }, []);

  const commit = useCallback(
    (amount: number, note: string) => {
      insertManual({
        amount,
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
    },
    [timestamp, reset],
  );

  const onSave = useCallback(() => {
    const total = parseFloat(totalFare) || 0;
    const n = parseInt(splitCount, 10) || 0;
    const adjusting = showAdjust && (youPaid.trim() !== '' || youReceived.trim() !== '');

    if (adjusting) {
      if (net <= 0) {
        Alert.alert(
          'Nothing to record',
          "Your net share is ₹0 or less — you weren't actually out of pocket on this one.",
        );
        return;
      }
      const paid = parseFloat(youPaid) || 0;
      const received = parseFloat(youReceived) || 0;
      const note =
        total > 0 && n > 0
          ? `Split ₹${fmt(total)} ÷ ${n} (₹${fmt(fairShare)} each) · paid ₹${fmt(paid)} · received ₹${fmt(received)}`
          : `Paid ₹${fmt(paid)} · received ₹${fmt(received)}`;
      commit(Math.round(net * 100) / 100, note);
      return;
    }

    if (!(total > 0 && n > 0)) {
      Alert.alert('Missing details', 'Enter the total fare and how many people split it.');
      return;
    }
    const share = Math.round((total / n) * 100) / 100;
    const note = `Split ₹${fmt(total)} ÷ ${n} — your share`;

    // Double-count guard: if the full fare was already captured via SMS the
    // same day, saving the fair share on top of it would silently double it.
    // Manual rows are skipped — a second split saved the same day is two
    // separate rides, not a duplicate capture. (NULL channel = pre-migration
    // history, which WAS captured, so it stays eligible.)
    const dayFrom = dayStart(new Date(timestamp)).getTime();
    const dayTo = dayFrom + 86_400_000 - 1;
    const candidates = queryTransactions({
      categories: ['Uber'],
      types: ['expense'],
      from: dayFrom,
      to: dayTo,
    }).filter(r => r.channel !== 'manual' && r.amount >= share - 0.005);

    if (candidates.length === 0) {
      commit(share, note);
      return;
    }
    const existing = candidates[0];
    Alert.alert(
      'Possible double-count',
      `A ₹${fmt(existing.amount)} Uber payment on ${formatDate(existing.timestamp)} is already recorded — ` +
        `likely the full fare you paid. Exclude it and keep just your ₹${fmt(share)} share?`,
      [
        {
          text: 'Exclude it',
          onPress: () => {
            if (existing.id != null) {
              updateTransaction(existing.id, { type: 'self' });
            }
            commit(share, note);
          },
        },
        { text: 'Keep both', onPress: () => commit(share, note) },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [totalFare, splitCount, youPaid, youReceived, showAdjust, net, fairShare, timestamp, commit]);

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

      <View style={styles.splitFooter}>
        <Text style={styles.splitNetLabel}>Your share</Text>
        <AmountText amount={Math.max(fairShare, 0)} type="expense" size={theme.font.size.lg} />
      </View>

      <TouchableOpacity onPress={() => setShowAdjust(v => !v)}>
        <Text style={styles.adjustLink}>
          {showAdjust ? 'Hide adjustment' : 'Paid a different amount? Adjust'}
        </Text>
      </TouchableOpacity>

      {showAdjust && (
        <>
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
            <AmountText amount={Math.max(net, 0)} type="expense" size={theme.font.size.md} />
          </View>
        </>
      )}

      <TouchableOpacity style={styles.splitSaveBtn} onPress={onSave} activeOpacity={0.8}>
        <Text style={styles.splitSaveText}>Save as Uber expense</Text>
      </TouchableOpacity>
    </Card>
  );
}

export default function UberScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [data, setData] = useState<UberData>(() => loadUberData());
  const rows = data.monthRows;

  const reload = useCallback(() => setData(loadUberData()), []);
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

  const markUber = useCallback((item: TransactionRow) => {
    if (item.id == null) {
      return;
    }
    updateTransaction(item.id, { category: 'Uber', category_source: 'manual' });
    DeviceEventEmitter.emit(DATA_CHANGED);
  }, []);

  const { summary, weekSummary, recentCredits } = data;

  // Average per day you actually rode, not per calendar day — riding 15 of
  // 20 elapsed days divides by 15, so a light month doesn't look misleadingly
  // cheap-per-day just because you didn't take Uber every day.
  const avgPerDayMonth = summary.activeDays > 0 ? Math.max(summary.net, 0) / summary.activeDays : 0;
  const avgPerDayWeek = weekSummary.activeDays > 0 ? Math.max(weekSummary.net, 0) / weekSummary.activeDays : 0;

  // The whole screen scrolls as one FlatList: with the split calculator and
  // recent-credits sections stacked above the list, a fixed header would
  // squeeze the transactions into a sliver on smaller screens.
  const header = (
    <>
      <Card style={styles.totalCard}>
        <Text style={styles.totalLabel}>Net Uber spend this month</Text>
        <AmountText
          amount={Math.abs(summary.net)}
          type={summary.net >= 0 ? 'expense' : 'income'}
          size={theme.font.size.xl}
        />
        <Text style={styles.totalSub}>
          {summary.rideCount} ride{summary.rideCount !== 1 ? 's' : ''}
          {summary.reimbursementCount > 0
            ? ` · ${summary.reimbursementCount} reimbursement${summary.reimbursementCount !== 1 ? 's' : ''}`
            : ''}
        </Text>
        {summary.reimbursed > 0 && (
          <Text style={styles.totalSub}>
            ₹{fmt(summary.spent)} spent · ₹{fmt(summary.reimbursed)} reimbursed
          </Text>
        )}
      </Card>

      <View style={styles.avgRow}>
        <Card style={styles.avgCard}>
          <Text style={styles.avgLabel}>Avg per ride day (month)</Text>
          <AmountText amount={avgPerDayMonth} type="expense" size={theme.font.size.md} />
        </Card>
        <Card style={styles.avgCard}>
          <Text style={styles.avgLabel}>Avg per ride day (week)</Text>
          <AmountText amount={avgPerDayWeek} type="expense" size={theme.font.size.md} />
        </Card>
      </View>

      <SplitFareCard />

      {recentCredits.length > 0 && (
        <>
          <SectionHeader title="Recent Credits" />
          <Card style={styles.creditsCard}>
            {recentCredits.map(item => (
              <View key={item.id} style={styles.creditRow}>
                <View style={styles.creditMain}>
                  <Text style={styles.merchant} numberOfLines={1}>
                    {item.counterparty ?? item.merchant ?? item.source ?? 'Unknown'}
                  </Text>
                  <Text style={styles.date}>{formatDate(item.timestamp)}</Text>
                </View>
                <AmountText amount={item.amount} type="income" size={theme.font.size.sm} />
                <TouchableOpacity
                  style={styles.markUberBtn}
                  onPress={() => markUber(item)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.markUberText}>Mark Uber</Text>
                </TouchableOpacity>
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionHeader title="This Month's Transactions" />
    </>
  );

  return (
    <FlatList
      style={styles.container}
      data={rows}
      keyExtractor={r => String(r.id)}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      ListEmptyComponent={
        <EmptyState
          icon="car"
          title="No Uber transactions this month"
          subtitle="Uber rides will show up here once captured from SMS or notifications."
        />
      }
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
  avgRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    margin: theme.spacing.lg,
    marginBottom: 0,
  },
  avgCard: {
    flex: 1,
    alignItems: 'center',
    padding: theme.spacing.md,
    gap: 4,
  },
  avgLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  listContent: {
    paddingBottom: theme.spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: theme.spacing.lg,
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
  creditsCard: {
    marginHorizontal: theme.spacing.lg,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  creditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  creditMain: {
    flex: 1,
    gap: 2,
  },
  markUberBtn: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.accent + '22',
  },
  markUberText: {
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.accent,
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
  adjustLink: {
    fontSize: theme.font.size.xs,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
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
