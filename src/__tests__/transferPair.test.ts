import {
  classifyPair,
  findMatchingLeg,
  extractRefs,
  findTransferPairs,
  isThirdPartyLeg,
  legLabel,
} from '../transferPair';
import type { TransferRow } from '../transferPair';
import type { Identity } from '../identity';

const identity: Identity = {
  name: 'Test User',
  phones: ['9000000001'],
  upiHandles: ['testuser@bankx'],
  accountLast4: ['1111', '2222'],
};

const T = 1_700_000_000_000;
const MIN = 60_000;

let nextId = 1;
const row = (over: Partial<TransferRow>): TransferRow => ({
  id: nextId++,
  amount: 750,
  timestamp: T,
  type: 'expense',
  category: 'UPI',
  category_source: 'auto',
  channel: 'sms',
  source: 'BANKA',
  account: '1111',
  ...over,
});

const debit = (over: Partial<TransferRow> = {}) => row({ type: 'expense', ...over });
const credit = (over: Partial<TransferRow> = {}) =>
  row({ type: 'income', source: 'BANKB', account: '2222', ...over });

describe('extractRefs', () => {
  it('finds UPI/IMPS/UTR/RRN references in common phrasings', () => {
    expect(extractRefs('sent Rs.5 to Test User (UPI Ref: 626107872291)')).toEqual(['626107872291']);
    expect(extractRefs('credited from VPA *4545@slc (UPI 626107872291)')).toEqual(['626107872291']);
    expect(extractRefs('IMPS Ref no. 411139386007 done')).toEqual(['411139386007']);
    expect(extractRefs('UTR: 121282891840, RRN 987889400392')).toEqual(['121282891840', '987889400392']);
  });

  it('ignores phone-number local parts, short numbers and empty text', () => {
    expect(extractRefs('paid to 9000000001@ybl')).toEqual([]);
    expect(extractRefs('Ref 12345')).toEqual([]);
    expect(extractRefs(null)).toEqual([]);
  });
});

describe('classifyPair — high confidence', () => {
  it('shared reference number → high, even a few minutes apart', () => {
    const d = debit({ raw_text: 'sent to Test User (UPI Ref: 626107872291)', counterparty: 'Test User' });
    const c = credit({ raw_text: 'credited from VPA *4545@slc (UPI 626107872291)', timestamp: T + 9 * MIN });
    const p = classifyPair(d, c, identity);
    expect(p?.confidence).toBe('high');
    expect(p?.basis).toBe('ref');
  });

  it('2-min different-account pair with no ref → high (no minimum amount)', () => {
    const p = classifyPair(debit({ amount: 40 }), credit({ amount: 40, timestamp: T + 2 * MIN }), identity);
    expect(p?.confidence).toBe('high');
    expect(p?.basis).toBe('time');
  });

  it('one account unknown still counts as different accounts', () => {
    const p = classifyPair(debit({ account: null }), credit({ timestamp: T + MIN }), identity);
    expect(p?.confidence).toBe('high');
  });

  it("the user's own name as counterparty is not third-party", () => {
    const d = debit({ counterparty: 'Test User' });
    const c = credit({ merchant: 'TEST USER', timestamp: T + MIN });
    expect(classifyPair(d, c, identity)?.confidence).toBe('high');
  });
});

describe('classifyPair — never high', () => {
  it('same account → no pair at all', () => {
    expect(classifyPair(debit(), credit({ account: '1111', timestamp: T + MIN }), identity)).toBeNull();
  });

  it('both accounts unknown and same sender → no pair', () => {
    const d = debit({ account: null });
    const c = credit({ account: null, source: 'BANKA', timestamp: T + MIN });
    expect(classifyPair(d, c, identity)).toBeNull();
  });

  it('20 minutes apart → no pair, even with a shared reference', () => {
    const c = credit({ timestamp: T + 20 * MIN, raw_text: 'UPI Ref 626107872291' });
    expect(classifyPair(debit({ raw_text: 'UPI Ref 626107872291' }), c, identity)).toBeNull();
  });

  it('5 minutes apart without a reference → medium only', () => {
    const p = classifyPair(debit(), credit({ timestamp: T + 5 * MIN }), identity);
    expect(p?.confidence).toBe('medium');
  });

  it('manual rows are never auto (high) but can still be suggested', () => {
    const d = debit({ category_source: 'manual' });
    const c = credit({ timestamp: T + MIN });
    expect(classifyPair(d, c, identity)?.confidence).toBe('medium');
    const dm = debit({ channel: 'manual', raw_text: 'Ref 626107872291' });
    const cm = credit({ raw_text: 'Ref 626107872291' });
    expect(classifyPair(dm, cm, identity)?.confidence).toBe('medium');
  });

  it('card purchase + friend credit of the same amount → no pair', () => {
    const d = debit({
      amount: 1200,
      category: 'Shopping',
      merchant: 'RETAIL STORE',
      raw_text: 'Rs.1200 spent via Credit Card XX1111 at RETAIL STORE',
    });
    const c = credit({ amount: 1200, counterparty: 'Friend Name', category: 'Friend Transfer', timestamp: T + MIN });
    expect(classifyPair(d, c, identity)).toBeNull();
  });

  it('merchant-category debit + friend credit (no card wording) is not high', () => {
    const d = debit({ amount: 1200, category: 'Shopping', merchant: 'RETAIL STORE' });
    const c = credit({ amount: 1200, counterparty: 'Friend Name', timestamp: T + MIN });
    expect(classifyPair(d, c, identity)?.confidence).toBe('medium');
  });

  it('cash withdrawal + reversal credit → no pair', () => {
    const d = debit({ amount: 300, category: 'Cash', raw_text: 'Rs.300 withdrawn at ATM' });
    const c = credit({ amount: 300, raw_text: 'Rs.300 credited as reversal of failed txn', timestamp: T + MIN });
    expect(classifyPair(d, c, identity)).toBeNull();
  });

  it('a reversal sharing the original reference is still not a transfer', () => {
    const d = debit({ raw_text: 'debited UPI Ref 626107872291' });
    const c = credit({ raw_text: 'refund credited UPI Ref 626107872291', timestamp: T + MIN });
    expect(classifyPair(d, c, identity)).toBeNull();
  });

  it('a stranger paying the same amount a week later → no pair', () => {
    const c = credit({ timestamp: T + 7 * 86_400_000, counterparty: 'Other Person' });
    expect(classifyPair(debit(), c, identity)).toBeNull();
  });

  it('different amounts, already-linked, self and Investment rows → no pair', () => {
    expect(classifyPair(debit(), credit({ amount: 751 }), identity)).toBeNull();
    expect(classifyPair(debit(), credit({ settles_id: 9 }), identity)).toBeNull();
    expect(classifyPair(debit(), credit({ type: 'self' as never }), identity)).toBeNull();
    expect(classifyPair(debit({ category: 'Investment' }), credit(), identity)).toBeNull();
  });
});

describe('isThirdPartyLeg', () => {
  it('flags other people, brands categories and non-masked foreign VPAs', () => {
    expect(isThirdPartyLeg(debit({ counterparty: 'Friend Name' }), identity)).toBe(true);
    expect(isThirdPartyLeg(debit({ category: 'Food' }), identity)).toBe(true);
    expect(isThirdPartyLeg(debit({ counterparty: 'someone@okaxis' }), identity)).toBe(true);
  });

  it('allows own identifiers, masked VPAs, bank names and bare account fragments', () => {
    expect(isThirdPartyLeg(debit({ counterparty: 'testuser@bankx' }), identity)).toBe(false);
    expect(isThirdPartyLeg(credit({ counterparty: '*4545@slc' }), identity)).toBe(false);
    expect(isThirdPartyLeg(debit({ merchant: 'SOME BANK' }), identity)).toBe(false);
    expect(isThirdPartyLeg(debit({ counterparty: '2222' }), identity)).toBe(false);
  });
});

describe('findTransferPairs', () => {
  it('pairs fresh rows against the pool, one pair per row', () => {
    const d1 = debit({ timestamp: T });
    const c1 = credit({ timestamp: T + MIN });
    const d2 = debit({ timestamp: T + 60 * MIN, amount: 90 });
    const c2 = credit({ timestamp: T + 61 * MIN, amount: 90 });
    const pairs = findTransferPairs([c1, c2], [d1, d2, c1, c2], identity);
    expect(pairs).toHaveLength(2);
    expect(pairs.every(p => p.confidence === 'high')).toBe(true);
  });

  it('ignores pairs where neither row is fresh', () => {
    const d = debit();
    const c = credit({ timestamp: T + MIN });
    expect(findTransferPairs([], [d, c], identity)).toEqual([]);
  });

  it('with two candidate credits, the ref match wins and each credit pairs once', () => {
    const d = debit({ raw_text: 'UPI Ref 626107872291' });
    const near = credit({ timestamp: T + MIN });
    const refd = credit({ timestamp: T + 5 * MIN, raw_text: 'UPI 626107872291' });
    const pairs = findTransferPairs([d], [d, near, refd], identity);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].income.id).toBe(refd.id);
  });
});

describe('legLabel', () => {
  it('prefers a cleaned sender, falls back to the account', () => {
    expect(legLabel(debit({ source: 'AX-HDFCBK-S' }))).toBe('HDFCBK');
    expect(legLabel(debit({ source: null, account: 'XX1111' }))).toBe('a/c 1111');
  });
});

describe('findMatchingLeg', () => {
  it('returns the closest equal-amount opposite leg within 15 minutes', () => {
    const d = debit();
    const far = credit({ timestamp: T + 10 * MIN });
    const near = credit({ timestamp: T + 2 * MIN });
    expect(findMatchingLeg(d, [far, near])?.id).toBe(near.id);
  });

  it('ignores wrong amount, same direction, too far, self and linked rows', () => {
    const d = debit();
    const pool = [
      credit({ amount: 751 }),
      debit({ timestamp: T + MIN }),
      credit({ timestamp: T + 20 * MIN }),
      credit({ type: 'self' as never }),
      credit({ settles_id: 5 }),
    ];
    expect(findMatchingLeg(d, pool)).toBeNull();
  });

  it('works from the credit side too, and tolerates manual rows (user is choosing)', () => {
    const c = credit();
    const d = debit({ category_source: 'manual', timestamp: T + MIN });
    expect(findMatchingLeg(c, [d])?.id).toBe(d.id);
  });
});

describe('slice IMPS debit pairs with the receiving bank credit by reference', () => {
  it('is a high-confidence ref pair', () => {
    const d = debit({
      amount: 297627,
      source: 'VM-SLCBNK-T',
      raw_text: 'IMPS payment of Rs. 2,97,627 from A/c xx2222 done on 18-Aug-26 to TEST USER is successful (Ref ID: 624253159132). Not you? Call 08048329999 - slice',
    });
    const c = credit({
      amount: 297627,
      timestamp: T + 20_000,
      raw_text: 'Your account XXXXXXX1111 is credited by Rs.297627 on 18-08-26 received from account XXXXXXX2222/TEST USER (IMPS Ref no. 624253159132). Call 18602677777 to report issue-Bank',
    });
    const pairs = findTransferPairs([d, c], [d, c], identity);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ confidence: 'high', basis: 'ref' });
  });
});
