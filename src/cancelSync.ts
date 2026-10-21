// ─── DB glue for "cancel out" (friend repayment ↔ spend) ─────────────────────
//
// Pure rules live in cancelOut.ts. HIGH pairs are auto-linked after a sync
// (settles_id on the friend's credit → the spend) and logged in the same undo
// log as own-transfer auto-marks. Everything else is offered as a suggestion
// computed on demand from the CURRENT month, so the one-off pass over existing
// rows only ever suggests. In-app only; no background work (RULES.md §1).

import { getTransactionsAfterId, getTransactionsBetween, setSettlement } from './db';
import { CANCEL_MEDIUM_WINDOW_MS, findCancelPairs } from './cancelOut';
import type { CancelPair, CancelRow } from './cancelOut';
import { monthRange } from './dates';
import { displayMerchant } from './merchantDisplay';
import type { Identity } from './identity';
import { appendAutoLog, dismissLink, dismissedKeys, linkIfUnlinked, withIds } from './linkGlue';
import type { AutoSelfEntry } from './transferLog';

function personLabel(r: CancelRow): string {
  return r.counterparty ?? displayMerchant(r.merchant ?? null) ?? 'someone';
}

/**
 * After a sync batch: pair the new rows (either side) with rows within 24h and
 * auto-link HIGH-confidence pairs. Returns the number linked. Must run after
 * own-account transfer pairing so rows it marked 'self' are skipped.
 */
export function runCancelOut(maxIdBefore: number, identity: Identity, friends: string[]): number {
  const fresh = withIds(getTransactionsAfterId(maxIdBefore));
  if (fresh.length === 0) {
    return 0;
  }
  const lo = Math.min(...fresh.map(r => r.timestamp)) - CANCEL_MEDIUM_WINDOW_MS;
  const hi = Math.max(...fresh.map(r => r.timestamp)) + CANCEL_MEDIUM_WINDOW_MS;
  const pool = withIds(getTransactionsBetween(lo, hi));
  const high = findCancelPairs(fresh, pool, { identity, friends }, dismissedKeys()).filter(
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
  appendAutoLog(at, entries);
  return high.length;
}

/** Unlinked, not-dismissed candidate pairs among this month's rows. */
export function getCancelSuggestions(identity: Identity, friends: string[]): CancelPair[] {
  const { from, to } = monthRange(new Date());
  const rows = withIds(getTransactionsBetween(from, to));
  return findCancelPairs(rows, rows, { identity, friends }, dismissedKeys());
}

export const linkCancel = linkIfUnlinked;

export const dismissCancel = dismissLink;
