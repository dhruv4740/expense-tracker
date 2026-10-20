// ─── Shared classifier ────────────────────────────────────────────────────────
//
// One pure function used by BOTH the live sync path (sync.ts) and the history
// re-categorizer (maintenance.ts), so a message is classified identically
// whether it arrives now or is re-processed later.

import { categorize } from './categories';
import type { Category } from './categories';
import { isSelfTransfer } from './identity';
import type { Identity } from './identity';
import type { ParsedTransaction } from './parser';
import { isIpoDebit } from './ipo';
import type { IpoIssuer } from './ipo';

export interface ClassifyContext {
  identity: Identity;
  /** Learned merchant rules (merchant_rules table). */
  rules: Record<string, string>;
  /** Names or VPAs from the `family_members` setting. */
  family: string[];
  /** Names or VPAs from the `friends` setting (optional: older callers omit it). */
  friends?: string[];
  /** Amazon Pay wallet top-ups are family money (default true when omitted). */
  amazonTopupFamily?: boolean;
  /** IPOs with money blocked/allotted: their final bank debit is Investment. */
  ipoIssuers?: IpoIssuer[];
}

export interface Classification {
  category: Category;
  type: 'expense' | 'income' | 'self';
}

/**
 * Lowercase letters and digits only: "SONA KIRAN KO.." → "sonadilipko".
 * Digits are kept so a phone-number VPA ("9988776118@ibl") stays specific
 * instead of collapsing to "ibl", which would match every @ibl handle.
 */
function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a row's merchant/counterparty is on a configured people list
 * (family_members or friends).
 * Candidate contains the entry, or (for bank-truncated names like
 * "SONA KIRAN KO..") the entry starts with the candidate — only when the
 * candidate has at least 8 letters, so short fragments can't match.
 */
export function isFamilyMember(
  parsed: Pick<ParsedTransaction, 'merchant' | 'counterparty'>,
  family: string[],
): boolean {
  const entries = family.map(letters).filter(Boolean);
  if (entries.length === 0) {
    return false;
  }
  for (const cand of [parsed.merchant, parsed.counterparty]) {
    const c = cand ? letters(cand) : '';
    if (!c) {
      continue;
    }
    for (const e of entries) {
      if (c.includes(e) || (c.length >= 8 && e.startsWith(c))) {
        return true;
      }
    }
  }
  return false;
}

export function classify(
  parsed: ParsedTransaction,
  ctx: ClassifyContext,
): Classification {
  const { kind } = parsed;
  // Amazon Pay wallet top-up (Gmail confirmation): decisive, no counterparty to match.
  if (kind === 'wallet_topup') {
    return ctx.amazonTopupFamily === false
      ? { category: 'Other', type: 'self' }
      : { category: 'Family', type: 'income' };
  }
  if (kind === 'cashback') {
    return { category: 'Cashback', type: 'income' };
  }
  if (
    kind === 'card_bill' ||
    kind === 'wallet_load' ||
    kind === 'own_transfer' ||
    isSelfTransfer(parsed, ctx.identity)
  ) {
    return { category: categorize(parsed.merchant, parsed.raw_text, parsed.counterparty, ctx.rules, parsed.isExpense), type: 'self' };
  }
  const type = parsed.isExpense ? 'expense' : 'income';
  // Self check ran first: the user's own full name contains the father's name.
  if (!parsed.isExpense && isFamilyMember(parsed, ctx.family)) {
    return { category: 'Family', type };
  }
  // Friends: both directions; type stays as parsed. Family wins over friend.
  if (ctx.friends && isFamilyMember(parsed, ctx.friends)) {
    return { category: 'Friend Transfer', type };
  }
  if (parsed.isExpense && isIpoDebit(parsed.merchant, parsed.amount, ctx.ipoIssuers, parsed.timestamp)) {
    return { category: 'Investment', type };
  }
  if (kind === 'investment') {
    return { category: 'Investment', type };
  }
  return {
    category: categorize(parsed.merchant, parsed.raw_text, parsed.counterparty, ctx.rules, parsed.isExpense),
    type,
  };
}
