import { strictDedupKey, isSoftDuplicate } from '../dedup';

describe('strictDedupKey', () => {
  it('produces the same key for identical fields', () => {
    const tx = { source: 'HDFCBK', amount: 500, timestamp: 1719500000000, raw_text: 'Rs.500 debited' };
    expect(strictDedupKey(tx)).toBe(strictDedupKey({ ...tx }));
  });

  it('is identical within the same minute bucket (minute-boundary identity)', () => {
    const base = { source: 'HDFCBK', amount: 500, raw_text: 'Rs.500 debited' };
    const a = strictDedupKey({ ...base, timestamp: 1719500000000 });
    const b = strictDedupKey({ ...base, timestamp: 1719500000000 + 30000 }); // +30s, same minute
    expect(a).toBe(b);
  });

  it('differs once the minute bucket changes', () => {
    const base = { source: 'HDFCBK', amount: 500, raw_text: 'Rs.500 debited' };
    const a = strictDedupKey({ ...base, timestamp: 1719500000000 });
    const b = strictDedupKey({ ...base, timestamp: 1719500000000 + 61000 }); // +61s, next minute
    expect(a).not.toBe(b);
  });

  it('differs when raw_text differs (different channel wording for the same payment)', () => {
    const a = strictDedupKey({ source: 'HDFCBK', amount: 500, timestamp: 1719500000000, raw_text: 'Rs.500 debited via SMS' });
    const b = strictDedupKey({ source: 'com.snapwork.hdfc', amount: 500, timestamp: 1719500000000, raw_text: 'Rs.500 debited via app' });
    expect(a).not.toBe(b);
  });
});

describe('isSoftDuplicate (cross-channel-only policy)', () => {
  const base = { amount: 500, timestamp: 1719500000000, counterparty: null as string | null };

  it('drops a duplicate when the SAME payment arrives on a different channel', () => {
    const incoming = { ...base, channel: 'notification' as const };
    const existing = { ...base, channel: 'sms' as const };
    expect(isSoftDuplicate(incoming, existing)).toBe(true);
  });

  it('keeps a repeat on the SAME channel (not a duplicate)', () => {
    const incoming = { ...base, channel: 'sms' as const };
    const existing = { ...base, channel: 'sms' as const };
    expect(isSoftDuplicate(incoming, existing)).toBe(false);
  });

  it('never drops against a NULL-channel (pre-migration) row', () => {
    const incoming = { ...base, channel: 'sms' as const };
    const existing = { ...base, channel: null };
    expect(isSoftDuplicate(incoming, existing)).toBe(false);
  });

  it('never soft-dedups a manual entry', () => {
    const incoming = { ...base, channel: 'manual' as const };
    const existing = { ...base, channel: 'sms' as const };
    expect(isSoftDuplicate(incoming, existing)).toBe(false);
  });

  it('does not drop when amounts differ', () => {
    const incoming = { ...base, channel: 'sms' as const, amount: 500 };
    const existing = { ...base, channel: 'notification' as const, amount: 600 };
    expect(isSoftDuplicate(incoming, existing)).toBe(false);
  });

  it('does not drop when timestamps are more than 2 minutes apart', () => {
    const incoming = { ...base, channel: 'sms' as const, timestamp: 1719500000000 };
    const existing = { ...base, channel: 'notification' as const, timestamp: 1719500000000 + 121000 };
    expect(isSoftDuplicate(incoming, existing)).toBe(false);
  });

  it('drops when counterparties match', () => {
    const incoming = { ...base, channel: 'sms' as const, counterparty: 'merchant@oksbi' };
    const existing = { ...base, channel: 'notification' as const, counterparty: 'merchant@oksbi' };
    expect(isSoftDuplicate(incoming, existing)).toBe(true);
  });

  it('does not drop when both counterparties are known and differ', () => {
    const incoming = { ...base, channel: 'sms' as const, counterparty: 'merchant@oksbi' };
    const existing = { ...base, channel: 'notification' as const, counterparty: 'other@ybl' };
    expect(isSoftDuplicate(incoming, existing)).toBe(false);
  });

  it('drops when one side has an unknown counterparty (bank SMS often lack one)', () => {
    const incoming = { ...base, channel: 'sms' as const, counterparty: null };
    const existing = { ...base, channel: 'notification' as const, counterparty: 'merchant@oksbi' };
    expect(isSoftDuplicate(incoming, existing)).toBe(true);
  });
});
