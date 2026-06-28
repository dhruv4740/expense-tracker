/**
 * Sync glue — the single place where captured raw events become DB rows.
 *
 * Two entry points (RULES.md §1):
 *  - syncBuffer():  drains the native EventBuffer (events captured while the app was
 *    closed) and inserts them. Call on app open and whenever the app returns to foreground.
 *  - subscribeLiveEvents(): handles SmsReceived / NotificationReceived emitted while the
 *    app is open, for instant inserts.
 *
 * Both paths run the SAME parser → categorize → isSelfTransfer → insertTransaction
 * pipeline, so an event captured by BOTH the live emit and the buffer is de-duplicated
 * by the UNIQUE dedup_key in db.ts.
 *
 * Any successful insert emits DATA_CHANGED so focused screens can refresh in place.
 */
import { DeviceEventEmitter } from 'react-native';
import { drainBuffer, onSmsReceived, type RawEvent } from './native/SmsModule';
import { onNotificationReceived } from './native/NotificationModule';
import { parseTransaction } from './parser';
import { insertTransaction, getAllMerchantRules, setAccountBalance } from './db';
import { categorize } from './categories';
import type { Category } from './categories';
import { isSelfTransfer } from './identity';
import type { Identity } from './identity';
import { getIdentity } from './settings';

export const DATA_CHANGED = 'ExpenseDataChanged';

// ─── Module-level caches ──────────────────────────────────────────────────────
// Loaded once per syncBuffer() call and reused by subscribeLiveEvents() so we
// avoid a DB round-trip on every live event. Call refreshSyncCaches() after the
// user edits identity or merchant rules so the caches reflect the latest state.

let identityCache: Identity = {
  name: '',
  phones: [],
  upiHandles: [],
  accountLast4: [],
};

let learnedRulesCache: Record<string, string> = {};

/**
 * Reload identity and learned merchant rules from the DB into module-level
 * caches. Call this after the user:
 *  - changes their identity (SettingsScreen)
 *  - edits a merchant category (MerchantRuleScreen)
 */
export function refreshSyncCaches(): void {
  identityCache = getIdentity();
  learnedRulesCache = getAllMerchantRules();
}

// ─── Core processing ──────────────────────────────────────────────────────────

/**
 * Parse one raw event, classify it, and insert it if it is a new transaction.
 * Handles expense, income, and self-transfer types — nothing is discarded by
 * type at this layer; the DB / UI layer decides what to surface.
 *
 * @returns true if a new row was inserted into the DB.
 */
function processOne(e: RawEvent): boolean {
  const sender = e.sender || e.pkg || '';
  if (!e.body) {
    return false;
  }

  // 1. Parse — null means the message is not a transaction.
  const parsed = parseTransaction(sender, e.body, e.ts);
  if (!parsed) {
    return false;
  }

  // 2. Categorise using learned rules first, then keyword map.
  const category: Category = categorize(
    parsed.merchant,
    parsed.raw_text,
    parsed.counterparty,
    learnedRulesCache,
  );

  // 3. Determine transaction type.
  //    Self-transfer: counterparty matches one of the user's own identifiers.
  //    Otherwise: expense vs income follows the parser's isExpense flag.
  let type: 'expense' | 'income' | 'self';
  if (isSelfTransfer(parsed, identityCache)) {
    type = 'self';
  } else {
    type = parsed.isExpense ? 'expense' : 'income';
  }

  // 4. Merchant fallback chain: parser merchant → counterparty → sender.
  const merchant = parsed.merchant ?? parsed.counterparty ?? sender ?? null;

  // 5. Store available balance if the message included one (best-effort, no wake lock,
  //    runs only while the app is foregrounded or while draining the buffer on open).
  if (parsed.balance != null && !isNaN(parsed.balance)) {
    const accountKey = parsed.account ?? parsed.source ?? 'unknown';
    setAccountBalance(accountKey, parsed.balance, parsed.timestamp);
  }

  // 6. Insert (idempotent via dedup_key + cross-channel dedup in db.ts).
  return insertTransaction({
    amount: parsed.amount,
    merchant,
    source: parsed.source,
    raw_text: parsed.raw_text,
    category,
    timestamp: parsed.timestamp,
    type,
    counterparty: parsed.counterparty ?? null,
    account: parsed.account ?? null,
    category_source: 'auto',
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Drain everything captured while the app was closed. Refreshes caches first
 * so the run always uses the latest identity + merchant rules.
 *
 * @returns Number of new rows inserted.
 */
export async function syncBuffer(): Promise<number> {
  // Always refresh caches at the top of a drain cycle.
  refreshSyncCaches();

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

/**
 * Subscribe to live SMS / notification events emitted while the app is open.
 * Uses the module-level caches (refreshed by syncBuffer or refreshSyncCaches).
 *
 * @returns Unsubscribe function — call it in useEffect cleanup.
 */
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
