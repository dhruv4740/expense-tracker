// ─── Identity model and self-transfer detection ───────────────────────────────
//
// Used by sync.ts to classify inbound transfers to the user's own accounts /
// UPI handles as type='self' rather than 'income' or 'expense'.

import type { ParsedTransaction } from './parser';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The user's known personal identifiers. Populated from settings (src/settings.ts)
 * and consulted at sync time. All fields default to empty arrays / empty string
 * so an unset identity is safe to use everywhere without null checks.
 */
export interface Identity {
  /** Display name (not used for matching; kept for UI). */
  name: string;
  /**
   * List of the user's own mobile phone numbers in normalised 10-digit form
   * (no country code, no spaces). Example: ["9876543210"].
   */
  phones: string[];
  /**
   * UPI handles the user owns (case-insensitive). Example: ["user@okaxis", "9876543210@upi"].
   */
  upiHandles: string[];
  /**
   * Last 3-4 digits of the user's own bank accounts. Used to identify
   * account-fragment counterparties. Example: ["1234", "9012"].
   */
  accountLast4: string[];
}

// ─── Phone normaliser ─────────────────────────────────────────────────────────

/**
 * Strips all non-digit characters, drops a leading country code (91) or trunk
 * prefix (0), and returns the last 10 digits.
 *
 * Examples:
 *   "+91 98765 43210" → "9876543210"
 *   "09876543210"     → "9876543210"
 *   "9876543210"      → "9876543210"
 *   "919876543210"    → "9876543210"
 */
export function normalizePhone(s: string): string {
  const digits = s.replace(/\D/g, '');
  if (digits.length > 10) {
    // Drop leading 91 (country code) or 0 (trunk prefix) if present.
    if (digits.startsWith('91') && digits.length === 12) {
      return digits.slice(2);
    }
    if (digits.startsWith('0') && digits.length === 11) {
      return digits.slice(1);
    }
    // Otherwise take the last 10 digits.
    return digits.slice(-10);
  }
  return digits;
}

// ─── Self-transfer detection ──────────────────────────────────────────────────

const TITLE_RE = /^(?:mr|ms|mrs|miss|dr|shri|smt)$/;

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .filter((t, i) => !(i === 0 && TITLE_RE.test(t)));
}

/**
 * True when `candidate` is the user's own name. The FIRST tokens must be equal
 * and the LAST tokens prefix-compatible (min 3 chars, so a truncated
 * "KOTH"/"KOT.." still matches). Middle names are free. Never matches on the
 * surname alone or on initials: parents share the surname and middle name.
 */
function matchesOwnName(candidate: string, ownName: string): boolean {
  const own = nameTokens(ownName);
  const cand = nameTokens(candidate);
  if (own.length < 2 || cand.length < 2) {
    return false;
  }
  if (own[0] !== cand[0]) {
    return false;
  }
  const a = own[own.length - 1];
  const b = cand[cand.length - 1];
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

function matchesOwnVpa(vpa: string, identity: Identity): boolean {
  const lower = vpa.toLowerCase();
  if (identity.upiHandles.some(h => h.toLowerCase() === lower)) {
    return true;
  }
  const local = lower.slice(0, lower.indexOf('@'));
  // Masked: "*1111@bank" / "xx1111@bank" — last 4 digits of an own phone.
  const masked = local.match(/^[*x]+(\d{4})$/);
  if (masked) {
    return identity.phones.some(p => normalizePhone(p).endsWith(masked[1]));
  }
  // Phone number as the local part, any provider.
  if (/^\d{10}$/.test(local)) {
    return identity.phones.some(p => normalizePhone(p) === local);
  }
  return false;
}

/**
 * Returns true when the parsed transaction's counterparty or merchant is one of
 * the user's own identifiers, making it a self-transfer (wallet top-up, own
 * account transfer, etc.).
 *
 * Matching rules, per candidate:
 *  1. UPI VPA — exact own handle, masked `*1111@x` against an own phone's last
 *     4 digits, or an own phone as the local part (`9876543210@anything`).
 *  2. Phone counterparty — `normalizePhone(counterparty)` must be in `phones`.
 *  3. Account-fragment counterparty (3-4 digits) — must appear in `accountLast4`.
 *  4. Name — see matchesOwnName().
 *
 * An empty identity always returns false.
 */
export function isSelfTransfer(
  parsed: Pick<ParsedTransaction, 'counterparty'> & { merchant?: string | null },
  identity: Identity,
): boolean {
  const { counterparty, merchant } = parsed;

  if (counterparty) {
    if (counterparty.includes('@')) {
      if (matchesOwnVpa(counterparty, identity)) {
        return true;
      }
    } else if (/^\d{10}$/.test(counterparty)) {
      const normCp = normalizePhone(counterparty);
      if (identity.phones.some(p => normalizePhone(p) === normCp)) {
        return true;
      }
    } else if (/^\d{3,4}$/.test(counterparty)) {
      if (identity.accountLast4.includes(counterparty)) {
        return true;
      }
    }
  }

  for (const cand of [merchant, counterparty]) {
    if (!cand) {
      continue;
    }
    if (cand.includes('@')) {
      if (matchesOwnVpa(cand, identity)) {
        return true;
      }
    } else if (matchesOwnName(cand, identity.name)) {
      return true;
    }
  }
  return false;
}
