import { categorize, Category } from './categories';

export interface ParsedTransaction {
  amount: number;
  merchant: string | null;
  source: string;
  isExpense: boolean;
  timestamp: number;
  category: Category;
  raw_text: string;
}

const AMOUNT_RE = /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i;
const EXPENSE_RE = /\b(debited|spent|charged|sent|paid|purchase)\b/i;
const INCOME_RE = /\b(credited|received|refund)\b/i;
const MERCHANT_RE = /\b(?:at|to|towards)\s+([^.,;!\n]+)/i;

export function parseTransaction(
  sender: string,
  body: string,
  timestamp: number = Date.now(),
): ParsedTransaction | null {
  // Guard: null/empty/whitespace body
  if (!body || !body.trim()) {
    return null;
  }

  // 1. Amount — no match means not a transaction
  const amountMatch = body.match(AMOUNT_RE);
  if (!amountMatch) {
    return null;
  }
  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

  // 2. Direction — must be clearly debit or credit.
  //    If neither keyword is present but an amount exists the message is ambiguous
  //    (e.g. balance alerts, OTP-style messages that happen to mention Rs.) — treat as null
  //    so only intent-clear messages are stored.
  const isExpenseKeyword = EXPENSE_RE.test(body);
  const isIncomeKeyword = INCOME_RE.test(body);

  if (!isExpenseKeyword && !isIncomeKeyword) {
    // Amount present but direction unclear — not a transaction we can classify
    return null;
  }

  const isExpense = isExpenseKeyword;
  // Income rows are returned (isExpense=false); the caller decides to ignore them.

  // 3. Merchant — text after "at "/"to "/"towards " up to next punctuation or end
  const merchantMatch = body.match(MERCHANT_RE);
  const merchant: string | null = merchantMatch
    ? merchantMatch[1].trim() || null
    : null;

  // 4. Category
  const category = categorize(merchant, body);

  return {
    amount,
    merchant,
    source: sender,
    isExpense,
    timestamp,
    category,
    raw_text: body,
  };
}
