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

// ─── Local-day bucketing (for SQL GROUP BY that must agree with the device's
// local calendar day, not the UTC day) ─────────────────────────────────────

/**
 * Milliseconds to add to a UTC timestamp to get local-calendar-day arithmetic.
 * E.g. on an India-set device (UTC+5:30) this is +19,800,000ms. Used so a SQL
 * `CAST((timestamp + ?) / 86400000 AS INTEGER)` bucket agrees with the same
 * local day the transaction list (and this file's `dayStart`) uses — without
 * this, anything between local midnight and the UTC offset (00:00–05:30 IST)
 * lands in the *previous* UTC day's chart bucket while the list correctly
 * shows it under "Today".
 */
export function localTzOffsetMs(): number {
  return -new Date().getTimezoneOffset() * 60000;
}

/** Local-day index for `ts`, matching the bucket produced by the SQL expression above. */
export function localDayIndex(ts: number): number {
  return Math.floor((ts + localTzOffsetMs()) / 86400000);
}

/** Inverse of localDayIndex: the UTC ms instant of local midnight for that day index. */
export function localDayIndexToDate(dayIndex: number): Date {
  return new Date(dayIndex * 86400000 - localTzOffsetMs());
}

/**
 * Number of fully-elapsed local days in `range`, capped at "yesterday" when
 * the range includes today (today itself never counts as completed). Used
 * for "₹X/day" style averages. Returns 0 if the range hasn't completed a
 * single day yet (e.g. the 1st of the month, checked before end of day).
 */
export function completedDays(range: Range): number {
  const todayMs = dayStart(Date.now());
  const rangeFromDay = dayStart(range.from);
  // Effective end is "yesterday" if the range extends into today/future,
  // otherwise the range's own end (fully in the past, e.g. "Last month").
  const rangeToDay = dayStart(Math.min(range.to, Date.now() - 1));
  const effectiveToDay = rangeToDay >= todayMs ? todayMs - 86_400_000 : rangeToDay;

  if (effectiveToDay < rangeFromDay) {
    return 0;
  }
  return Math.round((effectiveToDay - rangeFromDay) / 86_400_000) + 1;
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
