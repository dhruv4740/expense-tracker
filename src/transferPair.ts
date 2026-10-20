// ─── Own-account transfer pairing (pure, no DB/native imports) ───────────────
//
// Moving money between the user's own accounts produces TWO rows: a debit SMS
// from one bank and a credit SMS from the other. Marking those by hand was so
// tedious users deleted them (which breaks the totals just as badly), so after
// each sync batch we look for the pair.
//
// HIGH confidence (auto-applied, undoable) — either:
//   (a) the two raw_texts share a UPI/IMPS reference number, or
//   (b) equal amount, ≤3 min apart, on different accounts, and NEITHER leg is a
//       third-party transaction (card/merchant purchase, refund/reversal, or a
//       person who is not the user).
// MEDIUM (suggestion only): equal amount, ≤15 min apart, different accounts,
//   not high, and not an obvious purchase/refund.
//
// Rows the user edited by hand are never touched automatically. An unrelated
// equal-amount credit from someone else a week later never pairs: the window is
// minutes, not days.

import type { Identity } from './identity';
import { isSelfTransfer } from './identity';

const MIN_MS = 60_000;
/** Amounts within this many rupees count as equal (rounding slack). */
const AMOUNT_EPSILON = 0.5;
export const HIGH_WINDOW_MS = 3 * MIN_MS;
export const MEDIUM_WINDOW_MS = 15 * MIN_MS;

export interface TransferRow {
  id: number;
  amount: number;
  timestamp: number;
  type: 'expense' | 'income' | 'self';
  category: string;
  category_source?: 'auto' | 'manual' | null;
  channel?: string | null;
  source?: string | null;
  account?: string | null;
  counterparty?: string | null;
  merchant?: string | null;
  raw_text?: string | null;
  settles_id?: number | null;
}

export type Confidence = 'high' | 'medium';

export interface TransferPair {
  expense: TransferRow;
  income: TransferRow;
  confidence: Confidence;
  /** Why it is high/medium — shown in the UI and kept in the undo log. */
  basis: 'ref' | 'time' | 'near';
}

// ─── Reference numbers ───────────────────────────────────────────────────────

// "UPI Ref: 626107872291", "(UPI 626107872291)", "Ref No. 121282891840",
// "IMPS Ref no 411139386007", "UTR: ...", "RRN ...". A phone-like local part
// ("9876543210@ybl") is not a reference.
const REF_RE = /\b(?:ref(?:erence)?|utr|rrn|upi|imps)\b[^0-9\n]{0,20}(\d{6,16})(?![\d@])/gi;

export function extractRefs(text?: string | null): string[] {
  if (!text) {
    return [];
  }
  const out = new Set<string>();
  for (const m of text.matchAll(REF_RE)) {
    out.add(m[1]);
  }
  return [...out];
}

function shareRef(a: TransferRow, b: TransferRow): boolean {
  const refs = extractRefs(a.raw_text);
  if (refs.length === 0) {
    return false;
  }
  const other = new Set(extractRefs(b.raw_text));
  return refs.some(r => other.has(r));
}

// ─── Leg classification ──────────────────────────────────────────────────────

const REFUND_RE = /\b(refund(?:ed)?|revers(?:al|ed)|chargeback|returned|failed|declined)\b/i;
const CARD_PURCHASE_RE = /\b(?:spent|purchase)\b[\s\S]*\bcard\b|\bcard\b[\s\S]*\b(?:spent|purchase|at)\b/i;
/** Categories a plain account-to-account leg can carry; everything else is a merchant/person leg. */
const TRANSFER_CATEGORIES = new Set(['UPI', 'Other', 'Income', 'Friend Transfer']);

export function isRefundOrReversal(r: TransferRow): boolean {
  return REFUND_RE.test(r.raw_text ?? '') || REFUND_RE.test(r.merchant ?? '');
}

export function isCardPurchase(r: TransferRow): boolean {
  return r.type === 'expense' && CARD_PURCHASE_RE.test(r.raw_text ?? '');
}

/**
 * A leg that is a dealing with someone/something other than the user's own
 * accounts: a card or merchant purchase, a refund/reversal, a cash withdrawal,
 * or a person who is not the user.
 */
export function isThirdPartyLeg(r: TransferRow, identity: Identity): boolean {
  if (isCardPurchase(r) || isRefundOrReversal(r)) {
    return true;
  }
  if (!TRANSFER_CATEGORIES.has(r.category)) {
    return true; // Shopping / Food / Cash / Family / Loan… — merchant, ATM or person
  }
  const cp = r.counterparty ?? null;
  const merchant = r.merchant ?? null;
  if (isSelfTransfer({ counterparty: cp, merchant }, identity)) {
    return false;
  }
  for (const who of [merchant, cp]) {
    if (!who || /^\d+$/.test(who)) {
      continue; // nothing, or a bare account fragment
    }
    if (who.includes('@')) {
      // Masked ("*4545@slc") is how a bank shows the user's own other account;
      // an unmasked, non-own handle is someone else.
      if (!/^[*x]+\d{3,4}@/i.test(who)) {
        return true;
      }
    } else if (/^[A-Za-z][A-Za-z .'-]*$/.test(who) && !/\bbank\b/i.test(who)) {
      return true; // a person's name (or brand) that is not the user's own
    }
  }
  return false;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

function acctKey(a?: string | null): string | null {
  const d = (a ?? '').replace(/\D/g, '');
  return d ? d.slice(-4) : null;
}

/** Different accounts, or one side unknown. Both unknown → fall back to the sender. */
function differentAccounts(a: TransferRow, b: TransferRow): boolean {
  const ka = acctKey(a.account);
  const kb = acctKey(b.account);
  if (ka && kb) {
    return ka !== kb;
  }
  if (ka || kb) {
    return true;
  }
  const sa = (a.source ?? '').toLowerCase();
  const sb = (b.source ?? '').toLowerCase();
  return !!sa && !!sb && sa !== sb;
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

function isManual(r: TransferRow): boolean {
  return r.category_source === 'manual' || r.channel === 'manual';
}

function eligible(r: TransferRow): boolean {
  return (
    r.type !== 'self' &&
    r.settles_id == null &&
    r.category !== 'Investment' &&
    r.amount > 0
  );
}

/** Classify one candidate pair, or null when it is not a pair at all. */
export function classifyPair(
  exp: TransferRow,
  inc: TransferRow,
  identity: Identity,
): TransferPair | null {
  if (exp.type !== 'expense' || inc.type !== 'income') {
    return null;
  }
  if (!eligible(exp) || !eligible(inc) || exp.id === inc.id) {
    return null;
  }
  if (Math.abs(exp.amount - inc.amount) > AMOUNT_EPSILON) {
    return null;
  }
  const dt = Math.abs(exp.timestamp - inc.timestamp);
  if (dt > MEDIUM_WINDOW_MS || !differentAccounts(exp, inc)) {
    return null;
  }
  // Refunds/reversals and card purchases are never an own-account transfer, not
  // even as a suggestion (a reversal can even share the original's reference).
  if (isRefundOrReversal(exp) || isRefundOrReversal(inc)) {
    return null;
  }
  if (isCardPurchase(exp) || isCardPurchase(inc)) {
    return null;
  }

  const auto = !isManual(exp) && !isManual(inc);
  if (auto && dt <= MEDIUM_WINDOW_MS && shareRef(exp, inc)) {
    return { expense: exp, income: inc, confidence: 'high', basis: 'ref' };
  }
  if (
    auto &&
    dt <= HIGH_WINDOW_MS &&
    !isThirdPartyLeg(exp, identity) &&
    !isThirdPartyLeg(inc, identity)
  ) {
    return { expense: exp, income: inc, confidence: 'high', basis: 'time' };
  }
  return { expense: exp, income: inc, confidence: 'medium', basis: 'near' };
}

/**
 * Pairs involving at least one of `fresh` (rows inserted this batch), matched
 * against `pool` (rows around them; may include the fresh rows themselves).
 * Each row ends up in at most one pair. Ref matches win, then the closest in time.
 */
export function findTransferPairs(
  fresh: TransferRow[],
  pool: TransferRow[],
  identity: Identity,
): TransferPair[] {
  const freshIds = new Set(fresh.map(r => r.id));
  const byKey = new Map<string, TransferPair>();
  const all = new Map<number, TransferRow>();
  for (const r of [...pool, ...fresh]) {
    all.set(r.id, r);
  }
  const rows = [...all.values()];
  for (const f of fresh) {
    for (const o of rows) {
      if (o.id === f.id || f.type === o.type) {
        continue;
      }
      const [exp, inc] = f.type === 'expense' ? [f, o] : [o, f];
      const key = `${exp.id}:${inc.id}`;
      if (byKey.has(key)) {
        continue;
      }
      const p = classifyPair(exp, inc, identity);
      if (p && (freshIds.has(exp.id) || freshIds.has(inc.id))) {
        byKey.set(key, p);
      }
    }
  }
  const rank = (p: TransferPair) =>
    (p.confidence === 'high' ? 0 : 1e12) +
    (p.basis === 'ref' ? 0 : 1e9) +
    Math.abs(p.expense.timestamp - p.income.timestamp);
  const used = new Set<number>();
  const out: TransferPair[] = [];
  for (const p of [...byKey.values()].sort((a, b) => rank(a) - rank(b))) {
    if (used.has(p.expense.id) || used.has(p.income.id)) {
      continue;
    }
    used.add(p.expense.id);
    used.add(p.income.id);
    out.push(p);
  }
  return out;
}

/** Stable key for remembering a dismissed suggestion. */
export function transferKey(expenseId: number, incomeId: number): string {
  return `${expenseId}:${incomeId}`;
}

/** Short label for one side of a pair, e.g. "HDFC" or "slice". */
export function legLabel(r: TransferRow): string {
  const src = (r.source ?? '').replace(/^[A-Z]{2}-/, '').replace(/-[A-Z]$/, '').trim();
  const a = acctKey(r.account);
  return src || (a ? `a/c ${a}` : 'account');
}

/**
 * The obvious opposite leg of `row` for a MANUAL "mark as transfer": equal
 * amount, opposite direction, within 15 min, unlinked and not already self.
 * Closest in time wins; null when there is none.
 */
export function findMatchingLeg(row: TransferRow, pool: TransferRow[]): TransferRow | null {
  let best: TransferRow | null = null;
  let bestDt = Infinity;
  for (const o of pool) {
    if (o.id === row.id || !eligible(o) || o.type === row.type || o.type === 'self') {
      continue;
    }
    if (Math.abs(o.amount - row.amount) > AMOUNT_EPSILON) {
      continue;
    }
    const dt = Math.abs(o.timestamp - row.timestamp);
    if (dt <= MEDIUM_WINDOW_MS && dt < bestDt) {
      best = o;
      bestDt = dt;
    }
  }
  return best;
}
