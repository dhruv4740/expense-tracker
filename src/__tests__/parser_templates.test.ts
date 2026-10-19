import { parseTransaction } from '../parser';
import { categorize } from '../categories';

const p = (body: string, sender = 'VM-TEST-S') => parseTransaction(sender, body, 1_700_000_000_000);

describe('templates', () => {
  it('slice credit card transaction is an expense with the merchant between "on" and "is successful"', () => {
    const r = p('Your slice credit card transaction of Rs. 280 on Swiggy is successful. If not you, call 08048329999 - slice');
    expect(r).toMatchObject({ amount: 280, isExpense: true, merchant: 'Swiggy', counterparty: null });
  });

  it('Apay balance payment takes the merchant after "at"', () => {
    const r = p('Payment of Rs 95.61 using Apay balance is successful at Uber India. Updated balance is Rs 892.46. If not u? call 18001200163 - SMS via Pine Labs');
    expect(r).toMatchObject({ amount: 95.61, isExpense: true, merchant: 'Uber India' });
  });

  it('Juspay Apay variant: the literal word "merchant" becomes null', () => {
    const r = p('Payment of Rs 35.36 using Apay Balance successful at merchant. Updated Balance is Rs 610.81 - If not u? call 186358076185 - SMS via Juspay');
    expect(r).toMatchObject({ amount: 35.36, isExpense: true, merchant: null });
  });

  it('Zomato Money balance payment', () => {
    const r = p('Payment of Rs. 7.54 from Zomato Money Balance is successful. Updated balance: Rs. 0.00. Contact help@example.com for queries. -ZOMATO');
    expect(r).toMatchObject({ amount: 7.54, isExpense: true, merchant: 'Zomato' });
  });

  it('deposit interest is income, not an expense', () => {
    const r = p('Net interest INR 3,528.77 paid on your IndusInd Deposit No 371***152378 on 27/09/25. Call 18602677777 for assistance - IndusInd Bank');
    expect(r).toMatchObject({ amount: 3528.77, isExpense: false });
    expect(r?.kind).toBeUndefined();
  });

  describe('card-bill settlements', () => {
    it.each([
      ['Your slice UPI credit card bill of Rs. 812.16 has been paid successfully via autopay. Thanks for paying on time! - slice', true],
      ['Repayment of Rs.19,256.76 received for the slice credit card. The amount has been credited to your card account - slice', false],
      ["Dear Anita, we've received your payment of INR 715.00 for your SuperCard. Your available limit is now INR 4,500.00 Happy spending!", false],
      ['Payment of INR 568 is credited to your Kotak Bank Credit Card x1111 on 26-SEP-2026. Available Credit limit is INR 4500.', false],
      ['Your account XXXXXXX1111 debited with Rs. 297627 on 18-08-26 and account XXXXXXX2222/CreditCard will be credited.(IMPS Ref no. 629308914346). Call 18602677777 to report issue - IndusInd Bank', true],
    ])('%s', (body, isExpense) => {
      const r = p(body);
      expect(r).not.toBeNull();
      expect(r?.kind).toBe('card_bill');
      expect(r?.isExpense).toBe(isExpense);
    });
  });

  it('FD closure proceeds are an own_transfer income', () => {
    const r = p('IndusInd A/C  Credited; INR 227,664.55 Ref-378145828129 : Closure Proceeds.Bal INR 242,581.48.Dispute-Call 18602677777-IndusInd Bank');
    expect(r).toMatchObject({ amount: 227664.55, isExpense: false, kind: 'own_transfer' });
  });

  it('IPO allotment debit is an investment expense', () => {
    const r = p('Rs. 14,905 has been debited from your slice savings account xx1111 towards ACME FIRE PROTECT LIMITED (Ref No 629195276529). Not you? Call 08048329999 - slice');
    expect(r).toMatchObject({ amount: 14905, isExpense: true, kind: 'investment', merchant: 'ACME FIRE PROTECT LIMITED' });
  });

  it('IMPS debit to a named account stays an expense (beats the "will be credited" guard)', () => {
    const r = p('Your account XXXXXXX1111 debited with Rs. 8103 on 01-12-25 and account XXXXXXX2222/ANITA RAO will be credited.(IMPS Ref no. 533075417762). Call 18602677777 to report issue - IndusInd Bank');
    expect(r).toMatchObject({ amount: 8103, isExpense: true, merchant: 'ANITA RAO' });
    expect(r?.kind).toBeUndefined();
  });
});

describe('negative guards', () => {
  it.each([
    'REMINDER: INR 50 will be auto-debited from your account on 12-Oct',
    'Txn of Rs 500 failed. For reversal of txn amount will be credited in 48 hours',
    'UPI-IPO mandate request of Rs 114000.00 received from ACME LTD. Approve in your UPI app',
    'UPI-IPO mandate for Rs 114000.00 created successfully',
    'UPI-IPO mandate Rs 114000.00 revoked',
    'IPO ACME : App no 123 for Rs 114000.00 received',
    'Rs 114000.00 unblocked in your account xx1111',
    'Your application of Rs 114000.00 submitted on BSE',
    'Shares allotted. Rs 14000.00 will reflect',
    'Rs 114000.00 blocked in your account xx1111 for ACME',
    'CDSL: credit of Rs 114000.00 shares',
    'Your SIP Purchase of Rs. 500.00 in ACME Fund has been processed successfully',
    'Your purchase request dated 01-Oct for Rs 500 in ACME fund is processed',
    'Your transaction for INR 100.00 against txn ID 12345 has been processed successfully',
    'UPI LITE Top-up of Rs 200 done',
    'Mandate for Rs 200 has been successfully created for ACME',
    'You have a collect request of Rs 200 from ACME',
    'Mandate reference no. HDFC123 issued to MF Utilities with value Rs. 200000 is received',
    'we received Rs. 16000 for invoice INV-1 from you',
    'Thanks for the payment of Rs 500. The pending amount is Rs 1000 debited later',
  ])('drops: %s', body => {
    expect(p(body)).toBeNull();
  });

  it('regression: "UPI Mandate: Sent ..." stays an Investment expense', () => {
    const r = p('UPI Mandate: Sent Rs.4000.00 from HDFC Bank A/c 1111 To ICCL - Mutual Funds - 18/10/26 Ref 123 Not You? Call 18002586161/SMS BLOCK UPI to 7308080808');
    expect(r).toMatchObject({ amount: 4000, isExpense: true });
    expect(r?.counterparty).toBeNull();
    expect(categorize(r!.merchant, r!.raw_text, r!.counterparty, {}, true)).toBe('Investment');
  });
});

describe('deducted / MF Utilities', () => {
  it('parses "deducted" as an expense with the UMRN stripped; categorized as Investment', () => {
    const r = p('PAYMENT ALERT! \nINR 2500.00 deducted from HDFC Bank A/C No 1111 towards MF Utilities India Pvt Ltd UMRN: HDFC7011507246002816');
    expect(r).toMatchObject({ amount: 2500, isExpense: true, merchant: 'MF Utilities India Pvt Ltd' });
    expect(categorize(r!.merchant, r!.raw_text, r!.counterparty, {}, true)).toBe('Investment');
  });
});

describe('helpline / own-handle extraction', () => {
  it('never takes a helpline number as the counterparty, and leaves raw_text intact', () => {
    const body = 'Rs. 120 sent from a/c xx1111 on 04-Oct-26 to Chai Point (UPI Ref: 624155472033). Not you? Call 08048329999 - slice';
    const r = p(body);
    expect(r?.counterparty).toBeNull();
    expect(r?.raw_text).toBe(body);
    expect(r?.merchant).toBe('Chai Point');
  });

  it('ignores the user\'s own FamPay handle after "using"', () => {
    const r = p('You paid Rs.265.0 to Rainbow Shoppe with txn ID FMPIB442730027 using 9000000001@fam. Your FamPay a/c balance is Rs.698.78');
    expect(r?.counterparty).toBeNull();
    expect(r?.merchant).toBe('Rainbow Shoppe');
  });

  it('still reads a counterparty VPA that is not a "using" handle', () => {
    const r = p('Credit Alert! Rs. 654.00 credited to a/c XXXXXX1111 on 01-11-24 by a/c linked to VPA 9000000002@fam (UPI Ref No 435937392625).');
    expect(r?.counterparty).toBe('9000000002@fam');
  });
});

describe('merchant cleanup', () => {
  it('strips the leading account and cuts at "(" for income "from account X/NAME"', () => {
    const r = p('Your account XXXXXXX1111 is credited by Rs.297627 on 18-08-26 received from account XXXXXXX2222/ANITA RAO (IMPS Ref no. 624253159132). Call 18602677777 to report issue-IndusInd Bank');
    expect(r?.merchant).toBe('ANITA RAO');
  });

  it('income never takes a "to ..." candidate', () => {
    const r = p('Rs. 500.00 credited to HDFC Bank A/c xx1111 on 01-01-26');
    expect(r?.merchant).toBeNull();
  });

  it('strips "via UPI" and "with txn ID" tails', () => {
    expect(p('Paid Rs. 50 to Cafe Moon via UPI Ref 123')?.merchant).toBe('Cafe Moon');
  });

  it('strips a leading "VPA "', () => {
    expect(p('Rs. 50 debited from a/c xx1111 to VPA shop@okaxis')?.merchant).toBe('shop@okaxis');
  });
});

describe('kind: wallet loads and own-bank payees', () => {
  it.each([
    'Rs. 1,500 sent from a/c xx1111 on 04-Oct-26 to Amazon Pay Balance (UPI Ref: 624155472033). Not you? Call 08048329999 - slice',
    'Rs. 500 sent from a/c xx1111 on 03-Oct-26 to Amazon Pay (UPI Ref: 628474453305). Not you? Call 08048329999 - slice',
    'Sent Rs.2000.00 From HDFC Bank A/c 1111 To Amazon Pay On 03/10/26 Ref 123',
  ])('wallet_load: %s', body => {
    expect(p(body)?.kind).toBe('wallet_load');
  });

  it('a payee that is a bank is an own_transfer', () => {
    const r = p('Rs. 10,500 sent from a/c xx1111 on 04-Oct-26 to Kotak Mahindra Bank Ltd (UPI Ref: 625736378467). Not you? Call 08048329999 - slice');
    expect(r?.kind).toBe('own_transfer');
  });

  it('an ordinary merchant has no kind', () => {
    expect(p('Rs. 50 sent from a/c xx1111 to Cafe Moon')?.kind).toBeUndefined();
  });
});
