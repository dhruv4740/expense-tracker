// ─── IposScreen ───────────────────────────────────────────────────────────────
//
// IPO tracker: applied, blocked now, allotted (debited), refunded/unblocked.
// Only the bank's final debit on allotment counts as money spent (Investment);
// blocks, revokes and unblocks are shown here and nowhere else.

import React, { useCallback, useState } from 'react';
import { DeviceEventEmitter, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { loadIpos } from '../ipoStore';
import type { IpoStatus, IpoSummaryItem } from '../ipo';
import { DATA_CHANGED } from '../sync';
import { formatDate } from '../dates';
import { Card, EmptyState, SectionHeader } from '../components';
import { theme } from '../theme';

function fmt(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

const SECTIONS: Array<{ title: string; statuses: IpoStatus[] }> = [
  { title: 'Blocked now', statuses: ['blocked'] },
  { title: 'Applied', statuses: ['applied'] },
  { title: 'Allotted (debited)', statuses: ['debited', 'allotted'] },
  { title: 'Refunded / unblocked', statuses: ['refunded'] },
];

function detail(i: IpoSummaryItem): string {
  const when = formatDate(i.lastTs);
  switch (i.status) {
    case 'debited':
      return `debited ${fmt(i.debited)} · ${when}`;
    case 'allotted':
      return `allotted, bank debit not seen yet · ${when}`;
    case 'refunded':
      return `${i.blocked > 0 ? `${fmt(i.blocked)} ` : ''}returned · ${when}`;
    case 'blocked':
      return `${fmt(i.blocked)} blocked · ${when}`;
    default:
      return `${i.blocked > 0 ? `${fmt(i.blocked)} · ` : ''}${when}`;
  }
}

export default function IposScreen() {
  const [ipos, setIpos] = useState<IpoSummaryItem[]>([]);
  const load = useCallback(() => {
    try {
      setIpos(loadIpos());
    } catch {
      setIpos([]);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
      const sub = DeviceEventEmitter.addListener(DATA_CHANGED, load);
      return () => sub.remove();
    }, [load]),
  );

  const invested = ipos.reduce((s, i) => s + (i.status === 'debited' ? i.debited : 0), 0);
  const blocked = ipos.reduce((s, i) => s + (i.status === 'blocked' ? i.blocked : 0), 0);

  if (ipos.length === 0) {
    return (
      <View style={styles.container}>
        <EmptyState
          icon="trending-up"
          title="No IPOs yet"
          subtitle="IPO application, block and allotment messages show up here once they arrive."
        />
      </View>
    );
  }
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.list}>
      <Text style={styles.total}>
        Invested via IPO: {fmt(invested)}
        {blocked > 0 ? ` · ${fmt(blocked)} blocked (not spent)` : ''}
      </Text>
      {SECTIONS.map(sec => {
        const rows = ipos.filter(i => sec.statuses.includes(i.status));
        if (rows.length === 0) {
          return null;
        }
        return (
          <View key={sec.title}>
            <SectionHeader title={sec.title} />
            {rows.map(i => (
              <Card key={i.key}>
                <Text style={styles.name} numberOfLines={1}>
                  {i.name}
                </Text>
                <Text style={styles.sub}>{detail(i)}</Text>
              </Card>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  list: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xl, gap: theme.spacing.sm },
  total: {
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textPrimary,
    marginVertical: theme.spacing.md,
  },
  name: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium, color: theme.colors.textPrimary },
  sub: { fontSize: theme.font.size.xs, color: theme.colors.textMuted, marginTop: 2 },
});
