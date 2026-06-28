// ─── Transaction parser (pure TypeScript, no DB, no side effects) ────────────
//
// Input:  (sender: string, body: string, ts?: number)
// Output: ParsedTransaction | null
//
// Returns null for:
//   - empty / whitespace-only body
//   - no amount match
//   - ambiguous direction (no clear expense OR income keyword)
//
// Categorization is intentionally NOT done here — it belongs in sync.ts where
// DB-backed learned rules are available.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedTransaction {
  /** Transaction amount in INR (commas removed). */
  amount: number;
  /**
   * Last-known available balance, if present in the message ("Avl Bal", "Available
   * Balance", "Bal:"). null if not found. Best-effort — display as "last seen" only.
   */
  balance?: number;
  /**
   * Cleaned merchant name extracted from "at / to / towards" clauses.
   * null if extraction fails or produces empty text; sync.ts falls back to
   * counterparty then sender.
   */
  merchant: string | null;
  /**
   * Counterparty identifier — the other party in the transaction.
   * Resolution priority: UPI VPA > 10-digit phone > account fragment.
   * null when none found.
   */
  counterparty: string | null;
  /** SMS sender ID or notification package name — always the raw e.sender/e.pkg. */
  source: string;
  /** true = expense (debit), false = income (credit/refund). */
  isExpense: boolean;
  /**
   * The USER's own account hint (last 3–4 digits) from "A/c XX1234" / "account
   * ending 1234" patterns. Distinct from counterparty. null if not found.
   */
  account: string | null;
  /** Capture timestamp in milliseconds (passed in from the raw event). */
  timestamp: number;
  /** Unmodified original message body. */
  raw_text: string;
}

// ─── Compiled regexes ─────────────────────────────────────────────────────────

/** Amount: ₹, Rs., Rs, INR — with optional space before the digits. */
const AMOUNT_RE = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i;

/** Expense direction keywords. */
const EXPENSE_RE =
  /\b(debited|spent|charged|sent|paid|purchase|withdrawn|w\/d)\b/i;

/** Income direction keywords. */
const INCOME_RE = /\b(credited|received|refund)\b/i;

/**
 * Merchant: text immediately after "at ", "to ", or "towards " up to the first
 * punctuation character, a newline, or end of string.
 */
const MERCHANT_RE = /\b(?:at|to|towards)\s+([^.,;!\n]+)/i;

/** UPI VPA pattern: word.chars@word (at least 2-letter domain). */
const VPA_RE = /[\w.\-]+@[a-z]{2,}/i;

/**
 * Indian mobile phone — optional +91 or 0 prefix, then 10 digits starting with
 * 6-9 (TRAI numbering plan). The \b anchors prevent matching longer digit runs.
 */
const PHONE_RE = /(?:(?:\+91|0)\s*)?([6-9]\d{9})\b/;

/**
 * Counterparty account fragment from message text:
 * "a/c 1234", "acct 9876", "account 0012" — 3-4 trailing digits.
 * This regex is used for COUNTERPARTY extraction only when VPA/phone are absent.
 */
const COUNTERPARTY_ACCT_RE = /(?:a\/c|acct|account)[^\d]*(\d{3,4})\b/i;

/**
 * The USER's own account hint: "A/c XX1234", "account ending 1234",
 * "a/c ending in 9012", "Ac No. XX5678". Captures the trailing 3-4 digits.
 */
const USER_ACCT_RE =
  /(?:a\/c\s*(?:no\.?\s*)?(?:x+|ending(?:\s+in)?)\s*|account\s+ending\s*(?:in\s*)?)(\d{3,4})\b/i;

/** Trailing noise to strip from merchant strings. */
const MERCHANT_NOISE_RE =
  /\s+(on\s+\d{1,2}[-/]\w+[-/]\w+|ref\w*[:\s]+\S+|avl\s*bal\w*.*|a\/c\s*\w+|\bacct\b.*|\baccount\b.*)/i;

/**
 * Available balance from bank SMS: "Avl Bal: Rs.5,000.00", "Avl Bal INR 1234.56",
 * "Available Balance: ₹12000", "Bal: Rs.500".
 */
const BALANCE_RE =
  /(?:avl\.?\s*bal(?:ance)?|available\s+balance|bal)\s*[:\s]*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i;

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parse a single SMS / notification body into a structured transaction.
 *
 * Pure function — no DB access, no logging, no side effects.
 *
 * @param sender  SMS sender ID (e.g. "HDFCBK") or notification package name.
 * @param body    Raw message text.
 * @param ts      Capture timestamp in ms (defaults to Date.now()).
 * @returns ParsedTransaction or null for non-transaction / ambiguous messages.
 */
export function parseTransaction(
  sender: string,
  body: string,
  ts: number = Date.now(),
): ParsedTransaction | null {
  // ── Guard: null / empty / whitespace body ──────────────────────────────────
  if (!body || !body.trim()) {
    return null;
  }

  // ── 1. Amount ──────────────────────────────────────────────────────────────
  const amountMatch = body.match(AMOUNT_RE);
  if (!amountMatch) {
    return null;
  }
  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

  // ── 2. Direction ───────────────────────────────────────────────────────────
  // "transfer" alone is ambiguous — only treated as expense when "debited" or
  // "sent" is also present (handled naturally by EXPENSE_RE below).
  const isExpenseKeyword = EXPENSE_RE.test(body);
  const isIncomeKeyword = INCOME_RE.test(body);

  if (!isExpenseKeyword && !isIncomeKeyword) {
    // Amount present but direction unclear (balance alerts, OTP-adjacent, etc.)
    return null;
  }

  const isExpense = isExpenseKeyword;

  // ── 3. Counterparty (priority: VPA > phone > account fragment) ─────────────
  let counterparty: string | null = null;

  const vpaMatch = body.match(VPA_RE);
  if (vpaMatch) {
    counterparty = vpaMatch[0].toLowerCase();
  } else {
    const phoneMatch = body.match(PHONE_RE);
    if (phoneMatch) {
      // Keep the normalised 10-digit form.
      counterparty = phoneMatch[1];
    } else {
      const ctAcctMatch = body.match(COUNTERPARTY_ACCT_RE);
      if (ctAcctMatch) {
        counterparty = ctAcctMatch[1];
      }
    }
  }

  // ── 4. User's own account hint ─────────────────────────────────────────────
  const userAcctMatch = body.match(USER_ACCT_RE);
  const account: string | null = userAcctMatch ? userAcctMatch[1] : null;

  // ── 5. Merchant ────────────────────────────────────────────────────────────
  let merchant: string | null = null;
  const merchantMatch = body.match(MERCHANT_RE);
  if (merchantMatch) {
    let raw = merchantMatch[1];
    // Strip trailing noise: " on 27-Jun-26", "Ref: 12345", "Avl Bal ...", etc.
    raw = raw.replace(MERCHANT_NOISE_RE, '');
    // Strip trailing punctuation / whitespace.
    raw = raw.replace(/[.,;!?]+$/, '').trim();
    merchant = raw || null;
  }

  // ── 6. Available balance (optional, best-effort) ────────────────────────────
  const balanceMatch = body.match(BALANCE_RE);
  const balance = balanceMatch
    ? parseFloat(balanceMatch[1].replace(/,/g, ''))
    : undefined;

  return {
    amount,
    merchant,
    counterparty,
    source: sender,
    isExpense,
    account,
    timestamp: ts,
    raw_text: body,
    ...(balance != null && !isNaN(balance) ? { balance } : {}),
  };
}
