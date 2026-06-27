/**
 * Sync glue — the single place where captured raw events become DB rows.
 *
 * Two entry points (RULES.md §1):
 *  - syncBuffer():  drains the native EventBuffer (events captured while the app was
 *    closed) and inserts them. Call on app open and whenever the app returns to foreground.
 *  - subscribeLiveEvents(): handles SmsReceived / NotificationReceived emitted while the
 *    app is open, for instant inserts.
 *
 * Both paths run the SAME parser + idempotent insert, so an event captured by BOTH the
 * live emit and the buffer is de-duplicated by the UNIQUE dedup_key in db.ts.
 *
 * Any successful insert emits DATA_CHANGED so focused screens can refresh in place.
 */
import { DeviceEventEmitter } from 'react-native';
import { drainBuffer, onSmsReceived, type RawEvent } from './native/SmsModule';
import { onNotificationReceived } from './native/NotificationModule';
import { parseTransaction } from './parser';
import { insertTransaction } from './db';

export const DATA_CHANGED = 'ExpenseDataChanged';

/** Parse one raw event and insert it if it is a new expense. Returns true if a row was added. */
function processOne(e: RawEvent): boolean {
  const sender = e.sender || e.pkg || '';
  if (!e.body) {
    return false;
  }
  const parsed = parseTransaction(sender, e.body, e.ts);
  // Ignore non-transactions (null) and income (isExpense === false) for now.
  if (!parsed || !parsed.isExpense) {
    return false;
  }
  return insertTransaction({
    amount: parsed.amount,
    merchant: parsed.merchant,
    source: parsed.source,
    raw_text: parsed.raw_text,
    category: parsed.category,
    timestamp: parsed.timestamp,
    type: 'expense',
  });
}

/** Drain everything captured while the app was closed. Returns the number of new rows. */
export async function syncBuffer(): Promise<number> {
  let inserted = 0;
  try {
    const events = await drainBuffer();
    for (const e of events) {
      if (processOne(e)) {
        inserted++;
      }
    }
  } catch {
    // Native module not ready (e.g. dev fast-refresh) — buffer persists for next drain.
  }
  if (inserted > 0) {
    DeviceEventEmitter.emit(DATA_CHANGED);
  }
  return inserted;
}

/** Subscribe to live SMS/notification events while the app is open. Returns an unsubscribe fn. */
export function subscribeLiveEvents(): () => void {
  const subs = [
    onSmsReceived(e => {
      if (processOne(e)) {
        DeviceEventEmitter.emit(DATA_CHANGED);
      }
    }),
    onNotificationReceived(e => {
      if (processOne(e as RawEvent)) {
        DeviceEventEmitter.emit(DATA_CHANGED);
      }
    }),
  ];
  return () => subs.forEach(s => s.remove());
}
