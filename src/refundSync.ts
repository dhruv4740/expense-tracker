// ─── DB glue for refund → original payment linking ───────────────────────────
//
// After a sync batch: every new refund-worded income row is matched to the
// payment it returns (refundLink.ts) and linked via settles_id, so the spend
// nets down and the refund stops counting as income. Logged in the same undo
// log as cancel-out auto-links. Runs on sync only; no background work.
// Only ref-number and merchant+amount matches auto-link; an amount-only match is
// a medium-confidence suggestion the user accepts (like cancel-out's medium pairs).

import { getTransactionById, getTransactionsAfterId, getTransactionsBetween, setSettlement } from './db';
import type { TransactionRow } from './db';
import { cancelKey } from './cancelOut';
import { monthRange } from './dates';
import { REFUND_WINDOW_MS, findRefundParent, isRefundRow } from './refundLink';
import type { RefundRow } from './refundLink';
import { paidBack } from './netting';
import { displayMerchant } from './merchantDisplay';
import { getJSON, setJSON } from './settings';
import { AUTO_SELF_LOG_KEY, CANCEL_DISMISSED_KEY, addDismissed, appendBatch } from './transferLog';
import type { AutoSelfBatch, AutoSelfEntry } from './transferLog';

function toRows(rows: TransactionRow[]): RefundRow[] {
  const out: RefundRow[] = [];
  for (const r of rows) {
    if (r.id != null) {
      out.push({ ...r, id: r.id });
    }
  }
  return out;
}

/**
 * Link refunds among the rows inserted after `maxIdBefore` by ref number or
 * merchant+amount. Amount-only matches are left for getRefundSuggestions.
 * Returns the number linked.
 */
export function runRefundLinking(maxIdBefore: number): number {
  const fresh = toRows(getTransactionsAfterId(maxIdBefore)).filter(isRefundRow);
  if (fresh.length === 0) {
    return 0;
  }
  const lo = Math.min(...fresh.map(r => r.timestamp)) - REFUND_WINDOW_MS;
  const hi = Math.max(...fresh.map(r => r.timestamp));
  const pool = toRows(getTransactionsBetween(lo, hi));
  const refunded = new Map<number, number>();
  for (const [id, v] of paidBack(pool.map(r => ({ ...r, category: '' })))) {
    refunded.set(id, v.paid);
  }
  const at = Date.now();
  const entries: AutoSelfEntry[] = [];
  for (const r of fresh.sort((a, b) => a.timestamp - b.timestamp)) {
    const m = findRefundParent(r, pool, refunded);
    if (!m || m.basis === 'amount') {
      continue;
    }
    setSettlement(r.id, m.parent.id);
    refunded.set(m.parent.id, (refunded.get(m.parent.id) ?? 0) + r.amount);
    entries.push({
      id: `${at}-r-${m.parent.id}-${r.id}`,
      amount: r.amount,
      from: displayMerchant(m.parent.merchant ?? null) ?? 'payment',
      to: 'refund',
      basis: m.basis === 'ref' ? 'ref' : 'time',
      prev: [],
      kind: 'cancel',
      link: { childId: r.id, parentId: m.parent.id },
      seen: false,
      undone: false,
    });
  }
  if (entries.length > 0) {
    const log = getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []);
    setJSON(AUTO_SELF_LOG_KEY, appendBatch(log, { at, entries }));
  }
  return entries.length;
}

export interface RefundSuggestion {
  refund: RefundRow;
  parent: RefundRow;
}

/** Unlinked, not-dismissed refunds this month whose only match is an equal amount. */
export function getRefundSuggestions(): RefundSuggestion[] {
  const { from, to } = monthRange(new Date());
  const pool = toRows(getTransactionsBetween(from - REFUND_WINDOW_MS, to));
  const refunded = new Map<number, number>();
  for (const [id, v] of paidBack(pool.map(r => ({ ...r, category: '' })))) {
    refunded.set(id, v.paid);
  }
  const dismissed = new Set(getJSON<string[]>(CANCEL_DISMISSED_KEY, []));
  const out: RefundSuggestion[] = [];
  for (const r of pool.filter(x => x.timestamp >= from && isRefundRow(x))) {
    const m = findRefundParent(r, pool, refunded);
    if (m && m.basis === 'amount' && !dismissed.has(cancelKey(m.parent.id, r.id))) {
      out.push({ refund: r, parent: m.parent });
    }
  }
  return out;
}

export function linkRefund(parentId: number, refundId: number): void {
  if (getTransactionById(refundId)?.settles_id == null) {
    setSettlement(refundId, parentId);
  }
}

export function dismissRefund(parentId: number, refundId: number): void {
  setJSON(
    CANCEL_DISMISSED_KEY,
    addDismissed(getJSON<string[]>(CANCEL_DISMISSED_KEY, []), cancelKey(parentId, refundId)),
  );
}
