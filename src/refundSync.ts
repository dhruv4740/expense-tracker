// ─── DB glue for refund → original payment linking ───────────────────────────
//
// After a sync batch: every new refund-worded income row is matched to the
// payment it returns (refundLink.ts) and linked via settles_id, so the spend
// nets down and the refund stops counting as income. Logged in the same undo
// log as cancel-out auto-links. Runs on sync only; no background work.
// Only ref-number and merchant+amount matches auto-link; an amount-only match is
// a medium-confidence suggestion the user accepts (like cancel-out's medium pairs).

import { getTransactionsAfterId, getTransactionsBetween, setSettlement } from './db';
import { cancelKey } from './cancelOut';
import { monthRange } from './dates';
import { REFUND_WINDOW_MS, findRefundParent, isRefundRow } from './refundLink';
import type { RefundRow } from './refundLink';
import { paidBack } from './netting';
import { displayMerchant } from './merchantDisplay';
import { appendAutoLog, dismissLink, dismissedKeys, linkIfUnlinked, withIds } from './linkGlue';
import type { AutoSelfEntry } from './transferLog';

/** parent id → amount already refunded to it, from the linked refunds in `pool`. */
function refundedAmounts(pool: RefundRow[]): Map<number, number> {
  const refunded = new Map<number, number>();
  for (const [id, v] of paidBack(pool.map(r => ({ ...r, category: '' })))) {
    refunded.set(id, v.paid);
  }
  return refunded;
}

/**
 * Link refunds among the rows inserted after `maxIdBefore` by ref number or
 * merchant+amount. Amount-only matches are left for getRefundSuggestions.
 * Returns the number linked.
 */
export function runRefundLinking(maxIdBefore: number): number {
  const fresh = withIds(getTransactionsAfterId(maxIdBefore)).filter(isRefundRow);
  if (fresh.length === 0) {
    return 0;
  }
  const lo = Math.min(...fresh.map(r => r.timestamp)) - REFUND_WINDOW_MS;
  const hi = Math.max(...fresh.map(r => r.timestamp));
  const pool = withIds(getTransactionsBetween(lo, hi));
  const refunded = refundedAmounts(pool);
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
  appendAutoLog(at, entries);
  return entries.length;
}

export interface RefundSuggestion {
  refund: RefundRow;
  parent: RefundRow;
}

/** Unlinked, not-dismissed refunds this month whose only match is an equal amount. */
export function getRefundSuggestions(): RefundSuggestion[] {
  const { from, to } = monthRange(new Date());
  const pool = withIds(getTransactionsBetween(from - REFUND_WINDOW_MS, to));
  const refunded = refundedAmounts(pool);
  const dismissed = dismissedKeys();
  const out: RefundSuggestion[] = [];
  for (const r of pool.filter(x => x.timestamp >= from && isRefundRow(x))) {
    const m = findRefundParent(r, pool, refunded);
    if (m && m.basis === 'amount' && !dismissed.has(cancelKey(m.parent.id, r.id))) {
      out.push({ refund: r, parent: m.parent });
    }
  }
  return out;
}

export const linkRefund = linkIfUnlinked;

export const dismissRefund = dismissLink;
