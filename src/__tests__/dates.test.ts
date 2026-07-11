import { localDayIndex, localTzOffsetMs, completedDays, groupByDay } from '../dates';
import type { TransactionRow } from '../db';

describe('localDayIndex / localTzOffsetMs', () => {
  it('produces the same day index for two timestamps in the same local day', () => {
    const noonToday = new Date();
    noonToday.setHours(12, 0, 0, 0);
    const almostMidnight = new Date(noonToday);
    almostMidnight.setHours(23, 59, 0, 0);

    expect(localDayIndex(noonToday.getTime())).toBe(localDayIndex(almostMidnight.getTime()));
  });

  it('advances by exactly 1 across a local midnight boundary', () => {
    const justBeforeMidnight = new Date();
    justBeforeMidnight.setHours(23, 59, 59, 999);
    const justAfterMidnight = new Date(justBeforeMidnight.getTime() + 2);

    expect(localDayIndex(justAfterMidnight.getTime())).toBe(
      localDayIndex(justBeforeMidnight.getTime()) + 1,
    );
  });

  it('agrees with groupByDay bucketing around the 00:00-05:30 IST window', () => {
    // Regression for issue #7: a transaction at 2 AM local time must land in
    // the SAME bucket whether computed via localDayIndex (charts) or via
    // groupByDay's dayStart (transaction list), not off by one UTC day.
    const twoAmLocal = new Date();
    twoAmLocal.setHours(2, 0, 0, 0);

    const grouped = groupByDay([
      { id: 1, amount: 100, merchant: null, source: null, raw_text: null, category: 'Other', timestamp: twoAmLocal.getTime(), type: 'expense' } as TransactionRow,
    ]);

    // groupByDay labels today's bucket 'Today' — localDayIndex for the same
    // instant, converted back, must land on the same calendar date.
    expect(grouped[0].title).toBe('Today');
  });

  it('localTzOffsetMs matches the negated device timezone offset in ms', () => {
    expect(localTzOffsetMs()).toBe(-new Date().getTimezoneOffset() * 60000);
  });
});

describe('completedDays', () => {
  it('returns 0 for a range that starts today (no day has fully elapsed yet)', () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth() + 1, 0, 23, 59, 59, 999);

    // Simulate "the 1st of the month" by using a range that starts now.
    const result = completedDays({ from: Date.now(), to: endOfMonth.getTime() });
    expect(result).toBe(0);
  });

  it('counts every day in a fully-past range (e.g. "Last month")', () => {
    const now = new Date();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const daysInLastMonth = lastMonthEnd.getDate();

    const result = completedDays({ from: lastMonthStart.getTime(), to: lastMonthEnd.getTime() });
    expect(result).toBe(daysInLastMonth);
  });

  it('counts only completed days for a range including today (mid-month)', () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const result = completedDays({ from: monthStart.getTime(), to: monthEnd.getTime() });
    // Completed days = however many full days have elapsed before today.
    expect(result).toBe(now.getDate() - 1);
  });
});
