import { displayMerchant } from '../merchantDisplay';

describe('displayMerchant', () => {
  it.each([
    ['Rajratna raju wagh (UPI Ref', 'Rajratna raju wagh'],
    ['Amazon Pay (UPI Ref', 'Amazon Pay'],
    ['TESTA AJAY SAMPLEKAR via UPI (Ref ID (', 'TESTA AJAY SAMPLEKAR'],
    ['Test Person test@okaxis', 'Test Person'],
    ['Dr. Mehta', 'Dr. Mehta'],
    ['SWIGGY', 'SWIGGY'],
  ])('%s → %s', (raw, out) => {
    expect(displayMerchant(raw)).toBe(out);
  });
  it('handles null and empty', () => {
    expect(displayMerchant(null)).toBeNull();
    expect(displayMerchant('  ')).toBeNull();
  });
});
