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
});
