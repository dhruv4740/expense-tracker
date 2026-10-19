// ─── EditTransactionScreen ────────────────────────────────────────────────────
//
// ADD (tx param absent) or EDIT (tx param present) a transaction.
// After save/delete: emits DATA_CHANGED and navigation.goBack().

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

import {
  insertManual,
  updateTransaction,
  deleteTransaction,
  queryTransactions,
  upsertMerchantRule,
  setSettlement,
  getSettlementLinks,
  getPairCandidates,
  getKnownSettlementCounterparties,
} from '../db';
import type { TransactionRow, TransactionType } from '../db';
import { GROUPED_CATEGORIES } from '../categories';
import type { Category } from '../categories';
import { isGenericMerchantKey, normalizeMerchantKey } from '../categories';
import { DATA_CHANGED, refreshSyncCaches } from '../sync';
import { suggestPairs } from '../settle';
import { promptMarkTransfer } from './markTransfer';
import { CategoryChip, Icon, SectionHeader } from '../components';
import { theme } from '../theme';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'EditTransaction'>;

type SegType = { label: string; value: TransactionType };

const TYPE_SEGMENTS: SegType[] = [
  { label: 'Debit', value: 'expense' },
  { label: 'Credit', value: 'income' },
  { label: 'Self', value: 'self' },
];

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Format epoch ms → e.g. '17 Jul 2026' */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Format epoch ms → e.g. '2:30 PM' */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function whoIs(r: { counterparty?: string | null; merchant?: string | null; source?: string | null }): string {
  return r.counterparty ?? r.merchant ?? r.source ?? 'someone';
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function EditTransactionScreen({ route, navigation }: Props) {
  const tx = route.params?.tx;
  const isEdit = tx != null;

  const [amount, setAmount] = useState(tx?.amount != null ? String(tx.amount) : '');
  const [type, setType] = useState<TransactionType>(tx?.type ?? 'expense');
  const [category, setCategory] = useState<string>(tx?.category ?? 'Other');
  const [merchant, setMerchant] = useState(tx?.merchant ?? '');
  const [note, setNote] = useState(tx?.note ?? '');
  const [timestamp, setTimestamp] = useState(tx?.timestamp ?? Date.now());
  const [applyToAll, setApplyToAll] = useState(false);

  // Pair-to-cancel links: rows that settle this one, or the row this one settles.
  const [linkTick, setLinkTick] = useState(0);
  const [showPairs, setShowPairs] = useState(false);
  const [pairSearch, setPairSearch] = useState('');
  const links = useMemo(
    () =>
      isEdit && tx?.id != null
        ? getSettlementLinks(tx.id)
        : { children: [] as TransactionRow[], parent: null as TransactionRow | null },
    // linkTick forces a re-read after a link/unlink
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isEdit, tx?.id, linkTick],
  );
  const pairable = isEdit && tx?.id != null && tx.settles_id == null && tx.type !== 'self';
  const paidSoFar = links.children
    .filter(c => c.type !== tx?.type)
    .reduce((a, c) => a + c.amount, 0);
  const pairSuggestions = useMemo(() => {
    if (!showPairs || !pairable || tx?.id == null) {
      return [];
    }
    const t = tx.type as 'expense' | 'income';
    const q = pairSearch.trim().toLowerCase();
    let candidates = getPairCandidates({ id: tx.id, type: t, timestamp: tx.timestamp });
    if (q) {
      // Search by amount ("500", "1,200") or by name/VPA/merchant.
      candidates = candidates.filter(
        c =>
          String(c.amount).includes(q.replace(/,/g, '')) ||
          `${c.counterparty ?? ''} ${c.merchant ?? ''}`.toLowerCase().includes(q),
      );
    }
    return suggestPairs(
      {
        id: tx.id,
        type: t,
        amount: tx.amount,
        timestamp: tx.timestamp,
        counterparty: tx.counterparty,
        merchant: tx.merchant,
        alreadyPaid: paidSoFar,
      },
      candidates,
      { knownCounterparties: getKnownSettlementCounterparties() },
      q ? 10 : 5,
    );
  }, [showPairs, pairable, tx, paidSoFar, pairSearch]);

  function linkPair(childId: number | undefined) {
    if (childId == null || tx?.id == null) {
      return;
    }
    setSettlement(childId, tx.id);
    DeviceEventEmitter.emit(DATA_CHANGED);
    setShowPairs(false);
    setPairSearch('');
    setLinkTick(n => n + 1);
  }

  function unlinkPair(childId: number | undefined) {
    if (childId == null) {
      return;
    }
    setSettlement(childId, null);
    DeviceEventEmitter.emit(DATA_CHANGED);
    setLinkTick(n => n + 1);
  }

  // Keyboard-safe scrolling (6a): the Note field can sit near the bottom of
  // the form and nothing lifted the screen above the keyboard, so the user
  // typed blind. Track its Y position on layout and scroll it into view on
  // focus — RN 0.86 edge-to-edge on Android 15 ignores adjustResize, so the
  // manifest setting alone doesn't fix this; KeyboardAvoidingView + manual
  // scroll-into-view does.
  const scrollRef = useRef<ScrollView>(null);
  const noteFieldY = useRef(0);
  const scrollFieldIntoView = useCallback((y: number) => {
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 120), animated: true });
  }, []);

  // Quick date shortcuts — keep the current time-of-day, only move the date.
  function setToday() {
    const now = new Date();
    const original = new Date(timestamp);
    now.setHours(original.getHours(), original.getMinutes(), 0, 0);
    setTimestamp(now.getTime());
  }

  function setYesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const original = new Date(timestamp);
    d.setHours(original.getHours(), original.getMinutes(), 0, 0);
    setTimestamp(d.getTime());
  }

  // Native calendar / clock dialogs (Android). Each merges the picked
  // date-or-time part into the current timestamp, leaving the other part
  // untouched — picking a new date shouldn't reset the time and vice versa.
  function openDatePicker() {
    DateTimePickerAndroid.open({
      value: new Date(timestamp),
      mode: 'date',
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
  }

  function openTimePicker() {
    DateTimePickerAndroid.open({
      value: new Date(timestamp),
      mode: 'time',
      is24Hour: false,
      onChange: (event, selected) => {
        if (event.type !== 'set' || !selected) {
          return;
        }
        setTimestamp(prev => {
          const d = new Date(prev);
          d.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
          return d.getTime();
        });
      },
    });
  }

  const handleSave = useCallback(() => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount greater than 0.');
      return;
    }

    const merchantTrimmed = merchant.trim() || null;
    const noteTrimmed = note.trim() || null;

    if (isEdit && tx.id != null) {
      // EDIT
      const changed: Partial<TransactionRow> = {
        amount: amountNum,
        type,
        category,
        merchant: merchantTrimmed,
        timestamp,
        note: noteTrimmed,
      };

      const categoryChanged = category !== tx.category;
      if (categoryChanged) {
        changed.category_source = 'manual';
      }

      updateTransaction(tx.id, changed);

      // A one-off category edit must NOT teach a rule — tagging a single UPI
      // credit from a friend as Uber would otherwise silently recategorize
      // everything from that person forever. Only "apply to all" opts into
      // learning + backfilling matching rows.
      if (categoryChanged && applyToAll) {
        const key = normalizeMerchantKey(merchantTrimmed, tx.counterparty ?? null);
        // A bare few-digit key (e.g. an account fragment) matches far too
        // broadly across unrelated transactions from the same bank to be
        // safe to learn as a rule.
        if (key != null && !isGenericMerchantKey(key)) {
          upsertMerchantRule(key, category);
          refreshSyncCaches();

          const matchingRows = queryTransactions({
            search: merchantTrimmed ?? undefined,
            includeSelf: true,
          });
          for (const row of matchingRows) {
            if (
              row.id != null &&
              row.id !== tx.id &&
              normalizeMerchantKey(row.merchant ?? null, row.counterparty ?? null) === key
            ) {
              updateTransaction(row.id, { category, category_source: 'manual' });
            }
          }
        }
      }
    } else {
      // ADD
      insertManual({
        amount: amountNum,
        merchant: merchantTrimmed,
        category: category as Category,
        timestamp,
        type,
        counterparty: tx?.counterparty ?? null,
        account: null,
        note: noteTrimmed,
        raw_text: null,
      });

    }

    DeviceEventEmitter.emit(DATA_CHANGED);
    navigation.goBack();
  }, [
    amount,
    type,
    category,
    merchant,
    note,
    timestamp,
    isEdit,
    tx,
    applyToAll,
    navigation,
  ]);

  const handleDelete = useCallback(() => {
    if (!isEdit || tx?.id == null) {
      return;
    }
    Alert.alert(
      'Delete transaction',
      'This cannot be undone. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteTransaction(tx.id!);
            DeviceEventEmitter.emit(DATA_CHANGED);
            navigation.goBack();
          },
        },
      ],
    );
  }, [isEdit, tx, navigation]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={Platform.select({ ios: 0, android: 0 })}
    >
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Amount */}
      <SectionHeader title="Amount (₹)" />
      <View style={styles.card}>
        <TextInput
          style={styles.amountInput}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={theme.colors.textMuted}
          autoFocus={!isEdit}
        />
      </View>

      {/* Type */}
      <SectionHeader title="Type" />
      <View style={styles.card}>
        <View style={styles.segRow}>
          {TYPE_SEGMENTS.map(seg => (
            <TouchableOpacity
              key={seg.value}
              style={[
                styles.segment,
                type === seg.value ? styles.segmentActive : undefined,
              ]}
              onPress={() => setType(seg.value)}
            >
              <Text
                style={[
                  styles.segmentText,
                  type === seg.value ? styles.segmentTextActive : undefined,
                ]}
              >
                {seg.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      {isEdit && tx?.id != null && type !== 'self' && tx.settles_id == null && (
        <TouchableOpacity
          style={styles.unlinkBtn}
          onPress={() => promptMarkTransfer(tx, () => navigation.goBack())}
          activeOpacity={0.8}
        >
          <Text style={styles.unlinkText}>Mark as transfer to self</Text>
        </TouchableOpacity>
      )}

      {/* Category */}
      <SectionHeader title="Category" />
      {GROUPED_CATEGORIES.map(({ group, categories }) => (
        <View key={group}>
          <Text style={styles.groupLabel}>{group.toUpperCase()}</Text>
          <View style={[styles.card, styles.catCard]}>
            {categories.map(cat => (
              <TouchableOpacity
                key={cat}
                onPress={() => setCategory(cat)}
                style={[
                  styles.catChip,
                  category === cat ? styles.catChipActive : undefined,
                ]}
              >
                <CategoryChip category={cat} small />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}

      {/* Merchant */}
      <SectionHeader title="Merchant" />
      <View style={styles.card}>
        <TextInput
          style={styles.textInput}
          value={merchant}
          onChangeText={setMerchant}
          placeholder="Merchant name"
          placeholderTextColor={theme.colors.textMuted}
          returnKeyType="next"
        />
      </View>

      {/* Date */}
      <SectionHeader title="Date & Time" />
      <View style={styles.card}>
        <View style={styles.dateTimeRow}>
          <TouchableOpacity style={styles.dateTimeBtn} onPress={openDatePicker}>
            <Icon name="calendar" size={16} color={theme.colors.accent} />
            <Text style={styles.dateTimeText}>{formatDate(timestamp)}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dateTimeBtn} onPress={openTimePicker}>
            <Text style={styles.dateTimeText}>{formatTime(timestamp)}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.dateShortcuts}>
          <TouchableOpacity style={styles.shortcutBtn} onPress={setToday}>
            <Text style={styles.shortcutText}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.shortcutBtn} onPress={setYesterday}>
            <Text style={styles.shortcutText}>Yesterday</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Settlement link — shown only when this row settles another one.
          Every link MUST be undoable here: a settled row is excluded from
          spend/income totals, and an exclusion the user can't find or reverse
          is indistinguishable from lost data. */}
      {tx?.settles_id != null && (
        <>
          <SectionHeader title="Settlement" />
          <View style={styles.card}>
            <Text style={styles.settlementText}>
              {links.parent
                ? `Cancels ${rupees(tx.amount)} ${
                    tx.type === 'income' ? 'payment to' : 'received from'
                  } ${whoIs(links.parent)}`
                : 'This payment is linked to another transaction, so it isn’t counted as separate spending.'}
            </Text>
            <TouchableOpacity
              style={styles.unlinkBtn}
              onPress={() => {
                if (tx?.id != null) {
                  setSettlement(tx.id, null);
                  DeviceEventEmitter.emit(DATA_CHANGED);
                  navigation.goBack();
                }
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.unlinkText}>Unlink — count it on its own</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Pair-to-cancel: repayments that net against this row. */}
      {pairable && (
        <>
          <SectionHeader title="Repayments" />
          <View style={styles.card}>
            {links.children.map(c => (
              <View key={c.id} style={styles.pairRow}>
                <Text style={[styles.settlementText, styles.pairText]}>
                  {c.type !== tx?.type ? 'Paid back' : 'Linked'} {rupees(c.amount)} by {whoIs(c)}
                </Text>
                <TouchableOpacity onPress={() => unlinkPair(c.id)}>
                  <Text style={styles.unlinkText}>Unlink</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              style={styles.unlinkBtn}
              onPress={() => setShowPairs(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.unlinkText}>Cancel out with a repayment</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      <Modal
        visible={showPairs}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPairs(false)}
      >
        <View style={styles.pairOverlay}>
          <View style={styles.pairSheet}>
            <Text style={styles.pairTitle}>Cancel out with…</Text>
            <TextInput
              style={styles.pairSearch}
              value={pairSearch}
              onChangeText={setPairSearch}
              placeholder="Search by amount or name"
              placeholderTextColor={theme.colors.textMuted}
              autoCorrect={false}
            />
            {pairSuggestions.length === 0 ? (
              <Text style={styles.settlementText}>
                No matching {tx?.type === 'income' ? 'debit' : 'credit'} found{pairSearch.trim() ? ' for that search' : ''}.
              </Text>
            ) : (
              pairSuggestions.map(sug => (
                <TouchableOpacity
                  key={sug.candidate.id}
                  style={styles.pairCand}
                  onPress={() => linkPair(sug.candidate.id)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pairCandMain}>
                    {rupees(sug.candidate.amount)} · {whoIs(sug.candidate)}
                  </Text>
                  <Text style={styles.pairCandSub}>
                    {formatDate(sug.candidate.timestamp)} · {sug.reason}
                  </Text>
                </TouchableOpacity>
              ))
            )}
            <TouchableOpacity style={styles.unlinkBtn} onPress={() => { setShowPairs(false); setPairSearch(''); }}>
              <Text style={styles.unlinkText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Note */}
      <SectionHeader title="Note (optional)" />
      <View
        style={styles.card}
        onLayout={e => { noteFieldY.current = e.nativeEvent.layout.y; }}
      >
        <TextInput
          style={[styles.textInput, styles.noteInput]}
          value={note}
          onChangeText={setNote}
          onFocus={() => scrollFieldIntoView(noteFieldY.current)}
          placeholder="Add a note…"
          placeholderTextColor={theme.colors.textMuted}
          multiline
          returnKeyType="done"
        />
      </View>

      {/* Apply category to all matching (edit only, category changed) */}
      {isEdit && (
        <View style={[styles.card, styles.toggleRow]}>
          <Text style={styles.toggleLabel}>
            Always use this category for this merchant
          </Text>
          <Switch
            value={applyToAll}
            onValueChange={setApplyToAll}
            trackColor={{ true: theme.colors.accent, false: theme.colors.surfaceAlt }}
            thumbColor={theme.colors.textPrimary}
          />
        </View>
      )}

      {/* Save button */}
      <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
        <Text style={styles.saveBtnText}>{isEdit ? 'Save Changes' : 'Add Transaction'}</Text>
      </TouchableOpacity>

      {/* Delete button (edit only) */}
      {isEdit && (
        <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
          <Text style={styles.deleteBtnText}>Delete Transaction</Text>
        </TouchableOpacity>
      )}

      <View style={styles.bottomPad} />
    </ScrollView>
    </KeyboardAvoidingView>
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
  card: {
    backgroundColor: theme.colors.surface,
    marginHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  amountInput: {
    fontSize: theme.font.size.xxl,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    padding: theme.spacing.sm,
  },
  segRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  segment: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  segmentActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent + '22',
  },
  segmentText: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
    fontWeight: theme.font.weight.medium,
  },
  segmentTextActive: {
    color: theme.colors.accent,
  },
  groupLabel: {
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textMuted,
    letterSpacing: 1.1,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
    marginLeft: theme.spacing.md,
  },
  catCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  catChip: {
    opacity: 0.5,
  },
  catChipActive: {
    opacity: 1,
  },
  textInput: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    padding: 0,
    paddingVertical: theme.spacing.sm,
  },
  settlementText: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
  },
  unlinkBtn: {
    alignSelf: 'flex-start',
    paddingVertical: theme.spacing.xs,
  },
  unlinkText: {
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.accent,
  },
  pairRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pairText: {
    flex: 1,
    marginRight: theme.spacing.md,
  },
  pairOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  pairSheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    paddingBottom: 40,
  },
  pairSearch: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
    color: theme.colors.textPrimary,
  },
  pairTitle: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
  },
  pairCand: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  pairCandMain: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
  },
  pairCandSub: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  noteInput: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  dateTimeRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  dateTimeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.sm + 2,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dateTimeText: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
  },
  dateShortcuts: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  shortcutBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  shortcutText: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textSecondary,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  toggleLabel: {
    flex: 1,
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
    marginRight: theme.spacing.md,
  },
  saveBtn: {
    margin: theme.spacing.lg,
    marginTop: theme.spacing.xl,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#000',
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.bold,
  },
  deleteBtn: {
    marginHorizontal: theme.spacing.lg,
    padding: theme.spacing.md,
    alignItems: 'center',
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.danger,
  },
  deleteBtnText: {
    color: theme.colors.danger,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  bottomPad: {
    height: theme.spacing.xxl,
  },
});
