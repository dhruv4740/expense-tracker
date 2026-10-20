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
import { peekBuffer, ackBuffer, onSmsReceived, type RawEvent } from './native/SmsModule';
import { onNotificationReceived } from './native/NotificationModule';
import { parseTransaction } from './parser';
import { insertTransaction, getAllMerchantRules } from './db';
import { runTransferPairing, snapshotMaxId } from './transferSync';
import { classify } from './classify';
import type { Identity } from './identity';
import { getIdentity, getFamilyMembers, getFriends, getAmazonTopupFamily } from './settings';
import { GMAIL_PKG, isAmazonWalletTopUp } from './gmailFilter';

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
let familyCache: string[] = [];
let friendsCache: string[] = [];
let amazonTopupFamilyCache = true;

/**
 * Reload identity and learned merchant rules from the DB into module-level
 * caches. Call this after the user:
 *  - changes their identity (SettingsScreen)
 *  - edits a merchant category (EditTransactionScreen, ReviewScreen)
 *  - deletes or edits a learned rule (MerchantRulesScreen)
 */
export function refreshSyncCaches(): void {
  identityCache = getIdentity();
  learnedRulesCache = getAllMerchantRules();
  familyCache = getFamilyMembers();
  friendsCache = getFriends();
  amazonTopupFamilyCache = getAmazonTopupFamily();
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
  // Gmail is captured only for Amazon Pay wallet top-ups; the native side already
  // filters, this drops anything else that somehow reached the buffer.
  const fromGmail = e.pkg === GMAIL_PKG;
  if (fromGmail && !isAmazonWalletTopUp(e.body)) {
    return false;
  }

  // 1. Parse — null means the message is not a transaction.
  const parsed = parseTransaction(sender, e.body, e.ts);
  if (!parsed) {
    return false;
  }

  // 2. Category + type from the shared classifier (identity, family, kind, rules).
  const { category, type } = classify(parsed, {
    identity: identityCache,
    rules: learnedRulesCache,
    family: familyCache,
    friends: friendsCache,
    amazonTopupFamily: amazonTopupFamilyCache,
  });

  // 3. Merchant fallback chain: parser merchant → counterparty → sender.
  const merchant = parsed.merchant ?? parsed.counterparty ?? sender ?? null;

  // 4. Insert (idempotent via dedup_key + cross-channel dedup in db.ts).
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
    channel: fromGmail ? 'email' : e.kind,
  });
}

/** Max row id before a batch, or -1 (skip pairing) if it cannot be read. */
function safeSnapshot(): number {
  try {
    return snapshotMaxId();
  } catch {
    return -1;
  }
}

/**
 * Look for own-account transfer pairs among rows inserted after `maxIdBefore`
 * and auto-mark the high-confidence ones. Never allowed to break a sync.
 */
function pairNewRows(maxIdBefore: number): void {
  if (maxIdBefore < 0) {
    return;
  }
  try {
    runTransferPairing(maxIdBefore, identityCache);
  } catch {
    // Pairing is a convenience; the rows are already safely stored.
  }
}

/** processOne + pairing for a single live event. */
function processLive(e: RawEvent): boolean {
  const before = safeSnapshot();
  const ok = processOne(e);
  if (ok) {
    pairNewRows(before);
  }
  return ok;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Drain everything captured while the app was closed. Refreshes caches first
 * so the run always uses the latest identity + merchant rules.
 *
 * Uses peek → per-event try/catch → ack(processedCount) instead of a single
 * clear-then-process drain: if one event's processing throws (a bad event
 * shouldn't be possible given parseTransaction's guards, but native input is
 * never fully trusted) it's skipped and counted, not fatal — and only events
 * that were actually looped over get acked, so a crash mid-loop (or the app
 * being killed) leaves the rest for the next sync instead of losing them.
 *
 * @returns Number of new rows inserted.
 */
export async function syncBuffer(): Promise<number> {
  // Always refresh caches at the top of a drain cycle.
  refreshSyncCaches();

  let inserted = 0;
  let processed = 0;
  let maxIdBefore = 0;
  try {
    maxIdBefore = safeSnapshot();
    const events = await peekBuffer();
    for (const e of events) {
      try {
        if (processOne(e)) {
          inserted++;
        }
      } catch {
        // One malformed event doesn't kill the batch — skip and move on.
      }
      processed++;
    }
    if (processed > 0) {
      await ackBuffer(processed);
    }
  } catch {
    // Native module not ready (e.g. dev fast-refresh) — buffer persists for next drain.
  }
  if (inserted > 0) {
    pairNewRows(maxIdBefore);
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
      if (processLive(e)) {
        DeviceEventEmitter.emit(DATA_CHANGED);
      }
    }),
    onNotificationReceived(e => {
      if (processLive(e as RawEvent)) {
        DeviceEventEmitter.emit(DATA_CHANGED);
      }
    }),
  ];
  return () => subs.forEach(s => s.remove());
}
