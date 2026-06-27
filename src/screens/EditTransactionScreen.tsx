// ─── EditTransactionScreen ────────────────────────────────────────────────────
//
// ADD (tx param absent) or EDIT (tx param present) a transaction.
// After save/delete: emits DATA_CHANGED and navigation.goBack().

import React, { useCallback, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

import {
  insertManual,
  updateTransaction,
  deleteTransaction,
  queryTransactions,
  upsertMerchantRule,
} from '../db';
import type { TransactionRow, TransactionType } from '../db';
import { CATEGORIES } from '../categories';
import type { Category } from '../categories';
import { normalizeMerchantKey } from '../categories';
import { DATA_CHANGED, refreshSyncCaches } from '../sync';
import { CategoryChip, SectionHeader } from '../components';
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

/** Format epoch ms → 'YYYY-MM-DD HH:mm' */
function tsToString(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse 'YYYY-MM-DD HH:mm' → epoch ms, returns NaN on failure */
function stringToTs(s: string): number {
  const trimmed = s.trim();
  // accept 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm'
  const [datePart, timePart = '00:00'] = trimmed.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);
  if (
    isNaN(year) ||
    isNaN(month) ||
    isNaN(day) ||
    isNaN(hours) ||
    isNaN(minutes)
  ) {
    return NaN;
  }
  return new Date(year, month - 1, day, hours, minutes).getTime();
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
  const [dateStr, setDateStr] = useState(tsToString(tx?.timestamp ?? Date.now()));
  const [applyToAll, setApplyToAll] = useState(false);

  // Quick date shortcuts
  function setToday() {
    const now = new Date();
    const original = new Date(tx?.timestamp ?? Date.now());
    now.setHours(original.getHours(), original.getMinutes(), 0, 0);
    setDateStr(tsToString(now.getTime()));
  }

  function setYesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const original = new Date(tx?.timestamp ?? Date.now());
    d.setHours(original.getHours(), original.getMinutes(), 0, 0);
    setDateStr(tsToString(d.getTime()));
  }

  const handleSave = useCallback(() => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount greater than 0.');
      return;
    }

    const timestamp = stringToTs(dateStr);
    if (isNaN(timestamp)) {
      Alert.alert(
        'Invalid date',
        'Enter date as YYYY-MM-DD or YYYY-MM-DD HH:mm',
      );
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

      if (categoryChanged) {
        const key = normalizeMerchantKey(merchantTrimmed, tx.counterparty ?? null);
        if (key != null) {
          upsertMerchantRule(key, category);
          refreshSyncCaches();

          // Optionally apply to all matching transactions
          if (applyToAll) {
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
    dateStr,
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
    <ScrollView
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

      {/* Category */}
      <SectionHeader title="Category" />
      <View style={[styles.card, styles.catCard]}>
        {CATEGORIES.map(cat => (
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
        <TextInput
          style={styles.textInput}
          value={dateStr}
          onChangeText={setDateStr}
          placeholder="YYYY-MM-DD HH:mm"
          placeholderTextColor={theme.colors.textMuted}
          keyboardType="default"
          returnKeyType="next"
        />
        <View style={styles.dateShortcuts}>
          <TouchableOpacity style={styles.shortcutBtn} onPress={setToday}>
            <Text style={styles.shortcutText}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.shortcutBtn} onPress={setYesterday}>
            <Text style={styles.shortcutText}>Yesterday</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Note */}
      <SectionHeader title="Note (optional)" />
      <View style={styles.card}>
        <TextInput
          style={[styles.textInput, styles.noteInput]}
          value={note}
          onChangeText={setNote}
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
            Apply this category to all from this merchant
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
  noteInput: {
    minHeight: 64,
    textAlignVertical: 'top',
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
