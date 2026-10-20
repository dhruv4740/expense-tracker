import { buildUpcoming, detectRecurring, parseMandateNotice, sumAmounts } from '../upcoming';
import type { HistoryRow } from '../upcoming';
import { parseTransaction } from '../parser';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 14, 12).getTime(); // 14 Oct 2026

const NOTICE =
  'E-Mandate! Rs.4000.00 will be deducted on 18/10/26, 00:00:00 For ICCL - Mutual Funds - Autopay mandate UMN 0000000000000000000000000000000a@bank Maintain Balance -HDFC Bank';

const charge = (daysAgo: number, amount: number, merchant = 'NETFLIX', extra: Partial<HistoryRow> = {}): HistoryRow => ({
  type: 'expense', amount, timestamp: NOW - daysAgo * DAY, merchant, ...extra,
});

describe('parseMandateNotice', () => {
  it('reads amount, date and merchant from the HDFC e-mandate notice', () => {
    const n = parseMandateNotice(NOTICE);
    expect(n).toMatchObject({ amount: 4000, merchant: 'ICCL - Mutual Funds', investment: true });
    expect(n?.dueTs).toBe(new Date(2026, 9, 18).getTime());
  });
  it('is not a transaction: the parser still rejects it', () => {
    expect(parseTransaction('HDFCBK', NOTICE, NOW)).toBeNull();
  });
  it('ignores unrelated messages', () => {
    expect(parseMandateNotice('Rs.500 debited from a/c XX1234 at Swiggy')).toBeNull();
  });
});

describe('detectRecurring', () => {
  it('finds a monthly subscription (3 charges, ~30 days apart)', () => {
    const [r] = detectRecurring([charge(65, 199), charge(35, 199), charge(5, 199)], NOW);
    expect(r).toMatchObject({ cadence: 'monthly', amount: 199, occurrences: 3, priceIncrease: null });
    expect(r.nextTs).toBeGreaterThan(NOW);
  });
  it('finds weekly payments', () => {
    const r = detectRecurring([charge(21, 50, 'MILKMAN'), charge(14, 50, 'MILKMAN'), charge(7, 50, 'MILKMAN')], NOW);
    expect(r[0].cadence).toBe('weekly');
  });
  it('needs at least 3 occurrences and a steady cadence', () => {
    expect(detectRecurring([charge(35, 199), charge(5, 199)], NOW)).toEqual([]);
    expect(detectRecurring([charge(60, 199), charge(40, 199), charge(5, 199)], NOW)).toEqual([]);
  });
  it('flags a price increase above 10% but not below', () => {
    const up = detectRecurring([charge(65, 199), charge(35, 199), charge(5, 249)], NOW)[0];
    expect(up.priceIncrease).toEqual({ from: 199, to: 249, pct: 25 });
    const small = detectRecurring([charge(65, 199), charge(35, 199), charge(5, 210)], NOW)[0];
    expect(small.priceIncrease).toBeNull();
  });
  it('drops a subscription that stopped, and ignores income/linked rows', () => {
    expect(detectRecurring([charge(165, 199), charge(135, 199), charge(105, 199)], NOW)).toEqual([]);
    expect(detectRecurring([charge(65, 199, 'X', { type: 'income' }), charge(35, 199, 'X', { type: 'income' }), charge(5, 199, 'X', { type: 'income' })], NOW)).toEqual([]);
  });
  it('varying amounts (food delivery) are not subscriptions', () => {
    expect(detectRecurring([charge(65, 150, 'SWIGGY'), charge(35, 420, 'SWIGGY'), charge(5, 90, 'SWIGGY')], NOW)).toEqual([]);
  });
});

describe('buildUpcoming', () => {
  const until = NOW + 30 * DAY;
  it('lists a notice and sums it', () => {
    const items = buildUpcoming([parseMandateNotice(NOTICE)!], [], [], NOW, until);
    expect(items).toHaveLength(1);
    expect(sumAmounts(items)).toBe(4000);
  });
  it('drops a notice once the debit has landed (no double count)', () => {
    const debit: HistoryRow = { type: 'expense', amount: 4000, timestamp: new Date(2026, 9, 18, 9).getTime(), merchant: 'ICCL', category: 'Investment' };
    const later = new Date(2026, 9, 19).getTime();
    expect(buildUpcoming([parseMandateNotice(NOTICE)!], [], [debit], later - DAY, until + 5 * DAY)).toHaveLength(0);
  });
  it('drops stale notices (due date passed)', () => {
    expect(buildUpcoming([parseMandateNotice(NOTICE)!], [], [], new Date(2026, 9, 25).getTime(), until + 20 * DAY)).toEqual([]);
  });
  it('predicts the next recurring charge and carries the price flag', () => {
    const rec = detectRecurring([charge(65, 199), charge(35, 199), charge(5, 249)], NOW);
    const items = buildUpcoming([], rec, [], NOW, until);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'recurring', amount: 249 });
    expect(items[0].priceIncrease?.pct).toBe(25);
  });
  it('a notice replaces the matching recurring prediction', () => {
    const rows = [charge(86, 4000, 'ICCL - Mutual Funds'), charge(56, 4000, 'ICCL - Mutual Funds'), charge(26, 4000, 'ICCL - Mutual Funds')];
    const rec = detectRecurring(rows, NOW);
    expect(rec).toHaveLength(1);
    const items = buildUpcoming([parseMandateNotice(NOTICE)!], rec, [], NOW, until);
    expect(items.filter(i => i.merchant.includes('ICCL'))).toHaveLength(1);
    expect(items[0].source).toBe('notice');
  });
});
