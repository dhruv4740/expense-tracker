// ─── DB glue for refund → original payment linking ───────────────────────────
//
// After a sync batch: every new refund-worded income row is matched to the
// payment it returns (refundLink.ts) and linked via settles_id, so the spend
// nets down and the refund stops counting as income. Logged in the same undo
// log as cancel-out auto-links. Runs on sync only; no background work.

import { getTransactionsAfterId, getTransactionsBetween, setSettlement } from './db';
import type { TransactionRow } from './db';
import { REFUND_WINDOW_MS, findRefundParent, isRefundRow } from './refundLink';
import type { RefundRow } from './refundLink';
import { paidBack } from './netting';
import { displayMerchant } from './merchantDisplay';
import { getJSON, setJSON } from './settings';
import { AUTO_SELF_LOG_KEY, appendBatch } from './transferLog';
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

/** Link refunds among the rows inserted after `maxIdBefore`. Returns the number linked. */
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
    if (!m) {
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
