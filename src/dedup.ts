// ─── Dedup helpers (pure, no DB/native imports) ──────────────────────────────
//
// Split out of db.ts so these are unit-testable under Jest: db.ts imports
// @op-engineering/op-sqlite at module scope, which is a native module and
// can't be required in a plain Jest/Node environment (ESM syntax error).
// This file has zero such imports.

/** Capture channel — used only for cross-channel soft dedup (see isSoftDuplicate). */
/** 'email' = a Gmail notification (Amazon Pay wallet top-ups only). */
export type Channel = 'sms' | 'notification' | 'email' | 'manual';

// djb2 hash — no external deps
export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16);
}

export function strictDedupKey(tx: {
  source: string | null;
  amount: number;
  timestamp: number;
  raw_text: string | null;
}): string {
  return hash(
    `${tx.source}|${tx.amount}|${Math.floor(tx.timestamp / 60000)}|${tx.raw_text}`,
  );
}

/** Channels that take part in cross-channel soft dedup (manual / NULL never do). */
function isCapturedChannel(c: Channel | null | undefined): boolean {
  return c === 'sms' || c === 'notification' || c === 'email';
}

/**
 * Pure mirror of the soft cross-channel dedup predicate embedded in the SQL
 * query inside db.ts's insertTransaction() — kept here so it's unit-testable
 * without a live op-sqlite connection. If the SQL predicate ever changes,
 * update this to match.
 *
 * User-chosen policy: a duplicate is only dropped when the SAME payment
 * arrives via a DIFFERENT channel (SMS vs notification). Same-channel
 * repeats are always kept; a NULL (pre-migration) channel on either side
 * never triggers a drop; manual entries never soft-dedup.
 */
export function isSoftDuplicate(
  incoming: { amount: number; timestamp: number; channel: Channel | null | undefined; counterparty: string | null | undefined },
  existing: { amount: number; timestamp: number; channel: Channel | null | undefined; counterparty: string | null | undefined },
): boolean {
  if (!isCapturedChannel(incoming.channel)) {
    return false;
  }
  if (existing.channel == null || existing.channel === incoming.channel) {
    return false;
  }
  if (!isCapturedChannel(existing.channel)) {
    return false;
  }
  if (existing.amount !== incoming.amount) {
    return false;
  }
  if (Math.abs(existing.timestamp - incoming.timestamp) >= 120000) {
    return false;
  }
  const incomingCp = incoming.counterparty ?? null;
  const existingCp = existing.counterparty ?? null;
  if (incomingCp != null && existingCp != null && incomingCp !== existingCp) {
    return false;
  }
  return true;
}
