// ─── Who owes whom (pure) ────────────────────────────────────────────────────
//
// A split expense records `owed_amount` (what others should pay back) and,
// optionally, `owed_friend` (who). Repayments are opposite-direction rows with
// settles_id = the split row (Uber "Link repayment", cancel-out links). A
// friend's balance = Σ owed − Σ repaid, never below zero per split row.

export type SplitPreset = 'half' | 'third' | 'twoThirds';

const PRESET_FRACTION: Record<SplitPreset, number> = {
  half: 1 / 2,
  third: 1 / 3,
  twoThirds: 2 / 3,
};

export const PRESET_LABEL: Record<SplitPreset, string> = {
  half: '½',
  third: '⅓',
  twoThirds: '⅔',
};

/** What the friend owes for a preset share of the fare, rounded to paise. */
export function presetOwed(amount: number, preset: SplitPreset): number {
  if (!(amount > 0)) {
    return 0;
  }
  return Math.round(amount * PRESET_FRACTION[preset] * 100) / 100;
}

export interface LedgerRow {
  id: number;
  type: 'expense' | 'income' | 'self';
  amount: number;
  timestamp: number;
  merchant?: string | null;
  counterparty?: string | null;
  owed_amount?: number | null;
  owed_friend?: string | null;
  settles_id?: number | null;
}

export interface LedgerEntry {
  kind: 'owed' | 'repaid';
  row: LedgerRow;
  /** Amount this entry moves the balance by (owed: +, repaid: −). */
  delta: number;
}

export interface FriendBalance {
  /** Display name ('' for splits with no friend chosen). */
  name: string;
  owed: number;
  repaid: number;
  outstanding: number;
  entries: LedgerEntry[];
}

const UNASSIGNED = 'Not assigned';

function keyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Per-friend balances from split rows (owed_amount > 0, not themselves a
 * settlement) and the opposite-direction rows that settle them. A repayment
 * larger than what is owed on its split row only counts up to the owed amount.
 */
export function buildLedger(rows: LedgerRow[]): FriendBalance[] {
  const children = new Map<number, LedgerRow[]>();
  for (const r of rows) {
    if (r.settles_id != null) {
      const list = children.get(r.settles_id) ?? [];
      list.push(r);
      children.set(r.settles_id, list);
    }
  }
  const balances = new Map<string, FriendBalance>();
  const parents = rows
    .filter(r => r.settles_id == null && (r.owed_amount ?? 0) > 0.005)
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const p of parents) {
    const name = (p.owed_friend ?? '').trim();
    const key = keyOf(name);
    let b = balances.get(key);
    if (!b) {
      b = { name: name || UNASSIGNED, owed: 0, repaid: 0, outstanding: 0, entries: [] };
      balances.set(key, b);
    }
    const owed = p.owed_amount ?? 0;
    b.owed += owed;
    b.entries.push({ kind: 'owed', row: p, delta: owed });
    let remaining = owed;
    for (const c of (children.get(p.id) ?? []).sort((x, y) => x.timestamp - y.timestamp)) {
      // Only opposite-direction rows are repayments (same-direction links are legacy Uber data).
      if (c.type === p.type || c.type === 'self') {
        continue;
      }
      const counted = Math.min(c.amount, remaining);
      remaining -= counted;
      b.repaid += counted;
      b.entries.push({ kind: 'repaid', row: c, delta: -counted });
    }
  }
  return [...balances.values()]
    .map(b => ({
      ...b,
      owed: round2(b.owed),
      repaid: round2(b.repaid),
      outstanding: round2(b.owed - b.repaid),
      entries: b.entries.sort((x, y) => y.row.timestamp - x.row.timestamp),
    }))
    .sort((a, b) => b.outstanding - a.outstanding);
}

/** Total still owed to the user across all friends. */
export function totalOutstanding(ledger: FriendBalance[]): number {
  return round2(ledger.reduce((s, b) => s + b.outstanding, 0));
}
