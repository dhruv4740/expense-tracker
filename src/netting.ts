// ─── Pair-to-cancel netting (pure mirror of the SQL in db.ts) ────────────────
//
// db.ts runs this in SQL (NETTING_JOIN / EFFECTIVE_AMOUNT) because op-sqlite is
// native and can't load under Jest. This module is the same arithmetic over
// in-memory rows so the rule can be unit-tested; keep the two in sync.
//
// Rule: a settling row (settles_id = parent.id) is excluded from every total.
// If it points the OPPOSITE way to its parent (income repays an expense, or an
// expense returns an income) it also reduces the parent:
//   effective(parent) = MAX(amount - SUM(opposite-direction children), 0)
// Same-direction links exclude the child but leave the parent whole.

export interface NetRow {
  id: number;
  type: 'expense' | 'income' | 'self';
  amount: number;
  category: string;
  timestamp: number;
  settles_id?: number | null;
}

const isMoney = (t: NetRow['type']) => t === 'expense' || t === 'income';

/** Sum and count of opposite-direction children per parent id. */
export function paidBack(rows: NetRow[]): Map<number, { paid: number; n: number }> {
  const byId = new Map(rows.map(r => [r.id, r]));
  const out = new Map<number, { paid: number; n: number }>();
  for (const c of rows) {
    if (c.settles_id == null || !isMoney(c.type)) {
      continue;
    }
    const p = byId.get(c.settles_id);
    if (!p || !isMoney(p.type) || p.type === c.type) {
      continue;
    }
    const cur = out.get(p.id) ?? { paid: 0, n: 0 };
    out.set(p.id, { paid: cur.paid + c.amount, n: cur.n + 1 });
  }
  return out;
}

export function effectiveAmount(amount: number, paid: number): number {
  return Math.max(amount - paid, 0);
}

export interface NetSummary {
  spent: number;
  received: number;
  /** Family-category income (netted). */
  fromFamily: number;
  /** received minus fromFamily. */
  earned: number;
  byCategory: { category: string; total: number }[];
}

/** Dashboard hero: what Spent cost after family money covered part of it. */
export function outOfPocket(spent: number, fromFamily: number): number {
  return Math.max(spent - fromFamily, 0);
}

/** Mirrors getSummary's received / byCategory / spent. */
export function netSummary(
  rows: NetRow[],
  range: { from: number; to: number },
  nonSpend: string[],
): NetSummary {
  const paid = paidBack(rows);
  const eff = (r: NetRow) => effectiveAmount(r.amount, paid.get(r.id)?.paid ?? 0);
  let received = 0;
  let fromFamily = 0;
  const cats = new Map<string, number>();
  for (const r of rows) {
    if (
      !isMoney(r.type) ||
      r.settles_id != null ||
      nonSpend.includes(r.category) ||
      r.timestamp < range.from ||
      r.timestamp > range.to
    ) {
      continue;
    }
    if (r.type === 'income') {
      received += eff(r);
      if (r.category === 'Family') {
        fromFamily += eff(r);
      }
    }
    cats.set(r.category, (cats.get(r.category) ?? 0) + (r.type === 'expense' ? eff(r) : -eff(r)));
  }
  const byCategory = [...cats.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
  const spent = byCategory.reduce((s, c) => (c.total > 0 ? s + c.total : s), 0);
  return { spent, received, fromFamily, earned: Math.max(received - fromFamily, 0), byCategory };
}

/** Mirrors getUberSummary's spent / reimbursed / net. */
export function netUber(
  rows: NetRow[],
  range: { from: number; to: number },
): { spent: number; reimbursed: number; net: number } {
  const paid = paidBack(rows);
  const byId = new Map(rows.map(r => [r.id, r]));
  let spent = 0;
  let reimbursed = 0;
  // Legacy same-direction links: an expense row linked to an Uber ride counts in full.
  for (const r of rows) {
    const ride = r.settles_id != null ? byId.get(r.settles_id) : undefined;
    if (
      ride &&
      r.type === 'expense' &&
      ride.type === 'expense' &&
      ride.category === 'Uber' &&
      ride.timestamp >= range.from &&
      ride.timestamp <= range.to
    ) {
      reimbursed += r.amount;
    }
  }
  for (const r of rows) {
    if (
      r.category !== 'Uber' ||
      r.settles_id != null ||
      r.timestamp < range.from ||
      r.timestamp > range.to
    ) {
      continue;
    }
    const p = paid.get(r.id)?.paid ?? 0;
    if (r.type === 'expense') {
      spent += r.amount;
      reimbursed += Math.min(p, r.amount);
    } else if (r.type === 'income') {
      reimbursed += effectiveAmount(r.amount, p);
    }
  }
  return { spent, reimbursed, net: Math.max(spent - reimbursed, 0) };
}
