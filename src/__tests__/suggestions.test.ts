import { suggestOwnAccounts, suggestFamily } from '../suggestions';
import type { Identity } from '../identity';

const identity: Identity = {
  name: 'Anita Priya Rao',
  phones: ['9000000001'],
  upiHandles: [],
  accountLast4: ['1111'],
};

describe('suggestOwnAccounts', () => {
  it('lists unknown fragments by count and skips known / malformed ones', () => {
    const r = suggestOwnAccounts(
      [
        { account: '1111', count: 50 },
        { account: '2222', count: 5 },
        { account: '3333', count: 42 },
        { account: 'abc', count: 9 },
      ],
      identity,
    );
    expect(r).toEqual([
      { account: '3333', count: 42 },
      { account: '2222', count: 5 },
    ]);
  });
});

describe('suggestFamily', () => {
  const rows = [
    { merchant: 'KIRAN RAO', counterparty: null, total: 61000 },
    { merchant: 'ANITA RAO', counterparty: null, total: 90000 }, // self
    { merchant: 'GROWW INVEST TECH PR', counterparty: null, total: 80000 }, // brand
    { merchant: 'SONA RAO', counterparty: null, total: 5000 }, // already family
    { merchant: null, counterparty: 'uncle@okaxis', total: 7000 },
    { merchant: null, counterparty: 'shop.payments@ybl', total: 9000 }, // merchant vpa
    { merchant: 'RAHUL', counterparty: null, total: 4000 }, // single token
  ];
  it('suggests people and personal VPAs, excluding self, family, brands, merchants', () => {
    const r = suggestFamily(rows, { identity, family: ['Sona Rao'] });
    expect(r.map(x => x.value)).toEqual(['KIRAN RAO', 'uncle@okaxis']);
  });
  it('respects the limit', () => {
    expect(suggestFamily(rows, { identity, family: [] }, 1)).toHaveLength(1);
  });
});
