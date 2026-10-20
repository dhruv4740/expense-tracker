const mockRows: Record<string, unknown>[] = [];
const mockSettle = jest.fn();
const store: Record<string, string> = {};

jest.mock('../db', () => ({
  getTransactionsAfterId: () => mockRows,
  getTransactionsBetween: () => mockRows,
  getTransactionById: (id: number) => mockRows.find(r => r.id === id),
  setSettlement: (...a: unknown[]) => mockSettle(...a),
  getSetting: (k: string) => store[k] ?? null,
  setSetting: (k: string, v: string) => {
    store[k] = v;
  },
}));

import { dismissRefund, getRefundSuggestions, linkRefund, runRefundLinking } from '../refundSync';

const NOW = Date.now();
const DAY = 86_400_000;
const row = (id: number, type: 'expense' | 'income', amount: number, merchant: string, raw: string, daysAgo: number) => ({
  id, type, amount, merchant, raw_text: raw, timestamp: NOW - daysAgo * DAY, settles_id: null,
});

beforeEach(() => {
  mockRows.length = 0;
  mockSettle.mockClear();
  for (const k of Object.keys(store)) {
    delete store[k];
  }
});

describe('amount-only refund is a suggestion, not an auto-link', () => {
  beforeEach(() => {
    mockRows.push(
      row(1, 'expense', 58, 'SWIGGY', 'Rs.58 paid to SWIGGY', 2),
      row(2, 'income', 58, 'KOTAK', 'Rs.58 refund credited to your account', 0),
    );
  });
  it('sync does not link it', () => {
    expect(runRefundLinking(0)).toBe(0);
    expect(mockSettle).not.toHaveBeenCalled();
  });
  it('is suggested, linkable and dismissable', () => {
    expect(getRefundSuggestions().map(s => [s.parent.id, s.refund.id])).toEqual([[1, 2]]);
    linkRefund(1, 2);
    expect(mockSettle).toHaveBeenCalledWith(2, 1);
    dismissRefund(1, 2);
    expect(getRefundSuggestions()).toEqual([]);
  });
});

describe('merchant-named refund still auto-links', () => {
  it('links and is not re-suggested', () => {
    mockRows.push(
      row(1, 'expense', 58, 'ZOMATO', 'Rs.58 paid to ZOMATO', 2),
      row(2, 'income', 58, 'ZOMATO', 'Refund for your Zomato order credited', 0),
    );
    expect(runRefundLinking(0)).toBe(1);
    expect(mockSettle).toHaveBeenCalledWith(2, 1);
    expect(getRefundSuggestions()).toEqual([]);
  });
});
