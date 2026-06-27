// ─── Date helpers ─────────────────────────────────────────────────────────────
//
// Utility functions for range computation, date formatting, and SectionList
// grouping. No external dependencies — pure TS, no datetimepicker.

import type { TransactionRow } from './db';
import type { Range } from './db';

// ─── Range helpers ────────────────────────────────────────────────────────────

/** Start of month 00:00:000 → end of month 23:59:59.999 for `ref` (default: now). */
export function monthRange(ref?: Date): Range {
  const d = ref ?? new Date();
  const year = d.getFullYear();
  const month = d.getMonth();
  return {
    from: new Date(year, month, 1).getTime(),
    to: new Date(year, month + 1, 0, 23, 59, 59, 999).getTime(),
  };
}

/** Same range but for the calendar month immediately before `ref`. */
export function prevMonthRange(ref?: Date): Range {
  const d = ref ?? new Date();
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-based
  // month - 1 works fine; Date handles negative month → previous year
  return {
    from: new Date(year, month - 1, 1).getTime(),
    to: new Date(year, month, 0, 23, 59, 59, 999).getTime(),
  };
}

/** Rolling window: from (now − n days 00:00) to now. */
export function lastNDaysRange(n: number): Range {
  const now = Date.now();
  const from = new Date();
  from.setDate(from.getDate() - n + 1);
  from.setHours(0, 0, 0, 0);
  return { from: from.getTime(), to: now };
}

/** Range covering the last 3 calendar months (including current). */
export function last3MonthsRange(ref?: Date): Range {
  const d = ref ?? new Date();
  const year = d.getFullYear();
  const month = d.getMonth();
  return {
    from: new Date(year, month - 2, 1).getTime(),
    to: new Date(year, month + 1, 0, 23, 59, 59, 999).getTime(),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** "28 Jun, 03:45 PM" */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${date}, ${time}`;
}

/** "28 Jun" for chart axis labels. */
export function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ─── SectionList grouping ─────────────────────────────────────────────────────

/** Midnight epoch-ms for the date of timestamp `ts`. */
function dayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Group rows into SectionList sections, newest section first.
 * Section titles: 'Today', 'Yesterday', or 'DD Mon' (e.g. '12 Jun').
 *
 * Rows within each section keep their original ordering (caller passes DESC).
 */
export function groupByDay(
  rows: TransactionRow[],
): { title: string; data: TransactionRow[] }[] {
  const todayMs = dayStart(Date.now());
  const yesterdayMs = todayMs - 86_400_000;

  const map = new Map<number, TransactionRow[]>();
  const order: number[] = [];

  for (const row of rows) {
    const key = dayStart(row.timestamp);
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(row);
  }

  // order is already newest-first if rows are DESC
  return order.map(key => {
    let title: string;
    if (key === todayMs) {
      title = 'Today';
    } else if (key === yesterdayMs) {
      title = 'Yesterday';
    } else {
      const d = new Date(key);
      title = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }
    return { title, data: map.get(key)! };
  });
}
