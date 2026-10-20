// ─── Dashboard insights (pure) ───────────────────────────────────────────────
//
// Three cards, computed once when the app opens (no background work):
//   1. a category up/down by more than 30% against the same stretch of the
//      previous three months (fair early in the month, unlike a full-month average)
//   2. late-night spending (22:00–04:00) over the last 7 days
//   3. the top merchant this month
// Spend here means what the Dashboard calls spend: expenses net of refunds,
// without Investment, transfers, linked settlements or self-moves.

import { displayMerchant } from './merchantDisplay';

const DAY = 86_400_000;
export const CHANGE_THRESHOLD = 0.3;
/** Ignore categories too small for a percentage to mean anything. */
const MIN_BASE = 500;
const NON_SPEND = new Set(['Investment', 'Friend Transfer', 'Loan/Dues']);

export interface InsightRow {
  type: 'expense' | 'income' | 'self';
  amount: number;
  /** Refunds already netted off this row (queryTransactions sets it). */
  paid_back?: number;
  category: string;
  timestamp: number;
  merchant?: string | null;
  counterparty?: string | null;
  settles_id?: number | null;
}

export interface Insight {
  id: string;
  kind: 'category_change' | 'late_night' | 'top_merchant';
  title: string;
  detail: string;
  /** 'up' = spending rose (worth a look), 'down' = fell, 'info' = neutral. */
  tone: 'up' | 'down' | 'info';
}

function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function spendOf(r: InsightRow): number {
  if (r.type !== 'expense' || r.settles_id != null || NON_SPEND.has(r.category)) {
    return 0;
  }
  return Math.max(r.amount - (r.paid_back ?? 0), 0);
}

function monthStart(now: number, back: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() - back, 1).getTime();
}

/** Spend by category in [from, to). */
function byCategory(rows: InsightRow[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.timestamp >= from && r.timestamp < to) {
      const v = spendOf(r);
      if (v > 0) {
        out.set(r.category, (out.get(r.category) ?? 0) + v);
      }
    }
  }
  return out;
}

export function categoryChanges(rows: InsightRow[], now: number): Insight[] {
  const elapsed = now - monthStart(now, 0); // time into this month
  if (elapsed < 3 * DAY) {
    return []; // too early to compare
  }
  const cur = byCategory(rows, monthStart(now, 0), now + 1);
  const prev: Array<Map<string, number>> = [1, 2, 3].map(b => {
    const start = monthStart(now, b);
    const end = Math.min(start + elapsed, monthStart(now, b - 1));
    return byCategory(rows, start, end);
  });
  const month = new Date(now).toLocaleDateString('en-IN', { month: 'long' });
  const names = new Set<string>([...cur.keys(), ...prev.flatMap(m => [...m.keys()])]);
  const found: Array<{ insight: Insight; size: number }> = [];
  for (const c of names) {
    const avg = prev.reduce((s, m) => s + (m.get(c) ?? 0), 0) / 3;
    const spent = cur.get(c) ?? 0;
    if (Math.max(avg, spent) < MIN_BASE || avg < MIN_BASE / 2) {
      continue;
    }
    const pct = (spent - avg) / avg;
    if (Math.abs(pct) <= CHANGE_THRESHOLD) {
      continue;
    }
    const up = pct > 0;
    found.push({
      size: Math.abs(spent - avg),
      insight: {
        id: `cat-${c}`,
        kind: 'category_change',
        title: `${c} ${up ? 'up' : 'down'} ${Math.round(Math.abs(pct) * 100)}%`,
        detail: `${rupees(spent)} so far in ${month} vs ${rupees(avg)} average for the same days over the last 3 months`,
        tone: up ? 'up' : 'down',
      },
    });
  }
  return found.sort((a, b) => b.size - a.size).slice(0, 2).map(f => f.insight);
}

export function lateNight(rows: InsightRow[], now: number): Insight | null {
  let total = 0;
  let n = 0;
  for (const r of rows) {
    if (r.timestamp <= now - 7 * DAY || r.timestamp > now) {
      continue;
    }
    const h = new Date(r.timestamp).getHours();
    const v = spendOf(r);
    if (v > 0 && (h >= 22 || h < 4)) {
      total += v;
      n++;
    }
  }
  if (n === 0) {
    return null;
  }
  return {
    id: 'late-night',
    kind: 'late_night',
    title: `${rupees(total)} spent late at night this week`,
    detail: `${n} payment${n === 1 ? '' : 's'} between 10 pm and 4 am in the last 7 days`,
    tone: 'info',
  };
}

export function topMerchant(rows: InsightRow[], now: number): Insight | null {
  const from = monthStart(now, 0);
  const sums = new Map<string, { name: string; total: number; n: number }>();
  for (const r of rows) {
    if (r.timestamp < from || r.timestamp > now) {
      continue;
    }
    const v = spendOf(r);
    const name = displayMerchant(r.merchant ?? r.counterparty ?? null);
    if (v <= 0 || !name) {
      continue;
    }
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cur = sums.get(key) ?? { name, total: 0, n: 0 };
    cur.total += v;
    cur.n += 1;
    sums.set(key, cur);
  }
  const top = [...sums.values()].sort((a, b) => b.total - a.total)[0];
  if (!top) {
    return null;
  }
  return {
    id: 'top-merchant',
    kind: 'top_merchant',
    title: `Top merchant: ${top.name}`,
    detail: `${rupees(top.total)} across ${top.n} payment${top.n === 1 ? '' : 's'} this month`,
    tone: 'info',
  };
}

/** `rows` should cover the last ~4 months of transactions. */
export function buildInsights(rows: InsightRow[], now: number): Insight[] {
  const out: Insight[] = [...categoryChanges(rows, now)];
  const late = lateNight(rows, now);
  if (late) {
    out.push(late);
  }
  const top = topMerchant(rows, now);
  if (top) {
    out.push(top);
  }
  return out;
}
