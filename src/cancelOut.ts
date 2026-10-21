// ─── "Cancel out": a payment and a friend's payment back (pure) ──────────────
//
// You pay a shop ₹1,200 and a friend sends you ₹1,200 for their share (or the
// friend pays first). The friend's credit is a repayment: link it to the spend
// via settles_id so the netting layer reduces the spend instead of counting the
// credit as income. The credit is the CHILD (settles_id → the spend), the spend
// is the PARENT.
//
// HIGH (auto-linked, undoable): exact amount AND ≤10 min apart, neither row
//   manual. MEDIUM (suggestion): exact amount within 24h, or a plausible share
//   (smaller credit within 24h from someone on the Friends list).
// Never: rows >24h apart, Investment, self, Uber, or rows already linked. A row
// ends up in at most one pair. Works in either time order.

import { isFamilyMember } from './classify';
import { isSelfTransfer } from './identity';
import type { Identity } from './identity';
import { isBusinessName } from './settle';
import { AMOUNT_EPSILON, MIN_MS, amountsMatch } from './pairingBasics';

const CANCEL_HIGH_WINDOW_MS = 10 * MIN_MS;
export const CANCEL_MEDIUM_WINDOW_MS = 24 * 60 * MIN_MS;

export interface CancelRow {
  id: number;
  type: 'expense' | 'income' | 'self';
  amount: number;
  timestamp: number;
  category: string;
  category_source?: 'auto' | 'manual' | null;
  channel?: string | null;
  merchant?: string | null;
  counterparty?: string | null;
  raw_text?: string | null;
  settles_id?: number | null;
}

export interface CancelContext {
  identity: Identity;
  friends: string[];
}

export interface CancelPair {
  /** The spend (parent). */
  expense: CancelRow;
  /** The friend's payment (child; gets settles_id = expense.id). */
  income: CancelRow;
  confidence: 'high' | 'medium';
  basis: 'exact' | 'share';
}

const NOT_A_REPAYMENT_RE =
  /\b(salary|payroll|interest|cashback|dividend|refund|reversal|matured|maturity)\b/i;

export function cancelKey(expenseId: number, incomeId: number): string {
  return `${expenseId}:${incomeId}`;
}

function linkable(r: CancelRow): boolean {
  return r.type !== 'self' && r.settles_id == null && r.category !== 'Investment' && r.amount > 0;
}

function isManual(r: CancelRow): boolean {
  return r.category_source === 'manual' || r.channel === 'manual';
}

/** Could this credit be a person paying the user back? */
function isPersonCredit(r: CancelRow, ctx: CancelContext): boolean {
  if (r.category === 'Family' || r.category === 'Cashback') {
    return false;
  }
  if (NOT_A_REPAYMENT_RE.test(`${r.merchant ?? ''} ${r.raw_text ?? ''}`)) {
    return false;
  }
  if (isBusinessName(r.merchant, r.counterparty)) {
    return false;
  }
  return !isSelfTransfer(
    { counterparty: r.counterparty ?? null, merchant: r.merchant ?? null },
    ctx.identity,
  );
}

export function classifyCancel(
  exp: CancelRow,
  inc: CancelRow,
  ctx: CancelContext,
): CancelPair | null {
  if (exp.type !== 'expense' || inc.type !== 'income' || exp.id === inc.id) {
    return null;
  }
  // Uber rides have their own settlement flow.
  if (!linkable(exp) || !linkable(inc) || exp.category === 'Uber') {
    return null;
  }
  const dt = Math.abs(exp.timestamp - inc.timestamp);
  if (dt > CANCEL_MEDIUM_WINDOW_MS || !isPersonCredit(inc, ctx)) {
    return null;
  }
  if (amountsMatch(exp.amount, inc.amount)) {
    const auto = dt <= CANCEL_HIGH_WINDOW_MS && !isManual(exp) && !isManual(inc);
    return { expense: exp, income: inc, confidence: auto ? 'high' : 'medium', basis: 'exact' };
  }
  if (isFamilyMember({ merchant: inc.merchant ?? null, counterparty: inc.counterparty ?? null }, ctx.friends) && inc.amount < exp.amount - AMOUNT_EPSILON) {
    return { expense: exp, income: inc, confidence: 'medium', basis: 'share' };
  }
  return null;
}

/**
 * Pairs involving at least one of `fresh`, matched against `pool` (which may
 * contain the fresh rows). Dismissed keys are never offered again. One pair
 * per row: high before medium, exact before share, then the closest in time.
 */
export function findCancelPairs(
  fresh: CancelRow[],
  pool: CancelRow[],
  ctx: CancelContext,
  dismissed: Set<string> = new Set(),
): CancelPair[] {
  const all = new Map<number, CancelRow>();
  for (const r of [...pool, ...fresh]) {
    all.set(r.id, r);
  }
  const rows = [...all.values()];
  const found = new Map<string, CancelPair>();
  for (const f of fresh) {
    for (const o of rows) {
      if (o.id === f.id || o.type === f.type) {
        continue;
      }
      const [exp, inc] = f.type === 'expense' ? [f, o] : [o, f];
      const key = cancelKey(exp.id, inc.id);
      if (found.has(key) || dismissed.has(key)) {
        continue;
      }
      const p = classifyCancel(exp, inc, ctx);
      if (p) {
        found.set(key, p);
      }
    }
  }
  const rank = (p: CancelPair) =>
    (p.confidence === 'high' ? 0 : 1e12) +
    (p.basis === 'exact' ? 0 : 1e9) +
    Math.abs(p.expense.timestamp - p.income.timestamp);
  const used = new Set<number>();
  const out: CancelPair[] = [];
  for (const p of [...found.values()].sort((a, b) => rank(a) - rank(b))) {
    if (used.has(p.expense.id) || used.has(p.income.id)) {
      continue;
    }
    used.add(p.expense.id);
    used.add(p.income.id);
    out.push(p);
  }
  return out;
}
