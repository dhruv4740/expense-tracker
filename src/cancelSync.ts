// ─── DB glue for "cancel out" (friend repayment ↔ spend) ─────────────────────
//
// Pure rules live in cancelOut.ts. HIGH pairs are auto-linked after a sync
// (settles_id on the friend's credit → the spend) and logged in the same undo
// log as own-transfer auto-marks. Everything else is offered as a suggestion
// computed on demand from the CURRENT month, so the one-off pass over existing
// rows only ever suggests. In-app only; no background work (RULES.md §1).

import {
  getTransactionById,
  getTransactionsAfterId,
  getTransactionsBetween,
  setSettlement,
} from './db';
import type { TransactionRow } from './db';
import { cancelKey, CANCEL_MEDIUM_WINDOW_MS, findCancelPairs } from './cancelOut';
import type { CancelPair, CancelRow } from './cancelOut';
import { monthRange } from './dates';
import { displayMerchant } from './merchantDisplay';
import type { Identity } from './identity';
import { getJSON, setJSON } from './settings';
import {
  AUTO_SELF_LOG_KEY,
  CANCEL_DISMISSED_KEY,
  addDismissed,
  appendBatch,
} from './transferLog';
import type { AutoSelfBatch, AutoSelfEntry } from './transferLog';

function toCancelRows(rows: TransactionRow[]): CancelRow[] {
  const out: CancelRow[] = [];
  for (const r of rows) {
    if (r.id != null) {
      out.push({ ...r, id: r.id });
    }
  }
  return out;
}

function dismissedSet(): Set<string> {
  return new Set(getJSON<string[]>(CANCEL_DISMISSED_KEY, []));
}

export function personLabel(r: CancelRow): string {
  return r.counterparty ?? displayMerchant(r.merchant ?? null) ?? 'someone';
}

/**
 * After a sync batch: pair the new rows (either side) with rows within 24h and
 * auto-link HIGH-confidence pairs. Returns the number linked. Must run after
 * own-account transfer pairing so rows it marked 'self' are skipped.
 */
export function runCancelOut(maxIdBefore: number, identity: Identity, friends: string[]): number {
  const fresh = toCancelRows(getTransactionsAfterId(maxIdBefore));
  if (fresh.length === 0) {
    return 0;
  }
  const lo = Math.min(...fresh.map(r => r.timestamp)) - CANCEL_MEDIUM_WINDOW_MS;
  const hi = Math.max(...fresh.map(r => r.timestamp)) + CANCEL_MEDIUM_WINDOW_MS;
  const pool = toCancelRows(getTransactionsBetween(lo, hi));
  const high = findCancelPairs(fresh, pool, { identity, friends }, dismissedSet()).filter(
    p => p.confidence === 'high',
  );
  if (high.length === 0) {
    return 0;
  }
  const at = Date.now();
  const entries: AutoSelfEntry[] = [];
  for (const p of high) {
    setSettlement(p.income.id, p.expense.id);
    entries.push({
      id: `${at}-c-${p.expense.id}-${p.income.id}`,
      amount: p.expense.amount,
      from: displayMerchant(p.expense.merchant ?? null) ?? 'spend',
      to: personLabel(p.income),
      basis: 'time',
      prev: [],
      kind: 'cancel',
      link: { childId: p.income.id, parentId: p.expense.id },
      seen: false,
      undone: false,
    });
  }
  const log = getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []);
  setJSON(AUTO_SELF_LOG_KEY, appendBatch(log, { at, entries }));
  return high.length;
}

/** Unlinked, not-dismissed candidate pairs among this month's rows. */
export function getCancelSuggestions(identity: Identity, friends: string[]): CancelPair[] {
  const { from, to } = monthRange(new Date());
  const rows = toCancelRows(getTransactionsBetween(from, to));
  return findCancelPairs(rows, rows, { identity, friends }, dismissedSet());
}

export function linkCancel(expenseId: number, incomeId: number): void {
  if (getTransactionById(incomeId)?.settles_id == null) {
    setSettlement(incomeId, expenseId);
  }
}

export function dismissCancel(expenseId: number, incomeId: number): void {
  setJSON(
    CANCEL_DISMISSED_KEY,
    addDismissed(getJSON<string[]>(CANCEL_DISMISSED_KEY, []), cancelKey(expenseId, incomeId)),
  );
}
