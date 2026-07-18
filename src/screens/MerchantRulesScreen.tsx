// ─── MerchantRulesScreen ──────────────────────────────────────────────────────
//
// Lists every learned merchant_rules entry so the user can see and delete
// whatever categorize() is silently applying. Existed to catch cases like the
// generic-numeric-key bug (see categories.ts isGenericMerchantKey) before it
// causes another round of mysterious mis-categorization.

import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { getAllMerchantRules, deleteMerchantRule, upsertMerchantRule } from '../db';
import { CATEGORY_META, GROUPED_CATEGORIES, isGenericMerchantKey } from '../categories';
import type { Category } from '../categories';
import { refreshSyncCaches } from '../sync';
import { Card, EmptyState, Icon, SectionHeader } from '../components';
import { theme } from '../theme';

interface RuleRow {
  key: string;
  category: string;
}

export default function MerchantRulesScreen() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [editing, setEditing] = useState<RuleRow | null>(null);

  const load = useCallback(() => {
    const map = getAllMerchantRules();
    const rows = Object.entries(map)
      .map(([key, category]) => ({ key, category }))
      .sort((a, b) => a.key.localeCompare(b.key));
    setRules(rows);
  }, []);

  useFocusEffect(load);

  function handleDelete(key: string) {
    Alert.alert(
      'Delete rule',
      `Stop auto-categorizing transactions keyed "${key}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteMerchantRule(key);
            refreshSyncCaches();
            load();
          },
        },
      ],
    );
  }

  function handlePickCategory(cat: Category) {
    if (!editing) {
      return;
    }
    upsertMerchantRule(editing.key, cat);
    refreshSyncCaches();
    setEditing(null);
    load();
  }

  return (
    <View style={styles.container}>
      <SectionHeader
        title={`${rules.length} learned rule${rules.length !== 1 ? 's' : ''}`}
      />
      {rules.length === 0 ? (
        <EmptyState
          icon="list"
          title="No learned rules yet"
          subtitle="Rules are created when you recategorize a transaction and choose 'All from this merchant'."
        />
      ) : (
        <FlatList
          data={rules}
          keyExtractor={r => r.key}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <Card style={styles.ruleCard}>
              <TouchableOpacity
                style={styles.ruleMain}
                onPress={() => setEditing(item)}
                activeOpacity={0.7}
              >
                {isGenericMerchantKey(item.key) && (
                  <Text style={styles.warningBadge}>⚠</Text>
                )}
                <Text style={styles.ruleKey} numberOfLines={1}>
                  {item.key}
                </Text>
                <View
                  style={[
                    styles.catDot,
                    {
                      backgroundColor:
                        CATEGORY_META[item.category as Category]?.color ??
                        theme.colors.textMuted,
                    },
                  ]}
                />
                <Text style={styles.ruleCategory}>{item.category}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => handleDelete(item.key)}
                hitSlop={8}
              >
                <Icon name="trash" size={18} color={theme.colors.danger} />
              </TouchableOpacity>
            </Card>
          )}
        />
      )}

      {/* ── Category picker for editing a rule's category ── */}
      <Modal
        visible={editing != null}
        transparent
        animationType="slide"
        onRequestClose={() => setEditing(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Change category</Text>
            {editing && (
              <Text style={styles.sheetSub} numberOfLines={1}>
                {editing.key}
              </Text>
            )}
            <ScrollView style={styles.catList} showsVerticalScrollIndicator={false}>
              {GROUPED_CATEGORIES.map(({ group, categories }) => (
                <View key={group}>
                  <Text style={styles.groupLabel}>{group.toUpperCase()}</Text>
                  {categories.map(cat => (
                    <TouchableOpacity
                      key={cat}
                      style={styles.catRow}
                      onPress={() => handlePickCategory(cat)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.catRowDot, { backgroundColor: CATEGORY_META[cat].color }]} />
                      <Text style={styles.catLabel}>{cat}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditing(null)}>
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
  listContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  ruleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  ruleMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  warningBadge: {
    fontSize: theme.font.size.sm,
    color: theme.colors.warning,
  },
  ruleKey: {
    flex: 1,
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
  },
  catDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  ruleCategory: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
  },
  deleteBtn: {
    padding: theme.spacing.xs,
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
  groupLabel: {
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textMuted,
    letterSpacing: 1.1,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  catRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing.md,
  },
  catRowDot: {
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
  },
  cancelText: {
    fontSize: theme.font.size.md,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
  },
});
