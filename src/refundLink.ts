// ─── Refund → original payment linking (pure) ────────────────────────────────
//
// A refund is not income: it hands money back for an earlier spend. Linking it
// (settles_id on the refund → the spend) makes the spend's effective amount
// shrink (NETTING_JOIN) and keeps the refund out of income totals.
//
// Match order, strongest first:
//   1. reference number: the refund text and a payment text share a ≥8-digit ref
//   2. merchant + amount: the refund names the merchant ("Zomato order", "from
//      Swiggy") and a spend at it, within 30 days before, is at least the refund
//   3. amount only (bank credits like Kotak's name no merchant): exactly one
//      spend of exactly that amount within 30 days before. This is only a MEDIUM
//      suggestion (basis 'amount'): callers must not auto-link it, the user taps
//      to accept (refundSync.getRefundSuggestions).
// Anything ambiguous stays unlinked.

import { merchantKey } from './upcoming';

const DAY = 86_400_000;
export const REFUND_WINDOW_MS = 30 * DAY;

export interface RefundRow {
  id: number;
  type: 'expense' | 'income' | 'self';
  amount: number;
  timestamp: number;
  merchant?: string | null;
  counterparty?: string | null;
  raw_text?: string | null;
  settles_id?: number | null;
}

const REFUND_RE = /\b(refund(?:ed)?|reversal|reversed)\b/i;

export function isRefundRow(r: RefundRow): boolean {
  return r.type === 'income' && r.settles_id == null && REFUND_RE.test(r.raw_text ?? '');
}

/** ≥8-digit references in a message (UPI/card refs, order ids with digits only). */
export function refsIn(text: string | null | undefined): string[] {
  return [...(text ?? '').matchAll(/\b\d{8,}\b/g)].map(m => m[0]);
}

const NAMED_RE = [
  /\bfor your ([A-Za-z][\w&' .-]{1,30}?) (?:order|booking|ride|trip)\b/i,
  /\bfrom ([A-Za-z][\w&'-]{1,30}?)(?: has been|\s+has|\.|\s+is\b|\s+-|$)/i,
  /\bfor (?:the )?([A-Za-z][\w&'-]{1,30}?) order\b/i,
  /\bfor ([A-Za-z][\w&'-]{1,30}?) order\b/i,
];

/** Merchant named in a refund message, or null when the text names none. */
export function refundMerchant(text: string | null | undefined): string | null {
  for (const re of NAMED_RE) {
    const m = (text ?? '').match(re);
    if (m && !/^(your|the|a|an|credit|debit)$/i.test(m[1].trim())) {
      return m[1].trim();
    }
  }
  return null;
}

export type RefundBasis = 'ref' | 'merchant' | 'amount';

export interface RefundMatch {
  parent: RefundRow;
  basis: RefundBasis;
}

/**
 * Best original payment for `refund` among `pool` (expenses; the refund itself
 * and already-fully-refunded parents are the caller's concern via `refunded`).
 * `refunded` maps parent id → amount already refunded to it.
 */
export function findRefundParent(
  refund: RefundRow,
  pool: RefundRow[],
  refunded: Map<number, number> = new Map(),
): RefundMatch | null {
  const open = pool.filter(
    p =>
      p.type === 'expense' &&
      p.id !== refund.id &&
      p.settles_id == null &&
      p.timestamp <= refund.timestamp &&
      refund.timestamp - p.timestamp <= REFUND_WINDOW_MS &&
      refund.amount <= p.amount - (refunded.get(p.id) ?? 0) + 0.005,
  );
  if (open.length === 0) {
    return null;
  }
  const newest = (xs: RefundRow[]) => [...xs].sort((a, b) => b.timestamp - a.timestamp)[0];

  const refs = refsIn(refund.raw_text);
  if (refs.length > 0) {
    const byRef = open.filter(p => refsIn(p.raw_text).some(x => refs.includes(x)));
    if (byRef.length > 0) {
      return { parent: newest(byRef), basis: 'ref' };
    }
  }

  const named = refundMerchant(refund.raw_text);
  const key = named ? merchantKey(named) : '';
  if (key.length >= 3) {
    const byMerchant = open.filter(p => {
      const pk = merchantKey(p.merchant ?? p.counterparty);
      return pk.length >= 3 && (pk.includes(key) || key.includes(pk));
    });
    if (byMerchant.length > 0) {
      const exact = byMerchant.filter(p => Math.abs(p.amount - refund.amount) < 0.005);
      return { parent: newest(exact.length > 0 ? exact : byMerchant), basis: 'merchant' };
    }
  }

  if (!named) {
    const exact = open.filter(p => Math.abs(p.amount - refund.amount) < 0.005);
    if (exact.length === 1) {
      return { parent: exact[0], basis: 'amount' };
    }
  }
  return null;
}
