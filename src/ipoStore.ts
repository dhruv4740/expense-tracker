// ─── IPO tracker: persistence glue ───────────────────────────────────────────
//
// IPO status messages are kept as a small event list in app_settings (no
// schema change). The tracker screen and the "bank debit → Investment" rule
// both read it. Computed on demand; nothing runs in the background.

import { queryTransactions, updateTransaction } from './db';
import { getJSON, setJSON } from './settings';
import { activeIssuers, buildIpos, isIpoDebit } from './ipo';
import type { IpoEvent, IpoIssuer, IpoSummaryItem } from './ipo';

const EVENTS_KEY = 'ipo_events';
const MAX_EVENTS = 400;
const DAY = 86_400_000;

export function getIpoEvents(): IpoEvent[] {
  return getJSON<IpoEvent[]>(EVENTS_KEY, []);
}

/** Store an event (idempotent for the same message arriving on two channels). */
export function recordIpoEvent(e: IpoEvent): void {
  const all = getIpoEvents();
  const dup = all.some(
    x =>
      x.kind === e.kind &&
      x.name === e.name &&
      (x.appNo ?? '') === (e.appNo ?? '') &&
      (x.amount ?? 0) === (e.amount ?? 0) &&
      Math.abs(x.ts - e.ts) < DAY,
  );
  if (!dup) {
    all.push(e);
    setJSON(EVENTS_KEY, all.slice(-MAX_EVENTS));
  }
}

/** Issuers whose bank debit should be counted as Investment. */
export function getIpoIssuers(): IpoIssuer[] {
  return activeIssuers(getIpoEvents());
}

/** Tracker rows: events plus the Investment debits the bank confirmed. */
export function loadIpos(now: number = Date.now()): IpoSummaryItem[] {
  const debits = queryTransactions({
    types: ['expense'],
    categories: ['Investment'],
    from: now - 365 * DAY,
    to: now + DAY,
  }).map(r => ({ ts: r.timestamp, amount: r.amount, merchant: r.merchant }));
  return buildIpos(getIpoEvents(), debits);
}

/**
 * Re-tag recent bank debits that turn out to be an IPO allotment debit (the
 * block notice can arrive after the debit when messages are drained late).
 * Manual categories are never touched. Returns rows changed.
 */
export function reconcileIpoDebits(now: number = Date.now()): number {
  const issuers = getIpoIssuers();
  if (issuers.length === 0) {
    return 0;
  }
  let changed = 0;
  for (const r of queryTransactions({ types: ['expense'], from: now - 60 * DAY, to: now + DAY })) {
    if (
      r.id != null &&
      r.category !== 'Investment' &&
      r.category_source !== 'manual' &&
      isIpoDebit(r.merchant ?? r.counterparty, r.amount, issuers)
    ) {
      updateTransaction(r.id, { category: 'Investment' });
      changed++;
    }
  }
  return changed;
}
