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
