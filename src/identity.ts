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

/**
 * Returns true when the parsed transaction's counterparty matches one of the
 * user's own identifiers, making it a self-transfer (wallet top-up, own account
 * transfer, etc.).
 *
 * Matching rules (in order; first match wins):
 *  1. UPI VPA counterparty — case-insensitive exact match against `upiHandles`.
 *  2. Phone counterparty — `normalizePhone(counterparty)` must be in `phones`.
 *  3. Account-fragment counterparty (3-4 digits) — must appear in `accountLast4`.
 *
 * An empty identity (all arrays empty) always returns false — the function is
 * safe to call before the user has configured anything.
 *
 * @param parsed  Only the `counterparty` field is inspected.
 * @param identity The user's stored Identity.
 */
export function isSelfTransfer(
  parsed: Pick<ParsedTransaction, 'counterparty'>,
  identity: Identity,
): boolean {
  const { counterparty } = parsed;
  if (!counterparty) {
    return false;
  }

  const cpLower = counterparty.toLowerCase();

  // 1. UPI VPA — contains '@', so check identity handles case-insensitively.
  if (counterparty.includes('@')) {
    return identity.upiHandles.some(h => h.toLowerCase() === cpLower);
  }

  // 2. 10-digit phone — normalise both sides.
  if (/^\d{10}$/.test(counterparty)) {
    const normCp = normalizePhone(counterparty);
    return identity.phones.some(p => normalizePhone(p) === normCp);
  }

  // 3. Short account fragment (3-4 digits) — check accountLast4.
  if (/^\d{3,4}$/.test(counterparty)) {
    return identity.accountLast4.includes(counterparty);
  }

  return false;
}
