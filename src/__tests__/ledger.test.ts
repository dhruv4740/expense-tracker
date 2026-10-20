import { buildLedger, presetOwed, totalOutstanding } from '../ledger';
import type { LedgerRow } from '../ledger';

const ride = (id: number, amount: number, owed: number, friend: string | null, ts = id * 1000): LedgerRow => ({
  id, type: 'expense', amount, timestamp: ts, owed_amount: owed, owed_friend: friend,
});
const paid = (id: number, amount: number, parent: number): LedgerRow => ({
  id, type: 'income', amount, timestamp: id * 1000, settles_id: parent,
});

describe('presets', () => {
  it('½, ⅓, ⅔ of the fare to paise', () => {
    expect(presetOwed(300, 'half')).toBe(150);
    expect(presetOwed(100, 'third')).toBe(33.33);
    expect(presetOwed(100, 'twoThirds')).toBe(66.67);
    expect(presetOwed(0, 'half')).toBe(0);
  });
});

describe('buildLedger', () => {
  it('sums what a friend owes across rides, ignoring case and punctuation in names', () => {
    const l = buildLedger([ride(1, 300, 150, 'Testa'), ride(2, 200, 100, 'testa.')]);
    expect(l).toHaveLength(1);
    expect(l[0].outstanding).toBe(250);
    expect(l[0].entries.map(e => e.kind)).toEqual(['owed', 'owed']);
  });
  it('partial repayments reduce the balance; the history lists both', () => {
    const l = buildLedger([ride(1, 300, 150, 'Testa'), paid(2, 50, 1)]);
    expect(l[0]).toMatchObject({ owed: 150, repaid: 50, outstanding: 100 });
    expect(l[0].entries.map(e => e.kind).sort()).toEqual(['owed', 'repaid']);
  });
  it('overpayment never makes the balance negative on that ride', () => {
    const l = buildLedger([ride(1, 300, 150, 'Testa'), paid(2, 400, 1), ride(3, 100, 50, 'Testa')]);
    expect(l[0].outstanding).toBe(50);
  });
  it('a repayment from a cancel-out "share" link counts like any other', () => {
    const l = buildLedger([ride(1, 1200, 400, 'Testa'), paid(2, 400, 1)]);
    expect(l[0].outstanding).toBe(0);
  });
  it('same-direction legacy links are not repayments', () => {
    const l = buildLedger([ride(1, 300, 150, 'Testa'), { ...ride(2, 150, 0, null), settles_id: 1 }]);
    expect(l[0].outstanding).toBe(150);
  });
  it('splits with no friend go to Not assigned; totals add up; biggest first', () => {
    const l = buildLedger([ride(1, 100, 50, null), ride(2, 400, 300, 'Arun')]);
    expect(l.map(b => b.name)).toEqual(['Arun', 'Not assigned']);
    expect(totalOutstanding(l)).toBe(350);
  });
});
