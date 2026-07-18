// maintenance.ts pulls in db.ts (op-sqlite, a native module that can't run
// under Jest) and sync.ts (which pulls in react-native + native modules
// transitively). Mock all of those so planRecategorization — the pure part —
// and runCleanupIfNeeded can be exercised in isolation.

jest.mock('../db', () => ({
  deleteMerchantRule: jest.fn(),
  getAllMerchantRules: jest.fn(() => ({})),
  getSetting: jest.fn(() => null),
  queryTransactions: jest.fn(() => []),
  setSetting: jest.fn(),
  updateTransaction: jest.fn(),
}));

jest.mock('../sync', () => ({
  refreshSyncCaches: jest.fn(),
}));

import { planRecategorization, runCleanupIfNeeded } from '../maintenance';
import {
  deleteMerchantRule,
  getAllMerchantRules,
  getSetting,
  queryTransactions,
  setSetting,
  updateTransaction,
} from '../db';
import type { TransactionRow } from '../db';

const mockedDelete = deleteMerchantRule as jest.Mock;
const mockedGetRules = getAllMerchantRules as jest.Mock;
const mockedGetSetting = getSetting as jest.Mock;
const mockedQuery = queryTransactions as jest.Mock;
const mockedSetSetting = setSetting as jest.Mock;
const mockedUpdate = updateTransaction as jest.Mock;

function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 1,
    amount: 100,
    merchant: null,
    source: 'HDFCBK',
    raw_text: 'Rs.100 debited',
    category: 'Other',
    timestamp: 1719500000000,
    type: 'expense',
    category_source: 'auto',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetRules.mockReturnValue({});
  mockedGetSetting.mockReturnValue(null);
  mockedQuery.mockReturnValue([]);
});

describe('planRecategorization (pure)', () => {
  it('recategorizes an auto row whose stored category no longer matches', () => {
    const rows = [
      row({ id: 5, category: 'Uber', raw_text: 'Rs.3000 debited from A/c XX1234 to ICCL - Mutual Funds via NACH.', category_source: 'auto' }),
    ];
    const diffs = planRecategorization(rows, {});
    expect(diffs).toEqual([{ id: 5, from: 'Uber', to: 'Investment' }]);
  });

  it('never touches a manually-categorized row, even if it disagrees with keywords', () => {
    const rows = [
      row({ id: 7, category: 'Uber', raw_text: 'Rs.100 debited at Swiggy', category_source: 'manual' }),
    ];
    const diffs = planRecategorization(rows, {});
    expect(diffs).toEqual([]);
  });

  it('leaves a row unchanged when the recomputed category matches the stored one', () => {
    const rows = [
      row({ id: 9, category: 'Food', raw_text: 'Rs.200 debited at Swiggy', category_source: 'auto' }),
    ];
    const diffs = planRecategorization(rows, {});
    expect(diffs).toEqual([]);
  });

  it('skips a generic-numeric-keyed rule and recategorizes by keyword instead', () => {
    const rows = [
      row({
        id: 11,
        category: 'Uber',
        counterparty: '1234',
        raw_text: 'Rs.3000 debited from A/c XX1234 to ICCL - Mutual Funds via NACH.',
        category_source: 'auto',
      }),
    ];
    // Simulates a rule that survived because the caller forgot to purge it —
    // planRecategorization must defend against this itself via categorize().
    const diffs = planRecategorization(rows, { '1234': 'Uber' });
    expect(diffs).toEqual([{ id: 11, from: 'Uber', to: 'Investment' }]);
  });
});

describe('runCleanupIfNeeded', () => {
  it('does nothing if the cleanup flag is already set', () => {
    mockedGetSetting.mockReturnValue('1719500000000');

    runCleanupIfNeeded();

    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(mockedSetSetting).not.toHaveBeenCalled();
  });

  it('purges generic-keyed rules, re-categorizes auto rows, and sets the flag', () => {
    mockedGetRules.mockReturnValue({ '1234': 'Uber', 'swiggy': 'Food' });
    mockedQuery.mockReturnValue([
      row({ id: 1, category: 'Uber', raw_text: 'Rs.3000 debited from A/c XX1234 to ICCL - Mutual Funds via NACH.', category_source: 'auto' }),
      row({ id: 2, category: 'Food', raw_text: 'Rs.200 debited at Swiggy', category_source: 'auto' }),
      row({ id: 3, category: 'Uber', raw_text: 'Rs.100 debited at Uber ride', category_source: 'manual' }),
    ]);

    runCleanupIfNeeded();

    expect(mockedDelete).toHaveBeenCalledWith('1234');
    expect(mockedDelete).not.toHaveBeenCalledWith('swiggy');
    expect(mockedUpdate).toHaveBeenCalledWith(1, { category: 'Investment' });
    expect(mockedUpdate).not.toHaveBeenCalledWith(2, expect.anything());
    expect(mockedUpdate).not.toHaveBeenCalledWith(3, expect.anything());
    expect(mockedSetSetting).toHaveBeenCalledWith('recat_cleanup_v1', expect.any(String));
  });
});
