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

/**
 * Amount: ₹, Rs., Rs, INR — with optional space before the digits, plus an
 * optional "lakh"/"lac"/"crore"/"cr" magnitude word (e.g. "₹1.5 Lakh").
 */
const AMOUNT_RE =
  /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)\s*(lakh|lac|lakhs|crore|cr)?\b/i;

const AMOUNT_MULTIPLIERS: Record<string, number> = {
  lakh: 100000,
  lac: 100000,
  lakhs: 100000,
  crore: 10000000,
  cr: 10000000,
};

/**
 * Messages that contain an amount but are NOT a real settled transaction:
 * future-dated autopay/mandate notices, promo terms, failed/declined
 * payments, OTP prompts, and money-request notices. Matching any of these
 * short-circuits parsing entirely (returns null).
 */
const NEGATIVE_GUARD_RE =
  /will be (?:debited|credited)|could not|failed|declined|unsuccessful|reversed request|\botp\b|e-?mandate|autopay.*(?:set|registered)|requested money|has requested/i;

/** Refund/reversal keywords — used to override direction even when "debited" also appears. */
const REFUND_RE = /\b(refund|reversed|reversal)\b/i;

/** Expense direction keywords. */
const EXPENSE_RE =
  /\b(debited|spent|charged|sent|paid|purchase|withdrawn|w\/d)\b/i;

/** Income direction keywords. */
const INCOME_RE = /\b(credited|received|refund)\b/i;

/**
 * Merchant: text immediately after "at ", "to ", "towards ", or (income only)
 * "from " up to the first punctuation character, a newline, or end of string.
 * ":" is excluded from the capture so a time like "10:30" can't swallow the
 * real merchant clause that follows it. A negative lookahead skips "your"
 * ("credited to your account") so that phrase is never captured as a merchant.
 */
const MERCHANT_RE_EXPENSE = /\b(?:at|to|towards)\s+(?!your\b)([^.,;:!\n]+)/gi;
const MERCHANT_RE_INCOME = /\b(?:at|to|towards|from)\s+(?!your\b)([^.,;:!\n]+)/gi;

/** UPI VPA pattern: word.chars@word (at least 2-letter domain), not an email
 * (emails continue with a ".tld" after the domain; VPAs don't). */
const VPA_RE = /[\w.\-]+@[a-z]{2,}(?!\.[a-z]{2,})/i;

/**
 * Indian mobile phone — optional +91 or 0 prefix, then 10 digits starting with
 * 6-9 (TRAI numbering plan). Boundaries on both sides prevent matching a
 * 10-digit run embedded in a longer digit string (e.g. a 12-digit reference
 * number). Candidates immediately preceded by "ref/utr/rrn/txn" are rejected
 * in findCounterpartyPhone() below since those aren't expressible as a
 * fixed-length lookbehind.
 */
const PHONE_RE = /(?<![\d])(?:(?:\+91|0)\s*)?([6-9]\d{9})(?!\d)/g;

/** Words that mean "the digits after this are a reference number, not a phone". */
const REF_NUMBER_CONTEXT_RE = /(?:ref|utr|rrn|txn)[^a-z0-9]{0,6}$/i;

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
  /(?:avl\.?\s*bal(?:ance)?|available\s+balance|\bbal\b)\s*[:\s]*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** When both an expense and an income keyword appear, pick the one nearest the amount. */
function closerKeywordIsExpense(body: string, amountIndex: number): boolean {
  let nearestExpenseDist = Infinity;
  for (const m of body.matchAll(new RegExp(EXPENSE_RE.source, 'gi'))) {
    nearestExpenseDist = Math.min(nearestExpenseDist, Math.abs((m.index ?? 0) - amountIndex));
  }
  let nearestIncomeDist = Infinity;
  for (const m of body.matchAll(new RegExp(INCOME_RE.source, 'gi'))) {
    nearestIncomeDist = Math.min(nearestIncomeDist, Math.abs((m.index ?? 0) - amountIndex));
  }
  return nearestExpenseDist <= nearestIncomeDist;
}

/** Finds a plausible counterparty phone number, skipping reference/UTR/RRN/txn numbers. */
function findCounterpartyPhone(body: string): string | null {
  for (const m of body.matchAll(new RegExp(PHONE_RE.source, PHONE_RE.flags))) {
    const idx = m.index ?? 0;
    const before = body.slice(Math.max(0, idx - 15), idx);
    if (REF_NUMBER_CONTEXT_RE.test(before)) {
      continue;
    }
    return m[1];
  }
  return null;
}

/**
 * Extracts a merchant name from an "at/to/towards" (or "from", income only)
 * clause. Skips low-quality candidates: "your ..." clauses (excluded by the
 * regex itself) and purely-numeric fragments left over after ":" truncated a
 * time expression (e.g. "at 10:30 at SWIGGY" → skip "10", capture "SWIGGY").
 */
function extractMerchant(body: string, isExpense: boolean): string | null {
  const re = isExpense ? MERCHANT_RE_EXPENSE : MERCHANT_RE_INCOME;
  re.lastIndex = 0;
  for (const m of body.matchAll(re)) {
    let raw = m[1];
    raw = raw.replace(MERCHANT_NOISE_RE, '');
    raw = raw.replace(/[.,;!?]+$/, '').trim();
    if (raw && !/^\d+$/.test(raw)) {
      return raw;
    }
  }
  return null;
}

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

  // ── Guard: promo / autopay-future / failed / OTP / money-request messages ──
  // These all commonly contain a real-looking amount + direction keyword but
  // are not a settled transaction.
  if (NEGATIVE_GUARD_RE.test(body)) {
    return null;
  }

  // ── 1. Amount ──────────────────────────────────────────────────────────────
  const amountMatch = body.match(AMOUNT_RE);
  if (!amountMatch) {
    return null;
  }
  let amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  const magnitudeWord = amountMatch[2]?.toLowerCase();
  if (magnitudeWord && AMOUNT_MULTIPLIERS[magnitudeWord]) {
    amount *= AMOUNT_MULTIPLIERS[magnitudeWord];
  }
  if (!(amount > 0)) {
    // Rejects amount <= 0 and NaN (e.g. "Rs.0.00 debited" failed-auth messages).
    return null;
  }

  // ── 2. Direction ───────────────────────────────────────────────────────────
  // "transfer" alone is ambiguous — only treated as expense when "debited" or
  // "sent" is also present (handled naturally by EXPENSE_RE below).
  const isExpenseKeyword = EXPENSE_RE.test(body);
  const isIncomeKeyword = INCOME_RE.test(body);

  if (!isExpenseKeyword && !isIncomeKeyword) {
    // Amount present but direction unclear (balance alerts, OTP-adjacent, etc.)
    return null;
  }

  let isExpense: boolean;
  if (REFUND_RE.test(body) && isIncomeKeyword) {
    // "Refund of Rs.500 credited… originally debited on…" contains both
    // keyword sets; a refund/reversal message with a credit keyword is
    // always income, even though "debited" also appears (referring to the
    // original, now-reversed, charge).
    isExpense = false;
  } else if (isExpenseKeyword && isIncomeKeyword) {
    // Both keyword sets matched and it's not a refund — pick whichever
    // keyword occurs closer to the amount, since that's the one actually
    // describing THIS message's direction.
    isExpense = closerKeywordIsExpense(body, amountMatch.index ?? 0);
  } else {
    isExpense = isExpenseKeyword;
  }

  // ── 3. Counterparty (priority: VPA > phone > account fragment) ─────────────
  let counterparty: string | null = null;

  const vpaMatch = body.match(VPA_RE);
  if (vpaMatch) {
    counterparty = vpaMatch[0].toLowerCase();
  } else {
    const phoneDigits = findCounterpartyPhone(body);
    if (phoneDigits) {
      counterparty = phoneDigits;
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
  const merchant = extractMerchant(body, isExpense);

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
