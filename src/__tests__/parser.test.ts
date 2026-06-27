import { parseTransaction } from '../parser';

describe('parseTransaction', () => {
  // ── 1. HDFC debit SMS ────────────────────────────────────────────────────
  it('parses HDFC debit SMS → isExpense true, amount 499, merchant contains SWIGGY, category Food', () => {
    const body =
      'Rs.499.00 debited from your HDFC Bank account ending 1234 at SWIGGY on 27-Jun-26. Avl Bal: Rs.5,000.00';
    const result = parseTransaction('HDFCBK', body, 1719500000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(true);
    expect(result!.amount).toBe(499);
    expect(result!.merchant).not.toBeNull();
    expect(result!.merchant!.toUpperCase()).toContain('SWIGGY');
    expect(result!.category).toBe('Food');
    expect(result!.source).toBe('HDFCBK');
    expect(result!.timestamp).toBe(1719500000000);
    expect(result!.raw_text).toBe(body);
  });

  // ── 2. ICICI credit SMS ──────────────────────────────────────────────────
  it('parses ICICI credit SMS → isExpense false (income)', () => {
    const body =
      'INR 2,000.00 credited to your ICICI Bank account ending 5678. Refund from AMAZON.';
    const result = parseTransaction('ICICIB', body, 1719600000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(false);
    expect(result!.amount).toBe(2000);
    expect(result!.source).toBe('ICICIB');
  });

  // ── 3. UPI sent SMS ──────────────────────────────────────────────────────
  it('parses UPI sent SMS → isExpense true, category UPI', () => {
    const body =
      'Rs.150 sent via UPI to merchant@oksbi. Ref: 987654321. Your A/c XX9012 debited.';
    const result = parseTransaction('SBIBNK', body, 1719700000000);

    expect(result).not.toBeNull();
    expect(result!.isExpense).toBe(true);
    expect(result!.amount).toBe(150);
    // UPI keyword in body → category UPI
    expect(result!.category).toBe('UPI');
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
    // TypeScript won't allow null directly, but guard should handle it at runtime
    const result = parseTransaction('SENDER', null as unknown as string, Date.now());
    expect(result).toBeNull();
  });

  // ── 8. No direction keyword → null ───────────────────────────────────────
  it('returns null when amount is present but no direction keyword', () => {
    const body = 'Your account balance is Rs.5000.';
    const result = parseTransaction('BANKX', body, Date.now());
    expect(result).toBeNull();
  });
});
