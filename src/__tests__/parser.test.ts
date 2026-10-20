import { parseTransaction } from '../parser';

describe('parseTransaction', () => {
  // ── 1. HDFC debit SMS ────────────────────────────────────────────────────
  it('parses HDFC debit SMS → isExpense true, amount 499, merchant contains SWIGGY', () => {
    const body =
      'Rs.499.00 debited from your HDFC Bank account ending 1234 at SWIGGY on 27-Jun-26. Avl Bal: Rs.5,000.00';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(true);
    expect(result!.amount).toBe(499);
    expect(result!.merchant).not.toBeNull();
    expect(result!.merchant!.toUpperCase()).toContain('SWIGGY');
    // No category field in ParsedTransaction anymore — categorization is in sync.ts
    expect(result!.source).toBe('HDFCBK');
    expect(result!.timestamp).toBe(1719500000000);
    expect(result!.raw_text).toBe(body);
  });

  // ── 2. ICICI credit SMS ──────────────────────────────────────────────────
  it('parses ICICI credit SMS → isExpense false (income), NOT null', () => {
    const body =
      'INR 2,000.00 credited to your ICICI Bank account ending 5678. Refund from AMAZON.';
    const result = parseTransaction('ICICIB', body, 1719600000000);

    // Income is now returned (isExpense: false), not discarded as null
    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(false);
    expect(result!.amount).toBe(2000);
    expect(result!.source).toBe('ICICIB');
  });

  // ── 3. UPI sent SMS ──────────────────────────────────────────────────────
  it('parses UPI sent SMS → isExpense true, counterparty is VPA', () => {
    const body =
      'Rs.150 sent via UPI to merchant@oksbi. Ref: 987654321. Your A/c XX9012 debited.';
    const result = parseTransaction('SBIBNK', body, 1719700000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(true);
    expect(result!.amount).toBe(150);
    // VPA extracted as counterparty
    expect(result!.counterparty).toBe('merchant@oksbi');
  });

  // ── 4. Non-transaction SMS (OTP) ─────────────────────────────────────────
  it('returns null for a non-transaction SMS (OTP message)', () => {
    const body = 'Your OTP is 123456. Do not share it with anyone.';
    const result = parseTransaction('AD-BANKX', body, 1719800000000);

    expect(result).toBeNull();
  });

  // ── 5. Empty body ────────────────────────────────────────────────────────
  it('returns null for an empty body', () => {
    expect(parseTransaction('SENDER', '', Date.now())).toBeNull();
    expect(parseTransaction('SENDER', '   ', Date.now())).toBeNull();
  });

  // ── 6. Amount with commas (Indian numbering) ─────────────────────────────
  it('parses comma-separated Indian amount: INR 1,25,000 → 125000', () => {
    const body = 'INR 1,25,000 spent at BigBasket on 28-Jun-26.';
    const result = parseTransaction('KOTAK', body, 1719900000000);

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(125000);
    expect(result!.isExpense).toBe(true);
  });

  // ── 7. Null body guard ───────────────────────────────────────────────────
  it('returns null when body is null-ish (cast)', () => {
    const result = parseTransaction(
      'SENDER',
      null as unknown as string,
      Date.now(),
    );
    expect(result).toBeNull();
  });

  // ── 8. No direction keyword → null ───────────────────────────────────────
  it('returns null when amount is present but no direction keyword', () => {
    const body = 'Your account balance is Rs.5000.';
    const result = parseTransaction('BANKX', body, Date.now());
    expect(result).toBeNull();
  });

  // ── 9. ₹ symbol amount ───────────────────────────────────────────────────
  it('parses ₹ symbol amount correctly', () => {
    const body = '₹250.00 debited from your account at Dominos.';
    const result = parseTransaction('AXISBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(250);
    expect(result!.isExpense).toBe(true);
  });

  // ── 10. Counterparty: VPA extraction ─────────────────────────────────────
  it('extracts UPI VPA as counterparty', () => {
    const body = 'Rs.500 debited via UPI to user123@ybl. Txn ID: 112233.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.counterparty).toBe('user123@ybl');
  });

  // ── 11. Counterparty: 10-digit phone ─────────────────────────────────────
  it('extracts 10-digit phone as counterparty when no VPA present', () => {
    const body = 'Rs.200 sent to 9876543210. Your account debited.';
    const result = parseTransaction('SBIBNK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.counterparty).toBe('9876543210');
  });

  // ── 12. Counterparty: account fragment ────────────────────────────────────
  it('extracts account fragment as counterparty when no VPA or phone', () => {
    const body = 'Rs.1000 debited. Transfer to a/c 5678 processed.';
    const result = parseTransaction('KOTAKB', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.counterparty).toBe('5678');
  });

  // ── 13. User own account hint ─────────────────────────────────────────────
  it('extracts user account hint (last 4 digits) from "A/c XX1234"', () => {
    const body =
      'Rs.750 debited. Your A/c XX1234 has been debited for NETFLIX.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.account).toBe('1234');
  });

  // ── 13b. Own account is never mistaken for counterparty ───────────────────
  it('does not capture own account as counterparty when there is no to/from a/c clause', () => {
    const body =
      'Rs.750 debited. Your A/c XX1234 has been debited for NETFLIX.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.counterparty).toBeNull();
  });

  it('does not capture own account as counterparty for "debited from A/c XX1234 to ICCL"', () => {
    const body = 'Rs.3000 debited from A/c XX1234 to ICCL - Mutual Funds.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.account).toBe('1234');
    expect(result!.counterparty).toBeNull();
  });

  it('extracts a genuine counterparty account fragment on income: "credited from a/c 5678"', () => {
    const body = 'Rs.2000 credited from a/c 5678 to your account.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(false);
    expect(result!.counterparty).toBe('5678');
  });

  // ── 14. "withdrawn" keyword → expense ────────────────────────────────────
  it('"withdrawn" keyword is treated as an expense direction', () => {
    const body = 'Rs.5000.00 withdrawn at ATM. A/c XX9012 debited.';
    const result = parseTransaction('AXISBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(true);
    expect(result!.amount).toBe(5000);
  });

  // ── 15. "w/d" keyword → expense ──────────────────────────────────────────
  it('"w/d" keyword is treated as an expense direction', () => {
    const body = 'INR 2000 w/d from your account ending 4321.';
    const result = parseTransaction('ICICIB', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(true);
  });

  // ── 16. No category field on result ──────────────────────────────────────
  it('result does not have a category field', () => {
    const body = 'Rs.100 debited at Cafe Coffee Day.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect((result as unknown as Record<string, unknown>).category).toBeUndefined();
  });

  // ── 17. Refund-as-income even though "debited" also appears ─────────────
  it('a refund message is income even when it mentions the original debit', () => {
    const body =
      'Refund of Rs.500 credited to your account. Originally debited on 20-Jun-26 for a cancelled order.';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(false);
    expect(result!.amount).toBe(500);
  });

  // ── 18. Promo "will be credited" is not a transaction ────────────────────
  it('returns null for a promo "will be credited" message', () => {
    const body = 'Rs.100 will be credited on your first payment. T&C apply.';
    expect(parseTransaction('PROMO', body, Date.now())).toBeNull();
  });

  // ── 19. Future-dated autopay "will be debited" is not a transaction ──────
  it('returns null for a future-dated autopay "will be debited" message', () => {
    const body = 'Rs.5000 will be debited on 01-Jul towards your EMI.';
    expect(parseTransaction('BANKX', body, Date.now())).toBeNull();
  });

  // ── 20. Failed payment is not a transaction ───────────────────────────────
  it('returns null for a failed payment message', () => {
    const body = 'Rs.2000 could not be debited from your account due to insufficient balance.';
    expect(parseTransaction('BANKX', body, Date.now())).toBeNull();
  });

  // ── 21. ₹0 "transaction" is rejected ──────────────────────────────────────
  it('returns null for a Rs.0.00 failed-auth message', () => {
    const body = 'Rs.0.00 debited for authorization. Your card is now verified.';
    expect(parseTransaction('BANKX', body, Date.now())).toBeNull();
  });

  // ── 22. Lakh magnitude suffix ──────────────────────────────────────────────
  it('parses "₹1.5 Lakh" as 150000', () => {
    const body = '₹1.5 Lakh credited to your account via NEFT.';
    const result = parseTransaction('HDFCBK', body, Date.now());

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(150000);
  });

  // ── 23. Crore magnitude suffix ─────────────────────────────────────────────
  it('parses "Rs.2 Crore" as 20000000', () => {
    const body = 'Rs.2 Crore debited from your account towards property purchase.';
    const result = parseTransaction('HDFCBK', body, Date.now());

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(20000000);
  });

  // ── 24. 12-digit reference number is not mistaken for a phone ────────────
  it('does not extract a phone counterparty from inside a 12-digit reference number', () => {
    const body = 'Rs.300 debited. Ref No 789876543210. Txn successful.';
    const result = parseTransaction('HDFCBK', body, Date.now());

    expect(result).not.toBeNull();
    expect(result!.counterparty).not.toBe('9876543210');
    expect(result!.counterparty).not.toBe('7898765432');
  });

  // ── 25. Support email is not mistaken for a UPI VPA ───────────────────────
  it('does not extract a support email as a UPI VPA counterparty', () => {
    const body = 'Rs.400 debited. For queries contact care@hdfcbank.com.';
    const result = parseTransaction('HDFCBK', body, Date.now());

    expect(result).not.toBeNull();
    // Asserting `not.toBe('care@hdfcbank')` passed vacuously: the regex
    // actually returned the truncated 'care@hdfcban', so the email WAS being
    // stored as a counterparty. Assert the real requirement instead.
    expect(result!.counterparty).toBeNull();
  });

  // ── 26. "credited to your account" is not captured as the merchant ───────
  it('does not capture "your account" as the merchant', () => {
    const body = 'Rs.600 credited to your account from AMAZON refund.';
    const result = parseTransaction('HDFCBK', body, Date.now());

    expect(result).not.toBeNull();
    expect(result!.merchant?.toLowerCase()).not.toContain('your account');
  });

  // ── 27. A truncated time doesn't swallow the real merchant clause ────────
  it('captures the merchant after a time expression, not the time itself', () => {
    const body = 'Rs.350 spent at 10:30 at SWIGGY on 01-Jul-26.';
    const result = parseTransaction('HDFCBK', body, Date.now());

    expect(result).not.toBeNull();
    expect(result!.merchant).not.toBe('10');
    expect(result!.merchant!.toUpperCase()).toContain('SWIGGY');
  });

  // ── Corpus-audit regressions ─────────────────────────────────────────────
  it('ignores the user own outgoing money request', () => {
    const body = 'Hi Test, your request for Rs.500.00 through user@idfcbank has been sent to friend@okhdfcbank using your UPI app. We will keep you updated on this. Team IDFC FIRST Bank';
    expect(parseTransaction('JX-IDFCFB', body, Date.now())).toBeNull();
  });

  it('ignores sign-up bonus promos and bill-due reminders', () => {
    expect(parseTransaction('AD-APP', 'Dear, Rs.1500 Welcome Bonus credited to ABC account. IND vs PAK T20 Match. Prize Pool - Rs.2,57,00,000', Date.now())).toBeNull();
    expect(
      parseTransaction('ViCARE', 'Hi! Your Jul bill for Vi Postpaid no. 98XXXX10 has been sent to your registered email ID - a@b.com. Due date is 10 days from the bill date. Please pay your due amount, Rs 588.82 by the due date 07/08', Date.now()),
    ).toBeNull();
  });

  it('treats card-bill payment confirmations as card_bill, not income', () => {
    const a = parseTransaction('AD-UTKSPR-S', 'We have received payment of INR 103.95 for your SuperCard ending 1234. Your available limit is now INR 15,300.00 -Utkarsh SFBL', Date.now());
    expect(a).toMatchObject({ amount: 103.95, isExpense: false, kind: 'card_bill' });
    const b = parseTransaction('VM-KOTAKB-S', 'Hi! Payment of INR 130 received towards Kotak Bank Credit Card x1234 via auto-debit on 10-Mar-2026 and will be posted to your card account by end of day.', Date.now());
    expect(b).toMatchObject({ amount: 130, isExpense: false, kind: 'card_bill' });
  });

  it('does not keep the trailing "using your ... UPI" clause in the merchant', () => {
    const r = parseTransaction('VM-IDFCFB', 'Hi, you have sent Rs.35.00 from user@idfcbank to shop@paytm using your IDFC FIRST Bank UPI.Txn ID-304834505695.', Date.now());
    expect(r!.merchant).toBe('shop@paytm');
  });

  it('takes the payee after "towards" in an MF Utilities debit', () => {
    const r = parseTransaction('VM-HDFCBK-S', 'INR 2500.00 debited to HDFC Bank A/C No XXXXXXXXXX1234 towards MF Utilities India Pvt Ltd / 17210233051171D04B95  with UMRN HDFC7011507246002816', Date.now());
    expect(r!.merchant).toBe('MF Utilities India Pvt Ltd');
  });

  it('parses "M/s X has transferred an amount of Rs. N to your account" as income', () => {
    const r = parseTransaction('VM-YESBNK', 'This is to inform you that M/s ACME TRADERS has transferred an amount of Rs. 200.00 to your account no. XXXXXXXX1234 from their YES Bank account through RTGS/NEFT/IMPS', Date.now());
    expect(r).toMatchObject({ amount: 200, isExpense: false, merchant: 'ACME TRADERS' });
  });
});
