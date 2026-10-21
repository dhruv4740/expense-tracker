// ─── Constants shared by the pairing rules (pure) ────────────────────────────
//
// transferPair (own-account transfers) and cancelOut (friend repayments) both
// call two amounts "equal" when they differ by less than 50 paise (rounding
// slack between a bank's debit and the other bank's credit).

export const MIN_MS = 60_000;
/** Amounts within this many rupees count as equal. */
export const AMOUNT_EPSILON = 0.5;

export function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_EPSILON;
}
