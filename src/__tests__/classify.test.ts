import { isSelfTransfer } from '../identity';
import type { Identity } from '../identity';
import { classify, isFamilyMember } from '../classify';
import { parseTransaction } from '../parser';
import { categorize, isGenericMerchantKey, CATEGORIES, CATEGORY_META, GROUP_OF } from '../categories';
import type { Category } from '../categories';

const identity: Identity = {
  name: 'Mr Anita Priya Rao',
  phones: ['9000000001'],
  upiHandles: ['anita@okaxis'],
  accountLast4: ['1111'],
};
const none: Identity = { name: '', phones: [], upiHandles: [], accountLast4: [] };

describe('isSelfTransfer: name matching', () => {
  const self = (merchant: string | null, id = identity) =>
    isSelfTransfer({ merchant, counterparty: null }, id);

  it('matches the full name, truncated surname and middle-name differences', () => {
    expect(self('ANITA RAO')).toBe(true);
    expect(self('Anita P Rao')).toBe(true);
    expect(self('ANITA PRIYA RAO')).toBe(true);
    expect(self('Ms. Anita Rao')).toBe(true);
    expect(self('ANITA RAOS')).toBe(true); // surname prefix-compatible (>=3 chars)
  });

  it('never matches a parent who shares the surname and middle name', () => {
    expect(self('KIRAN PRIYA RAO')).toBe(false);
    expect(self('SONA PRIYA RAO')).toBe(false);
  });

  it('never matches on surname alone or on initials', () => {
    expect(self('RAO')).toBe(false);
    expect(self('A P RAO')).toBe(false);
    expect(self('Anita')).toBe(false);
    expect(self('ANITA R')).toBe(false); // surname fragment under 3 chars
  });

  it('empty name never matches', () => {
    expect(self('ANITA RAO', none)).toBe(false);
  });
});

describe('isSelfTransfer: VPAs', () => {
  const cp = (counterparty: string, id = identity) =>
    isSelfTransfer({ merchant: null, counterparty }, id);

  it('masked VPA matches the last 4 digits of an own phone', () => {
    expect(cp('*0001@slc')).toBe(true);
    expect(cp('xx0001@okbank')).toBe(true);
    expect(cp('xx9999@slc')).toBe(false);
  });

  it('phone as the local part matches regardless of provider', () => {
    expect(cp('9000000001@fam')).toBe(true);
    expect(cp('9000000002@fam')).toBe(false);
  });

  it('existing exact handle / phone / account rules still hold', () => {
    expect(cp('ANITA@okaxis')).toBe(true);
    expect(cp('9000000001')).toBe(true);
    expect(cp('1111')).toBe(true);
    expect(cp('2222')).toBe(false);
  });
});

describe('isFamilyMember', () => {
  const family = ['Sona Priya Rao', 'kiran@okaxis'];
  it('matches by letters-only containment', () => {
    expect(isFamilyMember({ merchant: 'SONA PRIYA RAO', counterparty: null }, family)).toBe(true);
    expect(isFamilyMember({ merchant: null, counterparty: 'kiran@okaxis' }, family)).toBe(true);
  });
  it('matches a bank-truncated name (candidate >= 8 letters, entry startsWith it)', () => {
    expect(isFamilyMember({ merchant: 'SONA PRIYA RA..', counterparty: null }, family)).toBe(true);
    expect(isFamilyMember({ merchant: 'SONA PR', counterparty: null }, family)).toBe(false);
  });
  it('does not match strangers or an empty list', () => {
    expect(isFamilyMember({ merchant: 'Cafe Moon', counterparty: null }, family)).toBe(false);
    expect(isFamilyMember({ merchant: 'SONA PRIYA RAO', counterparty: null }, [])).toBe(false);
  });
});

describe('classify', () => {
  const ctx = { identity, rules: {}, family: ['Sona Priya Rao'] };
  const parse = (body: string) => parseTransaction('VM-TEST-S', body, 1)!;

  it('card bills, wallet loads and own-bank payees are type self', () => {
    expect(classify(parse('Your slice UPI credit card bill of Rs. 812.16 has been paid successfully via autopay.'), ctx).type).toBe('self');
    expect(classify(parse('Rs. 500 sent from a/c xx1111 on 03-Oct-26 to Amazon Pay (UPI Ref: 628474453305).'), ctx).type).toBe('self');
    expect(classify(parse('Rs. 10,500 sent from a/c xx1111 on 04-Oct-26 to Kotak Mahindra Bank Ltd (UPI Ref: 1).'), ctx).type).toBe('self');
  });

  it('a credit from the user\'s own name is self, even if the family list overlaps', () => {
    const r = classify(
      parse('Your account XXXXXXX1111 is credited by Rs.5000 on 18-08-26 received from account XXXXXXX2222/ANITA RAO (IMPS Ref no. 1).'),
      { ...ctx, family: ['Anita Rao'] },
    );
    expect(r.type).toBe('self');
  });

  it('a credit from a family member is Family income', () => {
    const r = classify(
      parse('Your account XXXXXXX1111 is credited by Rs.5000 on 18-08-26 received from account XXXXXXX2222/SONA PRIYA RAO (IMPS Ref no. 1).'),
      ctx,
    );
    expect(r).toEqual({ category: 'Family', type: 'income' });
  });

  it('an IPO allotment debit is an Investment expense', () => {
    const r = classify(
      parse('Rs. 14,905 has been debited from your slice savings account xx1111 towards ACME FIRE PROTECT LIMITED (Ref No 1). Not you? Call 08048329999 - slice'),
      ctx,
    );
    expect(r).toEqual({ category: 'Investment', type: 'expense' });
  });

  it('ordinary spend falls through to categorize()', () => {
    const r = classify(
      parse('Your slice credit card transaction of Rs. 280 on Swiggy is successful. If not you, call 08048329999 - slice'),
      ctx,
    );
    expect(r).toEqual({ category: 'Food', type: 'expense' });
  });
});

describe('classify: friends', () => {
  const friends = ['Testa Ajay Samplekar', '9988776118@ibl'];
  const ctx = { identity, rules: {}, family: ['Sona Priya Rao'], friends };
  const parse = (body: string) => parseTransaction('VM-TEST-S', body, 1)!;

  it('a payment to a friend is Friend Transfer, still an expense', () => {
    const r = classify(
      parse('Rs. 1,200 sent from a/c xx9999 on 03-Oct-26 to TESTA AJAY SAMPLEKAR (UPI Ref: 628474453305).'),
      ctx,
    );
    expect(r).toEqual({ category: 'Friend Transfer', type: 'expense' });
  });

  it('a credit from a friend is Friend Transfer, still income', () => {
    const r = classify(
      parse('Your account XXXXXXX9999 is credited by Rs.700 on 18-08-26 received from account XXXXXXX2222/TESTA AJAY SAMPLEKAR (IMPS Ref no. 1).'),
      ctx,
    );
    expect(r).toEqual({ category: 'Friend Transfer', type: 'income' });
  });

  it('precedence: self beats family beats friend', () => {
    const credit = (who: string) =>
      parse(`Your account XXXXXXX1111 is credited by Rs.5000 on 18-08-26 received from account XXXXXXX2222/${who} (IMPS Ref no. 1).`);
    expect(classify(credit('ANITA RAO'), { ...ctx, friends: ['Anita Rao'] }).type).toBe('self');
    expect(classify(credit('SONA PRIYA RAO'), { ...ctx, friends: ['Sona Priya Rao'] }).category).toBe('Family');
  });

  it('a friend phone VPA matches that handle only, not every @ibl handle', () => {
    expect(isFamilyMember({ merchant: null, counterparty: '9988776118@ibl' }, friends)).toBe(true);
    expect(isFamilyMember({ merchant: null, counterparty: '9000000000@ibl' }, friends)).toBe(false);
    expect(isFamilyMember({ merchant: null, counterparty: 'other@ibl' }, friends)).toBe(false);
  });

  it('no friends list leaves classification unchanged', () => {
    const body = 'Rs. 1,200 sent from a/c xx9999 on 03-Oct-26 to TESTA AJAY SAMPLEKAR (UPI Ref: 628474453305).';
    expect(classify(parse(body), { identity, rules: {}, family: [] }).category).not.toBe('Friend Transfer');
  });
});

describe('classify: own-account IMPS', () => {
  const ctx = { identity, rules: {}, family: [] as string[] };
  const parse = (body: string) => parseTransaction('VM-TEST-S', body, 1)!;
  it('IMPS "To A/c" with an own account fragment is self', () => {
    expect(classify(parse('Rs. 100 debited from a/c xx2222 IMPS To A/c xxxxxxxx1111 Ref 1'), ctx).type).toBe('self');
  });
  it('"and account X/NAME will be credited" with an own account is self', () => {
    expect(classify(parse('Your account XXXXXXX2222 debited with Rs. 8103 on 01-12-25 and account XXXXXXX1111/SOME ONE will be credited.(IMPS Ref no. 1)'), ctx).type).toBe('self');
  });
  it('a broker IMPS credit is Investment and an FD/credit-transfer is self', () => {
    expect(classify(parse('Received! INR 45,000.00 in HDFC Bank A/c xx2222 On 25-09-25 For IMPS -GROWW INVEST TECH PR- 529240802077 Avl bal INR 1.00'), ctx))
      .toEqual({ category: 'Investment', type: 'income' });
    expect(classify(parse('IndusInd A/C **2222 Debited; INR 100,000.00 Ref-Transfer/Debit for FD A/c 379358580202 : Bal INR 5.00'), ctx).type).toBe('self');
  });
});

describe('Family category wiring', () => {
  it('is registered as income and has display metadata', () => {
    expect(CATEGORIES).toContain('Family');
    expect(CATEGORY_META.Family.icon).toBe('home');
    expect(GROUP_OF.Family).toBe('Income');
  });
});

describe('brand coverage', () => {
  const cat = (m: string): Category => categorize(m, '', null, {}, true);
  it.each([
    ['McDonalds', 'Food'], ['Mc Donalds', 'Food'], ['Taco Bell', 'Food'], ['Popeyes', 'Food'],
    ['Jubilant Foodworks Ltd', 'Food'], ['Eternal Limited', 'Food'], ['District Dining', 'Food'],
    ['Dineout', 'Food'], ['Shree Sweets', 'Food'], ['Fresh Juice Centre', 'Food'],
    ['Blink Commerce Pvt Ltd', 'Groceries'], ['Raj General Store', 'Groceries'],
    ['Sharma Kirana', 'Groceries'], ['Daily Mart', 'Groceries'],
    ['Roppen Transportation Services', 'Transport'], ['Indian Railways', 'Transport'],
    ['UTS', 'Transport'], ['Delhi Metro', 'Transport'],
    ['City Chemist', 'Health'], ['MF Utilities India Pvt Ltd', 'Investment'],
    ['Jumbo King', 'Food'], ['Urban Meals Pvt', 'Food'], ['Darjeeling Momos', 'Food'],
    ['Rapsap', 'Groceries'], ['Cityflo', 'Transport'], ['District Movies', 'Entertainment'],
    ['ReliancejIO', 'Bills'], ['MyJio', 'Bills'],
    ['swiggy.com', 'Food'], ['Zomatocom', 'Food'],
  ])('%s -> %s', (m, c) => {
    expect(cat(m)).toBe(c);
  });
  it('does not match inside longer words', () => {
    expect(cat('Walmartx Smartphones')).toBe('Other');
  });
});

describe('isGenericMerchantKey: helplines', () => {
  it.each(['7308080808', '8048329999', '18002586161', '18602677777', '08048329999'])('%s is generic', k => {
    expect(isGenericMerchantKey(k)).toBe(true);
  });
  it('a real phone number or VPA is not', () => {
    expect(isGenericMerchantKey('9000000002')).toBe(false);
    expect(isGenericMerchantKey('shop@okaxis')).toBe(false);
  });
});
