import { parseTransaction } from '../parser';
import { classify } from '../classify';
import { isAmazonWalletTopUp, GMAIL_PKG } from '../gmailFilter';
import { isSoftDuplicate } from '../dedup';

const GM = GMAIL_PKG;
const TOPUP =
  '₹2000.00 added to your Amazon Pay Wallet. You have added ₹2000.00 successfully to your Amazon Pay Wallet. Order ID: 000-0000000-0000000. Updated Amazon Pay Balance ₹2404.41';
const identity = { name: '', phones: [], upiHandles: [], accountLast4: [] };

describe('gmail filter', () => {
  it('accepts the wallet top-up (title+text joined, various amount forms)', () => {
    expect(isAmazonWalletTopUp(TOPUP)).toBe(true);
    expect(isAmazonWalletTopUp('Amazon. ₹2000.00 added to your Amazon Pay Wallet.')).toBe(true);
    expect(isAmazonWalletTopUp('Rs. 500 ADDED to your amazon pay wallet')).toBe(true);
    expect(isAmazonWalletTopUp('INR 1,500.00 added to your Amazon  Pay  Wallet')).toBe(true);
  });
  it('rejects every other email', () => {
    expect(isAmazonWalletTopUp('Your OTP is 123456')).toBe(false);
    expect(isAmazonWalletTopUp('3 new messages')).toBe(false);
    expect(isAmazonWalletTopUp('Amazon Pay Wallet balance is debited ₹50')).toBe(false);
    expect(isAmazonWalletTopUp('Money added to your Amazon Pay Wallet')).toBe(false); // no rupee amount
    expect(isAmazonWalletTopUp('₹2000 added to your bank account')).toBe(false);
    expect(isAmazonWalletTopUp('Salary ₹50,000 credited')).toBe(false);
  });
});

describe('parser: Amazon Pay wallet top-up', () => {
  it('parses as income from Amazon Pay with the wallet merchant', () => {
    const p = parseTransaction(GM, TOPUP, 1)!;
    expect(p.amount).toBe(2000);
    expect(p.isExpense).toBe(false);
    expect(p.source).toBe('Amazon Pay');
    expect(p.merchant).toBe('Amazon Pay wallet top-up');
    expect(p.kind).toBe('wallet_topup');
  });
  it('handles the long-form body and Rs./INR variants', () => {
    for (const body of [
      'You have added ₹2000.00 successfully to your Amazon Pay Wallet',
      'Rs.2000.00 added to your Amazon Pay Wallet.',
      'INR 2,000.00 added to your Amazon Pay Wallet.',
    ]) {
      const p = parseTransaction(GM, body, 1)!;
      expect(p.amount).toBe(2000);
      expect(p.kind).toBe('wallet_topup');
    }
  });
  it('does not match wallet debit texts', () => {
    expect(
      parseTransaction('AX-AMAZON', 'Rs.120.00 using Apay Wallet balance is debited at Zomato', 1)?.kind,
    ).not.toBe('wallet_topup');
    expect(
      parseTransaction('AX-AMAZON', 'Payment of ₹120 using Apay balance is successful at ZOMATO. Updated Amazon Pay Balance ₹2000', 1)?.kind,
    ).not.toBe('wallet_topup');
  });
});

describe('classify: wallet top-up toggle', () => {
  const p = parseTransaction(GM, TOPUP, 1)!;
  it('defaults to Family income', () => {
    expect(classify(p, { identity, rules: {}, family: [] })).toEqual({ category: 'Family', type: 'income' });
  });
  it('ON → Family income', () => {
    expect(classify(p, { identity, rules: {}, family: [], amazonTopupFamily: true }).category).toBe('Family');
  });
  it('OFF → self', () => {
    expect(classify(p, { identity, rules: {}, family: [], amazonTopupFamily: false }).type).toBe('self');
  });
});

describe('dedup: Gmail email vs Amazon app notification', () => {
  const base = { amount: 2000, timestamp: 1_700_000_000_000, counterparty: null };
  it('same top-up via notification and email within 2 min is a duplicate', () => {
    expect(isSoftDuplicate({ ...base, channel: 'email' }, { ...base, channel: 'notification' })).toBe(true);
    expect(isSoftDuplicate({ ...base, channel: 'notification' }, { ...base, channel: 'email' })).toBe(true);
  });
  it('two emails (same channel) are both kept', () => {
    expect(isSoftDuplicate({ ...base, channel: 'email' }, { ...base, channel: 'email' })).toBe(false);
  });
});

describe('Cashback', () => {
  const ctx = { identity, rules: {}, family: [], friends: [], amazonTopupFamily: true };
  const CB = 'Cashback of ₹20.00 added to your Amazon Pay Wallet. Updated Amazon Pay Balance ₹2424.41';

  it('Gmail cashback is income/Cashback, not a Family top-up', () => {
    expect(isAmazonWalletTopUp(CB)).toBe(true); // still passes the Gmail gate
    const p = parseTransaction(GM, CB, 1)!;
    expect(p.kind).toBe('cashback');
    expect(p.amount).toBe(20);
    expect(p.source).toBe('Amazon Pay');
    expect(classify(p, ctx)).toEqual({ category: 'Cashback', type: 'income' });
  });
  it('the top-up wording still wins when cashback only appears after it', () => {
    const body = 'You have added ₹2000.00 successfully to your Amazon Pay Wallet. Earn cashback on your next order';
    const p = parseTransaction(GM, body, 1)!;
    expect(p.kind).toBe('wallet_topup');
    expect(classify(p, ctx).category).toBe('Family');
  });
  it('SMS/notification "cashback credited/added" is income/Cashback', () => {
    for (const body of [
      'Rs.15.00 cashback credited to your account XX1234',
      'Cashback of Rs 25 added to your wallet',
      '₹10 credited as cashback for your UPI payment',
    ]) {
      const p = parseTransaction('HDFCBK', body, 1)!;
      expect(classify(p, ctx)).toEqual({ category: 'Cashback', type: 'income' });
    }
  });
  it('promo, failed and debit messages are not cashback', () => {
    expect(parseTransaction('HDFCBK', 'Get Rs.50 cashback will be credited within 7 days', 1)).toBeNull();
    const d = parseTransaction('HDFCBK', 'Rs.500 debited from A/c XX1234 to SWIGGY. Cashback if any will be credited later', 1);
    expect(d?.kind).not.toBe('cashback');
  });
});
