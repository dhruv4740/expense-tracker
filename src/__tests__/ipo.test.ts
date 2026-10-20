import { activeIssuers, buildIpos, ipoKey, isIpoDebit, parseIpoEvent } from '../ipo';
import type { IpoEvent } from '../ipo';
import { parseTransaction } from '../parser';

const DAY = 86_400_000;
const T = 1_790_000_000_000;

const SAMPLES: Array<[string, string, Partial<IpoEvent>]> = [
  ['slice block', 'UPI-IPO mandate successfully created towards Acme Fire Protect from your slice savings account xx0000 for Rs. 14,650. Amount has been blocked in your account. (UMN 01a1@slc) Not you? Call 0800 - slice', { kind: 'blocked', amount: 14650 }],
  ['slice revoke', 'UPI-IPO mandate for Rs. 14,949 to BETA MANUFACTURING BUSINESSES LIMITED has been revoked. The amount has been unblocked in your account. (UMN 01a1@slc) - slice', { kind: 'revoked', amount: 14949 }],
  ['KFin unblock', 'Informed your Bank to unblock Rs. 14950.00 for GAMMA IPO appl no. GROWWe0000000001 due to non-allotment - KFintech', { kind: 'unblocked', amount: 14950, appNo: 'GROWWe0000000001' }],
  ['Link Intime unblock', 'Your bank is instructed to unblock Rs. 14960.00 for DELTACABL IPO applno. GROWW5a000000002 due to non-allotment. Please contact your bank or ignore if already unblocked. click <tinyurl.com/unblk>', { kind: 'unblocked', amount: 14960 }],
  ['MUFG unblock', 'Informed your Bnk. to unblk Rs. 14964.00 for EPSILON IPO applno GROWW000000003 due to non-allotment. Pls contact your bank if req. MUFGIN', { kind: 'unblocked', amount: 14964 }],
  ['BSE no allotment', 'DEAR INVESTOR, No allotment to Application No.GROWW000000004  FOR  ZETACO. FOR DETAILS, PLEASE VISIT YOUR REGISTERED MAIL BOX. REGARDS, BSETEAM', { kind: 'not_allotted', name: 'ZETACO' }],
  ['BSE allotment', 'DEAR INVESTOR,SUCCESSFUL ALLOTMENT OF  35 SHARES AT RS.417.00 TO APPLICATION NO.2400000000005  FOR  ETAINFRA. FOR DETAILS, PLEASE VISIT YOUR REGISTERED MAIL BOX. REGARDS, BSE TEAM', { kind: 'allotted', amount: 14595 }],
  ['NSE allotment', 'Dear ABCDE1234F IPO Hero Co Limited: 178 shares allotted at Rs 84.00 for App no GROWW000000006. Refer registered email id for details- NSEIL', { kind: 'allotted', amount: 14952 }],
  ['HDFC Sec allotment', 'You have been allotted 26 shares of THETA FUNDS LIMITED at 574 - per share. Application number 2400000000007 -HDFC SEC', { kind: 'allotted', amount: 14924 }],
  ['CDSL credit', 'CDSL: Credit in a/c *00000001 through IPO/FPO for 55-ACME FIRE PROTEC-EQ5/- on 19OCT', { kind: 'allotted', name: 'ACME FIRE PROTEC' }],
  ['NSE received', 'Dear ABCDE1234F IPO Iota Retail Limited : App no GROWW000000008 UPI ID 0000000000@slc for Rs 14840.00 received. Please check for UPI-Mandate collect request for blocking of funds- NSEIL', { kind: 'applied', amount: 14840 }],
  ['HDFC Sec placed', 'Your IPO application no - 2400000000009 for KAPPA TECHNOLOGIES LIMITED has been placed successfully. For more details please check your IPO order book.Please visit HDFC Securities website.', { kind: 'applied', name: 'KAPPA TECHNOLOGIES LIMITED' }],
  ['HDFC Sec placed (SME)', 'Your IPO application no - 2400000000010 for SME - LAMBDA POWERTECH LIMITED - GENERAL has been placed successfully. For more details', { kind: 'applied', name: 'LAMBDA POWERTECH LIMITED' }],
  ['HDFC Sec accepted', 'Your IPO order for THETA FUNDS LIMITED with PAN: ABCDE1234F has been accepted. Stay tuned for allotment updates -HDFC SEC', { kind: 'applied' }],
  ['BSE submitted', 'DEAR INVESTOR,APPLICATION NO.GROWW000000011  OF  MU. HAS BEEN SUBMITTED ON BSE.YOU WILL RECEIVE A UPI-MANDATE COLLECT REQUEST FOR BLOCKING OF FUNDS.BSE TEAM', { kind: 'applied', name: 'MU' }],
];

describe('parseIpoEvent', () => {
  it.each(SAMPLES)('%s', (_label, body, want) => {
    expect(parseIpoEvent(body, T)).toMatchObject(want);
  });
  it('ignores mandate requests, SIP allotments and ordinary debits', () => {
    expect(parseIpoEvent('You have received a UPI-IPO mandate request from Acme for Rs. 14,650. Click here to approve: https://x', T)).toBeNull();
    expect(parseIpoEvent('Your SIP under folio XXXX in scheme Fund for Rs.2000.00 is processed and 72.403 units at NAV 27.6 are allotted', T)).toBeNull();
    expect(parseIpoEvent('Rs. 250 has been debited from your account towards Swiggy Limited (Ref No 1)', T)).toBeNull();
  });
  it('no IPO message becomes a transaction', () => {
    for (const [, body] of SAMPLES) {
      expect(parseTransaction('SLICE', body, T)).toBeNull();
    }
  });
});

describe('ipoKey', () => {
  it('matches the spellings different senders use', () => {
    expect(ipoKey('HD FIRE PROTECT LIMITED')).toBe(ipoKey('HD FIRE PROTEC'));
    expect(ipoKey('Moneyview Limited')).toBe(ipoKey('MONEYVIEW'));
    expect(ipoKey('SBIFUNDS/2400000041076281-XXXX')).toBe(ipoKey('SBI FUNDS MANAGEMENT LIMITED'));
  });
});

describe('buildIpos', () => {
  const ev = (kind: IpoEvent['kind'], name: string, d: number, extra: Partial<IpoEvent> = {}): IpoEvent => ({ kind, name, ts: T + d * DAY, ...extra });

  it('applied → blocked → refunded', () => {
    const [i] = buildIpos([ev('applied', 'GAMMA', 0), ev('blocked', 'GAMMA LIMITED', 0.1, { amount: 14950 }), ev('unblocked', 'GAMMA', 5, { amount: 14950 })]);
    expect(i).toMatchObject({ status: 'refunded', blocked: 14950 });
  });
  it('blocked and still waiting is "blocked"', () => {
    expect(buildIpos([ev('blocked', 'GAMMA', 0, { amount: 14950 })])[0].status).toBe('blocked');
  });
  it('allotted, then debited once the bank debit exists', () => {
    const events = [ev('blocked', 'ACME FIRE PROTECT LIMITED', 0, { amount: 14950 }), ev('allotted', 'ACME FIRE PROTEC', 7)];
    expect(buildIpos(events)[0].status).toBe('allotted');
    const withDebit = buildIpos(events, [{ ts: T + 6 * DAY, amount: 14905, merchant: 'ACME FIRE PROTECT LIMITED' }]);
    expect(withDebit[0]).toMatchObject({ status: 'debited', debited: 14905 });
  });
  it('joins events from different senders by application number', () => {
    const items = buildIpos([ev('applied', 'ZZZ ONE', 0, { appNo: 'A1' }), ev('not_allotted', 'QQQ TWO', 3, { appNo: 'A1' })]);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('refunded');
  });
  it('a late non-allotment notice does not undo a seen debit', () => {
    const events = [ev('blocked', 'THETA', 0, { amount: 14950 }), ev('allotted', 'THETA', 2), ev('unblocked', 'THETA', 4, { amount: 26 })];
    expect(buildIpos(events, [{ ts: T + 1 * DAY, amount: 14924, merchant: 'THETA FUNDS LIMITED' }])[0].status).toBe('debited');
  });
});

describe('isIpoDebit', () => {
  const issuers = activeIssuers([
    { ts: T, kind: 'blocked', name: 'ACME FIRE PROTECT LIMITED', amount: 14950 },
    { ts: T, kind: 'blocked', name: 'REFUNDCO', amount: 14950 },
    { ts: T + DAY, kind: 'revoked', name: 'REFUNDCO', amount: 14950 },
  ]);
  it('only the bank debit that fits an active IPO block counts', () => {
    expect(isIpoDebit('ACME FIRE PROTECT LIMITED', 14905, issuers)).toBe(true);
    expect(isIpoDebit('ACME FIRE PROTECT LIMITED', 250, issuers)).toBe(false);
    expect(isIpoDebit('REFUNDCO', 14905, issuers)).toBe(false);
    expect(isIpoDebit('SWIGGY LIMITED', 14905, issuers)).toBe(false);
    expect(isIpoDebit(null, 14905, issuers)).toBe(false);
  });

  describe('clearing-corporation debit', () => {
    const allot = T + 3 * DAY;
    const cl = activeIssuers([
      { ts: T, kind: 'blocked', name: 'ACME FIRE PROTECT LIMITED', amount: 14950 },
      { ts: allot, kind: 'allotted', name: 'ACME FIRE PROTECT LIMITED' },
    ]);
    it('ICCL debit inside the 7 days after allotment counts', () => {
      expect(isIpoDebit('ICCL', 14905, cl, allot + 2 * DAY)).toBe(true);
      expect(isIpoDebit('Indian Clearing Corporation Limited', 14905, cl, allot + 7 * DAY)).toBe(true);
      expect(isIpoDebit('NSE Clearing', 8000, cl, allot)).toBe(true);
    });
    it('does not count outside the window, off-band, or without the other evidence', () => {
      expect(isIpoDebit('ICCL', 14905, cl, allot + 7 * DAY + 1)).toBe(false);
      expect(isIpoDebit('ICCL', 14905, cl, allot - 1)).toBe(false);
      expect(isIpoDebit('ICCL', 14905, cl)).toBe(false); // no timestamp
      expect(isIpoDebit('ICCL', 3000, cl, allot + DAY)).toBe(false); // < 30% of block
      expect(isIpoDebit('ICCL', 15400, cl, allot + DAY)).toBe(false); // > 102% of block
      expect(isIpoDebit('ICCL', 14905, issuers, allot + DAY)).toBe(false); // blocked, no allotment notice
      expect(isIpoDebit('BSE Sports Club', 14905, cl, allot + DAY)).toBe(false); // not a clearing name
    });
  });
});
