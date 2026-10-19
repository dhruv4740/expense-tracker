// sync.ts pulls in db.ts (op-sqlite, a native module that can't run under
// Jest) and react-native modules transitively via ./settings and
// ./native/*. Mock all of those so we can exercise the peek/ack resilience
// logic in isolation.

jest.mock('react-native', () => ({
  DeviceEventEmitter: { emit: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('../native/SmsModule', () => ({
  peekBuffer: jest.fn(),
  ackBuffer: jest.fn(),
  onSmsReceived: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../native/NotificationModule', () => ({
  onNotificationReceived: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../db', () => ({
  insertTransaction: jest.fn(() => true),
  getAllMerchantRules: jest.fn(() => ({})),
}));

jest.mock('../transferSync', () => ({
  snapshotMaxId: jest.fn(() => 0),
  runTransferPairing: jest.fn(() => 0),
}));

jest.mock('../settings', () => ({
  getIdentity: jest.fn(() => ({ name: '', phones: [], upiHandles: [], accountLast4: [] })),
  getFamilyMembers: jest.fn(() => []),
}));

import { syncBuffer } from '../sync';
import { peekBuffer, ackBuffer } from '../native/SmsModule';
import { insertTransaction } from '../db';
import type { RawEvent } from '../native/SmsModule';

const mockedPeek = peekBuffer as jest.Mock;
const mockedAck = ackBuffer as jest.Mock;
const mockedInsert = insertTransaction as jest.Mock;

function bankEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    kind: 'sms',
    sender: 'HDFCBK',
    body: 'Rs.100 debited at STORE on 01-Jul-26.',
    ts: 1719500000000,
    ...overrides,
  };
}

beforeEach(() => {
  mockedPeek.mockReset();
  mockedAck.mockReset();
  mockedInsert.mockReset();
  mockedInsert.mockReturnValue(true);
});

describe('syncBuffer', () => {
  it('acks exactly the number of events it looped over when all succeed', async () => {
    mockedPeek.mockResolvedValue([bankEvent(), bankEvent(), bankEvent()]);

    const inserted = await syncBuffer();

    expect(inserted).toBe(3);
    expect(mockedAck).toHaveBeenCalledWith(3);
  });

  it("one bad event doesn't kill the batch — still acks all processed events", async () => {
    mockedPeek.mockResolvedValue([bankEvent(), bankEvent(), bankEvent()]);
    mockedInsert
      .mockImplementationOnce(() => {
        throw new Error('simulated DB failure on this row');
      })
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    const inserted = await syncBuffer();

    // The failing event is skipped (not counted as inserted), but the other
    // two succeed, and ack still covers all 3 looped-over events.
    expect(inserted).toBe(2);
    expect(mockedAck).toHaveBeenCalledWith(3);
  });

  it('does not ack when the buffer is empty', async () => {
    mockedPeek.mockResolvedValue([]);

    const inserted = await syncBuffer();

    expect(inserted).toBe(0);
    expect(mockedAck).not.toHaveBeenCalled();
  });

  it('leaves the buffer untouched (no ack) if peekBuffer itself throws', async () => {
    mockedPeek.mockRejectedValue(new Error('native module not ready'));

    const inserted = await syncBuffer();

    expect(inserted).toBe(0);
    expect(mockedAck).not.toHaveBeenCalled();
  });
});
