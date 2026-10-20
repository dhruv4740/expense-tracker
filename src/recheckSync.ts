// ─── DB-facing glue for the "Re-check old transactions" tool ─────────────────
// Pure rules live in recheck.ts. In-app, user-triggered only (no background work).

import { getAllMerchantRules, getTransactionById, queryTransactions, updateTransaction } from './db';
import { AUTO_SELF_LOG_KEY } from './transferLog';
import type { AutoSelfBatch } from './transferLog';
import { getFamilyMembers, getIdentity, getJSON, setJSON } from './settings';
import { refreshSyncCaches } from './sync';
import { RECHECK_LOG_KEY, buildLog, planRecheck, planUndo } from './recheck';
import type { RecheckChange, RecheckLog } from './recheck';

/** Plan against every stored row (including 'self'); nothing is written. */
export function previewRecheck(): RecheckChange[] {
  const rows = queryTransactions({ includeSelf: true });
  const protectedIds = getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, [])
    .flatMap(b => b.entries)
    .flatMap(e => e.prev.map(p => p.id));
  return planRecheck(rows, {
    protectedIds,
    identity: getIdentity(),
    rules: getAllMerchantRules(),
    family: getFamilyMembers(),
  });
}

/** Writes the undo log first, then applies. Returns the number of rows changed. */
export function applyRecheck(changes: RecheckChange[]): number {
  if (changes.length === 0) {
    return 0;
  }
  setJSON(RECHECK_LOG_KEY, buildLog(changes, Date.now()));
  for (const c of changes) {
    updateTransaction(c.id, {
      type: c.type,
      category: c.category,
      note: c.note,
      category_source: 'auto',
    });
  }
  refreshSyncCaches();
  return changes.length;
}

export function getRecheckLog(): RecheckLog | null {
  const log = getJSON<RecheckLog | null>(RECHECK_LOG_KEY, null);
  return log && log.entries?.length ? log : null;
}

/** Restores previous values, only for rows still holding what the re-check set. */
export function undoRecheck(): { restored: number; skipped: number } {
  const log = getRecheckLog();
  if (!log) {
    return { restored: 0, skipped: 0 };
  }
  const current = new Map<number, { type: string; category: string; note?: string | null }>();
  for (const e of log.entries) {
    const r = getTransactionById(e.id);
    if (r) {
      current.set(e.id, { type: r.type, category: r.category, note: r.note ?? null });
    }
  }
  const todo = planUndo(log, current);
  for (const e of todo) {
    updateTransaction(e.id, {
      type: e.prev.type,
      category: e.prev.category,
      note: e.prev.note,
      category_source: e.prev.category_source,
    });
  }
  setJSON(RECHECK_LOG_KEY, null);
  refreshSyncCaches();
  return { restored: todo.length, skipped: log.entries.length - todo.length };
}
