// Regression tests built from REAL full-length bank SMS, including footers.
//
// Every existing categorize test passed a clean merchant with a minimal body
// ("Rs.850 debited"), which is precisely why whole-body keyword matching
// shipped: no test ever exercised a message with bank boilerplate in it. Each
// case below is a defect that was live in the app.

import { parseTransaction } from '../parser';
import { categorize } from '../categories';

const noRules = {};

/** Parse + categorize exactly as sync.ts does, so these cover the real path. */
function classify(body: string, sender = 'HDFCBK') {
  const parsed = parseTransaction(sender, body, 1_700_000_000_000);
  if (!parsed) {
    return null;
  }
  return {
    amount: parsed.amount,
    isExpense: parsed.isExpense,
    merchant: parsed.merchant,
    counterparty: parsed.counterparty,
    category: categorize(
      parsed.merchant,
      body,
      parsed.counterparty,
      noRules,
      parsed.isExpense,
    ),
  };
}

describe('SMS regressions — direction', () => {
  it('does NOT invert a purchase that mentions a partial refund', () => {
    // Was stored as ₹2499 of INCOME: the refund keyword won unconditionally
    // while AMOUNT_RE took the first amount. A ~₹5000 swing from one message.
    const r = classify(
      'Rs.2499.00 debited at AMAZON on 01-Jul. Your refund of Rs.300 has been credited to A/c XX1234',
    )!;
    expect(r.isExpense).toBe(true);
    expect(r.amount).toBe(2499);
  });

  it('still treats a pure refund message as income', () => {
    const r = classify(
      'Refund of Rs.500.00 has been credited to your A/c XX1234 on 05-Jul-26',
    )!;
    expect(r.isExpense).toBe(false);
    expect(r.amount).toBe(500);
  });

  it('keeps a debit-and-credit-to-merchant message as an expense', () => {
    const r = classify(
      'Rs.500.00 has been debited from your A/c XX1234 and credited to SWIGGY on 12-Jul-26',
    )!;
    expect(r.isExpense).toBe(true);
  });
});

describe('SMS regressions — categorization', () => {
  it('files an Uber Eats order as Food, not as a ride', () => {
    // Counting food delivery as a ride silently corrupted the Uber screen's
    // ride count and per-ride averages.
    expect(
      classify('Rs.480.00 debited from A/c XX1234 on 12-Jul-26 to UBER EATS INDIA')!
        .category,
    ).toBe('Food');
  });

  it('still files a genuine Uber ride as Uber', () => {
    expect(
      classify('Rs.360.00 debited from A/c XX1234 to UBER INDIA SYSTEMS on 12-Jul-26')!
        .category,
    ).toBe('Uber');
  });

  it('does not let a credit-card-bill footer outrank the merchant', () => {
    expect(
      classify('Rs.600.00 spent at Barbeque Nation. Your credit card bill is due on 20-Jul')!
        .category,
    ).not.toBe('Bills');
  });

  it('files a pharmacy "bill payment" as Health, not Bills', () => {
    expect(
      classify('Rs.850.00 debited for bill payment at Apollo Pharmacy on 12-Jul-26')!
        .category,
    ).toBe('Health');
  });

  it('does not force UPI just because a support email is in the footer', () => {
    expect(
      classify('Rs.1200.00 spent at LIFESTYLE STORES using card XX9012. Dispute? care@hdfcbank.com')!
        .category,
    ).not.toBe('UPI');
  });

  it('still categorizes a real UPI payment as UPI', () => {
    expect(
      classify('Rs.320.00 debited from A/c XX5678 to friend@okhdfcbank UPI Ref 4512')!
        .category,
    ).toBe('UPI');
  });
});

describe('SMS regressions — counterparty and merchant extraction', () => {
  it('does not mistake a bank support email for a counterparty', () => {
    // The old VPA regex backtracked to "care@hdfcban". Because merchant rules
    // prefer counterparty, "apply to all" on such a row wrote a rule matching
    // EVERY message from that bank.
    const r = classify(
      'Rs.1200.00 spent at LIFESTYLE STORES using card XX9012. Dispute? care@hdfcbank.com',
    )!;
    expect(r.counterparty).toBeNull();
  });

  it('keeps a dotted VPA intact', () => {
    const r = classify(
      'Rs.120.00 credited to A/c XX1234 from friend.user@okhdfcbank on 12-Jul-26',
    )!;
    expect(r.counterparty).toBe('friend.user@okhdfcbank');
  });

  it('does not capture an instruction clause as a merchant', () => {
    const r = classify(
      'Rs.780.00 debited from A/c XX1234. Not you? Call 18002586161 to report fraud immediately',
    )!;
    expect(r.merchant).toBeNull();
  });
});

describe('SMS regressions — credit categorization', () => {
  it('files a friend\'s UPI payback as Friend Transfer, not generic Income', () => {
    // Every credit used to collapse to 'Income', which made the Uber screen's
    // `category !== 'Uber'` filter exclude nothing at all.
    expect(
      classify('Rs.120.00 credited to A/c XX1234 from friend.user@okhdfcbank on 12-Jul-26')!
        .category,
    ).toBe('Friend Transfer');
  });

  it('still files salary as Income', () => {
    expect(
      classify('INR 45000.00 credited to A/c XX1234 on 01-Jul-26 by ACME PVT LTD SALARY')!
        .category,
    ).toBe('Income');
  });
});
