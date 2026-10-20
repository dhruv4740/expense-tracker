// ─── Upcoming payments & subscriptions (pure) ────────────────────────────────
//
// Two sources of "coming up":
//   1. Pre-debit notices (HDFC "E-Mandate! Rs.4000.00 will be deducted on
//      18/10/26 ... For ICCL - Mutual Funds"). These are NOT transactions: the
//      parser's negative guards drop them, and sync records them here instead.
//   2. Recurring payments inferred from history: same merchant, similar
//      amount, ~monthly or ~weekly cadence, at least 3 occurrences.
// A recurring amount that rises more than 10% is flagged as a price increase.

const DAY = 86_400_000;

export interface MandateNotice {
  merchant: string;
  amount: number;
  /** Local midnight of the due date. */
  dueTs: number;
  investment: boolean;
}

const NOTICE_RE =
  /e-?mandate!?\s*(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*will be (?:deducted|debited) on\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/i;
const NOTICE_MERCHANT_RE = /\bfor\s+(.+?)\s*(?:-\s*autopay|autopay|\bumn\b|$)/i;
const INVESTMENT_RE = /mutual fund|iccl|\bsip\b|\bnps\b|zerodha|groww|\bmf\b|bse star|nse/i;

/** Parse an HDFC-style e-mandate pre-debit notice; null for anything else. */
export function parseMandateNotice(body: string): MandateNotice | null {
  const m = body.match(NOTICE_RE);
  if (!m) {
    return null;
  }
  const amount = parseFloat(m[1].replace(/,/g, ''));
  const day = parseInt(m[2], 10);
  const month = parseInt(m[3], 10);
  let year = parseInt(m[4], 10);
  if (year < 100) {
    year += 2000;
  }
  if (!(amount > 0) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const after = body.slice((m.index ?? 0) + m[0].length);
  const mm = after.match(NOTICE_MERCHANT_RE);
  const merchant = (mm?.[1] ?? 'Autopay').replace(/^[,\s:]+/, '').trim() || 'Autopay';
  return {
    merchant,
    amount,
    dueTs: new Date(year, month - 1, day).getTime(),
    investment: INVESTMENT_RE.test(merchant),
  };
}

export function noticeKey(n: Pick<MandateNotice, 'merchant' | 'amount' | 'dueTs'>): string {
  return `${merchantKey(n.merchant)}|${n.amount}|${n.dueTs}`;
}

export function merchantKey(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface HistoryRow {
  id?: number;
  type: 'expense' | 'income' | 'self';
  amount: number;
  timestamp: number;
  merchant?: string | null;
  counterparty?: string | null;
  category?: string;
  settles_id?: number | null;
}

export interface RecurringPayment {
  key: string;
  merchant: string;
  /** Typical (median) amount before any increase. */
  amount: number;
  /** Latest charge amount. */
  latest: number;
  cadence: 'weekly' | 'monthly';
  lastTs: number;
  nextTs: number;
  occurrences: number;
  investment: boolean;
  /** Set when the latest charge is more than 10% above the usual amount. */
  priceIncrease: { from: number; to: number; pct: number } | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cadenceOf(gapsDays: number[]): 'weekly' | 'monthly' | null {
  const ok = (lo: number, hi: number) =>
    gapsDays.filter(g => g >= lo && g <= hi).length / gapsDays.length >= 0.75;
  if (ok(6, 8)) {
    return 'weekly';
  }
  if (ok(26, 35)) {
    return 'monthly';
  }
  return null;
}

/**
 * Recurring expenses in `rows` (expected: about the last 6 months). A group
 * needs ≥3 charges, a steady cadence, and earlier charges within 10% of each
 * other; the latest may differ (that is how a price increase shows up).
 * Groups that stopped (last charge more than 1.5 cadences ago) are dropped.
 */
export function detectRecurring(rows: HistoryRow[], now: number): RecurringPayment[] {
  const groups = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    if (r.type !== 'expense' || r.settles_id != null || !(r.amount > 0)) {
      continue;
    }
    const name = r.merchant ?? r.counterparty;
    const key = merchantKey(name);
    if (key.length < 3) {
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: RecurringPayment[] = [];
  for (const [key, list] of groups) {
    const sorted = list.sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length < 3) {
      continue;
    }
    // Collapse same-day duplicates (two charges a day apart are not a cadence).
    const dedup = sorted.filter((r, i) => i === 0 || r.timestamp - sorted[i - 1].timestamp > DAY);
    if (dedup.length < 3) {
      continue;
    }
    const gaps = dedup.slice(1).map((r, i) => (r.timestamp - dedup[i].timestamp) / DAY);
    const cadence = cadenceOf(gaps);
    if (!cadence) {
      continue;
    }
    const earlier = dedup.slice(0, -1).map(r => r.amount);
    const base = median(earlier);
    if (!earlier.every(a => Math.abs(a - base) <= base * 0.1)) {
      continue;
    }
    const last = dedup[dedup.length - 1];
    if (last.amount > base * 2 || last.amount < base * 0.5) {
      continue;
    }
    const step = (cadence === 'weekly' ? 7 : 30) * DAY;
    if (now - last.timestamp > step * 1.5) {
      continue;
    }
    const pct = (last.amount - base) / base;
    out.push({
      key,
      merchant: (last.merchant ?? last.counterparty ?? key) as string,
      amount: Math.round(base * 100) / 100,
      latest: last.amount,
      cadence,
      lastTs: last.timestamp,
      nextTs: cadence === 'weekly' ? last.timestamp + step : addMonth(last.timestamp),
      occurrences: dedup.length,
      investment: dedup.some(r => r.category === 'Investment'),
      priceIncrease:
        pct > 0.1
          ? { from: Math.round(base * 100) / 100, to: last.amount, pct: Math.round(pct * 100) }
          : null,
    });
  }
  return out.sort((a, b) => a.nextTs - b.nextTs);
}

function addMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()).getTime();
}

export interface UpcomingItem {
  merchant: string;
  amount: number;
  dueTs: number;
  source: 'notice' | 'recurring';
  investment: boolean;
  priceIncrease: RecurringPayment['priceIncrease'];
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Merge notices and predicted recurring payments into one dated list, from
 * today until `until`. A notice wins over a prediction for the same merchant
 * within 4 days. Anything already debited (an expense of the same amount at or
 * after the day before it was due) is dropped, so it is never counted twice.
 */
export function buildUpcoming(
  notices: MandateNotice[],
  recurring: RecurringPayment[],
  recent: HistoryRow[],
  now: number,
  until: number,
): UpcomingItem[] {
  const today = startOfDay(now);
  const items: UpcomingItem[] = [];
  const paid = (merchant: string, amount: number, dueTs: number) =>
    recent.some(
      r =>
        r.type === 'expense' &&
        r.timestamp >= dueTs - DAY &&
        Math.abs(r.amount - amount) <= 1 &&
        (merchantKey(r.merchant ?? r.counterparty) === merchantKey(merchant) ||
          // Mandate notices name the fund house; the bank debit names the AMC/ICCL.
          r.category === 'Investment'),
    );
  for (const n of notices) {
    if (n.dueTs < today || n.dueTs > until || paid(n.merchant, n.amount, n.dueTs)) {
      continue;
    }
    items.push({
      merchant: n.merchant,
      amount: n.amount,
      dueTs: n.dueTs,
      source: 'notice',
      investment: n.investment,
      priceIncrease: null,
    });
  }
  for (const r of recurring) {
    // A prediction may roll forward more than once inside the window (weekly).
    const step = (r.cadence === 'weekly' ? 7 : 30) * DAY;
    for (let due = r.nextTs, i = 0; due <= until && i < 6; due = r.cadence === 'weekly' ? due + step : addMonth(due), i++) {
      if (due < today) {
        continue;
      }
      const covered = items.some(
        it => it.source === 'notice' && merchantKey(it.merchant) === r.key && Math.abs(it.dueTs - due) <= 4 * DAY,
      );
      if (covered || paid(r.merchant, r.latest, due)) {
        continue;
      }
      items.push({
        merchant: r.merchant,
        amount: r.latest,
        dueTs: startOfDay(due),
        source: 'recurring',
        investment: r.investment,
        priceIncrease: r.priceIncrease,
      });
    }
  }
  return items.sort((a, b) => a.dueTs - b.dueTs);
}

export function sumAmounts(items: UpcomingItem[]): number {
  return Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
}
