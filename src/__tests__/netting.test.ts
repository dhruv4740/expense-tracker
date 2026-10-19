import { netSummary, netUber, outOfPocket, paidBack } from '../netting';
import type { NetRow } from '../netting';

const NON_SPEND = ['Investment', 'Friend Transfer', 'Loan/Dues'];
const range = { from: 0, to: 1_000_000 };
const row = (
  id: number,
  type: NetRow['type'],
  amount: number,
  category: string,
  settles_id: number | null = null,
): NetRow => ({ id, type, amount, category, timestamp: 1000 + id, settles_id });

const sum = (rows: NetRow[]) => netSummary(rows, range, NON_SPEND);
const cat = (rows: NetRow[], c: string) =>
  sum(rows).byCategory.find(x => x.category === c)?.total;

describe('netting: effective amounts', () => {
  it('a part-payback reduces the parent; the child stays excluded', () => {
    const rows = [row(1, 'expense', 500, 'Food'), row(2, 'income', 200, 'Friend Transfer', 1)];
    expect(cat(rows, 'Food')).toBe(300);
    expect(sum(rows).spent).toBe(300);
    expect(sum(rows).received).toBe(0);
  });

  it('a full payback or overpayback floors the parent at zero', () => {
    expect(cat([row(1, 'expense', 500, 'Food'), row(2, 'income', 500, 'Friend Transfer', 1)], 'Food')).toBe(0);
    expect(cat([row(1, 'expense', 500, 'Food'), row(2, 'income', 800, 'Friend Transfer', 1)], 'Food')).toBe(0);
  });

  it('several children add up', () => {
    const rows = [
      row(1, 'expense', 600, 'Food'),
      row(2, 'income', 200, 'Friend Transfer', 1),
      row(3, 'income', 250, 'Friend Transfer', 1),
    ];
    expect(cat(rows, 'Food')).toBe(150);
    expect(paidBack(rows).get(1)).toEqual({ paid: 450, n: 2 });
  });

  it('an expense can cancel an income (money given back)', () => {
    const rows = [row(1, 'income', 1000, 'Income'), row(2, 'expense', 400, 'Other', 1)];
    expect(sum(rows).received).toBe(600);
    expect(sum(rows).spent).toBe(0);
  });

  it('same-direction links exclude the child but do not reduce the parent', () => {
    const rows = [row(1, 'expense', 150, 'Uber'), row(2, 'expense', 150, 'Uber', 1)];
    expect(cat(rows, 'Uber')).toBe(150);
    expect(paidBack(rows).size).toBe(0);
  });

  it('an Investment credit never counts as received', () => {
    expect(sum([row(1, 'income', 45000, 'Investment')]).received).toBe(0);
  });

  it('unlinked rows are untouched', () => {
    const rows = [row(1, 'expense', 500, 'Food'), row(2, 'income', 200, 'Friend Transfer')];
    expect(cat(rows, 'Food')).toBe(500);
  });
});

describe('netting: Uber card and Dashboard agree', () => {
  const cases: [string, NetRow[]][] = [
    ['unlinked rides', [row(1, 'expense', 300, 'Uber'), row(2, 'expense', 120, 'Uber')]],
    ['partly paid ride', [row(1, 'expense', 300, 'Uber'), row(2, 'income', 100, 'Friend Transfer', 1)]],
    ['overpaid ride', [row(1, 'expense', 300, 'Uber'), row(2, 'income', 400, 'Friend Transfer', 1)]],
    ['legacy Uber-tagged income', [row(1, 'expense', 300, 'Uber'), row(2, 'income', 120, 'Uber')]],
    [
      'linked + legacy',
      [
        row(1, 'expense', 300, 'Uber'),
        row(2, 'income', 100, 'Friend Transfer', 1),
        row(3, 'income', 50, 'Uber'),
      ],
    ],
  ];
  it.each(cases)('%s', (_name, rows) => {
    expect(netUber(rows, range).net).toBeCloseTo(cat(rows, 'Uber') ?? 0, 6);
  });
});

describe('netting: legacy same-direction Uber links', () => {
  const rows = [row(1, 'expense', 150, 'Uber'), row(2, 'expense', 150, 'Other', 1)];
  it('still count as reimbursed on the Uber card', () => {
    expect(netUber(rows, range)).toEqual({ spent: 150, reimbursed: 150, net: 0 });
  });
  it('but do not reduce the ride in the Dashboard totals', () => {
    expect(cat(rows, 'Uber')).toBe(150);
  });
  it('an opposite-direction link is not double counted', () => {
    const r = [row(1, 'expense', 300, 'Uber'), row(2, 'income', 100, 'Friend Transfer', 1)];
    expect(netUber(r, range).reimbursed).toBe(100);
  });
});

describe('netting: Dashboard hero figures', () => {
  it('splits received into family and earned, and computes out of pocket', () => {
    const rows = [
      row(1, 'expense', 1000, 'Food'),
      row(2, 'expense', 500, 'Shopping'),
      row(3, 'income', 700, 'Family'),
      row(4, 'income', 300, 'Income'),
      row(5, 'self', 9999, 'Other'),
      row(6, 'income', 200, 'Loan/Dues'), // non-spend: in neither figure
    ];
    const s = sum(rows);
    expect(s.spent).toBe(1500);
    expect(s.fromFamily).toBe(700);
    expect(s.earned).toBe(300);
    expect(s.fromFamily + s.earned).toBe(s.received);
    expect(outOfPocket(s.spent, s.fromFamily)).toBe(800);
  });

  it('nets a family credit that is partly paid back, ignores settling rows', () => {
    const rows = [
      row(1, 'income', 1000, 'Family'),
      row(2, 'expense', 400, 'Family', 1), // returns part of the credit
      row(3, 'expense', 100, 'Food'),
    ];
    expect(sum(rows).fromFamily).toBe(600);
  });

  it('out of pocket never goes negative', () => {
    expect(outOfPocket(300, 1000)).toBe(0);
  });
});

describe('netting: Uber screen Paid − Got back = Your share', () => {
  const rows = [
    row(1, 'expense', 300, 'Uber'), // unsplit, unpaid
    row(2, 'expense', 200, 'Uber'), // split, half repaid
    row(3, 'income', 100, 'Friend Transfer', 2),
    row(4, 'expense', 100, 'Uber'), // partially repaid
    row(5, 'income', 40, 'Friend Transfer', 4),
    row(6, 'expense', 150, 'Uber'), // legacy same-direction link
    row(7, 'expense', 150, 'Other', 6),
  ];
  it('reconciles on a mixed month', () => {
    const u = netUber(rows, range);
    expect(u).toEqual({ spent: 750, reimbursed: 290, net: 460 });
    expect(u.spent - u.reimbursed).toBe(u.net);
  });
});
