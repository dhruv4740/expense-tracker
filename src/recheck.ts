// ─── "Re-check old transactions" planning (pure, no DB/native imports) ───────
//
// Re-parses every stored raw_text with the CURRENT parser, identity, rules and
// family list and reports what would change. Nothing is applied here.
//
// Safety rules (each has a test):
//  - rows the user touched (category_source or channel 'manual') are skipped;
//  - rows in a settles_id link, as parent or child, are skipped;
//  - a historical card_bill / wallet_load row is never flipped to 'self': those
//    months' card and wallet spends were never captured, so the leg is the only
//    record of the spend;
//  - a row the parser now rejects (a "phantom") is NEVER deleted: it becomes
//    type 'self' (hidden from totals) with an appended note;
//  - changed rows keep category_source 'auto'; raw_text/dedup_key are untouched.

import { classify } from './classify';
import type { Identity } from './identity';
import { parseTransaction } from './parser';

export const PHANTOM_NOTE = '[auto] not a transaction (re-check)';
export const RECHECK_LOG_KEY = 'recheck_log';

export interface RecheckRow {
  id?: number;
  amount: number;
  merchant: string | null;
  source: string | null;
  raw_text: string | null;
  category: string;
  timestamp: number;
  type: 'expense' | 'income' | 'self';
  note?: string | null;
  category_source?: 'auto' | 'manual';
  channel?: string | null;
  settles_id?: number | null;
}

export interface RecheckCtx {
  identity: Identity;
  rules: Record<string, string>;
  family: string[];
}

export interface RecheckChange {
  id: number;
  row: RecheckRow;
  phantom: boolean;
  type: 'expense' | 'income' | 'self';
  category: string;
  note: string | null;
  /** Preview group, e.g. "UPI → Family", "income → self", "phantom → hidden". */
  group: string;
}

export function groupLabel(row: RecheckRow, type: string, category: string, phantom: boolean): string {
  if (phantom) {
    return 'phantom → hidden';
  }
  if (type !== row.type) {
    return `${row.type} → ${type}`;
  }
  return `${row.category} → ${category}`;
}

export function appendNote(existing: string | null | undefined, add: string): string {
  const cur = (existing ?? '').trim();
  if (!cur) {
    return add;
  }
  return cur.includes(add) ? cur : `${cur}\n${add}`;
}

export function planRecheck(rows: RecheckRow[], ctx: RecheckCtx): RecheckChange[] {
  // Rows in any settlement link, as child (settles_id set) or parent.
  const linked = new Set<number>();
  for (const r of rows) {
    if (r.settles_id != null) {
      linked.add(r.settles_id);
      if (r.id != null) {
        linked.add(r.id);
      }
    }
  }

  const out: RecheckChange[] = [];
  for (const row of rows) {
    if (
      row.id == null ||
      row.category_source === 'manual' ||
      row.channel === 'manual' ||
      linked.has(row.id) ||
      !row.raw_text
    ) {
      continue;
    }
    const parsed = parseTransaction(row.source ?? '', row.raw_text, row.timestamp);

    if (!parsed) {
      if (row.type === 'self') {
        continue; // already hidden; nothing to change
      }
      out.push({
        id: row.id,
        row,
        phantom: true,
        type: 'self',
        category: row.category,
        note: appendNote(row.note, PHANTOM_NOTE),
        group: groupLabel(row, 'self', row.category, true),
      });
      continue;
    }

    const c = classify(parsed, ctx);
    if (
      c.type === 'self' &&
      row.type === 'expense' &&
      (parsed.kind === 'card_bill' || parsed.kind === 'wallet_load')
    ) {
      continue; // the leg is the only record of that spend
    }
    if (c.type === row.type && c.category === row.category) {
      continue;
    }
    out.push({
      id: row.id,
      row,
      phantom: false,
      type: c.type,
      category: c.category,
      note: row.note ?? null,
      group: groupLabel(row, c.type, c.category, false),
    });
  }
  return out;
}

export interface RecheckGroup {
  label: string;
  changes: RecheckChange[];
}

/** Groups sorted by size, largest first. */
export function groupChanges(changes: RecheckChange[]): RecheckGroup[] {
  const map = new Map<string, RecheckChange[]>();
  for (const c of changes) {
    const list = map.get(c.group) ?? [];
    list.push(c);
    map.set(c.group, list);
  }
  return [...map.entries()]
    .map(([label, list]) => ({ label, changes: list }))
    .sort((a, b) => b.changes.length - a.changes.length);
}

// ─── Undo log ────────────────────────────────────────────────────────────────

export interface RecheckValues {
  type: 'expense' | 'income' | 'self';
  category: string;
  note: string | null;
  category_source: 'auto' | 'manual';
}

export interface RecheckLogEntry {
  id: number;
  prev: RecheckValues;
  set: RecheckValues;
}

export interface RecheckLog {
  at: number;
  entries: RecheckLogEntry[];
}

export function buildLog(changes: RecheckChange[], at: number): RecheckLog {
  return {
    at,
    entries: changes.map(c => ({
      id: c.id,
      prev: {
        type: c.row.type,
        category: c.row.category,
        note: c.row.note ?? null,
        category_source: c.row.category_source ?? 'auto',
      },
      set: { type: c.type, category: c.category, note: c.note, category_source: 'auto' },
    })),
  };
}

/**
 * Entries that can be undone: only rows still holding exactly what the re-check
 * set. A row the user edited since (or deleted) is left alone.
 */
export function planUndo(
  log: RecheckLog,
  current: Map<number, { type: string; category: string; note?: string | null }>,
): RecheckLogEntry[] {
  return log.entries.filter(e => {
    const cur = current.get(e.id);
    return (
      !!cur &&
      cur.type === e.set.type &&
      cur.category === e.set.category &&
      (cur.note ?? null) === (e.set.note ?? null)
    );
  });
}
