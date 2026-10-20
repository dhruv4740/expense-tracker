const store: Record<string, unknown> = {};
const rows: Record<number, { settles_id: number | null; type: string }> = {};

jest.mock('../settings', () => ({
  getJSON: (k: string, d: unknown) => (k in store ? store[k] : d),
  setJSON: (k: string, v: unknown) => {
    store[k] = v;
  },
}));
jest.mock('../db', () => ({
  getTransactionById: (id: number) => rows[id] ?? null,
  updateTransaction: (id: number, patch: Record<string, unknown>) => {
    Object.assign(rows[id], patch);
    return true;
  },
  getKnownSettlementCounterparties: jest.fn(),
  getMaxTransactionId: jest.fn(),
  getTransactionsAfterId: jest.fn(),
  getTransactionsBetween: jest.fn(),
  queryTransactions: jest.fn(),
}));

import { undoAutoApplied } from '../transferSync';
import { findCancelPairs, cancelKey } from '../cancelOut';

const entry = {
  id: 'e1', amount: 1200, from: 'Reliance', to: 'Testa', basis: 'time' as const, prev: [],
  kind: 'cancel' as const, link: { childId: 1, parentId: 2 }, seen: false, undone: false,
};

describe('undo of a cancel-out link', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) { delete store[k]; }
    rows[1] = { settles_id: 2, type: 'income' };
    rows[2] = { settles_id: null, type: 'expense' };
    store.auto_self_log = [{ at: 0, entries: [{ ...entry }] }];
  });

  it('unlinks the credit and remembers the pair so it is not re-offered', () => {
    undoAutoApplied('e1');
    expect(rows[1].settles_id).toBeNull();
    expect(rows[1].type).toBe('income');
    const dismissed = new Set(store.cancel_dismissed as string[]);
    expect(dismissed.has(cancelKey(2, 1))).toBe(true);
    const ctx = { identity: { name: '', phones: [], upiHandles: [], accountLast4: [] }, friends: [] };
    const exp = { id: 2, type: 'expense' as const, amount: 1200, timestamp: 1000, category: 'Shopping', merchant: 'Shop' };
    const inc = { id: 1, type: 'income' as const, amount: 1200, timestamp: 2000, category: 'Friend Transfer', merchant: 'TESTA' };
    expect(findCancelPairs([inc], [exp], ctx, dismissed)).toEqual([]);
  });

  it('leaves a link the user has since changed alone', () => {
    rows[1].settles_id = 9;
    undoAutoApplied('e1');
    expect(rows[1].settles_id).toBe(9);
  });
});
