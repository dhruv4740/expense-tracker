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
  it('drops message text from phantom rows and over-long phrases', () => {
    const junk = [
      { merchant: 'view and approve the request', counterparty: null, total: 99000 },
      { merchant: 'Shawa rmaji has been successfully processed and shall your account by now', counterparty: null, total: 98000 },
      { merchant: 'One Two Three Four Five Six', counterparty: null, total: 97000 },
      { merchant: 'Harsha Vardhan', counterparty: null, total: 1000 },
    ];
    expect(suggestFamily(junk, { identity, family: [] }).map(x => x.value)).toEqual(['Harsha Vardhan']);
  });
  it('excludes anyone already on the friends list', () => {
    const r = suggestFamily(rows, { identity, family: [], friends: ['Kiran Rao'] });
    expect(r.map(x => x.value)).not.toContain('KIRAN RAO');
  });
  it('respects the limit', () => {
    expect(suggestFamily(rows, { identity, family: [] }, 1)).toHaveLength(1);
  });
});
