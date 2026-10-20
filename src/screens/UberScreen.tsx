// ─── UberScreen ───────────────────────────────────────────────────────────────
//
// One month of Uber rides (month switcher shared with the Dashboard). Summary:
// Paid, Got back, Your share (= Paid − Got back, straight from getUberSummary).
// Each ride has an inline one-tap Split; rides still owed money can be linked
// to a repayment through the ranked suggestion sheet.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  FlatList,
  Modal,
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
  getKnownSettlementCounterparties,
  getUberSummary,
  getUnsettledRides,
  insertManual,
  queryTransactions,
  setSettlement,
  updateTransaction,
} from '../db';
import type { TransactionRow, UberSummary, UnsettledRide } from '../db';
import { splitOwed, suggestSettlements } from '../settle';
import { PRESET_LABEL, presetOwed } from '../ledger';
import type { SplitPreset } from '../ledger';
import { getFriends } from '../settings';
import type { CandidateTx, Suggestion } from '../settle';
import { DATA_CHANGED } from '../sync';
import { AmountText, Card, EmptyState, Icon, MonthSwitcher } from '../components';
import { monthRef } from '../components/MonthSwitcher';
import { theme } from '../theme';
import { displayMerchant } from '../merchantDisplay';
import { formatDate, monthRange } from '../dates';

/** Local midnight for `d` (or now). */
function dayStart(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const SUGGESTION_LIMIT = 5;

interface UberData {
  monthRows: TransactionRow[];
  summary: UberSummary;
  waiting: UnsettledRide[];
}

function loadUberData(offset: number): UberData {
  const { from, to } = monthRange(monthRef(offset));
  return {
    monthRows: queryTransactions({ categories: ['Uber'], from, to }),
    summary: getUberSummary({ from, to }),
    waiting: getUnsettledRides({ from, to }),
  };
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
    (amount: number, note: string, owed: number) => {
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
        // Persisted rather than buried in `note`: this is what the
        // reimbursement matcher scores candidates against. Without it there
        // was nothing to match on, so suggestions were pure recency.
        owed_amount: owed > 0.005 ? Math.round(owed * 100) / 100 : null,
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
      // Still owed = what you fronted beyond your own share, less what's
      // already come back.
      const stillOwed = total > 0 && n > 0 ? paid - fairShare - received : 0;
      commit(Math.round(net * 100) / 100, note, stillOwed);
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
      commit(share, note, total - share);
      return;
    }
    const existing = candidates[0];
    Alert.alert(
      'Full fare already recorded',
      `A ₹${fmt(existing.amount)} Uber payment on ${formatDate(existing.timestamp)} is already recorded — ` +
        `likely the full fare you paid. Track the ₹${fmt(total - share)} your friends owe you against it?`,
      [
        {
          text: 'Yes, track what I’m owed',
          onPress: () => {
            // Annotate the captured full-fare row instead of saving a second
            // one. The previous flow flipped this row to type='self', which
            // hid a real ride from every total AND from the transactions list
            // (self is filtered out by default), with no way to undo it.
            if (existing.id != null) {
              updateTransaction(existing.id, {
                owed_amount: Math.round((existing.amount - share) * 100) / 100,
                note,
              });
              DeviceEventEmitter.emit(DATA_CHANGED);
              reset();
            }
          },
        },
        {
          text: 'Save separately',
          onPress: () => commit(share, note, total - share),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [totalFare, splitCount, youPaid, youReceived, showAdjust, net, fairShare, timestamp, commit, reset]);

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
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<UberData>(() => loadUberData(0));
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [splitFor, setSplitFor] = useState<number | null>(null);
  const [customN, setCustomN] = useState('');
  const [customAmt, setCustomAmt] = useState('');
  const [splitFriend, setSplitFriend] = useState('');
  const friendNames = useMemo(() => getFriends().slice(0, 6), []);
  const [repayFor, setRepayFor] = useState<UnsettledRide | null>(null);
  const [showManual, setShowManual] = useState(false);

  const reload = useCallback(() => setData(loadUberData(offset)), [offset]);
  useFocusEffect(reload);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, reload);
    return () => sub.remove();
  }, [reload]);

  const { summary, monthRows, waiting } = data;
  const waitingIds = useMemo(() => new Set(waiting.map(w => w.id)), [waiting]);
  const rows = onlyWaiting ? monthRows.filter(r => r.id != null && waitingIds.has(r.id)) : monthRows;

  // One tap: n people → friends owe (n-1)/n of the fare.
  const saveOwed = useCallback(
    (item: TransactionRow, owed: number | null, label: string) => {
      if (item.id == null) {
        return;
      }
      const friend = splitFriend.trim();
      const fields: Partial<TransactionRow> = {
        owed_amount: owed,
        owed_friend: owed != null && friend ? friend : null,
      };
      if (owed != null && !item.note) {
        fields.note = `Split ₹${fmt(item.amount)} ${label} — your share`;
      }
      updateTransaction(item.id, fields);
      setSplitFor(null);
      setCustomN('');
      setCustomAmt('');
      DeviceEventEmitter.emit(DATA_CHANGED);
    },
    [splitFriend],
  );

  const applySplit = useCallback(
    (item: TransactionRow, n: number | null) =>
      saveOwed(item, n != null && n >= 2 ? splitOwed(item.amount, n) : null, `÷ ${n}`),
    [saveOwed],
  );

  const applyPreset = useCallback(
    (item: TransactionRow, preset: SplitPreset) =>
      saveOwed(item, presetOwed(item.amount, preset), `(friend owes ${PRESET_LABEL[preset]})`),
    [saveOwed],
  );

  const applyCustom = useCallback(
    (item: TransactionRow) => {
      const v = parseFloat(customAmt);
      if (v > 0 && v < item.amount) {
        saveOwed(item, Math.round(v * 100) / 100, `(friend owes ₹${fmt(v)})`);
      }
    },
    [customAmt, saveOwed],
  );

  // Ranked suggestions for the ride being settled (same scorer as before).
  const repaySuggestions = useMemo(() => {
    if (!repayFor) {
      return [];
    }
    const candidates = queryTransactions({
      types: ['income', 'expense'],
      from: repayFor.timestamp - 86_400_000,
      to: Date.now(),
    }).filter(r => r.category !== 'Uber' && r.settles_id == null);
    return suggestSettlements(
      candidates as CandidateTx[],
      [
        {
          id: repayFor.id,
          amount: repayFor.amount,
          timestamp: repayFor.timestamp,
          outstanding: repayFor.outstanding,
        },
      ],
      { knownCounterparties: getKnownSettlementCounterparties() },
      SUGGESTION_LIMIT,
    );
  }, [repayFor]);

  const linkSettlement = useCallback((s: Suggestion) => {
    const id = s.candidate.id;
    if (id == null) {
      return;
    }
    setSettlement(id, s.ride.id);
    setRepayFor(null);
    DeviceEventEmitter.emit(DATA_CHANGED);
  }, []);

  const header = (
    <>
      <MonthSwitcher
        offset={offset}
        onChange={o => {
          setOffset(o);
          setSplitFor(null);
        }}
      />

      <Card style={styles.totalCard}>
        <View style={styles.threeRow}>
          <View style={styles.threeCol}>
            <Text style={styles.totalLabel}>Paid</Text>
            <Text style={styles.threeValue}>₹{fmt(summary.spent)}</Text>
          </View>
          <View style={styles.threeCol}>
            <Text style={styles.totalLabel}>Got back</Text>
            <Text style={styles.threeValue}>₹{fmt(summary.reimbursed)}</Text>
          </View>
          <View style={styles.threeCol}>
            <Text style={styles.totalLabel}>Your share</Text>
            <Text style={[styles.threeValue, styles.threeStrong]}>₹{fmt(summary.net)}</Text>
          </View>
        </View>
      </Card>

      {summary.reimbursed > summary.spent && (
        <Text style={styles.overNote}>
          Got back is more than the rides captured. Rides paid from Amazon Pay balance only show up if
          Uber notifications are on (Settings → Apps).
        </Text>
      )}

      {waiting.length > 0 && (
        <TouchableOpacity style={styles.waitingRow} onPress={() => setOnlyWaiting(v => !v)}>
          <Text style={styles.waitingText}>
            {waiting.length} ride{waiting.length !== 1 ? 's' : ''} waiting for repayment
          </Text>
          <Text style={styles.waitingAction}>{onlyWaiting ? 'Show all' : 'Show'}</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.manualToggle} onPress={() => setShowManual(v => !v)}>
        <Text style={styles.adjustLink}>{showManual ? '▾' : '▸'} Add a ride manually</Text>
      </TouchableOpacity>
      {showManual && <SplitFareCard />}
    </>
  );

  return (
    <>
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
            title={onlyWaiting ? 'Nothing waiting for repayment' : 'No Uber transactions this month'}
            subtitle="Uber rides will show up here once captured from SMS or notifications."
          />
        }
        renderItem={({ item }) => {
          const isRide = item.type === 'expense' && item.settles_id == null;
          const open = splitFor === item.id;
          const wait = item.id != null ? waiting.find(w => w.id === item.id) : undefined;
          return (
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.rowTop}
                onPress={() => navigation.navigate('EditTransaction', { tx: item })}
                activeOpacity={0.7}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.merchant} numberOfLines={1}>
                    {displayMerchant(item.merchant) ?? item.counterparty ?? item.source ?? 'Uber'}
                  </Text>
                  <Text style={styles.date}>
                    {formatDate(item.timestamp)}
                    {item.owed_amount ? ` · friends owe ₹${fmt(item.owed_amount)}` : ''}
                  </Text>
                </View>
                <AmountText amount={item.amount} type={item.type} size={theme.font.size.md} />
              </TouchableOpacity>
              {isRide && (
                <View style={styles.rowActions}>
                  {open ? (
                    <View style={styles.splitBlock}>
                      <View style={styles.splitLine}>
                        <TextInput
                          style={[styles.customInput, styles.friendInput]}
                          value={splitFriend}
                          onChangeText={setSplitFriend}
                          placeholder="Friend (optional)"
                          placeholderTextColor={theme.colors.textMuted}
                        />
                        {friendNames.map(f => (
                          <TouchableOpacity key={f} style={styles.chip} onPress={() => setSplitFriend(f)}>
                            <Text style={styles.chipText}>{f.split(' ')[0]}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <View style={styles.splitLine}>
                      <Text style={styles.date}>Owes</Text>
                      {(['half', 'third', 'twoThirds'] as SplitPreset[]).map(pr => (
                        <TouchableOpacity key={pr} style={styles.chip} onPress={() => applyPreset(item, pr)}>
                          <Text style={styles.chipText}>{PRESET_LABEL[pr]}</Text>
                        </TouchableOpacity>
                      ))}
                      <TextInput
                        style={[styles.customInput, styles.amtInput]}
                        value={customAmt}
                        onChangeText={setCustomAmt}
                        keyboardType="decimal-pad"
                        placeholder="₹ custom"
                        placeholderTextColor={theme.colors.textMuted}
                        onSubmitEditing={() => applyCustom(item)}
                      />
                      <TouchableOpacity style={styles.chip} onPress={() => applyCustom(item)}>
                        <Text style={styles.chipText}>Set</Text>
                      </TouchableOpacity>
                      </View>
                      <View style={styles.splitLine}>
                      {[2, 3, 4].map(n => (
                        <TouchableOpacity key={n} style={styles.chip} onPress={() => applySplit(item, n)}>
                          <Text style={styles.chipText}>÷{n}</Text>
                        </TouchableOpacity>
                      ))}
                      <TextInput
                        style={styles.customInput}
                        value={customN}
                        onChangeText={setCustomN}
                        keyboardType="number-pad"
                        placeholder="n"
                        placeholderTextColor={theme.colors.textMuted}
                        onSubmitEditing={() => applySplit(item, parseInt(customN, 10) || null)}
                        maxLength={2}
                      />
                      {item.owed_amount ? (
                        <TouchableOpacity style={styles.chip} onPress={() => applySplit(item, null)}>
                          <Text style={styles.chipText}>Clear</Text>
                        </TouchableOpacity>
                      ) : null}
                      </View>
                    </View>
                  ) : (
                    <TouchableOpacity onPress={() => setSplitFor(item.id ?? null)}>
                      <Text style={styles.adjustLink}>{item.owed_amount ? 'Change split' : 'Split'}</Text>
                    </TouchableOpacity>
                  )}
                  {wait && !open && (
                    <TouchableOpacity onPress={() => setRepayFor(wait)}>
                      <Text style={styles.adjustLink}>Link repayment</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          );
        }}
      />

      <Modal
        visible={repayFor != null}
        transparent
        animationType="slide"
        onRequestClose={() => setRepayFor(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.splitTitle}>Who paid you back?</Text>
            {repaySuggestions.length === 0 ? (
              <Text style={styles.date}>No likely payment found yet.</Text>
            ) : (
              repaySuggestions.map(s => (
                <TouchableOpacity
                  key={s.candidate.id}
                  style={styles.creditRow}
                  onPress={() => linkSettlement(s)}
                  activeOpacity={0.7}
                >
                  <View style={styles.creditMain}>
                    <Text style={styles.merchant} numberOfLines={1}>
                      {s.candidate.counterparty ?? displayMerchant(s.candidate.merchant) ?? 'Unknown'}
                    </Text>
                    <Text style={styles.date}>{formatDate(s.candidate.timestamp)}</Text>
                    <Text style={styles.reason} numberOfLines={2}>
                      {s.reason}
                    </Text>
                  </View>
                  <AmountText
                    amount={s.candidate.amount}
                    type={s.candidate.type === 'income' ? 'income' : 'expense'}
                    size={theme.font.size.sm}
                  />
                </TouchableOpacity>
              ))
            )}
            <TouchableOpacity onPress={() => setRepayFor(null)}>
              <Text style={styles.adjustLink}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
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
    padding: theme.spacing.lg,
  },
  threeRow: { flexDirection: 'row' },
  threeCol: { flex: 1, alignItems: 'center', gap: 2 },
  threeValue: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
  },
  threeStrong: { color: theme.colors.accent, fontWeight: theme.font.weight.bold },
  totalLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
  },
  overNote: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
  waitingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
  },
  waitingText: { fontSize: theme.font.size.sm, color: theme.colors.textSecondary },
  waitingAction: {
    fontSize: theme.font.size.sm,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.semibold,
  },
  manualToggle: { marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.md },
  listContent: {
    paddingBottom: theme.spacing.xl,
  },
  row: {
    marginHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.lg,
    marginTop: theme.spacing.xs,
  },
  chip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent + '22',
  },
  chipText: {
    fontSize: theme.font.size.sm,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.semibold,
  },
  splitBlock: { gap: theme.spacing.sm },
  splitLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  friendInput: { width: 130, textAlign: 'left' },
  amtInput: { width: 72 },
  customInput: {
    width: 44,
    paddingVertical: 2,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    color: theme.colors.textPrimary,
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
  reason: {
    fontSize: theme.font.size.xs,
    color: theme.colors.accent,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    paddingBottom: 40,
    gap: theme.spacing.md,
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
    fontSize: theme.font.size.sm,
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
