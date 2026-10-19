// Preview for Settings → Categorization → "Re-check old transactions".
// Shows counts per change; each group expands to example rows and can be
// switched off. Nothing is written until Apply.

import React, { useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';

import { groupChanges } from '../recheck';
import type { RecheckChange } from '../recheck';
import { theme } from '../theme';

const EXAMPLES = 20;

function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function day(ts: number): string {
  return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

export function RecheckModal({
  changes,
  onApply,
  onCancel,
}: {
  changes: RecheckChange[] | null;
  onApply: (selected: RecheckChange[]) => void;
  onCancel: () => void;
}) {
  const groups = useMemo(() => groupChanges(changes ?? []), [changes]);
  const [open, setOpen] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());

  const selected = groups.filter(g => !off.has(g.label)).flatMap(g => g.changes);
  const toggle = (label: string) => {
    const next = new Set(off);
    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }
    setOff(next);
  };

  return (
    <Modal visible={changes != null} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.wrap}>
        <Text style={styles.title}>Re-check old transactions</Text>
        <Text style={styles.sub}>
          {groups.length === 0
            ? 'Nothing to change — history already matches the current rules.'
            : `${changes?.length ?? 0} rows would change. Manual edits and linked rows are never touched.`}
        </Text>
        <ScrollView style={styles.list}>
          {groups.map(g => (
            <View key={g.label} style={styles.group}>
              <View style={styles.groupHead}>
                <TouchableOpacity style={styles.groupTitle} onPress={() => setOpen(open === g.label ? null : g.label)}>
                  <Text style={styles.groupText}>
                    {g.label}: {g.changes.length}
                  </Text>
                  <Text style={styles.chev}>{open === g.label ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                <Switch value={!off.has(g.label)} onValueChange={() => toggle(g.label)} />
              </View>
              {open === g.label &&
                g.changes.slice(0, EXAMPLES).map(c => (
                  <Text key={c.id} style={styles.example} numberOfLines={1}>
                    {day(c.row.timestamp)} · {rupees(c.row.amount)} · {c.row.merchant ?? c.row.source ?? '—'}
                  </Text>
                ))}
              {open === g.label && g.changes.length > EXAMPLES && (
                <Text style={styles.example}>…and {g.changes.length - EXAMPLES} more</Text>
              )}
            </View>
          ))}
        </ScrollView>
        <View style={styles.actions}>
          <TouchableOpacity style={styles.btn} onPress={onCancel}>
            <Text style={styles.btnText}>Cancel</Text>
          </TouchableOpacity>
          {selected.length > 0 && (
            <TouchableOpacity style={[styles.btn, styles.primary]} onPress={() => onApply(selected)}>
              <Text style={[styles.btnText, styles.primaryText]}>Apply {selected.length}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.colors.bg, padding: theme.spacing.lg },
  title: { fontSize: theme.font.size.lg, color: theme.colors.textPrimary, fontWeight: '600' },
  sub: { color: theme.colors.textMuted, marginVertical: theme.spacing.md },
  list: { flex: 1 },
  group: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, paddingVertical: theme.spacing.sm },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  groupTitle: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  groupText: { color: theme.colors.textPrimary, fontSize: theme.font.size.md },
  chev: { color: theme.colors.textMuted, marginLeft: theme.spacing.sm },
  example: { color: theme.colors.textMuted, fontSize: theme.font.size.sm, paddingVertical: 2, paddingLeft: theme.spacing.md },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.md, paddingTop: theme.spacing.md },
  btn: { paddingVertical: theme.spacing.sm, paddingHorizontal: theme.spacing.lg },
  btnText: { color: theme.colors.textPrimary },
  primary: { backgroundColor: theme.colors.accent, borderRadius: 8 },
  primaryText: { color: '#fff', fontWeight: '600' },
});
