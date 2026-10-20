import { findRefundParent, isRefundRow, refundMerchant } from '../refundLink';
import type { RefundRow } from '../refundLink';
import { parseTransaction } from '../parser';

const DAY = 86_400_000;
const T = 1_790_000_000_000;

const spend = (id: number, amount: number, merchant: string, daysAgo: number, raw = ''): RefundRow => ({
  id, type: 'expense', amount, merchant, timestamp: T - daysAgo * DAY, raw_text: raw,
});
const refund = (id: number, amount: number, raw: string, daysAgo = 0): RefundRow => ({
  id, type: 'income', amount, timestamp: T - daysAgo * DAY, raw_text: raw,
});

const KOTAK = 'Dear Customer, refund of Rs.58.00 is credited to your Kotak Bank A/C no.  XXXXXX0000 for your Kotak Debit Card txn Ref no  625265209792.';
const ZOMATO = 'Refund of Rs. 189.69 for your Zomato order from Test Kitchen has been successfully processed and shall reflect in your account by now. -ZOMATO';

describe('isRefundRow', () => {
  it('only unlinked refund-worded income', () => {
    expect(isRefundRow(refund(1, 58, KOTAK))).toBe(true);
    expect(isRefundRow({ ...refund(1, 58, KOTAK), settles_id: 9 })).toBe(false);
    expect(isRefundRow(refund(1, 58, 'Rs.58 credited by a friend'))).toBe(false);
    expect(isRefundRow({ ...spend(1, 58, 'X', 0, 'refund'), type: 'expense' })).toBe(false);
  });
});

describe('refundMerchant', () => {
  it('reads the merchant a refund names, or null', () => {
    expect(refundMerchant(ZOMATO)).toBe('Zomato');
    expect(refundMerchant('Refund of Rs. 411 from Swiggy has been  processed. - slice')).toBe('Swiggy');
    expect(refundMerchant('Refund of Rs 18.0 has been processed for your Zepto order HQ1')).toBe('Zepto');
    expect(refundMerchant(KOTAK)).toBeNull();
  });
});

describe('findRefundParent', () => {
  it('matches by shared reference number first', () => {
    const pool = [
      spend(1, 58, 'SWIGGY', 3, 'Rs.58 spent ... Ref no 625265209792'),
      spend(2, 58, 'SWIGGY', 1, 'Rs.58 spent ... Ref no 991034822204'),
    ];
    const m = findRefundParent(refund(9, 58, KOTAK), pool);
    expect(m).toMatchObject({ basis: 'ref', parent: { id: 1 } });
  });
  it('matches by merchant + amount, preferring the exact amount', () => {
    const pool = [spend(1, 250, 'ZOMATO', 2), spend(2, 189.69, 'Zomato', 4), spend(3, 189.69, 'SWIGGY', 1)];
    expect(findRefundParent(refund(9, 189.69, ZOMATO), pool)).toMatchObject({ basis: 'merchant', parent: { id: 2 } });
  });
  it('a partial refund links to a bigger spend at that merchant', () => {
    const pool = [spend(1, 152, 'SWIGGY', 2)];
    const m = findRefundParent(refund(9, 58, 'Refund of Rs. 58 from Swiggy has been processed'), pool);
    expect(m?.parent.id).toBe(1);
  });
  it('amount-only (no merchant named) needs exactly one equal spend', () => {
    expect(findRefundParent(refund(9, 58, KOTAK), [spend(1, 58, 'SWIGGY', 2), spend(2, 90, 'X', 1)])?.basis).toBe('amount');
    expect(findRefundParent(refund(9, 58, KOTAK), [spend(1, 58, 'SWIGGY', 2), spend(2, 58, 'ZEPTO', 1)])).toBeNull();
    expect(findRefundParent(refund(9, 58, KOTAK), [spend(1, 152, 'SWIGGY', 2)])).toBeNull();
  });
  it('respects the 30-day window, direction in time, and refund ≤ remaining amount', () => {
    expect(findRefundParent(refund(9, 189.69, ZOMATO), [spend(1, 189.69, 'ZOMATO', 31)])).toBeNull();
    expect(findRefundParent(refund(9, 189.69, ZOMATO, 5), [spend(1, 189.69, 'ZOMATO', 1)])).toBeNull();
    expect(findRefundParent(refund(9, 189.69, ZOMATO), [spend(1, 189.69, 'ZOMATO', 1)], new Map([[1, 100]]))).toBeNull();
  });
  it('never links to a different merchant', () => {
    expect(findRefundParent(refund(9, 189.69, ZOMATO), [spend(1, 189.69, 'SWIGGY', 1)])).toBeNull();
  });
});

describe('parser: refund and failed-payment messages', () => {
  const p = (s: string, b: string) => parseTransaction(s, b, T);
  it('failed / declined payments never become a spend', () => {
    expect(p('KOTAK', 'Txn at Swiggy via Kotak Bank Debit Card XX0000 on 04/04/2026 failed due to insufficient Balance in A/C XX0000 Bal Rs.59.38')).toBeNull();
    expect(p('KOTAK', 'Txn at TACO BELL MUMBAI via Kotak Debit Card XX0000 on 21/06/2026 failed due to low balance in a/c XX0000. Charges apply on declined txns.')).toBeNull();
    expect(p('KOTAK', 'Txn of Rs.104.00 on Kotak Debit Card XX0000 on 26/03/2026 failed as incorrect PIN.')).toBeNull();
  });
  it('"initiated" notices are not transactions; the credit is', () => {
    expect(p('SWIGGY', 'Refund of Rs 124 has been initiated for Swiggy order 231683791372384. Updated balance should reflect in 4-7 days.')).toBeNull();
    expect(p('ZEPTO', 'Dear user, refund of Rs 18.0 for your Zepto order HQ1 has been initiated. It should reflect in your account within 5-7 business days!')).toBeNull();
    expect(p('SWIGGY', 'Dear Swiggy customer, your refund reference number for Rs 124 is 255968469064-1-R1.')).toBeNull();
    expect(p('VM-KOTAKB-S', KOTAK)).toMatchObject({ amount: 58, isExpense: false });
  });
});
