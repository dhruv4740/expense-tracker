// Edge-case coverage for the pure modules behind cancel-out, refunds, IPO,
// safe-to-spend, recurring payments, the dues ledger and weekly backup.

jest.mock('../db', () => ({
  getAll: jest.fn(() => []),
  getSetting: jest.fn(() => null),
  setSetting: jest.fn(),
}));
jest.mock('../native/FileModule', () => ({
  writeToFolder: jest.fn(),
  listBackups: jest.fn(),
  deleteBackups: jest.fn(),
}));

import { findCancelPairs, classifyCancel } from '../cancelOut';
import type { CancelRow } from '../cancelOut';
import { findRefundParent } from '../refundLink';
import type { RefundRow } from '../refundLink';
import { activeIssuers, isClearingMerchant, isIpoDebit } from '../ipo';
import { safeToSpend, safeToSpendLine, daysLeftInMonth } from '../safeToSpend';
import { buildUpcoming, detectRecurring } from '../upcoming';
import type { HistoryRow, RecurringPayment } from '../upcoming';
import { buildLedger, totalOutstanding } from '../ledger';
import type { LedgerRow } from '../ledger';
import { BACKUP_INTERVAL_MS, backupFileName, backupsToDelete, isBackupDue } from '../autoBackup';

const MIN = 60_000;
const DAY = 86_400_000;

// ─── cancelOut ───────────────────────────────────────────────────────────────
describe('cancelOut edge cases', () => {
  const T0 = 1_760_000_000_000;
  const ctx = {
    identity: { name: 'Anita Rao', phones: [], upiHandles: [], accountLast4: [] },
    friends: ['Testa Ajay Samplekar'],
  };
  const spend = (id: number, amount: number, ts: number, x: Partial<CancelRow> = {}): CancelRow => ({
    id, type: 'expense', amount, timestamp: ts, category: 'Shopping', merchant: 'RELIANCE RETAIL LIMITE', ...x,
  });
  const credit = (id: number, amount: number, ts: number, x: Partial<CancelRow> = {}): CancelRow => ({
    id, type: 'income', amount, timestamp: ts, category: 'Friend Transfer', merchant: 'TESTA AJAY SAMPLEKAR', ...x,
  });

  it('amounts within 50 paise are exact; beyond that only a friend share can match', () => {
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100.4, T0), ctx)?.basis).toBe('exact');
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100.6, T0), ctx)).toBeNull();
  });
  it('never links zero-amount, self, Investment, already-linked, or Family/Cashback credits', () => {
    expect(classifyCancel(spend(1, 0, T0), credit(2, 0, T0), ctx)).toBeNull();
    expect(classifyCancel(spend(1, 100, T0, { type: 'self' }), credit(2, 100, T0), ctx)).toBeNull();
    expect(classifyCancel(spend(1, 100, T0, { category: 'Investment' }), credit(2, 100, T0), ctx)).toBeNull();
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100, T0, { settles_id: 9 }), ctx)).toBeNull();
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100, T0, { category: 'Family' }), ctx)).toBeNull();
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100, T0, { category: 'Cashback' }), ctx)).toBeNull();
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100, T0, { raw_text: 'Rs.100 refund credited' }), ctx)).toBeNull();
  });
  it('a hand-entered row is never auto-linked (medium at most)', () => {
    expect(classifyCancel(spend(1, 100, T0, { category_source: 'manual' }), credit(2, 100, T0), ctx)?.confidence).toBe('medium');
    expect(classifyCancel(spend(1, 100, T0), credit(2, 100, T0, { channel: 'manual' }), ctx)?.confidence).toBe('medium');
  });
  it('a dismissed pair is not offered again', () => {
    const s = spend(1, 100, T0);
    const c = credit(2, 100, T0 + MIN);
    expect(findCancelPairs([s], [c, s], ctx, new Set(['1:2']))).toEqual([]);
  });
  it('each row is used once: two equal spends, one credit → the closer spend wins', () => {
    const near = spend(1, 100, T0 + 4 * MIN);
    const far = spend(2, 100, T0);
    const c = credit(3, 100, T0 + 5 * MIN);
    const pairs = findCancelPairs([near, far, c], [near, far, c], ctx);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].expense.id).toBe(1);
  });
  it('a share larger than the spend is not a repayment of it', () => {
    expect(classifyCancel(spend(1, 100, T0), credit(2, 150, T0), ctx)).toBeNull();
  });
  it('empty input is fine', () => {
    expect(findCancelPairs([], [], ctx)).toEqual([]);
  });
});

// ─── refundLink ──────────────────────────────────────────────────────────────
describe('refundLink edge cases', () => {
  const T = 1_790_000_000_000;
  const spend = (id: number, amount: number, merchant: string, daysAgo: number, raw = ''): RefundRow => ({
    id, type: 'expense', amount, merchant, timestamp: T - daysAgo * DAY, raw_text: raw,
  });
  const refund = (id: number, amount: number, raw: string, daysAgo = 0): RefundRow => ({
    id, type: 'income', amount, timestamp: T - daysAgo * DAY, raw_text: raw,
  });
  const Z = 'Refund of Rs. 100 for your Zomato order has been processed';

  it('30 days back still matches, 31 does not', () => {
    expect(findRefundParent(refund(9, 100, Z), [spend(1, 100, 'ZOMATO', 30)])?.parent.id).toBe(1);
    expect(findRefundParent(refund(9, 100, Z), [spend(1, 100, 'ZOMATO', 31)])).toBeNull();
  });
  it('a refund cannot precede its payment, nor exceed it', () => {
    expect(findRefundParent(refund(9, 100, Z, 3), [spend(1, 100, 'ZOMATO', 1)])).toBeNull();
    expect(findRefundParent(refund(9, 150, Z.replace('100', '150')), [spend(1, 100, 'ZOMATO', 1)])).toBeNull();
  });
  it('a second partial refund fits only in what is left of the payment', () => {
    const p = spend(1, 100, 'ZOMATO', 1);
    expect(findRefundParent(refund(9, 40, Z), [p], new Map([[1, 60]]))?.parent.id).toBe(1);
    expect(findRefundParent(refund(9, 41, Z), [p], new Map([[1, 60]]))).toBeNull();
  });
  it('a reference shorter than 8 digits is not a match key', () => {
    const p = spend(1, 500, 'SHOP', 1, 'paid ref 1234567');
    expect(findRefundParent(refund(9, 500, 'Refund ref 1234567 credited'), [p])?.basis).toBe('amount');
  });
  it('a named merchant that matches nothing never falls back to amount-only', () => {
    expect(findRefundParent(refund(9, 100, Z), [spend(1, 100, 'AMAZON', 1)])).toBeNull();
  });
  it('among several same-merchant payments, the one with the exact amount wins even if older', () => {
    const m = findRefundParent(refund(9, 100, Z), [spend(1, 100, 'ZOMATO', 5), spend(2, 250, 'ZOMATO', 1)]);
    expect(m).toMatchObject({ basis: 'merchant', parent: { id: 1 } });
  });
  it('already-linked payments and other incomes are not parents', () => {
    expect(findRefundParent(refund(9, 100, Z), [{ ...spend(1, 100, 'ZOMATO', 1), settles_id: 5 }])).toBeNull();
    expect(findRefundParent(refund(9, 100, Z), [{ ...spend(1, 100, 'ZOMATO', 1), type: 'income' }])).toBeNull();
  });
});

// ─── ipo ─────────────────────────────────────────────────────────────────────
describe('ipo edge cases', () => {
  const T = 1_790_000_000_000;
  it('the SIP mandate payee "ICCL - Mutual Funds" is not a clearing-debit match', () => {
    expect(isClearingMerchant('ICCL - Mutual Funds')).toBe(false);
    expect(isClearingMerchant('Indian Clearing Corporation Limited')).toBe(true);
    expect(isClearingMerchant('nse clearing ltd.')).toBe(true);
    expect(isClearingMerchant(null)).toBe(false);
  });
  it('a re-application after a refund clears the old allotment time', () => {
    const issuers = activeIssuers([
      { ts: T, kind: 'blocked', name: 'ACME CORP', amount: 10000 },
      { ts: T + DAY, kind: 'allotted', name: 'ACME CORP' },
      { ts: T + 2 * DAY, kind: 'unblocked', name: 'ACME CORP', amount: 10000 },
      { ts: T + 3 * DAY, kind: 'blocked', name: 'ACME CORP', amount: 12000 },
    ]);
    expect(issuers).toEqual([{ key: 'acmeco', blocked: 12000, allottedTs: 0 }]);
    expect(isIpoDebit('ICCL', 11000, issuers, T + 4 * DAY)).toBe(false);
  });
  it('each issuer has its own window and block', () => {
    const issuers = activeIssuers([
      { ts: T, kind: 'blocked', name: 'ALPHA ONE', amount: 10000 },
      { ts: T + DAY, kind: 'allotted', name: 'ALPHA ONE' },
      { ts: T + 20 * DAY, kind: 'blocked', name: 'BETA TWO', amount: 20000 },
      { ts: T + 21 * DAY, kind: 'allotted', name: 'BETA TWO' },
    ]);
    expect(isIpoDebit('ICCL', 19000, issuers, T + 22 * DAY)).toBe(true); // BETA window
    expect(isIpoDebit('ICCL', 4000, issuers, T + 22 * DAY)).toBe(false); // ALPHA window closed, below BETA band
    expect(isIpoDebit('ICCL', 9500, issuers, T + 2 * DAY)).toBe(true);
  });
  it('amount band edges: 30% and 102% inclusive', () => {
    const issuers = activeIssuers([
      { ts: T, kind: 'blocked', name: 'ACME CORP', amount: 10000 },
      { ts: T + DAY, kind: 'allotted', name: 'ACME CORP' },
    ]);
    expect(isIpoDebit('BSE', 3000, issuers, T + 2 * DAY)).toBe(true);
    expect(isIpoDebit('BSE', 10200, issuers, T + 2 * DAY)).toBe(true);
    expect(isIpoDebit('BSE', 2999, issuers, T + 2 * DAY)).toBe(false);
    expect(isIpoDebit('BSE', 10201, issuers, T + 2 * DAY)).toBe(false);
  });
  it('no issuers, or none allotted, never matches', () => {
    expect(isIpoDebit('ICCL', 5000, [], T)).toBe(false);
    expect(isIpoDebit('ICCL', 5000, undefined, T)).toBe(false);
  });
});

// ─── safe to spend ───────────────────────────────────────────────────────────
describe('safeToSpend edge cases', () => {
  const D = (m: number, d: number) => new Date(2028, m, d, 10).getTime();
  it('counts the leap day', () => {
    expect(daysLeftInMonth(D(1, 1))).toBe(29);
  });
  it('rounds float noise away and keeps an exact zero as "left"', () => {
    const s = safeToSpend({ fromFamily: 0.1, earned: 0.2, spent: 0.3, committed: 0 }, D(9, 10));
    expect(s.left).toBe(0);
    expect(safeToSpendLine(s)).toMatch(/^₹0 left/);
  });
  it('a sub-rupee shortfall reads as zero left, not "₹0 over"', () => {
    const s = safeToSpend({ fromFamily: 0, earned: 1000, spent: 1000.4, committed: 0 }, D(9, 10));
    expect(safeToSpendLine(s)).not.toMatch(/over/);
  });
  it('a per-day allowance below one rupee floors to zero', () => {
    const s = safeToSpend({ fromFamily: 0, earned: 5, spent: 0, committed: 0 }, D(9, 1));
    expect(s.left).toBe(5);
    expect(s.perDay).toBe(0);
  });
  it('committed money larger than income shows as an overspend', () => {
    const s = safeToSpend({ fromFamily: 0, earned: 1000, spent: 0, committed: 4000 }, D(9, 10));
    expect(s.left).toBe(-3000);
    expect(safeToSpendLine(s)).toBe("₹3,000 over this month's income");
  });
});

// ─── recurring / upcoming ────────────────────────────────────────────────────
describe('recurring edge cases', () => {
  const NOW = new Date(2026, 9, 14, 12).getTime();
  const charge = (daysAgo: number, amount: number, merchant = 'NETFLIX', x: Partial<HistoryRow> = {}): HistoryRow => ({
    type: 'expense', amount, timestamp: NOW - daysAgo * DAY, merchant, ...x,
  });
  it('earlier charges 10% apart still count; a wide spread does not', () => {
    expect(detectRecurring([charge(65, 100), charge(35, 110), charge(5, 100)], NOW)).toHaveLength(1);
    expect(detectRecurring([charge(65, 100), charge(35, 150), charge(5, 100)], NOW)).toEqual([]);
  });
  it('flags a latest charge more than 10% above the usual as a price increase', () => {
    const [r] = detectRecurring([charge(65, 100), charge(35, 100), charge(5, 150)], NOW);
    expect(r.priceIncrease).toEqual({ from: 100, to: 150, pct: 50 });
  });
  it('a latest charge more than double the usual is not the same subscription', () => {
    expect(detectRecurring([charge(65, 100), charge(35, 100), charge(5, 250)], NOW)).toEqual([]);
  });
  it('a lapsed subscription (last charge over 1.5 cycles ago) is dropped', () => {
    expect(detectRecurring([charge(125, 199), charge(95, 199), charge(65, 199)], NOW)).toEqual([]);
  });
  it('refunded/linked charges and short names are ignored', () => {
    const rows = [charge(65, 199, 'NETFLIX', { settles_id: 1 }), charge(35, 199), charge(5, 199)];
    expect(detectRecurring(rows, NOW)).toEqual([]);
    expect(detectRecurring([charge(65, 99, 'AB'), charge(35, 99, 'AB'), charge(5, 99, 'AB')], NOW)).toEqual([]);
  });
  it('an irregular gap pattern is not a cadence', () => {
    expect(detectRecurring([charge(80, 199), charge(50, 199), charge(10, 199)], NOW)).toEqual([]);
  });
});

describe('buildUpcoming edge cases', () => {
  const NOW = new Date(2026, 9, 14, 12).getTime();
  const until = NOW + 20 * DAY;
  const rec = (over: Partial<RecurringPayment> = {}): RecurringPayment => ({
    key: 'netflix', merchant: 'NETFLIX', amount: 199, latest: 199, cadence: 'monthly',
    lastTs: NOW - 25 * DAY, nextTs: NOW + 5 * DAY, occurrences: 3, investment: false, priceIncrease: null, ...over,
  });
  it('an unrelated Investment debit of a similar amount does not hide a subscription', () => {
    const recent: HistoryRow[] = [{ type: 'expense', amount: 199, timestamp: NOW + 5 * DAY, merchant: 'ICCL', category: 'Investment' }];
    expect(buildUpcoming([], [rec()], recent, NOW, until)).toHaveLength(1);
  });
  it('an investment autopay is still covered by an Investment debit', () => {
    const recent: HistoryRow[] = [{ type: 'expense', amount: 4000, timestamp: NOW + 4 * DAY, merchant: 'ICCL', category: 'Investment' }];
    const n = [{ merchant: 'ICCL - Mutual Funds', amount: 4000, dueTs: NOW + 5 * DAY, investment: true }];
    expect(buildUpcoming(n as never, [], recent, NOW, until)).toEqual([]);
  });
  it('a notice and the matching prediction within 4 days count once', () => {
    const n = [{ merchant: 'Netflix', amount: 199, dueTs: NOW + 6 * DAY, investment: false }];
    const items = buildUpcoming(n as never, [rec()], [], NOW, until);
    expect(items.map(i => i.source)).toEqual(['notice']);
  });
  it('past-due and beyond-window items are dropped', () => {
    const n = [
      { merchant: 'Old', amount: 10, dueTs: NOW - 3 * DAY, investment: false },
      { merchant: 'Far', amount: 10, dueTs: NOW + 40 * DAY, investment: false },
    ];
    expect(buildUpcoming(n as never, [], [], NOW, until)).toEqual([]);
  });
});

// ─── dues ledger ─────────────────────────────────────────────────────────────
describe('ledger edge cases', () => {
  const ride = (id: number, amount: number, owed: number, friend: string | null): LedgerRow => ({
    id, type: 'expense', amount, timestamp: id * 1000, owed_amount: owed, owed_friend: friend,
  });
  const back = (id: number, amount: number, parent: number, x: Partial<LedgerRow> = {}): LedgerRow => ({
    id, type: 'income', amount, timestamp: id * 1000, settles_id: parent, ...x,
  });
  it('an over-payment counts only up to what is owed', () => {
    const [b] = buildLedger([ride(1, 300, 150, 'Testa'), back(2, 400, 1)]);
    expect(b).toMatchObject({ owed: 150, repaid: 150, outstanding: 0 });
  });
  it('two part-payments add up and stop at the owed amount', () => {
    const [b] = buildLedger([ride(1, 300, 150, 'Testa'), back(2, 100, 1), back(3, 100, 1)]);
    expect(b).toMatchObject({ repaid: 150, outstanding: 0 });
    expect(b.entries.filter(e => e.kind === 'repaid').map(e => e.delta).sort()).toEqual([-100, -50].sort());
  });
  it('same-direction and self-type links are not repayments', () => {
    const [b] = buildLedger([
      ride(1, 300, 150, 'Testa'),
      back(2, 50, 1, { type: 'expense' }),
      back(3, 50, 1, { type: 'self' }),
    ]);
    expect(b.repaid).toBe(0);
  });
  it('splits with no friend group under "Not assigned"; zero-owed rows are ignored', () => {
    const l = buildLedger([ride(1, 300, 100, null), ride(2, 300, 0, 'Testa'), ride(3, 300, 100, '  ')]);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ name: 'Not assigned', owed: 200 });
  });
  it('a settlement row that itself carries owed_amount is not a split', () => {
    const l = buildLedger([ride(1, 300, 150, 'Testa'), { ...ride(2, 100, 50, 'Testa'), settles_id: 1 }]);
    expect(l[0].owed).toBe(150);
  });
  it('totals do not accumulate float error and empty input is zero', () => {
    const l = buildLedger([ride(1, 100, 33.33, 'A'), ride(2, 100, 33.33, 'B'), ride(3, 100, 33.34, 'C')]);
    expect(totalOutstanding(l)).toBe(100);
    expect(totalOutstanding(buildLedger([]))).toBe(0);
  });
  it('friends are sorted by what they still owe', () => {
    const l = buildLedger([ride(1, 100, 10, 'Low'), ride(2, 100, 90, 'High')]);
    expect(l.map(b => b.name)).toEqual(['High', 'Low']);
  });
});

// ─── backup ──────────────────────────────────────────────────────────────────
describe('backup edge cases', () => {
  const NOW = new Date(2026, 9, 20, 9, 5).getTime();
  it('a last-backup time in the future (clock was wrong) still counts as due', () => {
    expect(isBackupDue(NOW + 30 * DAY, NOW)).toBe(true);
  });
  it('pads single-digit date and time parts', () => {
    expect(backupFileName(new Date(2026, 0, 5, 3, 7).getTime())).toBe('expense-tracker-backup-2026-01-05-0307.json');
  });
  it('a same-minute duplicate "(1)" counts as newer than the original', () => {
    const names = [
      'expense-tracker-backup-2026-10-01-0900.json',
      'expense-tracker-backup-2026-10-01-0900 (1).json',
      ...Array.from({ length: 7 }, (_, i) => `expense-tracker-backup-2026-10-1${i}-0900.json`),
    ];
    // 9 files, keep 8: exactly one is deleted and it must be the ORIGINAL oldest, not its newer duplicate.
    expect(backupsToDelete(names)).toEqual(['expense-tracker-backup-2026-10-01-0900.json']);
  });
  it('exactly the keep count deletes nothing; foreign files are never listed', () => {
    const ours = Array.from({ length: 8 }, (_, i) => `expense-tracker-backup-2026-10-0${i + 1}-0900.json`);
    expect(backupsToDelete([...ours, 'notes.txt'])).toEqual([]);
    expect(backupsToDelete([])).toEqual([]);
  });
  it('the interval is exactly seven days', () => {
    expect(BACKUP_INTERVAL_MS).toBe(7 * DAY);
  });
});
