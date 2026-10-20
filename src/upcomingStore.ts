// ─── Upcoming payments: persistence glue ─────────────────────────────────────
//
// Pre-debit notices live in app_settings (a small JSON list, no schema change).
// Everything is computed on demand when the Dashboard opens; nothing runs in
// the background (RULES.md §1).

import { queryTransactions } from './db';
import { getJSON, setJSON } from './settings';
import { buildUpcoming, detectRecurring, noticeKey, startOfDay } from './upcoming';
import type { MandateNotice, UpcomingItem } from './upcoming';

const NOTICES_KEY = 'upcoming_notices';
const HISTORY_DAYS = 180;
const DAY = 86_400_000;

export function getNotices(now: number = Date.now()): MandateNotice[] {
  const keep = startOfDay(now) - DAY;
  return getJSON<MandateNotice[]>(NOTICES_KEY, []).filter(n => n.dueTs >= keep);
}

/** Remember a pre-debit notice (idempotent; stale ones are pruned). */
export function recordNotice(n: MandateNotice, now: number = Date.now()): void {
  const all = getNotices(now);
  if (!all.some(x => noticeKey(x) === noticeKey(n))) {
    all.push(n);
  }
  setJSON(NOTICES_KEY, all.slice(-100));
}

/** Upcoming payments from today until `until` (notices + recurring history). */
export function loadUpcoming(until: number, now: number = Date.now()): UpcomingItem[] {
  const rows = queryTransactions({
    types: ['expense'],
    from: now - HISTORY_DAYS * DAY,
    to: now + DAY,
  });
  return buildUpcoming(getNotices(now), detectRecurring(rows, now), rows, now, until);
}
