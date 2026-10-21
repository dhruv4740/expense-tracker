// ─── DB glue shared by the pairing / cancel-out / refund sync modules ────────
//
// Each *Sync module reads rows, applies a link and writes one undo-log batch.
// The row filtering, log append, link and dismiss steps were identical, so
// they live here once.

import { setSettlement, getTransactionById } from './db';
import { cancelKey } from './cancelOut';
import { getJSON, setJSON } from './settings';
import {
  AUTO_SELF_LOG_KEY,
  CANCEL_DISMISSED_KEY,
  addDismissed,
  appendBatch,
} from './transferLog';
import type { AutoSelfBatch, AutoSelfEntry } from './transferLog';

/** Rows that have a DB id (everything read back from SQLite does). */
export function withIds<T extends { id?: number | null }>(rows: T[]): Array<T & { id: number }> {
  const out: Array<T & { id: number }> = [];
  for (const r of rows) {
    if (r.id != null) {
      out.push({ ...r, id: r.id });
    }
  }
  return out;
}

/** Append one sync run's auto-applied entries to the undo log. */
export function appendAutoLog(at: number, entries: AutoSelfEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  const log = getJSON<AutoSelfBatch[]>(AUTO_SELF_LOG_KEY, []);
  setJSON(AUTO_SELF_LOG_KEY, appendBatch(log, { at, entries }));
}

/** Pairs the user dismissed or undid, as `parentId:childId` keys. */
export function dismissedKeys(): Set<string> {
  return new Set(getJSON<string[]>(CANCEL_DISMISSED_KEY, []));
}

/** Remember a dismissed suggestion under the given app_settings list key. */
export function addDismissedKey(settingKey: string, pairKey: string): void {
  setJSON(settingKey, addDismissed(getJSON<string[]>(settingKey, []), pairKey));
}

export function dismissLink(parentId: number, childId: number): void {
  addDismissedKey(CANCEL_DISMISSED_KEY, cancelKey(parentId, childId));
}

/** Link `childId` (repayment / refund) to `parentId` unless it is already linked. */
export function linkIfUnlinked(parentId: number, childId: number): void {
  if (getTransactionById(childId)?.settles_id == null) {
    setSettlement(childId, parentId);
  }
}
