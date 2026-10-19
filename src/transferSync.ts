// ─── DB-facing glue for transfer pairing + repayment banners ─────────────────
//
// Pure rules live in transferPair.ts / transferLog.ts / settle.ts; this file
// only reads rows, applies changes and persists the log. In-app only: no
// Android notification, no background work (see RULES.md §1) — it runs inside
// the sync that already happens when the app is open.

import {
  getKnownSettlementCounterparties,
  getMaxTransactionId,
  getTransactionById,
  getTransactionsAfterId,
  getTransactionsBetween,
  queryTransactions,
  updateTransaction,
} from './db';
import type { TransactionRow } from './db';
import type { Identity } from './identity';
import { getJSON, setJSON } from './settings';
import {
  AUTO_SELF_LOG_KEY,
  addDismissed,
  appendBatch,
  findEntry,
  markSeen,
  markUndone,
  unseenEntries,
} from './transferLog';
import type { AutoSelfBatch, AutoSelfEntry } from './transferLog';
import { findTransferPairs, legLabel, MEDIUM_WINDOW_MS, transferKey } from './transferPair';
import type { TransferPair, TransferRow } from './transferPair';
import { pairKey, pickRepaymentBanner } from './settle';
import type { BannerRow, RepaymentBanner } from './settle';

const DAY_MS = 86_400_000;
const TRANSFER_DISMISSED_KEY = 'transfer_dismissed';
const REPAY_DISMISSED_KEY = 'repay_dismissed';

function toTransferRows(rows: TransactionRow[]): TransferRow[] {
  const out: TransferRow[] = [];
  for (const r of rows) {
    if (r.id != null) {
      out.push({ ...r, id: r.id });
    }
  }
  return out;
}

/** Snapshot before a sync batch; rows inserted afterwards have id > this. */
export const snapshotMaxId = getMaxTransactionId;

/**
 * After a sync batch: pair the new rows against rows ±15 min around them and
 * auto-apply HIGH-confidence pairs (both → type 'self'), logging the previous
 * types so each can be undone. Returns the number of pairs applied.
 */
export function runTransferPairing(maxIdBefore: number, identity: Identity): number {
  const fresh = toTransferRows(getTransactionsAfterId(maxIdBefore));
  if (fresh.length === 0) {
    return 0;
  }
  const lo = Math.min(...fresh.map(r => r.timestamp)) - MEDIUM_WINDOW_MS;
  const hi = Math.max(...fresh.map(r => r.timestamp)) + MEDIUM_WINDOW_MS;
  const pool = toTransferRows(getTransactionsBetween(lo, hi));
  const high = findTransferPairs(fresh, pool, identity).filter(p => p.confidence === 'high');
  if (high.length === 0) {
    return 0;
  }
  const at = Date.now();
  const entries: AutoSelfEntry[] = [];
  for (const p of high) {
    updateTransaction(p.expense.id, { type: 'self' });
    updateTransaction(p.income.id, { type: 'self' });
    entries.push({
      id: `${at}-${p.expense.id}-${p.income.id}`,
      amount: p.expense.amount,
      from: legLabel(p.expense),
      to: legLabel(p.income),
      basis: p.basis,
      prev: [
        { id: p.expense.id, type: 'expense' },
        { id: p.income.id, type: 'income' },
      ],
      seen: false,
      undone: false,
    });
  }
  const log = getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []);
  setJSON(AUTO_SELF_LOG_KEY, appendBatch(log, { at, entries }));
  return high.length;
}

// ─── Auto-applied banner ─────────────────────────────────────────────────────

export function getAutoAppliedBanners(): AutoSelfEntry[] {
  return unseenEntries(getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []));
}

export function dismissAutoApplied(entryId: string): void {
  setJSON(AUTO_SELF_LOG_KEY, markSeen(getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []), entryId));
}

/** Restore the previous types — but only rows that are still 'self' (a later manual edit wins). */
export function undoAutoApplied(entryId: string): void {
  const log = getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []);
  const entry = findEntry(log, entryId);
  if (!entry || entry.undone) {
    return;
  }
  for (const p of entry.prev) {
    if (getTransactionById(p.id)?.type === 'self') {
      updateTransaction(p.id, { type: p.type });
    }
  }
  setJSON(AUTO_SELF_LOG_KEY, markUndone(log, entryId));
}

// ─── Medium-confidence suggestion banner ─────────────────────────────────────

/** Unlinked equal-amount pairs from the last week that we did not auto-apply. */
export function getTransferSuggestions(identity: Identity): TransferPair[] {
  const now = Date.now();
  const rows = toTransferRows(getTransactionsBetween(now - 7 * DAY_MS, now));
  const dismissed = new Set(getJSON<string[]>(TRANSFER_DISMISSED_KEY, []));
  return findTransferPairs(rows, rows, identity).filter(
    p =>
      p.confidence === 'medium' &&
      !dismissed.has(transferKey(p.expense.id, p.income.id)),
  );
}

export function dismissTransferSuggestion(expenseId: number, incomeId: number): void {
  setJSON(
    TRANSFER_DISMISSED_KEY,
    addDismissed(getJSON<string[]>(TRANSFER_DISMISSED_KEY, []), transferKey(expenseId, incomeId)),
  );
}

/** Mark both legs as a transfer between the user's own accounts. */
export function linkTransfer(expenseId: number, incomeId: number): void {
  updateTransaction(expenseId, { type: 'self' });
  updateTransaction(incomeId, { type: 'self' });
}

// ─── Repayment banner (proactive, high confidence only) ──────────────────────

export function getRepaymentBanner(): RepaymentBanner | null {
  const now = Date.now();
  const raw = queryTransactions({ from: now - 31 * DAY_MS, to: now });
  const parents = new Set(raw.map(r => r.settles_id).filter((x): x is number => x != null));
  const rows: BannerRow[] = [];
  for (const r of raw) {
    // Uber rides have their own settlement flow and screen.
    if (r.id == null || r.category === 'Uber') {
      continue;
    }
    rows.push({ ...r, id: r.id, has_children: parents.has(r.id), paid_back: r.paid_back ?? 0 });
  }
  const dismissed = new Set(getJSON<string[]>(REPAY_DISMISSED_KEY, []));
  return pickRepaymentBanner(
    rows,
    { knownCounterparties: getKnownSettlementCounterparties() },
    dismissed,
  );
}

export function dismissRepaymentBanner(parentId: number, candidateId: number): void {
  setJSON(
    REPAY_DISMISSED_KEY,
    addDismissed(getJSON<string[]>(REPAY_DISMISSED_KEY, []), pairKey(parentId, candidateId)),
  );
}
