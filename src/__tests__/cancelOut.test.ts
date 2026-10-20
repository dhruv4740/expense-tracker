import { cancelKey, classifyCancel, findCancelPairs } from '../cancelOut';
import type { CancelRow } from '../cancelOut';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_760_000_000_000;
const identity = { name: 'Anita Rao', phones: [], upiHandles: [], accountLast4: [] };
const ctx = { identity, friends: ['Testa Ajay Samplekar'] };

const spend = (id: number, amount: number, ts: number, extra: Partial<CancelRow> = {}): CancelRow => ({
  id, type: 'expense', amount, timestamp: ts, category: 'Shopping', merchant: 'RELIANCE RETAIL LIMITE', ...extra,
});
const credit = (id: number, amount: number, ts: number, extra: Partial<CancelRow> = {}): CancelRow => ({
  id, type: 'income', amount, timestamp: ts, category: 'Friend Transfer', merchant: 'TESTA AJAY SAMPLEKAR', ...extra,
});

describe('cancel-out pairing', () => {
  it('friend pays first, spend a minute later → high (the 4 Oct case)', () => {
    const c = credit(1, 1200, T0);
    const s = spend(2, 1200, T0 + MIN);
    const [p] = findCancelPairs([s], [c, s], ctx);
    expect(p.confidence).toBe('high');
    expect(p.expense.id).toBe(2);
    expect(p.income.id).toBe(1);
  });
  it('spend first, friend pays later → high', () => {
    const [p] = findCancelPairs([credit(2, 1200, T0 + 5 * MIN)], [spend(1, 1200, T0)], ctx);
    expect(p.confidence).toBe('high');
  });
  it('10 min boundary: exactly 10 high, 10 min 1 s medium', () => {
    expect(classifyCancel(spend(1, 500, T0), credit(2, 500, T0 + 10 * MIN), ctx)?.confidence).toBe('high');
    expect(classifyCancel(spend(1, 500, T0), credit(2, 500, T0 + 10 * MIN + 1000), ctx)?.confidence).toBe('medium');
  });
  it('24h boundary: exact amount at 24h is medium, past 24h is nothing', () => {
    expect(classifyCancel(spend(1, 500, T0), credit(2, 500, T0 + 24 * HOUR), ctx)?.confidence).toBe('medium');
    expect(classifyCancel(spend(1, 500, T0), credit(2, 500, T0 + 24 * HOUR + 1000), ctx)).toBeNull();
  });
  it('share from a friend within 24h is medium; from a stranger it is nothing', () => {
    const p = classifyCancel(spend(1, 1200, T0), credit(2, 400, T0 + HOUR), ctx);
    expect(p?.confidence).toBe('medium');
    expect(p?.basis).toBe('share');
    expect(classifyCancel(spend(1, 1200, T0), credit(2, 400, T0 + HOUR, { merchant: 'RANDOM PERSON' }), ctx)).toBeNull();
  });
  it('unrelated ₹100s a week apart never pair', () => {
    expect(findCancelPairs([credit(2, 100, T0 + 7 * 24 * HOUR)], [spend(1, 100, T0)], ctx)).toEqual([]);
  });
  it('never touches self, Investment, Uber or already-linked rows', () => {
    const c = credit(2, 1200, T0);
    expect(classifyCancel(spend(1, 1200, T0, { type: 'self' }), c, ctx)).toBeNull();
    expect(classifyCancel(spend(1, 1200, T0, { category: 'Investment' }), c, ctx)).toBeNull();
    expect(classifyCancel(spend(1, 1200, T0, { category: 'Uber' }), c, ctx)).toBeNull();
    expect(classifyCancel(spend(1, 1200, T0, { settles_id: 9 }), c, ctx)).toBeNull();
    expect(classifyCancel(spend(1, 1200, T0), credit(2, 1200, T0, { settles_id: 9 }), ctx)).toBeNull();
  });
  it('ignores family, cashback, salary, business and own-name credits', () => {
    const s = spend(1, 1200, T0);
    expect(classifyCancel(s, credit(2, 1200, T0, { category: 'Family' }), ctx)).toBeNull();
    expect(classifyCancel(s, credit(2, 1200, T0, { category: 'Cashback' }), ctx)).toBeNull();
    expect(classifyCancel(s, credit(2, 1200, T0, { merchant: 'ACME PVT LTD' }), ctx)).toBeNull();
    expect(classifyCancel(s, credit(2, 1200, T0, { raw_text: 'salary credited' }), ctx)).toBeNull();
    expect(classifyCancel(s, credit(2, 1200, T0, { merchant: 'ANITA RAO' }), ctx)).toBeNull();
  });
  it('a manual row is only suggested, never auto-linked', () => {
    expect(classifyCancel(spend(1, 500, T0, { category_source: 'manual' }), credit(2, 500, T0 + MIN), ctx)?.confidence).toBe('medium');
  });
  it('dismissed pairs are never offered again', () => {
    const s = spend(1, 500, T0);
    const c = credit(2, 500, T0 + 2 * HOUR);
    expect(findCancelPairs([c], [s], ctx)).toHaveLength(1);
    expect(findCancelPairs([c], [s], ctx, new Set([cancelKey(1, 2)]))).toEqual([]);
  });
  it('each row is used once: closest credit wins', () => {
    const s = spend(1, 500, T0);
    const near = credit(2, 500, T0 + MIN);
    const far = credit(3, 500, T0 + 5 * MIN);
    const out = findCancelPairs([near, far], [s], ctx);
    expect(out).toHaveLength(1);
    expect(out[0].income.id).toBe(2);
  });
});
