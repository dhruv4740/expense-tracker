import { isSelfTransfer, normalizePhone } from '../identity';
import type { Identity } from '../identity';

// ─── normalizePhone ───────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  it('returns 10-digit number unchanged', () => {
    expect(normalizePhone('9876543210')).toBe('9876543210');
  });

  it('strips +91 prefix (12-digit)', () => {
    expect(normalizePhone('+919876543210')).toBe('9876543210');
  });

  it('strips 91 prefix (12-digit, no +)', () => {
    expect(normalizePhone('919876543210')).toBe('9876543210');
  });

  it('strips leading 0 (11-digit)', () => {
    expect(normalizePhone('09876543210')).toBe('9876543210');
  });

  it('strips spaces and dashes', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('9876543210');
  });

  it('handles 13+ digit string by taking last 10', () => {
    // Not a realistic case but should not crash.
    expect(normalizePhone('1234919876543210')).toBe('9876543210');
  });
});

// ─── isSelfTransfer ───────────────────────────────────────────────────────────

const baseIdentity: Identity = {
  name: 'Test User',
  phones: ['9876543210'],
  upiHandles: ['myhandle@okaxis', 'myphone@upi'],
  accountLast4: ['1234', '9012'],
};

describe('isSelfTransfer', () => {
  // ── null / missing counterparty ───────────────────────────────────────────
  it('returns false when counterparty is null', () => {
    expect(isSelfTransfer({ counterparty: null }, baseIdentity)).toBe(false);
  });

  it('returns false when counterparty is empty string', () => {
    expect(isSelfTransfer({ counterparty: '' }, baseIdentity)).toBe(false);
  });

  // ── UPI VPA matching ──────────────────────────────────────────────────────
  it('matches own UPI handle (case-insensitive)', () => {
    expect(isSelfTransfer({ counterparty: 'MYHANDLE@OKAXIS' }, baseIdentity)).toBe(true);
  });

  it('matches own UPI handle in lowercase', () => {
    expect(isSelfTransfer({ counterparty: 'myhandle@okaxis' }, baseIdentity)).toBe(true);
  });

  it('does NOT match a different VPA', () => {
    expect(isSelfTransfer({ counterparty: 'other@oksbi' }, baseIdentity)).toBe(false);
  });

  // ── Phone matching ────────────────────────────────────────────────────────
  it('matches own phone number (exact 10 digits)', () => {
    expect(isSelfTransfer({ counterparty: '9876543210' }, baseIdentity)).toBe(true);
  });

  it('does NOT match a different phone number', () => {
    expect(isSelfTransfer({ counterparty: '9000000001' }, baseIdentity)).toBe(false);
  });

  // ── Account last-4 matching ───────────────────────────────────────────────
  it('matches own account last 4 digits', () => {
    expect(isSelfTransfer({ counterparty: '1234' }, baseIdentity)).toBe(true);
  });

  it('matches own account last 4 digits (second account)', () => {
    expect(isSelfTransfer({ counterparty: '9012' }, baseIdentity)).toBe(true);
  });

  it('does NOT match a random 4-digit string', () => {
    expect(isSelfTransfer({ counterparty: '5555' }, baseIdentity)).toBe(false);
  });

  it('does NOT match a 3-digit string that is not in accountLast4', () => {
    expect(isSelfTransfer({ counterparty: '999' }, baseIdentity)).toBe(false);
  });

  // ── Empty identity ────────────────────────────────────────────────────────
  it('returns false for any counterparty when identity is empty', () => {
    const empty: Identity = {
      name: '',
      phones: [],
      upiHandles: [],
      accountLast4: [],
    };
    expect(isSelfTransfer({ counterparty: 'myhandle@okaxis' }, empty)).toBe(false);
    expect(isSelfTransfer({ counterparty: '9876543210' }, empty)).toBe(false);
    expect(isSelfTransfer({ counterparty: '1234' }, empty)).toBe(false);
  });
});
