import {
  categorize,
  isGenericMerchantKey,
  normalizeMerchantKey,
  CATEGORIES,
  CATEGORY_META,
  type Category,
} from '../categories';

// ─── CATEGORIES array & CATEGORY_META ────────────────────────────────────────

describe('CATEGORIES', () => {
  it('includes all expected category values', () => {
    const expected: Category[] = [
      'Food', 'Groceries', 'Transport', 'Shopping', 'Bills',
      'Entertainment', 'Health', 'UPI', 'Cash', 'Income',
      'Friend Transfer', 'Loan/Dues', 'Other',
    ];
    for (const cat of expected) {
      expect(CATEGORIES).toContain(cat);
    }
  });

  it('has metadata for every category', () => {
    for (const cat of CATEGORIES) {
      expect(CATEGORY_META[cat]).toBeDefined();
      expect(typeof CATEGORY_META[cat].color).toBe('string');
      expect(CATEGORY_META[cat].color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(typeof CATEGORY_META[cat].icon).toBe('string');
    }
  });
});

// ─── normalizeMerchantKey ─────────────────────────────────────────────────────

describe('normalizeMerchantKey', () => {
  it('lowercases and trims merchant', () => {
    expect(normalizeMerchantKey('  Swiggy  ', null)).toBe('swiggy');
  });

  it('collapses multiple spaces', () => {
    // The spec says "collapse spaces" — multiple spaces become one.
    expect(normalizeMerchantKey('Big  Basket', null)).toBe('big basket');
    expect(normalizeMerchantKey('Big   Basket', null)).toBe('big basket');
  });

  it('prefers counterparty over merchant when both present', () => {
    expect(normalizeMerchantKey('Swiggy', 'merchant@oksbi')).toBe('merchant@oksbi');
  });

  it('falls back to merchant when counterparty is null', () => {
    expect(normalizeMerchantKey('Amazon', null)).toBe('amazon');
  });

  it('returns null when both are null', () => {
    expect(normalizeMerchantKey(null, null)).toBeNull();
  });

  it('returns null when both are empty strings', () => {
    expect(normalizeMerchantKey('', '')).toBeNull();
  });
});

// ─── isGenericMerchantKey ─────────────────────────────────────────────────────

describe('isGenericMerchantKey', () => {
  it('flags bare 1-5 digit keys as generic', () => {
    expect(isGenericMerchantKey('1234')).toBe(true);
    expect(isGenericMerchantKey('5678')).toBe(true);
    expect(isGenericMerchantKey('9')).toBe(true);
    expect(isGenericMerchantKey('12345')).toBe(true);
  });

  it('does not flag a 10-digit phone number', () => {
    expect(isGenericMerchantKey('9876543210')).toBe(false);
  });

  it('does not flag a VPA', () => {
    expect(isGenericMerchantKey('user123@ybl')).toBe(false);
  });

  it('does not flag a merchant name', () => {
    expect(isGenericMerchantKey('swiggy')).toBe(false);
  });
});

// ─── categorize: keyword rules ────────────────────────────────────────────────

describe('categorize — keyword matching', () => {
  const noRules = undefined;

  it('categorizes Swiggy → Food', () => {
    expect(categorize('Swiggy', 'Rs.200 debited at Swiggy', null, noRules)).toBe('Food');
  });

  it('categorizes Zomato → Food', () => {
    expect(categorize('Zomato', 'Rs.300 sent to Zomato', null, noRules)).toBe('Food');
  });

  it('categorizes BigBasket → Groceries', () => {
    expect(categorize('BigBasket', 'Rs.800 debited at BigBasket', null, noRules)).toBe('Groceries');
  });

  it('categorizes Blinkit → Groceries', () => {
    expect(categorize('Blinkit', 'Rs.500 debited at Blinkit', null, noRules)).toBe('Groceries');
  });

  it('categorizes Zepto → Groceries', () => {
    expect(categorize(null, 'Rs.400 debited via Zepto delivery', null, noRules)).toBe('Groceries');
  });

  it('categorizes Jiomart → Groceries', () => {
    expect(categorize('JioMart', 'Rs.1200 debited at JioMart', null, noRules)).toBe('Groceries');
  });

  it('categorizes Uber → Uber (not Transport)', () => {
    expect(categorize('Uber', 'Rs.150 spent on Uber ride', null, noRules)).toBe('Uber');
  });

  it('categorizes Ola → Transport', () => {
    expect(categorize('Ola', 'Rs.150 spent on Ola ride', null, noRules)).toBe('Transport');
  });

  it('categorizes Amazon → Shopping', () => {
    expect(categorize('Amazon', 'Rs.999 debited for Amazon order', null, noRules)).toBe('Shopping');
  });

  it('categorizes Netflix → Entertainment', () => {
    expect(categorize('Netflix', 'Rs.499 debited for Netflix subscription', null, noRules)).toBe('Entertainment');
  });

  it('categorizes Spotify → Entertainment', () => {
    expect(categorize(null, 'Rs.119 debited for Spotify', null, noRules)).toBe('Entertainment');
  });

  it('categorizes Hotstar → Entertainment', () => {
    expect(categorize('Hotstar', 'Rs.299 paid for Hotstar', null, noRules)).toBe('Entertainment');
  });

  it('categorizes BookMyShow → Entertainment', () => {
    expect(categorize(null, 'Rs.600 debited at bookmyshow for movie tickets', null, noRules)).toBe('Entertainment');
  });

  it('categorizes Apollo Pharmacy → Health', () => {
    expect(categorize('Apollo Pharmacy', 'Rs.350 debited at Apollo Pharmacy', null, noRules)).toBe('Health');
  });

  it('categorizes 1mg → Health', () => {
    expect(categorize('1mg', 'Rs.200 spent at 1mg', null, noRules)).toBe('Health');
  });

  it('categorizes Pharmeasy → Health', () => {
    expect(categorize(null, 'Rs.400 debited for pharmeasy order', null, noRules)).toBe('Health');
  });

  it('categorizes UPI transfer (@ in body) → UPI', () => {
    expect(categorize(null, 'Rs.500 sent via UPI to user@oksbi', 'user@oksbi', noRules)).toBe('UPI');
  });

  it('categorizes ATM withdrawal → Cash', () => {
    expect(categorize(null, 'Rs.5000 withdrawn at ATM', null, noRules)).toBe('Cash');
  });

  it('defaults to Other for unknown merchant', () => {
    expect(categorize('UnknownShop', 'Rs.100 debited at UnknownShop', null, noRules)).toBe('Other');
  });
});

// ─── categorize: word-boundary matching (regression for substring false positives) ──

describe('categorize — word-boundary matching', () => {
  const noRules = undefined;

  it('does not match "uber" inside "suburban"', () => {
    const result = categorize(null, 'Rs.3000 debited from A/c XX1234 to suburban co-op society', null, noRules);
    expect(result).not.toBe('Uber');
  });

  it('still matches a real Uber ride', () => {
    expect(categorize('Uber', 'Rs.150 spent on Uber ride', null, noRules)).toBe('Uber');
  });

  it('does not match "emi" inside "premium"', () => {
    const result = categorize(null, 'Rs.500 debited for premium membership renewal', null, noRules);
    expect(result).not.toBe('Bills');
  });

  it('does not match "bus" inside "business"', () => {
    const result = categorize(null, 'Rs.1000 debited for business services payment', null, noRules);
    expect(result).not.toBe('Transport');
  });

  it('still matches a real EMI message', () => {
    expect(categorize(null, 'Rs.2500 debited towards EMI payment', null, noRules)).toBe('Bills');
  });

  it('still matches "@" for UPI even though it has no word boundaries', () => {
    expect(categorize(null, 'Rs.500 sent via UPI to user@oksbi', 'user@oksbi', noRules)).toBe('UPI');
  });
});

// ─── categorize: learnedRules override ───────────────────────────────────────

describe('categorize — learnedRules override', () => {
  it('learned rule overrides keyword match', () => {
    // "swiggy" would normally → Food, but if the user reclassified it → Bills
    const rules: Record<string, string> = { swiggy: 'Bills' };
    const result = categorize('Swiggy', 'Rs.200 debited at Swiggy', null, rules);
    expect(result).toBe('Bills');
  });

  it('learned rule from counterparty key wins over keyword', () => {
    const rules: Record<string, string> = { 'merchant@oksbi': 'Shopping' };
    const result = categorize('SomeStore', 'Rs.100 debited', 'merchant@oksbi', rules);
    expect(result).toBe('Shopping');
  });

  it('falls through to keyword if learned key not found', () => {
    const rules: Record<string, string> = { 'other@vpa': 'Food' };
    const result = categorize('Uber', 'Rs.150 spent on Uber', null, rules);
    expect(result).toBe('Uber');
  });

  it('ignores learned rule with invalid category value', () => {
    const rules: Record<string, string> = { swiggy: 'INVALID_CATEGORY' };
    const result = categorize('Swiggy', 'Rs.200 debited at Swiggy', null, rules);
    // Should fall through to keyword match → Food
    expect(result).toBe('Food');
  });

  it('empty learnedRules falls through to keyword map', () => {
    const rules: Record<string, string> = {};
    expect(categorize('Zomato', 'Rs.250 debited', null, rules)).toBe('Food');
  });

  it('ignores an already-poisoned generic numeric learned rule and falls through to keywords', () => {
    // Simulates a rule keyed on the user's own account fragment (e.g. "1234")
    // mapped to Uber from a past mis-edit — should never override categorization.
    const rules: Record<string, string> = { '1234': 'Uber' };
    const result = categorize(null, 'Rs.3000 debited from A/c XX1234 to ICCL - Mutual Funds', '1234', rules);
    expect(result).not.toBe('Uber');
  });
});
