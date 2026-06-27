import React, { useCallback, useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getMonthlySummary, MonthlySummary } from '../db';
import { DATA_CHANGED } from '../sync';

// ─── screen ──────────────────────────────────────────────────────────────────

export default function SummaryScreen() {
  const [summary, setSummary] = useState<MonthlySummary | null>(null);

  // Reload summary on focus AND whenever a live event inserts a new row.
  const load = useCallback(() => {
    setSummary(getMonthlySummary());
  }, []);

  useFocusEffect(load);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, load);
    return () => sub.remove();
  }, [load]);

  if (!summary) {
    return (
      <View style={styles.centered}>
        <Text style={styles.placeholderText}>Loading…</Text>
      </View>
    );
  }

  const hasData = summary.total > 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Month label */}
      <Text style={styles.monthLabel}>{summary.month}</Text>

      {/* Big total */}
      <View style={styles.totalCard}>
        <Text style={styles.totalCaption}>This month</Text>
        <Text style={styles.totalAmount}>
          ₹{summary.total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      </View>

      {/* Category breakdown */}
      {hasData ? (
        <View style={styles.categorySection}>
          <Text style={styles.sectionTitle}>By Category</Text>
          {summary.byCategory.map(({ category, total }) => (
            <View key={category} style={styles.categoryRow}>
              <Text style={styles.categoryName}>{category}</Text>
              <Text style={styles.categoryAmount}>
                ₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.centered}>
          <Text style={styles.placeholderText}>No expenses recorded this month.</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingBottom: 40,
    backgroundColor: '#F5F5F5',
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#F5F5F5',
  },
  placeholderText: {
    fontSize: 15,
    color: '#9E9E9E',
    textAlign: 'center',
  },
  monthLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#757575',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  totalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 2,
  },
  totalCaption: {
    fontSize: 13,
    color: '#9E9E9E',
    marginBottom: 6,
  },
  totalAmount: {
    fontSize: 36,
    fontWeight: '700',
    color: '#C62828',
  },
  categorySection: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#757575',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  categoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F0F0F0',
  },
  categoryName: {
    fontSize: 15,
    color: '#1A1A1A',
  },
  categoryAmount: {
    fontSize: 15,
    fontWeight: '500',
    color: '#C62828',
  },
});
