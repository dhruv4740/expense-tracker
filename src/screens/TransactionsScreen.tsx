// ─── TransactionsScreen ───────────────────────────────────────────────────────
//
// SectionList of transactions grouped by day, with search + filter modal.
// Perf: memoised renderItem, keyExtractor, SectionList windowing.
// Self-transfers hidden by default; togglable via filter.

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  DeviceEventEmitter,
  Modal,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SectionListData } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

import {
  deleteTransaction,
  queryTransactions,
} from '../db';
import type { TransactionRow, TransactionType, TransactionFilters } from '../db';
import { GROUPED_CATEGORIES } from '../categories';
import { DATA_CHANGED } from '../sync';
import {
  AmountText,
  CategoryChip,
  EmptyState,
  Fab,
  Icon,
  SectionHeader,
} from '../components';
import { theme } from '../theme';
import { formatDate, groupByDay, monthRange, lastNDaysRange } from '../dates';

// ─── Types ────────────────────────────────────────────────────────────────────

type Section = { title: string; data: TransactionRow[] };

type DatePreset = 'month' | 'lastmonth' | 'last30' | 'all';

interface FilterState {
  search: string;
  datePreset: DatePreset;
  selectedCategories: string[];
  selectedTypes: TransactionType[];
  showSelf: boolean;
  amountMin: string;
  amountMax: string;
}

interface Props {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Tabs'>;
}

// ─── Row component (memoised for SectionList perf) ────────────────────────────

const TxRow = React.memo(function TxRow({
  item,
  onPress,
  onLongPress,
}: {
  item: TransactionRow;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const displayName =
    item.merchant ?? item.counterparty ?? item.source ?? 'Unknown';
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      <CategoryChip category={item.category} small />
      <View style={styles.rowMid}>
        <View style={styles.merchantRow}>
          <Text style={styles.merchant} numberOfLines={1}>
            {displayName}
          </Text>
          {item.type === 'self' && (
            <View style={styles.selfBadge}>
              <Text style={styles.selfBadgeText}>Self</Text>
            </View>
          )}
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>
          {formatDate(item.timestamp)}
        </Text>
      </View>
      <AmountText amount={item.amount} type={item.type} size={theme.font.size.md} />
    </TouchableOpacity>
  );
});

// ─── Filter Modal ─────────────────────────────────────────────────────────────

const DATE_PRESETS: { label: string; value: DatePreset }[] = [
  { label: 'This month', value: 'month' },
  { label: 'Last month', value: 'lastmonth' },
  { label: 'Last 30 days', value: 'last30' },
  { label: 'All time', value: 'all' },
];

const TYPE_OPTIONS: { label: string; value: TransactionType }[] = [
  { label: 'Debit', value: 'expense' },
  { label: 'Credit', value: 'income' },
  { label: 'Self', value: 'self' },
];

const FilterModal = React.memo(function FilterModal({
  visible,
  filter,
  onClose,
  onApply,
}: {
  visible: boolean;
  filter: FilterState;
  onClose: () => void;
  onApply: (f: FilterState) => void;
}) {
  const [local, setLocal] = useState<FilterState>(filter);

  useEffect(() => {
    if (visible) {
      setLocal(filter);
    }
  }, [visible, filter]);

  function toggleCategory(cat: string) {
    setLocal(prev => ({
      ...prev,
      selectedCategories: prev.selectedCategories.includes(cat)
        ? prev.selectedCategories.filter(c => c !== cat)
        : [...prev.selectedCategories, cat],
    }));
  }

  function toggleType(t: TransactionType) {
    setLocal(prev => ({
      ...prev,
      selectedTypes: prev.selectedTypes.includes(t)
        ? prev.selectedTypes.filter(x => x !== t)
        : [...prev.selectedTypes, t],
    }));
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={fStyles.overlay}>
        <View style={fStyles.sheet}>
          <View style={fStyles.header}>
            <Text style={fStyles.title}>Filter</Text>
            <TouchableOpacity onPress={onClose}>
              <Icon name="close" size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={fStyles.scrollBody} showsVerticalScrollIndicator={false}>
          <Text style={fStyles.sectionLabel}>DATE RANGE</Text>
          <View style={fStyles.chips}>
            {DATE_PRESETS.map(p => (
              <TouchableOpacity
                key={p.value}
                style={[
                  fStyles.chip,
                  local.datePreset === p.value ? fStyles.chipActive : undefined,
                ]}
                onPress={() => setLocal(prev => ({ ...prev, datePreset: p.value }))}
              >
                <Text
                  style={[
                    fStyles.chipText,
                    local.datePreset === p.value ? fStyles.chipTextActive : undefined,
                  ]}
                >
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={fStyles.sectionLabel}>CATEGORIES</Text>
          {GROUPED_CATEGORIES.map(({ group, categories }) => (
            <View key={group}>
              <Text style={fStyles.groupLabel}>{group}</Text>
              <View style={fStyles.chips}>
                {categories.map(cat => (
                  <TouchableOpacity
                    key={cat}
                    style={[
                      fStyles.chip,
                      local.selectedCategories.includes(cat) ? fStyles.chipActive : undefined,
                    ]}
                    onPress={() => toggleCategory(cat)}
                  >
                    <Text
                      style={[
                        fStyles.chipText,
                        local.selectedCategories.includes(cat)
                          ? fStyles.chipTextActive
                          : undefined,
                      ]}
                    >
                      {cat}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}

          <Text style={fStyles.sectionLabel}>TYPE</Text>
          <View style={fStyles.chips}>
            {TYPE_OPTIONS.map(t => (
              <TouchableOpacity
                key={t.value}
                style={[
                  fStyles.chip,
                  local.selectedTypes.includes(t.value) ? fStyles.chipActive : undefined,
                ]}
                onPress={() => toggleType(t.value)}
              >
                <Text
                  style={[
                    fStyles.chipText,
                    local.selectedTypes.includes(t.value)
                      ? fStyles.chipTextActive
                      : undefined,
                  ]}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={fStyles.toggleRow}>
            <Text style={fStyles.toggleLabel}>Show self-transfers</Text>
            <Switch
              value={local.showSelf}
              onValueChange={v => setLocal(prev => ({ ...prev, showSelf: v }))}
              trackColor={{ true: theme.colors.accent, false: theme.colors.surfaceAlt }}
              thumbColor={theme.colors.textPrimary}
            />
          </View>

          <Text style={fStyles.sectionLabel}>Amount Range (₹)</Text>
          <View style={fStyles.amountRow}>
            <TextInput
              style={fStyles.amountInput}
              placeholder="Min"
              placeholderTextColor={theme.colors.textMuted}
              keyboardType="numeric"
              value={local.amountMin}
              onChangeText={v => setLocal(prev => ({ ...prev, amountMin: v }))}
            />
            <Text style={fStyles.amountSep}>–</Text>
            <TextInput
              style={fStyles.amountInput}
              placeholder="Max"
              placeholderTextColor={theme.colors.textMuted}
              keyboardType="numeric"
              value={local.amountMax}
              onChangeText={v => setLocal(prev => ({ ...prev, amountMax: v }))}
            />
          </View>
          </ScrollView>

          <View style={fStyles.actions}>
            <TouchableOpacity
              style={fStyles.resetBtn}
              onPress={() =>
                setLocal({
                  search: local.search,
                  datePreset: 'month',
                  selectedCategories: [],
                  selectedTypes: [],
                  showSelf: true,
                  amountMin: '',
                  amountMax: '',
                })
              }
            >
              <Text style={fStyles.resetText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={fStyles.applyBtn}
              onPress={() => onApply(local)}
            >
              <Text style={fStyles.applyText}>Apply</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildFilters(f: FilterState): TransactionFilters {
  const now = Date.now();
  let from: number | undefined;
  let to: number | undefined;

  if (f.datePreset === 'month') {
    const r = monthRange();
    from = r.from;
    to = r.to;
  } else if (f.datePreset === 'lastmonth') {
    const d = new Date();
    const year = d.getFullYear();
    const month = d.getMonth();
    from = new Date(year, month - 1, 1).getTime();
    to = new Date(year, month, 0, 23, 59, 59, 999).getTime();
  } else if (f.datePreset === 'last30') {
    const r = lastNDaysRange(30);
    from = r.from;
    to = r.to;
  }

  const amountMinNum = parseFloat(f.amountMin);
  const amountMaxNum = parseFloat(f.amountMax);

  return {
    from,
    to: to ?? now,
    categories:
      f.selectedCategories.length > 0 ? f.selectedCategories : undefined,
    types: f.selectedTypes.length > 0 ? f.selectedTypes : undefined,
    search: f.search.trim() || undefined,
    includeSelf: f.showSelf,
    amountMin: !isNaN(amountMinNum) ? amountMinNum : undefined,
    amountMax: !isNaN(amountMaxNum) ? amountMaxNum : undefined,
  };
}

const DEFAULT_FILTER: FilterState = {
  search: '',
  datePreset: 'month',
  selectedCategories: [],
  selectedTypes: [],
  showSelf: true,
  amountMin: '',
  amountMax: '',
};

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function TransactionsScreen({ navigation }: Props) {
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [sections, setSections] = useState<Section[]>([]);
  const [showFilter, setShowFilter] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    const rows = queryTransactions(buildFilters(filter));
    setSections(groupByDay(rows));
    setRefreshing(false);
  }, [filter]);

  const load = useCallback((f: FilterState) => {
    const rows = queryTransactions(buildFilters(f));
    setSections(groupByDay(rows));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(filter);
    }, [load, filter]),
  );

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, () => load(filter));
    return () => sub.remove();
  }, [load, filter]);

  function handleSearchChange(text: string) {
    const newFilter = { ...filter, search: text };
    setFilter(newFilter);
    if (debounceRef.current != null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      load(newFilter);
    }, 250);
  }

  function handleApplyFilter(f: FilterState) {
    setFilter(f);
    setShowFilter(false);
    load(f);
  }

  const handlePress = useCallback(
    (item: TransactionRow) => {
      navigation.navigate('EditTransaction', { tx: item });
    },
    [navigation],
  );

  const handleLongPress = useCallback(
    (item: TransactionRow) => {
      Alert.alert(
        item.merchant ?? 'Transaction',
        'What would you like to do?',
        [
          {
            text: 'Edit',
            onPress: () => navigation.navigate('EditTransaction', { tx: item }),
          },
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
        ],
      );
    },
    [navigation],
  );

  const keyExtractor = useCallback(
    (item: TransactionRow) => String(item.id),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: TransactionRow }) => (
      <TxRow
        item={item}
        onPress={() => handlePress(item)}
        onLongPress={() => handleLongPress(item)}
      />
    ),
    [handlePress, handleLongPress],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<TransactionRow, Section> }) => (
      <SectionHeader title={section.title} />
    ),
    [],
  );

  const ListEmpty = useCallback(
    () => (
      <EmptyState
        icon="list"
        title="No transactions"
        subtitle="Transactions matching your filters will appear here."
      />
    ),
    [],
  );

  return (
    <View style={styles.container}>
      {/* Search + filter bar */}
      <View style={styles.searchBar}>
        <Icon name="search" size={18} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={filter.search}
          onChangeText={handleSearchChange}
          placeholder="Search transactions…"
          placeholderTextColor={theme.colors.textMuted}
          returnKeyType="search"
        />
        <TouchableOpacity onPress={() => setShowFilter(true)} style={styles.filterBtn}>
          <Icon name="filter" size={20} color={theme.colors.accent} />
        </TouchableOpacity>
      </View>

      <SectionList<TransactionRow, Section>
        sections={sections}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        ListEmptyComponent={ListEmpty}
        stickySectionHeadersEnabled={false}
        removeClippedSubviews
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        contentContainerStyle={
          sections.length === 0 ? styles.emptyContainer : styles.listContent
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
          />
        }
      />

      <Fab onPress={() => navigation.navigate('EditTransaction', {})} />

      <FilterModal
        visible={showFilter}
        filter={filter}
        onClose={() => setShowFilter(false)}
        onApply={handleApplyFilter}
      />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    margin: theme.spacing.md,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    padding: 0,
  },
  filterBtn: {
    padding: theme.spacing.xs,
  },
  listContent: {
    paddingBottom: 80,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.bg,
  },
  rowMid: {
    flex: 1,
    gap: 2,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  merchant: {
    flex: 1,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
    color: theme.colors.textPrimary,
  },
  selfBadge: {
    backgroundColor: theme.colors.self + '33',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  selfBadgeText: {
    fontSize: 9,
    color: theme.colors.self,
    fontWeight: theme.font.weight.bold,
  },
  rowSub: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
  },
});

const fStyles = StyleSheet.create({
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
    paddingBottom: 36,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  scrollBody: {
    flex: 1,
  },
  title: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
  },
  sectionLabel: {
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textMuted,
    letterSpacing: 1.1,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  groupLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent + '22',
  },
  chipText: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textSecondary,
  },
  chipTextActive: {
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.lg,
  },
  toggleLabel: {
    fontSize: theme.font.size.md,
    color: theme.colors.textSecondary,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    marginTop: theme.spacing.xl,
  },
  resetBtn: {
    flex: 1,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
  },
  resetText: {
    color: theme.colors.textSecondary,
    fontWeight: theme.font.weight.medium,
  },
  applyBtn: {
    flex: 2,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
  },
  applyText: {
    color: '#000',
    fontWeight: theme.font.weight.bold,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  amountInput: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    color: theme.colors.textPrimary,
    fontSize: theme.font.size.sm,
  },
  amountSep: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.md,
  },
});
