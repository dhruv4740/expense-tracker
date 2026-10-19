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

export interface ClassifyContext {
  identity: Identity;
  /** Learned merchant rules (merchant_rules table). */
  rules: Record<string, string>;
  /** Names or VPAs from the `family_members` setting. */
  family: string[];
}

export interface Classification {
  category: Category;
  type: 'expense' | 'income' | 'self';
}

/** Lowercase, letters only: "SONA KIRAN KO.." → "sonadilipko". */
function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * True when a credit's merchant/counterparty is a configured family member.
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
  if (kind === 'investment') {
    return { category: 'Investment', type };
  }
  return {
    category: categorize(parsed.merchant, parsed.raw_text, parsed.counterparty, ctx.rules, parsed.isExpense),
    type,
  };
}
