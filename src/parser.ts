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
  /**
   * Set when the message is not ordinary spend/income: a credit-card bill
   * settlement, a top-up of the user's own wallet, a move between the user's
   * own accounts, or an investment (IPO allotment). Consumed by classify.ts.
   */
  kind?: TransactionKind;
}

export type TransactionKind =
  | 'card_bill'
  | 'wallet_load'
  | 'own_transfer'
  | 'investment'
  | 'wallet_topup'
  | 'cashback';

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
 * payments, OTP prompts, money-request notices, IPO bid/mandate traffic, and
 * AMC confirmations that duplicate a bank debit. Matching any of these
 * short-circuits parsing entirely (returns null).
 */
const NEGATIVE_GUARDS: RegExp[] = [
  // Future-dated / promo
  /will be (?:auto[- ]?)?(?:debited|deducted|credited)/i,
  /could not|failed|declined|unsuccessful|reversed request/i,
  /\botp\b|e-?mandate|autopay.*(?:set|registered)/i,
  /requested money|has requested/i,
  // The user's OWN outgoing money request ("your request for Rs.500 ... has been sent to X")
  /your request for (?:Rs\.?|INR|₹)\s*[\d,.]+[\s\S]*?has been sent to/i,
  // Gambling/app sign-up bonuses and bill reminders are not account movements
  /welcome bonus|prize pool/i,
  /pay your due amount|bill for [\s\S]{0,40}has been sent to your registered email/i,
  // Merchant refund notices that only announce intent (the credit is the real
  // movement of money; "processed" / bank-credit messages are kept)
  /refund[\s\S]{0,120}\binitiated\b/i,
  /refund reference number/i,
  // IPO bidding, blocking and allotment traffic (the bank debit is the
  // only message that is a real movement of money)
  /UPI-IPO/i,
  /\bIPO\b/i,
  /unbl(?:oc)?k/i,
  /submitted on BSE/i,
  /allot(?:ted|ment)/i,
  /blocked in your account/i,
  /\bCDSL\b/i,
  // AMC confirmations that duplicate the bank debit
  /SIP Purchase[\s\S]*processed/i,
  /purchase request dated[\s\S]*processed/i,
  // Kotak "twin" confirmation of an already-reported transaction
  /Your transaction for INR [\d,.]+ against txn ID \S+ has been processed successfully/i,
  /UPI LITE Top-?up/i,
  // FD closure request acknowledgement (the real money is the later
  // "Closure Proceeds" credit)
  /premature closure request/i,
  // Mandate setup (NOT a bare "UPI Mandate": that prefix is a real debit)
  /mandate[\s\S]*successfully created/i,
  /collect request/i,
  /Mandate reference no[\s\S]*issued/i,
  // Merchant receipts / dues
  /we received Rs\.?\s*[\d,.]+ for invoice/i,
  /pending amount is/i,
];

/** Refund/reversal keywords — used to override direction even when "debited" also appears. */
const REFUND_RE = /\b(refund|reversed|reversal)\b/i;

/** Expense direction keywords. */
const EXPENSE_RE =
  /\b(debited|deducted|spent|charged|sent|paid|purchase|withdrawn|w\/d)\b/i;

/** Income direction keywords. */
const INCOME_RE = /\b(credited|received|refund)\b/i;

/**
 * Merchant: text immediately after "at ", "to ", "towards ", or (income only)
 * "from " up to the first punctuation character, a newline, or end of string.
 * ":" is excluded from the capture so a time like "10:30" can't swallow the
 * real merchant clause that follows it. A negative lookahead skips "your"
 * ("credited to your account") so that phrase is never captured as a merchant.
 */
// "." is allowed INSIDE the capture (a sentence-final period is stripped
// separately below) — excluding it truncated every dotted VPA and abbreviated
// name: "john.doe@okhdfcbank" -> "john", "Dr. Mehta Clinic" -> "Dr".
const MERCHANT_RE_EXPENSE = /\b(?:at|to|towards)\s+(?!your\b)([^,;:!\n]+)/gi;
// Income never takes a "to ..." candidate: "credited to HDFC Bank A/c ..." is the
// user's own account. "from" is preferred; "towards"/"at" are the fallback.
const MERCHANT_RE_INCOME_FROM = /\bfrom\s+(?!your\b)([^,;:!\n]+)/gi;
const MERCHANT_RE_INCOME_OTHER = /\b(?:at|towards)\s+(?!your\b)([^,;:!\n]+)/gi;

/**
 * Clauses where "to"/"at" introduces an instruction, not a payee. Without this
 * "Call 18002586161 to report fraud immediately" stored a merchant of
 * "report fraud immediately".
 */
const MERCHANT_INSTRUCTION_RE =
  /^(?:report|dispute|block|call|know|check|view|avoid|stop|unsubscribe|opt|claim|activate|verify|update|register|download|login|log in|see|visit)\b/i;

/**
 * UPI VPA: handle@provider, rejecting email addresses. The provider label is
 * captured greedily and then checked for a dotted TLD — the previous inline
 * negative lookahead could be defeated by backtracking, which yielded
 * "care@hdfcban" from "care@hdfcbank.com" and let a bank support address
 * become a counterparty (and, via "apply to all", a merchant rule matching
 * every SMS from that bank).
 */
const VPA_CANDIDATE_RE = /[\w.\-]+@[a-z][a-z0-9\-]*(?:\.[a-z]{2,})*/i;

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
 * Counterparty account fragment from message text — directional so the
 * USER's own account (referenced as "your A/c XX1234", "A/c XX1234 debited",
 * with no to/from clause) is never mistaken for the other party. Only "to
 * a/c ..." (expense) / "from a/c ..." (income) clauses count as a
 * counterparty account. Gap bounded to 10 chars so it can't jump across an
 * unrelated sentence to grab an unrelated account number.
 */
const COUNTERPARTY_ACCT_EXPENSE_RE =
  /\b(?:to|and)\s+(?:a\/c|acct|account)[^\d]{0,10}(\d{3,4})\b/i;
const COUNTERPARTY_ACCT_INCOME_RE =
  /\bfrom\s+(?:a\/c|acct|account)[^\d]{0,10}(\d{3,4})\b/i;

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


/** Cut a message at the first disclaimer/helpline marker (helpline numbers are not counterparties). */
const DISCLAIMER_RE =
  /not you|if not (?:you|u)\b|dispute|\bcall\s*\+?\d|sms\s+block|for assistance|to report/i;

/** FamPay prints the user's OWN handle after "using". */
const OWN_FAM_HANDLE_RE = /\s+using\s+[\w.-]+@fam\b/gi;

function counterpartyView(body: string): string {
  const cut = body.search(DISCLAIMER_RE);
  const head = cut >= 0 ? body.slice(0, cut) : body;
  return head.replace(OWN_FAM_HANDLE_RE, '');
}

interface Template {
  re: RegExp;
  isExpense: boolean;
  /** Absent: generic extraction. Present (even null-returning): authoritative. */
  merchant?: string | ((m: RegExpMatchArray) => string | null);
  kind?: TransactionKind;
  /** Overrides the sender as the stored source (e.g. 'Amazon Pay' for a Gmail email). */
  source?: string;
}

/**
 * Known message formats, tried in order BEFORE the negative guard and the
 * generic direction logic. Each is specific enough that a match is decisive.
 */
const TEMPLATES: Template[] = [
  // Cashback credited/added (Amazon Pay wallet email, bank/UPI app SMS). Income, never
  // Family; promos ("will be credited"), failures and debits are excluded up front
  // because templates run before the negative guards.
  {
    re: /^(?![\s\S]*\bwill be\b)[\s\S]*\bcashback\b[\s\S]{0,60}?\badded\b[\s\S]{0,40}?\bamazon\s*pay\s*wallet/i,
    isExpense: false,
    merchant: () => 'Amazon Pay cashback',
    kind: 'cashback',
    source: 'Amazon Pay',
  },
  {
    re: /^(?![\s\S]*(?:will be|could not|failed|declined|reversed|\botp\b|debited|\bamazon\s*pay\s*wallet))(?:[\s\S]*\bcashback\b[\s\S]*?\b(?:credited|added)\b|[\s\S]*\b(?:credited|added)\b[\s\S]*?\bcashback\b)/i,
    isExpense: false,
    merchant: () => 'Cashback',
    kind: 'cashback',
  },
  // Amazon Pay wallet top-up confirmation ("₹2000.00 added to your Amazon Pay
  // Wallet" / "You have added ₹2000.00 successfully to your Amazon Pay Wallet").
  // Income into the user's own wallet; classify() decides Family vs self. Must not
  // match "Apay Wallet balance is debited" (that has no "added ... Amazon Pay Wallet").
  {
    re: /\badded\b[\s\S]*?\bamazon\s*pay\s*wallet/i,
    isExpense: false,
    merchant: () => 'Amazon Pay wallet top-up',
    kind: 'wallet_topup',
    source: 'Amazon Pay',
  },
  {
    re: /credit card transaction of (?:Rs\.?|INR|₹)\s*[\d,.]+ on (.+?) is successful/i,
    isExpense: true,
    merchant: m => m[1],
  },
  {
    re: /using Apay balance (?:is )?successful at (.+?)(?=\.?\s+Updated|\.\s|$)/i,
    isExpense: true,
    merchant: m => m[1],
  },
  {
    re: /^Payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ from (\w+) Money Balance is successful/i,
    isExpense: true,
    merchant: m => m[1],
  },
  {
    re: /^Net interest (?:INR|Rs\.?)\s*[\d,.]+ paid on your/i,
    isExpense: false,
    merchant: () => 'Deposit interest',
  },
  // A third party pushing money to the user's account (no "credited"/"received" word)
  {
    re: /^(?:This is to inform you that )?M\/s (.+?) has transferred an amount of (?:Rs\.?|INR|₹)\s*[\d,.]+ to your account/i,
    isExpense: false,
    merchant: m => m[1],
  },
  // Card-bill settlements (both legs; classify treats them as transfers)
  {
    re: /credit card bill of (?:Rs\.?|INR|₹)\s*[\d,.]+ has been paid successfully/i,
    isExpense: true,
    merchant: () => null,
    kind: 'card_bill',
  },
  {
    re: /^Repayment of (?:Rs\.?|INR|₹)\s*[\d,.]+ received for the .*credit card/i,
    isExpense: false,
    merchant: () => null,
    kind: 'card_bill',
  },
  {
    re: /received your payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ for your/i,
    isExpense: false,
    merchant: () => null,
    kind: 'card_bill',
  },
  {
    re: /received payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ for your \S*card/i,
    isExpense: false,
    merchant: () => null,
    kind: 'card_bill',
  },
  {
    re: /^(?:Hi!?\s+)?Payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ received towards .*Credit Card/i,
    isExpense: false,
    merchant: () => null,
    kind: 'card_bill',
  },
  {
    re: /^Payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ is credited to your .*Credit Card/i,
    isExpense: false,
    merchant: () => null,
    kind: 'card_bill',
  },
  {
    re: /debited with (?:Rs\.?|INR|₹)\s*[\d,.]+[\s\S]*?account \S*CreditCard will be credited/i,
    isExpense: true,
    merchant: () => null,
    kind: 'card_bill',
  },
  // IMPS debit to another account: must beat the "will be credited" guard.
  {
    re: /debited with (?:Rs\.?|INR|₹)\s*[\d,.]+[\s\S]*?and account [^()]*?will be credited/i,
    isExpense: true,
    merchant: m => {
      const n = m[0].match(/account\s+\S*?\/([^.()]+?)\s+will be credited/i);
      return n ? n[1] : null;
    },
  },
  // slice outgoing IMPS/NEFT: "IMPS payment of Rs. X from A/c xx1 done on D to NAME is successful".
  {
    re: /^(?:IMPS|NEFT) payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ from A\/c \S+ done on \S+ to (.+?) is successful/i,
    isExpense: true,
    merchant: m => m[1],
  },
  // UPI Lite top-ups: Lite spends send no per-payment SMS, so the top-up is the spend.
  // ("... has failed" is rejected by the UPI LITE guard.)
  {
    re: /^UPI LITE Top-?up amounting to (?:Rs\.?|INR|₹)\s*[\d,.]+ has been successful/i,
    isExpense: true,
    merchant: () => 'UPI Lite',
  },
  {
    re: /^UPI LITE is successfully enabled[\s\S]*? with Top-?Up of (?:Rs\.?|INR|₹)\s*[\d,.]+/i,
    isExpense: true,
    merchant: () => 'UPI Lite',
  },
  // Merchant receipts with no bank debit SMS of their own (gym, college portal).
  {
    re: /\bwe received (?:Rs\.?|INR|₹)\s*[\d,.]+ for invoice[\s\S]*?thank you (.+?)\s*\(/i,
    isExpense: true,
    merchant: m => m[1],
  },
  {
    re: /\byour payment of (?:Rs\.?|INR|₹)\s*[\d,.]+ towards (.+?) at (.+?) has been processed successfully/i,
    isExpense: true,
    merchant: m => `${m[2]} ${m[1]}`,
  },
  // Fixed-deposit placement: the user's own money moving into an FD.
  {
    re: /Debited;\s*(?:INR|Rs\.?)\s*[\d,.]+[\s\S]*(?:for FD A\/c|Transfer\/Debit for FD|FD booking)/i,
    isExpense: true,
    merchant: () => null,
    kind: 'own_transfer',
  },
  // Credit between the user's own accounts at the same bank.
  {
    re: /Credited;\s*(?:INR|Rs\.?)\s*[\d,.]+[\s\S]*Credit Transfer From \w+ Account/i,
    isExpense: false,
    merchant: () => null,
    kind: 'own_transfer',
  },
  // HDFC IMPS credit: the sender's name sits between "For IMPS -" and the next "-".
  {
    re: /^Received!\s*(?:INR|Rs\.?)\s*[\d,.]+ in [\s\S]*?\sFor IMPS -([^-]+?)-/i,
    isExpense: false,
    merchant: m => m[1],
  },
  // HDFC IPO application debit: Info: SBIFUNDS/<application no>-...
  {
    re: /debited from [\s\S]*?Info:\s*([A-Z]*FUNDS)\/\d{12,}/i,
    isExpense: true,
    merchant: m => m[1],
    kind: 'investment',
  },
  {
    re: /A\/C\s+Credited;\s*(?:INR|Rs\.?)\s*[\d,.]+[\s\S]*Closure Proceeds/i,
    isExpense: false,
    merchant: () => null,
    kind: 'own_transfer',
  },
  {
    re: /has been debited from your .+? towards (.+?\s(?:Limited|Ltd)\.?)\s*\(/i,
    isExpense: true,
    merchant: m => m[1],
    kind: 'investment',
  },
];

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

/**
 * True when a refund/reversal keyword sits closer to the matched amount than
 * any expense keyword does — i.e. the refund is describing THIS amount rather
 * than an unrelated original charge mentioned in the same message.
 */
function refundIsNearestToAmount(body: string, amountIndex: number): boolean {
  let nearestRefund = Infinity;
  for (const m of body.matchAll(new RegExp(REFUND_RE.source, 'gi'))) {
    nearestRefund = Math.min(nearestRefund, Math.abs((m.index ?? 0) - amountIndex));
  }
  let nearestExpense = Infinity;
  for (const m of body.matchAll(new RegExp(EXPENSE_RE.source, 'gi'))) {
    nearestExpense = Math.min(nearestExpense, Math.abs((m.index ?? 0) - amountIndex));
  }
  return nearestRefund < nearestExpense;
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

/** Normalises a raw merchant candidate; returns '' when nothing usable is left. */
export function cleanMerchant(candidate: string): string {
  let raw = candidate;
  // Cut at a sentence boundary: a period followed by whitespace. A period
  // inside a token ("john.doe@ybl", "Dr.Mehta", "5.00") is preserved.
  raw = raw.split(/\.\s/)[0];
  raw = raw.split('(')[0];
  raw = raw.replace(/^\s*VPA\s+/i, '');
  raw = raw.replace(/^\s*(?:a\/c|account)\s*[x*\d]+\/?\s*/i, '');
  raw = raw.replace(/\s+via UPI.*$/i, '');
  raw = raw.replace(/\s+with txn ID.*$/i, '');
  raw = raw.replace(/\s+using your .*$/i, '');
  // "debited to HDFC Bank A/c XX3636 towards MF Utilities ... / <ref> with UMRN ...": the payee follows "towards"
  raw = raw.replace(/^.*\btowards\s+/i, '').replace(/\s*\/\s*[A-Z0-9]{10,}.*$/i, '').replace(/\s+with$/i, '');
  raw = raw.replace(/\.?\s*UPI Ref.*$/i, '');
  raw = raw.replace(/\s+UMRN.*$/i, '');
  // The noise regex strips one tail clause per pass ("on 03/10/26 Ref 123").
  for (let prev = ''; prev !== raw; ) {
    prev = raw;
    raw = raw.replace(MERCHANT_NOISE_RE, '');
  }
  return raw.replace(/[.,;!?]+$/, '').trim();
}

/**
 * Extracts a merchant name from an "at/to/towards" (or "from", income only)
 * clause. Skips low-quality candidates: "your ..." clauses (excluded by the
 * regex itself), purely-numeric fragments left over after ":" truncated a
 * time expression (e.g. "at 10:30 at SWIGGY" → skip "10", capture "SWIGGY"),
 * instruction clauses, and the literal placeholder "merchant".
 */
function extractMerchant(body: string, isExpense: boolean): string | null {
  const patterns = isExpense
    ? [MERCHANT_RE_EXPENSE]
    : [MERCHANT_RE_INCOME_FROM, MERCHANT_RE_INCOME_OTHER];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      const raw = cleanMerchant(m[1]);
      if (!raw || /^\d+$/.test(raw) || /^merchant$/i.test(raw)) {
        continue;
      }
      if (MERCHANT_INSTRUCTION_RE.test(raw)) {
        continue;
      }
      return raw;
    }
  }
  return null;
}

/**
 * A UPI VPA, or null if the candidate is really an email address. Emails carry
 * a dotted TLD ("care@hdfcbank.com"); VPAs don't ("rahul@okhdfcbank").
 */
function extractVpa(body: string): string | null {
  const m = body.match(VPA_CANDIDATE_RE);
  if (!m) {
    return null;
  }
  const value = m[0].toLowerCase();
  const domain = value.slice(value.indexOf('@') + 1);
  return domain.includes('.') ? null : value;
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

  // ── Known templates run first: they are decisive and several would otherwise
  //    trip the negative guard or the generic direction logic.
  const template = TEMPLATES.find(t => t.re.test(body));

  // ── Guard: promo / autopay-future / failed / OTP / money-request messages ──
  // These all commonly contain a real-looking amount + direction keyword but
  // are not a settled transaction.
  if (!template && NEGATIVE_GUARDS.some(re => re.test(body))) {
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

  if (!template && !isExpenseKeyword && !isIncomeKeyword) {
    // Amount present but direction unclear (balance alerts, OTP-adjacent, etc.)
    return null;
  }

  let isExpense: boolean;
  if (template) {
    isExpense = template.isExpense;
  } else if (REFUND_RE.test(body) && isIncomeKeyword && !isExpenseKeyword) {
    // Pure refund message ("Refund of Rs.500 credited to your A/c") — income.
    isExpense = false;
  } else if (
    REFUND_RE.test(body) &&
    isIncomeKeyword &&
    refundIsNearestToAmount(body, amountMatch.index ?? 0)
  ) {
    // A refund keyword used to win UNCONDITIONALLY, which inverted whole
    // messages: "Rs.2499 debited at AMAZON. Your refund of Rs.300 has been
    // credited" was stored as ₹2499 of INCOME, because AMOUNT_RE also takes
    // the FIRST amount in the string. One message, a ~₹5000 error. The refund
    // now only wins when it is the keyword actually describing the amount we
    // matched.
    isExpense = false;
  } else if (isExpenseKeyword && isIncomeKeyword) {
    // Both keyword sets matched and it's not a refund — pick whichever
    // keyword occurs closer to the amount, since that's the one actually
    // describing THIS message's direction.
    isExpense = closerKeywordIsExpense(body, amountMatch.index ?? 0);
  } else {
    isExpense = isExpenseKeyword;
  }

  // ── 3. User's own account hint (computed first so the counterparty fallback
  //      below can be checked against it and never mistake "your account" for
  //      the other party) ────────────────────────────────────────────────────
  const userAcctMatch = body.match(USER_ACCT_RE);
  const account: string | null = userAcctMatch ? userAcctMatch[1] : null;

  // ── 4. Counterparty (priority: VPA > phone > directional account fragment) ─
  let counterparty: string | null = null;

  // Helpline numbers and the user's own FamPay handle live in the disclaimer /
  // "using ..." tail; extraction runs on a trimmed copy. raw_text is untouched
  // (dedup_key hashes it).
  const view = counterpartyView(body);

  const vpa = extractVpa(view);
  if (vpa) {
    counterparty = vpa;
  } else {
    const phoneDigits = findCounterpartyPhone(view);
    if (phoneDigits) {
      counterparty = phoneDigits;
    } else {
      const ctAcctRe = isExpense
        ? COUNTERPARTY_ACCT_EXPENSE_RE
        : COUNTERPARTY_ACCT_INCOME_RE;
      const ctAcctMatch = view.match(ctAcctRe);
      if (ctAcctMatch && ctAcctMatch[1] !== account) {
        counterparty = ctAcctMatch[1];
      }
    }
  }

  // ── 5. Merchant ────────────────────────────────────────────────────────────
  let merchant: string | null;
  if (template && template.merchant !== undefined) {
    const t = template.merchant;
    const raw = typeof t === 'function' ? t(body.match(template.re) as RegExpMatchArray) : t;
    const cleaned = raw == null ? '' : cleanMerchant(raw);
    merchant = cleaned && !/^merchant$/i.test(cleaned) ? cleaned : null;
  } else {
    merchant = extractMerchant(view, isExpense);
  }

  // ── 5b. Kind: money moving between the user's own pockets ───────────────────
  let kind: TransactionKind | undefined = template?.kind;
  if (!kind && isExpense && merchant) {
    if (/^amazon\s*pay(?:\s+balance)?$/i.test(merchant)) {
      kind = 'wallet_load';
    } else if (/\S\s+bank(?:\s+(?:ltd|limited))?\.?$/i.test(merchant.trim())) {
      kind = 'own_transfer';
    }
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
    source: template?.source ?? sender,
    isExpense,
    account,
    timestamp: ts,
    raw_text: body,
    ...(kind ? { kind } : {}),
    ...(balance != null && !isNaN(balance) ? { balance } : {}),
  };
}
