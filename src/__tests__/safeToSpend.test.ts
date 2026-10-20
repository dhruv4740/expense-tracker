import { daysLeftInMonth, safeToSpend, safeToSpendLine } from '../safeToSpend';

const D = (day: number) => new Date(2026, 9, day, 10).getTime(); // October 2026 (31 days)

describe('safeToSpend', () => {
  it('income − spent − committed, per day over the remaining days', () => {
    const s = safeToSpend({ fromFamily: 2000, earned: 2320, spent: 1000, committed: 1000 }, D(22));
    expect(s.left).toBe(2320);
    expect(s.daysLeft).toBe(10);
    expect(s.perDay).toBe(232);
    expect(safeToSpendLine(s)).toBe('₹2,320 left · ~₹232/day for 10 days');
  });
  it('counts today, and the last day is "1 day"', () => {
    expect(daysLeftInMonth(D(31))).toBe(1);
    expect(daysLeftInMonth(D(1))).toBe(31);
    expect(safeToSpendLine(safeToSpend({ fromFamily: 100, earned: 0, spent: 0, committed: 0 }, D(31)))).toBe(
      '₹100 left · ~₹100/day for 1 day',
    );
  });
  it('an investment autopay due this month reduces what is left (committed, not spent)', () => {
    const without = safeToSpend({ fromFamily: 0, earned: 10000, spent: 3000, committed: 0 }, D(10));
    const withSip = safeToSpend({ fromFamily: 0, earned: 10000, spent: 3000, committed: 4000 }, D(10));
    expect(without.left - withSip.left).toBe(4000);
    expect(withSip.spent).toBe(3000);
  });
  it('shows a negative result plainly and no per-day allowance', () => {
    const s = safeToSpend({ fromFamily: 1000, earned: 0, spent: 2500, committed: 0 }, D(10));
    expect(s.left).toBe(-1500);
    expect(s.perDay).toBe(0);
    expect(safeToSpendLine(s)).toBe("₹1,500 over this month's income");
  });
});
