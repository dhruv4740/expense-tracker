import { buildInsights, categoryChanges, lateNight, topMerchant } from '../insights';
import type { InsightRow } from '../insights';

const NOW = new Date(2026, 9, 20, 12).getTime(); // 20 Oct 2026
const at = (m: number, d: number, h = 12) => new Date(2026, m, d, h).getTime();
const row = (ts: number, amount: number, category = 'Food', merchant = 'Cafe', extra: Partial<InsightRow> = {}): InsightRow => ({
  type: 'expense', amount, category, merchant, timestamp: ts, ...extra,
});

describe('categoryChanges', () => {
  // Jul/Aug/Sep days 1-20: 1000 each → average 1000
  const history = [row(at(6, 5), 1000), row(at(7, 5), 1000), row(at(8, 5), 1000)];
  it('flags a category up more than 30% against the same days of prior months', () => {
    const [i] = categoryChanges([...history, row(at(9, 3), 1500)], NOW);
    expect(i).toMatchObject({ kind: 'category_change', tone: 'up', title: 'Food up 50%' });
  });
  it('flags a drop, and stays quiet inside ±30%', () => {
    expect(categoryChanges([...history, row(at(9, 3), 600)], NOW)[0]).toMatchObject({ tone: 'down', title: 'Food down 40%' });
    expect(categoryChanges([...history, row(at(9, 3), 1200)], NOW)).toEqual([]);
  });
  it('compares only the same stretch of earlier months', () => {
    const h = [...history, row(at(8, 28), 9000)]; // Sep 28 is outside days 1-20
    expect(categoryChanges([...h, row(at(9, 3), 1500)], NOW)[0].title).toBe('Food up 50%');
  });
  it('ignores tiny categories, early month, netted refunds and non-spend', () => {
    expect(categoryChanges([row(at(6, 5), 100), row(at(9, 3), 300)], NOW)).toEqual([]);
    expect(categoryChanges([...history, row(at(9, 3), 1500)], new Date(2026, 9, 2).getTime())).toEqual([]);
    expect(categoryChanges([...history, row(at(9, 3), 1500, 'Food', 'Cafe', { paid_back: 300 })], NOW)).toEqual([]);
    expect(categoryChanges([...history, row(at(9, 3), 1100), row(at(9, 4), 5000, 'Investment')], NOW)).toEqual([]);
  });
});

describe('lateNight', () => {
  it('counts 22:00-04:00 payments in the last 7 days only', () => {
    const rows = [row(at(9, 19, 23), 300), row(at(9, 18, 2), 200), row(at(9, 18, 15), 900), row(at(9, 10, 23), 700)];
    const i = lateNight(rows, NOW);
    expect(i?.title).toBe('₹500 spent late at night this week');
    expect(i?.detail).toContain('2 payments');
  });
  it('null when there is none', () => {
    expect(lateNight([row(at(9, 19, 15), 300)], NOW)).toBeNull();
  });
});

describe('topMerchant', () => {
  it('picks the merchant with the most spend this month', () => {
    const rows = [
      row(at(9, 2), 200, 'Food', 'SWIGGY'),
      row(at(9, 5), 300, 'Food', 'Swiggy'),
      row(at(9, 6), 400, 'Shopping', 'Amazon'),
      row(at(8, 6), 9000, 'Shopping', 'Old'),
    ];
    expect(topMerchant(rows, NOW)).toMatchObject({ title: 'Top merchant: SWIGGY', detail: '₹500 across 2 payments this month' });
  });
  it('null with no spend', () => {
    expect(topMerchant([], NOW)).toBeNull();
  });
});

describe('buildInsights', () => {
  it('combines the cards', () => {
    const rows = [row(at(6, 5), 1000), row(at(7, 5), 1000), row(at(8, 5), 1000), row(at(9, 3), 1500), row(at(9, 19, 23), 100)];
    expect(buildInsights(rows, NOW).map(i => i.kind)).toEqual(['category_change', 'late_night', 'top_merchant']);
  });
});
