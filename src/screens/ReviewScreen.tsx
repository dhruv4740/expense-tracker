// ─── ReviewScreen ─────────────────────────────────────────────────────────────
//
// Review queue for transactions that landed in "Other" (uncategorized).
// Tapping a row opens a category picker; the choice is saved both to the
// transaction row and to merchant_rules so future transactions auto-apply.
// Users can also apply the category to ALL past transactions from that merchant.

import React, { useCallback, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import {
  queryTransactions,
  updateTransaction,
  upsertMerchantRule,
} from '../db';
import type { TransactionRow } from '../db';
import { CATEGORIES } from '../categories';
import type { Category } from '../categories';
import { CATEGORY_META } from '../categories';
import { isGenericMerchantKey, normalizeMerchantKey } from '../categories';
import { DATA_CHANGED } from '../sync';
import { AmountText, Card, EmptyState, SectionHeader } from '../components';
import { theme } from '../theme';
import { formatDate } from '../dates';

export default function ReviewScreen() {
  const [items, setItems] = useState<TransactionRow[]>([]);
  const [selected, setSelected] = useState<TransactionRow | null>(null);

  const load = useCallback(() => {
    // Match getUncategorizedCount's predicate exactly (expenses only) so the
    // Dashboard banner count and this list never disagree.
    const rows = queryTransactions({
      categories: ['Other'],
      types: ['expense'],
      includeSelf: false,
    });
    setItems(rows);
  }, []);

  useFocusEffect(load);

  function handlePickCategory(cat: Category) {
    if (!selected) {
      return;
    }
    const tx = selected;
    setSelected(null);

    Alert.alert(
      `Set category to "${cat}"`,
      'Apply to this transaction only, or to all past transactions from this merchant?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'This one',
          onPress: () => {
            updateTransaction(tx.id!, { category: cat, category_source: 'manual' });
            DeviceEventEmitter.emit(DATA_CHANGED);
            load();
          },
        },
        {
          text: 'All from this merchant',
          onPress: () => {
            const merchantKey = normalizeMerchantKey(
              tx.merchant ?? tx.counterparty ?? tx.source ?? '',
              tx.counterparty ?? '',
            );
            // A bare few-digit key (e.g. an account fragment) matches far
            // too broadly across unrelated transactions from the same bank
            // to be safe to learn as a rule.
            if (!merchantKey || isGenericMerchantKey(merchantKey)) { return; }
            upsertMerchantRule(merchantKey, cat);
            // Bulk update all past "Other" rows with same merchant/counterparty
            const toUpdate = queryTransactions({
              categories: ['Other'],
              includeSelf: true,
            }).filter(
              r =>
                (r.merchant ?? r.counterparty ?? r.source ?? '') ===
                (tx.merchant ?? tx.counterparty ?? tx.source ?? ''),
            );
            for (const r of toUpdate) {
              updateTransaction(r.id!, { category: cat, category_source: 'manual' });
            }
            DeviceEventEmitter.emit(DATA_CHANGED);
            load();
          },
        },
      ],
    );
  }

  return (
    <View style={styles.container}>
      <SectionHeader
        title={`${items.length} transaction${items.length !== 1 ? 's' : ''} to review`}
      />
      <FlatList
        data={items}
        keyExtractor={item => String(item.id)}
        removeClippedSubviews
        initialNumToRender={20}
        ListEmptyComponent={
          <EmptyState icon="checkmark-circle" title="All caught up!" subtitle="No uncategorized transactions." />
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => setSelected(item)} activeOpacity={0.7}>
            <View style={styles.rowMain}>
              <Text style={styles.merchant} numberOfLines={1}>
                {item.merchant ?? item.counterparty ?? item.source ?? 'Unknown'}
              </Text>
              <Text style={styles.date}>{formatDate(item.timestamp)}</Text>
            </View>
            <View style={styles.rowRight}>
              <AmountText amount={item.amount} type={item.type} size={theme.font.size.md} />
              <Text style={styles.tapHint}>Tap to categorize →</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      {/* ── Category picker modal ── */}
      <Modal
        visible={selected != null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Choose a category</Text>
            {selected && (
              <Text style={styles.sheetSub} numberOfLines={1}>
                {selected.merchant ?? selected.counterparty ?? 'Transaction'} · ₹
                {selected.amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </Text>
            )}
            <ScrollView style={styles.catList} showsVerticalScrollIndicator={false}>
              {(CATEGORIES as Category[]).map(cat => (
                <TouchableOpacity
                  key={cat}
                  style={styles.catRow}
                  onPress={() => handlePickCategory(cat)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.catDot, { backgroundColor: CATEGORY_META[cat].color }]} />
                  <Text style={styles.catLabel}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setSelected(null)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
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
  rowRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  tapHint: {
    fontSize: 9,
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
    maxHeight: '75%',
  },
  sheetTitle: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xs,
  },
  sheetSub: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.md,
  },
  catList: {
    maxHeight: 400,
  },
  catRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing.md,
  },
  catDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  catLabel: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
  },
  cancelBtn: {
    marginTop: theme.spacing.md,
    padding: theme.spacing.md,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
  },
  cancelText: {
    color: theme.colors.textSecondary,
    fontWeight: theme.font.weight.medium,
  },
});
