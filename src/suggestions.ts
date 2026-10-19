// ─── Settings suggestions (pure) ──────────────────────────────────────────────
//
// Turn aggregate rows from db.ts (getAccountCounts / getIncomeSources) into the
// "Add ••1234" and family-member chips shown in Settings. No DB access here so
// the logic is unit-testable.

import { categorize, MERCHANT_VPA_RE } from './categories';
import { isFamilyMember } from './classify';
import { isSelfTransfer } from './identity';
import type { Identity } from './identity';

export interface AccountCount {
  account: string;
  count: number;
}

export interface IncomeSource {
  merchant: string | null;
  counterparty: string | null;
  total: number;
}

export interface FamilySuggestion {
  /** Value to store in family_members (a name or a VPA). */
  value: string;
  total: number;
}

/** Account last-4s seen on stored rows that are not yet in identity.accountLast4. */
export function suggestOwnAccounts(
  rows: AccountCount[],
  identity: Identity,
): AccountCount[] {
  const known = new Set(identity.accountLast4);
  const merged = new Map<string, number>();
  for (const r of rows) {
    const acct = (r.account ?? '').trim();
    if (!/^\d{3,4}$/.test(acct) || known.has(acct)) {
      continue;
    }
    merged.set(acct, (merged.get(acct) ?? 0) + r.count);
  }
  return [...merged.entries()]
    .map(([account, count]) => ({ account, count }))
    .sort((a, b) => b.count - a.count);
}

const PERSON_NAME_RE = /^[A-Za-z][A-Za-z.' ]*$/;

function looksLikePerson(name: string): boolean {
  const t = name.trim();
  return PERSON_NAME_RE.test(t) && t.split(/\s+/).filter(w => w.length > 0).length >= 2;
}

function isPersonalVpa(v: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(v) && !MERCHANT_VPA_RE.test(v);
}

/**
 * Top income counterparties by total amount that look like a person (>= 2 name
 * tokens) or a personal VPA, excluding anyone already in the family list, the
 * user themself, and anything the brand map already recognises.
 */
export function suggestFamily(
  rows: IncomeSource[],
  ctx: { identity: Identity; family: string[] },
  limit = 6,
): FamilySuggestion[] {
  const byKey = new Map<string, FamilySuggestion>();
  for (const r of rows) {
    const candidates: string[] = [];
    if (r.merchant && looksLikePerson(r.merchant)) {
      candidates.push(r.merchant.trim());
    } else if (r.counterparty && isPersonalVpa(r.counterparty)) {
      candidates.push(r.counterparty.trim());
    }
    for (const value of candidates) {
      if (isFamilyMember({ merchant: value, counterparty: null }, ctx.family)) {
        continue;
      }
      if (isSelfTransfer({ merchant: value, counterparty: null }, ctx.identity)) {
        continue;
      }
      // 'UPI' is the generic "@" bucket, not a recognised brand.
      const cat = categorize(value, '', null, {}, true);
      if (cat !== 'Other' && cat !== 'UPI') {
        continue;
      }
      const key = value.toLowerCase();
      const prev = byKey.get(key);
      byKey.set(key, { value: prev?.value ?? value, total: (prev?.total ?? 0) + r.total });
    }
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}
