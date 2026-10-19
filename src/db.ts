import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { localTzOffsetMs } from './dates';
import { hash, strictDedupKey } from './dedup';
import type { Channel } from './dedup';

export type { Channel } from './dedup';
export { strictDedupKey, isSoftDuplicate } from './dedup';

export type TransactionType = 'expense' | 'income' | 'self';

export interface TransactionRow {
  id?: number;
  amount: number;
  merchant: string | null;
  source: string | null;
  raw_text: string | null;
  category: string;
  timestamp: number;
  type: TransactionType;
  counterparty?: string | null;
  account?: string | null;
  note?: string | null;
  category_source?: 'auto' | 'manual';
  dedup_key?: string;
  /** null for all pre-migration history — never participates in soft-dedup drops. */
  channel?: Channel | null;
  /**
   * This row is money moving to settle transaction `settles_id` — e.g. paying a
   * friend back for their share of a ride you already recorded. Settling rows
   * are excluded from spend/income totals (the settled row is the real cost)
   * but stay visible in the transactions list.
   */
  settles_id?: number | null;
  /** On a split expense: how much the user expects to be paid back. */
  owed_amount?: number | null;
  /**
   * Read-only, set by queryTransactions: total of opposite-direction rows linked
   * to this one via settles_id (see NETTING_JOIN). Undefined/0 when none.
   */
  paid_back?: number;
}

export interface Range {
  from: number;
  to: number;
}

export interface Summary {
  spent: number;
  received: number;
  net: number;
  /** Sum of expense-type Investment-category transactions in the range —
   * tracked separately since SIPs/mutual funds aren't "spending". */
  invested: number;
  /**
   * Net money moved to/from other people (Friend Transfer, Loan/Dues) in the
   * range: positive = you paid out more than you got back. Excluded from
   * `spent`/`received` but surfaced here so the money stays visible rather
   * than silently vanishing from the app.
   */
  transferred: number;
  byCategory: { category: string; total: number }[];
  byDay: { day: number; total: number }[];
}

export interface UberSummary {
  spent: number;
  reimbursed: number;
  /** spent - reimbursed. Can go negative if reimbursements exceed spend. */
  net: number;
  rideCount: number;
  reimbursementCount: number;
  /** Distinct local calendar days with at least one Uber expense in range. */
  activeDays: number;
}

/** Category excluded from spend totals/charts (tracked separately as `invested`). */
const INVESTMENT_CATEGORY = 'Investment';

/**
 * Categories that move money between people rather than spending it. Excluded
 * from both `spent` and `received` (and surfaced separately as `transferred`)
 * for the same reason Investment is: paying a friend back for a shared fare
 * isn't new spending, and them paying you back isn't income — the underlying
 * expense row is the real cost. Counting both double-counted every fare split.
 */
const TRANSFER_CATEGORIES = ['Friend Transfer', 'Loan/Dues'];

/** `?, ?` placeholder list + params for the categories excluded from spend. */
const NON_SPEND_CATEGORIES = [INVESTMENT_CATEGORY, ...TRANSFER_CATEGORIES];
const NON_SPEND_PLACEHOLDERS = NON_SPEND_CATEGORIES.map(() => '?').join(', ');

/** An Uber ride with money still owed back on it. */
export interface UnsettledRide {
  id: number;
  amount: number;
  timestamp: number;
  /** What the user declared they expect back when saving the split. */
  owedAmount: number;
  /** owedAmount minus everything already linked as settling this ride. */
  outstanding: number;
}

export interface Budget {
  category: string;
  monthly_limit: number;
}

/** Reserved budgets key for the overall monthly limit (not a real category). */
export const OVERALL_BUDGET_KEY = '__overall__';

export interface TransactionFilters {
  from?: number;
  to?: number;
  categories?: string[];
  types?: TransactionType[];
  source?: string;
  /** free-text match against merchant / counterparty / raw_text / amount */
  search?: string;
  /** include type='self' rows; defaults to false (self-transfers hidden) */
  includeSelf?: boolean;
  /** minimum transaction amount (inclusive) */
  amountMin?: number;
  /** maximum transaction amount (inclusive) */
  amountMax?: number;
}

// op-sqlite QueryResult: rows is Array<Record<string, Scalar>>
// rowsAffected: number of rows changed (INSERT/UPDATE/DELETE)
// Scalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView

let db: DB | null = null;

const SCHEMA_VERSION = 4;

function requireDb(): DB {
  if (!db) {
    throw new Error('DB not initialised — call initDb() first');
  }
  return db;
}

function getUserVersion(conn: DB): number {
  const res = conn.executeSync('PRAGMA user_version;');
  const row = (res.rows ?? [])[0] as Record<string, unknown> | undefined;
  return row != null ? Number(row.user_version ?? 0) : 0;
}

/**
 * Linear migrations gated by PRAGMA user_version so existing installs (which
 * hold live data) are ALTERed in place rather than recreated. Each step is
 * idempotent and bumps the version exactly once.
 */
function migrate(conn: DB): void {
  let version = getUserVersion(conn);

  // v0 → v1: base schema (matches what shipped before migrations existed).
  if (version < 1) {
    conn.executeSync(`
      CREATE TABLE IF NOT EXISTS transactions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        amount     REAL    NOT NULL,
        merchant   TEXT,
        source     TEXT,
        raw_text   TEXT,
        category   TEXT,
        timestamp  INTEGER NOT NULL,
        type       TEXT    NOT NULL DEFAULT 'expense',
        dedup_key  TEXT    UNIQUE
      );
    `);
    conn.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);',
    );
    conn.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);',
    );
    conn.executeSync('PRAGMA user_version = 1;');
    version = 1;
  }

  // v1 → v2: new columns + auxiliary tables.
  if (version < 2) {
    // ADD COLUMN runs exactly once because the step is version-gated.
    conn.executeSync('ALTER TABLE transactions ADD COLUMN counterparty TEXT;');
    conn.executeSync('ALTER TABLE transactions ADD COLUMN account TEXT;');
    conn.executeSync('ALTER TABLE transactions ADD COLUMN note TEXT;');
    conn.executeSync(
      "ALTER TABLE transactions ADD COLUMN category_source TEXT DEFAULT 'auto';",
    );
    conn.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);',
    );

    conn.executeSync(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    conn.executeSync(`
      CREATE TABLE IF NOT EXISTS merchant_rules (
        key        TEXT PRIMARY KEY,
        category   TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    conn.executeSync(`
      CREATE TABLE IF NOT EXISTS budgets (
        category      TEXT PRIMARY KEY,
        monthly_limit REAL NOT NULL
      );
    `);
    conn.executeSync('PRAGMA user_version = 2;');
    version = 2;
  }

  // v2 → v3: additive-only. NULL for every existing row (data-preservation
  // rule — no UPDATE/rewrite of existing rows). NULL channel never
  // participates in the cross-channel soft-dedup check (see insertTransaction).
  if (version < 3) {
    conn.executeSync('ALTER TABLE transactions ADD COLUMN channel TEXT;');
    // Literal 3, NOT SCHEMA_VERSION — interpolating the constant here would
    // stamp the newest version onto a v2 install and silently skip every
    // later migration step.
    conn.executeSync('PRAGMA user_version = 3;');
    version = 3;
  }

  // v3 → v4: settlement links. Additive-only, no backfill — every existing row
  // gets settles_id = NULL / owed_amount = NULL and keeps behaving exactly as
  // it does today (reimbursements hand-tagged 'Uber' still net via the legacy
  // category path in getUberSummary).
  //
  //  settles_id  — this row is money moving to settle row N. It is NOT
  //                independent spend/income, so it's excluded from every
  //                total, but it stays VISIBLE in the transactions list
  //                (unlike type='self', which is hidden by default and so
  //                read as data loss).
  //  owed_amount — on a split expense: how much the user expects back. Without
  //                this there is nothing for the reimbursement matcher to
  //                match against, which is why the old suggestions were
  //                pure recency.
  if (version < 4) {
    conn.executeSync('ALTER TABLE transactions ADD COLUMN settles_id INTEGER;');
    conn.executeSync('ALTER TABLE transactions ADD COLUMN owed_amount REAL;');
    conn.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_tx_settles ON transactions(settles_id);',
    );
    conn.executeSync('PRAGMA user_version = 4;');
    version = 4;
  }

  // Catches a bumped SCHEMA_VERSION with no matching migration step — the
  // failure mode the interpolated PRAGMA above used to cause silently.
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Migration incomplete: at v${version}, expected v${SCHEMA_VERSION}`,
    );
  }
}

export function initDb(): void {
  if (db) {
    return; // idempotent
  }

  db = open({ name: 'expenses.db' });
  db.executeSync('PRAGMA journal_mode=WAL;');
  migrate(db);
}

// ─── transactions: write ──────────────────────────────────────────────────────

export function insertTransaction(
  tx: Omit<TransactionRow, 'id' | 'dedup_key'>,
  options: { skipSoftDedup?: boolean } = {},
): boolean {
  const conn = requireDb();

  // Soft cross-channel dedup (user-chosen policy): the SAME payment can arrive
  // via both SMS and the bank-app notification (different source/raw_text →
  // different strict key). A duplicate is only dropped when:
  //  - the existing row's channel is known (non-NULL) AND different from the
  //    incoming channel — same-channel repeats are ALWAYS kept, and any
  //    pre-migration row (channel NULL) never triggers a drop;
  //  - amount matches and timestamps are within 2 minutes;
  //  - counterparties match, OR at least one side's counterparty is unknown
  //    (bank SMS often lack one) — if BOTH are known and differ, it's a
  //    different payment, not a duplicate.
  // Manual entries are deliberate user actions and never soft-deduped.
  if (!options.skipSoftDedup && (tx.channel === 'sms' || tx.channel === 'notification')) {
    const existing = conn.executeSync(
      `SELECT 1 FROM transactions
        WHERE amount = ?
          AND ABS(timestamp - ?) < 120000
          AND channel IS NOT NULL AND channel != ? AND channel IN ('sms', 'notification')
          AND (counterparty IS NULL OR ? IS NULL OR counterparty = ?)
        LIMIT 1`,
      [tx.amount, tx.timestamp, tx.channel, tx.counterparty ?? null, tx.counterparty ?? null],
    );
    if ((existing.rows ?? []).length > 0) {
      return false;
    }
  }

  const dedup_key = strictDedupKey(tx);

  const res = conn.executeSync(
    `INSERT OR IGNORE INTO transactions
       (amount, merchant, source, raw_text, category, timestamp, type,
        counterparty, account, note, category_source, dedup_key, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.amount,
      tx.merchant ?? null,
      tx.source ?? null,
      tx.raw_text ?? null,
      tx.category,
      tx.timestamp,
      tx.type,
      tx.counterparty ?? null,
      tx.account ?? null,
      tx.note ?? null,
      tx.category_source ?? 'auto',
      dedup_key,
      tx.channel ?? null,
    ],
  );

  return res.rowsAffected > 0;
}

/** Insert a user-entered transaction. Always stored (unique dedup_key nonce). */
export function insertManual(
  tx: Omit<TransactionRow, 'id' | 'dedup_key' | 'source' | 'category_source'>,
): boolean {
  const conn = requireDb();
  const dedup_key = hash(
    `manual|${tx.timestamp}|${tx.amount}|${tx.merchant}|${Math.random()}`,
  );

  const res = conn.executeSync(
    `INSERT INTO transactions
       (amount, merchant, source, raw_text, category, timestamp, type,
        counterparty, account, note, category_source, dedup_key, channel,
        settles_id, owed_amount)
     VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'manual', ?, ?)`,
    [
      tx.amount,
      tx.merchant ?? null,
      tx.raw_text ?? null,
      tx.category,
      tx.timestamp,
      tx.type,
      tx.counterparty ?? null,
      tx.account ?? null,
      tx.note ?? null,
      dedup_key,
      tx.settles_id ?? null,
      tx.owed_amount ?? null,
    ],
  );

  return res.rowsAffected > 0;
}

const EDITABLE_FIELDS: Array<keyof TransactionRow> = [
  'amount',
  'merchant',
  'category',
  'timestamp',
  'type',
  'counterparty',
  'account',
  'note',
  'category_source',
  'settles_id',
  'owed_amount',
];

export function updateTransaction(
  id: number,
  fields: Partial<TransactionRow>,
): boolean {
  const conn = requireDb();
  const cols: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const key of EDITABLE_FIELDS) {
    if (key in fields) {
      cols.push(`${key} = ?`);
      vals.push(
        (fields as Record<string, string | number | null | undefined>)[key] ??
          null,
      );
    }
  }
  if (cols.length === 0) {
    return false;
  }
  vals.push(id);
  const res = conn.executeSync(
    `UPDATE transactions SET ${cols.join(', ')} WHERE id = ?`,
    vals,
  );
  return res.rowsAffected > 0;
}

export function deleteTransaction(id: number): boolean {
  const conn = requireDb();
  // SQLite enforces no foreign keys here, so unlink any rows that settled this
  // one FIRST. Leaving a dangling settles_id would keep those rows excluded
  // from every total, silently hiding real money once its parent is gone.
  conn.executeSync(
    'UPDATE transactions SET settles_id = NULL WHERE settles_id = ?',
    [id],
  );
  const res = conn.executeSync('DELETE FROM transactions WHERE id = ?', [id]);
  return res.rowsAffected > 0;
}

// ─── transactions: read ───────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): TransactionRow {
  return {
    id: row.id != null ? Number(row.id) : undefined,
    amount: Number(row.amount ?? 0),
    merchant: row.merchant != null ? String(row.merchant) : null,
    source: row.source != null ? String(row.source) : null,
    raw_text: row.raw_text != null ? String(row.raw_text) : null,
    category: String(row.category ?? ''),
    timestamp: Number(row.timestamp ?? 0),
    type: ((): TransactionType => {
      const t = String(row.type ?? 'expense');
      return t === 'income' || t === 'self' ? t : 'expense';
    })(),
    counterparty: row.counterparty != null ? String(row.counterparty) : null,
    account: row.account != null ? String(row.account) : null,
    note: row.note != null ? String(row.note) : null,
    category_source: row.category_source === 'manual' ? 'manual' : 'auto',
    dedup_key: row.dedup_key != null ? String(row.dedup_key) : undefined,
    // channel was previously dropped here, so every row read back had
    // channel === undefined and any `row.channel !== 'manual'` guard silently
    // passed for ALL rows (see the Uber double-count guard).
    channel: row.channel != null ? (String(row.channel) as Channel) : null,
    settles_id: row.settles_id != null ? Number(row.settles_id) : null,
    owed_amount: row.owed_amount != null ? Number(row.owed_amount) : null,
  };
}

export function getAll(): TransactionRow[] {
  const conn = requireDb();
  const res = conn.executeSync(
    'SELECT * FROM transactions ORDER BY timestamp DESC',
  );
  return (res.rows ?? []).map(mapRow);
}

/** Flexible, parameterized query for the Transactions screen (search + filters). */
export function queryTransactions(
  filters: TransactionFilters = {},
): TransactionRow[] {
  const conn = requireDb();
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filters.from != null) {
    where.push('timestamp >= ?');
    params.push(filters.from);
  }
  if (filters.to != null) {
    where.push('timestamp <= ?');
    params.push(filters.to);
  }

  if (filters.types && filters.types.length > 0) {
    where.push(`type IN (${filters.types.map(() => '?').join(', ')})`);
    params.push(...filters.types);
  } else if (!filters.includeSelf) {
    // Self-transfers are hidden by default unless explicitly requested.
    where.push("type != 'self'");
  }

  if (filters.categories && filters.categories.length > 0) {
    where.push(`category IN (${filters.categories.map(() => '?').join(', ')})`);
    params.push(...filters.categories);
  }

  if (filters.source) {
    where.push('source = ?');
    params.push(filters.source);
  }

  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    where.push(
      '(merchant LIKE ? OR counterparty LIKE ? OR raw_text LIKE ? OR CAST(amount AS TEXT) LIKE ?)',
    );
    params.push(term, term, term, term);
  }

  if (filters.amountMin != null) {
    where.push('amount >= ?');
    params.push(filters.amountMin);
  }
  if (filters.amountMax != null) {
    where.push('amount <= ?');
    params.push(filters.amountMax);
  }

  const sql =
    'SELECT * FROM transactions' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY timestamp DESC';

  const res = conn.executeSync(sql, params);
  const rows = (res.rows ?? []).map(mapRow);
  const paid = getPaidBackByParent();
  for (const r of rows) {
    const p = r.id != null ? paid.get(r.id) : undefined;
    if (p) {
      r.paid_back = p;
    }
  }
  return rows;
}

/** parent id -> total of opposite-direction rows linked to it. */
export function getPaidBackByParent(): Map<number, number> {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT c.settles_id AS pid, SUM(c.amount) AS paid
       FROM transactions c
       JOIN transactions p ON p.id = c.settles_id
      WHERE c.type IN ('expense', 'income') AND p.type IN ('expense', 'income')
        AND c.type != p.type
      GROUP BY c.settles_id`,
  );
  const out = new Map<number, number>();
  for (const r of res.rows ?? []) {
    out.set(Number(r.pid), Number(r.paid ?? 0));
  }
  return out;
}

// ─── aggregation (in SQL — never .map over all rows) ──────────────────────────

/**
 * Pair-to-cancel netting. A row linked via settles_id to an OPPOSITE-direction
 * parent (an income that repays an expense, or an expense that returns an
 * income) reduces that parent: effective = MAX(amount - paid, 0). The settling
 * rows themselves stay excluded from every total. Same-direction links (the
 * Uber "repayment" mode) exclude the child but do not reduce the parent.
 * Joined as `t` (parent) / `k` (paid-back totals). The math is mirrored in
 * src/netting.ts, which is what the unit tests exercise.
 */
const NETTING_JOIN = `LEFT JOIN (
        SELECT c.settles_id AS pid, SUM(c.amount) AS paid, COUNT(*) AS n
          FROM transactions c
          JOIN transactions p ON p.id = c.settles_id
         WHERE c.type IN ('expense', 'income')
           AND p.type IN ('expense', 'income')
           AND c.type != p.type
         GROUP BY c.settles_id
      ) k ON k.pid = t.id`;
const EFFECTIVE_AMOUNT = 'MAX(t.amount - COALESCE(k.paid, 0), 0)';

/**
 * Spent (expense) / received (income) / net + per-category and per-day spend
 * for a range. Self-transfers are excluded from every figure.
 */
export function getSummary(range: Range): Summary {
  const conn = requireDb();
  const { from, to } = range;

  // `received` previously summed EVERY income row with no category filter, so
  // a friend's payback tagged 'Uber' both reduced the Uber category net AND
  // inflated "Received" (and therefore `net`) — the same money counted twice
  // in opposite directions. It now excludes settling rows and the non-spend
  // categories, which are reported separately as `transferred`.
  const totalsRes = conn.executeSync(
    `SELECT
        COALESCE(SUM(CASE WHEN t.type = 'income'
                           AND t.settles_id IS NULL
                           AND t.category NOT IN (${NON_SPEND_PLACEHOLDERS})
                          THEN ${EFFECTIVE_AMOUNT} END), 0) AS received,
        COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.category = ?
                          THEN t.amount END), 0) AS invested,
        COALESCE(SUM(CASE WHEN t.category IN (${TRANSFER_CATEGORIES.map(() => '?').join(', ')})
                           AND t.type IN ('expense', 'income')
                          THEN CASE WHEN t.type = 'expense' THEN t.amount ELSE -t.amount END
                     END), 0) AS transferred
       FROM transactions t
       ${NETTING_JOIN}
      WHERE t.timestamp BETWEEN ? AND ?`,
    [
      ...NON_SPEND_CATEGORIES,
      INVESTMENT_CATEGORY,
      ...TRANSFER_CATEGORIES,
      from,
      to,
    ],
  );
  const totRow = (totalsRes.rows ?? [])[0] ?? {};
  const received = Number(totRow.received ?? 0);
  const invested = Number(totRow.invested ?? 0);
  const transferred = Number(totRow.transferred ?? 0);

  // Nets income against expense within the same category (e.g. a debit and a
  // credit both tagged "Uber" cancel out) so a category's total reflects what
  // it actually cost net of any money credited back under that same tag.
  // Investment is excluded here (and from spent/byDay) so SIPs/mutual funds
  // don't count as "spending" — see the separate `invested` total above.
  const catRes = conn.executeSync(
    `SELECT t.category AS category,
            SUM(CASE WHEN t.type = 'expense' THEN ${EFFECTIVE_AMOUNT}
                     WHEN t.type = 'income'  THEN -${EFFECTIVE_AMOUNT}
                     ELSE 0 END) AS total
       FROM transactions t
       ${NETTING_JOIN}
      WHERE t.type IN ('expense', 'income')
        AND t.settles_id IS NULL
        AND t.category NOT IN (${NON_SPEND_PLACEHOLDERS})
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY t.category
      ORDER BY total DESC`,
    [...NON_SPEND_CATEGORIES, from, to],
  );
  const byCategory = (catRes.rows ?? []).map(row => ({
    category: String(row.category ?? ''),
    total: Number(row.total ?? 0),
  }));

  // `spent` MUST be derived from the same netted-per-category totals as
  // `byCategory` (summing only the positive nets — a category netted to <=0
  // by an offsetting refund/credit is not "spend"). Computing it as a
  // separate raw SUM(expense) here previously double-counted: a category
  // with a same-month refund would net to <=0 and disappear from
  // byCategory/the donut, while the raw expense side still counted toward
  // `spent` — so the center total and the visible slices silently disagreed,
  // and that category (e.g. Uber) looked like it vanished even though money
  // was genuinely spent on it this period.
  const spent = byCategory.reduce(
    (sum, bc) => (bc.total > 0 ? sum + bc.total : sum),
    0,
  );

  // Bucket by LOCAL calendar day, not UTC day — otherwise anything between
  // local midnight and the UTC offset (00:00-05:30 on an IST device) lands in
  // yesterday's chart bucket while the transaction list correctly shows it
  // under "Today". `day` here is a localDayIndex (see dates.ts); convert back
  // with localDayIndexToDate() when rendering labels.
  const tzOffsetMs = localTzOffsetMs();
  const dayRes = conn.executeSync(
    `SELECT CAST((t.timestamp + ?) / 86400000 AS INTEGER) AS day,
            SUM(${EFFECTIVE_AMOUNT}) AS total
       FROM transactions t
       ${NETTING_JOIN}
      WHERE t.type = 'expense'
        AND t.settles_id IS NULL
        AND t.category NOT IN (${NON_SPEND_PLACEHOLDERS})
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY day
      ORDER BY day ASC`,
    [tzOffsetMs, ...NON_SPEND_CATEGORIES, from, to],
  );
  const byDay = (dayRes.rows ?? []).map(row => ({
    day: Number(row.day ?? 0),
    total: Number(row.total ?? 0),
  }));

  return {
    spent,
    received,
    net: received - spent,
    invested,
    transferred,
    byCategory,
    byDay,
  };
}

/**
 * Net Uber cost for a range: spend minus reimbursements, both tagged
 * category='Uber' regardless of who paid whom. This is the single source of
 * truth the Dashboard card and Uber screen both read from, so they can never
 * disagree the way an all-time raw sum and a this-month raw sum used to.
 */
export function getUberSummary(range: Range): UberSummary {
  const conn = requireDb();
  const { from, to } = range;

  // Rides = Uber-category expenses that are NOT themselves settling something.
  // Reimbursed uses the same pair-to-cancel rule as getSummary (so the Uber card
  // and the Dashboard donut always agree): per ride, the income rows linked via
  // settles_id, capped at the ride's amount; plus legacy income hand-tagged
  // 'Uber' with no link (every pre-v4 reimbursement), net of anything that
  // itself cancels it. Same-direction links never reduce a ride in the Dashboard
  // totals, but legacy ones still count as reimbursed on this card (last branch).
  const totalsRes = conn.executeSync(
    `SELECT
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS spent,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN 1 END), 0) AS rideCount
       FROM transactions
      WHERE category = 'Uber' AND type IN ('expense', 'income')
        AND settles_id IS NULL AND timestamp BETWEEN ? AND ?`,
    [from, to],
  );

  const reimbRes = conn.executeSync(
    `SELECT COALESCE(SUM(amount), 0) AS reimbursed, COALESCE(SUM(n), 0) AS reimbursementCount
       FROM (
         SELECT MIN(k.paid, t.amount) AS amount, k.n AS n
           FROM transactions t
           ${NETTING_JOIN}
          WHERE t.category = 'Uber' AND t.type = 'expense'
            AND t.settles_id IS NULL
            AND k.pid IS NOT NULL
            AND t.timestamp BETWEEN ? AND ?
         UNION ALL
         SELECT ${EFFECTIVE_AMOUNT} AS amount,
                CASE WHEN ${EFFECTIVE_AMOUNT} > 0 THEN 1 ELSE 0 END AS n
           FROM transactions t
           ${NETTING_JOIN}
          WHERE t.category = 'Uber' AND t.type = 'income'
            AND t.settles_id IS NULL AND t.timestamp BETWEEN ? AND ?
         UNION ALL
         -- Legacy same-direction links (Uber "repayment" mode: an expense row
         -- linked to a ride). Counted in full as before, so existing Uber
         -- numbers do not move now that netting is opposite-direction only.
         SELECT s.amount AS amount, 1 AS n
           FROM transactions s
           JOIN transactions ride ON ride.id = s.settles_id
          WHERE ride.category = 'Uber' AND ride.type = 'expense'
            AND s.type = 'expense'
            AND ride.timestamp BETWEEN ? AND ?
       )`,
    [from, to, from, to, from, to],
  );
  const totRow = (totalsRes.rows ?? [])[0] ?? {};
  const reimbRow = (reimbRes.rows ?? [])[0] ?? {};
  const spent = Number(totRow.spent ?? 0);
  const rideCount = Number(totRow.rideCount ?? 0);
  const reimbursed = Number(reimbRow.reimbursed ?? 0);
  const reimbursementCount = Number(reimbRow.reimbursementCount ?? 0);

  const tzOffsetMs = localTzOffsetMs();
  const activeDaysRes = conn.executeSync(
    `SELECT COUNT(DISTINCT CAST((timestamp + ?) / 86400000 AS INTEGER)) AS activeDays
       FROM transactions
      WHERE category = 'Uber' AND type = 'expense'
        AND settles_id IS NULL AND timestamp BETWEEN ? AND ?`,
    [tzOffsetMs, from, to],
  );
  const activeDays = Number((activeDaysRes.rows ?? [])[0]?.activeDays ?? 0);

  return { spent, reimbursed, net: spent - reimbursed, rideCount, reimbursementCount, activeDays };
}

/**
 * Uber rides in the range that declared an `owed_amount` and haven't been fully
 * paid back yet, with how much is still outstanding. This is what the
 * reimbursement matcher scores candidates against — before v4 nothing recorded
 * what the user was owed, so there was nothing to match on and the "suggestions"
 * were just the most recent credits.
 */
export function getUnsettledRides(range: Range): UnsettledRide[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT r.id, r.amount, r.timestamp, r.owed_amount,
            COALESCE((SELECT SUM(s.amount) FROM transactions s
                       WHERE s.settles_id = r.id AND s.type = 'income'), 0) AS settled
       FROM transactions r
      WHERE r.category = 'Uber' AND r.type = 'expense'
        AND r.settles_id IS NULL
        AND r.owed_amount IS NOT NULL AND r.owed_amount > 0
        AND r.timestamp BETWEEN ? AND ?
      ORDER BY r.timestamp DESC`,
    [range.from, range.to],
  );
  return (res.rows ?? [])
    .map(row => {
      const owed = Number(row.owed_amount ?? 0);
      const settled = Number(row.settled ?? 0);
      return {
        id: Number(row.id),
        amount: Number(row.amount ?? 0),
        timestamp: Number(row.timestamp ?? 0),
        owedAmount: owed,
        outstanding: Math.round((owed - settled) * 100) / 100,
      };
    })
    .filter(r => r.outstanding > 0.005);
}

/**
 * Link `id` as settling `settlesId` (or pass null to unlink). Used by the
 * reimbursement matcher and by the undo path — every settlement is reversible,
 * unlike the old flow which flipped a real ride to type='self' where the user
 * could never find it again.
 */
export function setSettlement(id: number, settlesId: number | null): boolean {
  return updateTransaction(id, { settles_id: settlesId });
}

/** Rows linked to `id` (its settlers) and, if `id` itself settles one, that parent. */
export function getSettlementLinks(id: number): {
  children: TransactionRow[];
  parent: TransactionRow | null;
} {
  const conn = requireDb();
  const kids = conn.executeSync(
    'SELECT * FROM transactions WHERE settles_id = ? ORDER BY timestamp ASC',
    [id],
  );
  const me = conn.executeSync(
    'SELECT settles_id FROM transactions WHERE id = ? LIMIT 1',
    [id],
  );
  const pid = (me.rows ?? [])[0]?.settles_id;
  let parent: TransactionRow | null = null;
  if (pid != null) {
    const pr = conn.executeSync('SELECT * FROM transactions WHERE id = ? LIMIT 1', [Number(pid)]);
    const row = (pr.rows ?? [])[0];
    parent = row ? mapRow(row) : null;
  }
  return { children: (kids.rows ?? []).map(mapRow), parent };
}

/**
 * Candidate rows that could cancel `parent`: opposite direction, unlinked, not
 * self/Investment, not themselves a parent of something, and within the
 * no earlier than 12h before it (no upper time limit — recency only ranks).
 * Scoring happens in settle.suggestPairs; this only narrows the set in SQL.
 */
export function getPairCandidates(parent: {
  id: number;
  type: 'expense' | 'income';
  timestamp: number;
}): TransactionRow[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT * FROM transactions c
      WHERE c.type = ? AND c.id != ?
        AND c.settles_id IS NULL
        AND c.category != 'Investment'
        AND c.timestamp >= ?
        AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.settles_id = c.id)
      ORDER BY c.timestamp ASC
      LIMIT 2000`,
    [
      parent.type === 'expense' ? 'income' : 'expense',
      parent.id,
      parent.timestamp - 12 * 3600_000,
    ],
  );
  return (res.rows ?? []).map(mapRow);
}

/**
 * Counterparties that have settled an Uber ride before — a strong signal that a
 * new payment from the same person is another reimbursement.
 */
export function getKnownSettlementCounterparties(): string[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT DISTINCT s.counterparty
       FROM transactions s
       JOIN transactions ride ON ride.id = s.settles_id
      WHERE ride.category = 'Uber' AND s.counterparty IS NOT NULL`,
  );
  return (res.rows ?? []).map(r => String(r.counterparty).toLowerCase());
}

/**
 * True if any transaction (any time, any type) is tagged with `category`.
 * The Dashboard uses this to keep the Uber card — the only entry point to the
 * Uber screen — visible in months with no rides yet.
 */
export function hasCategoryRows(category: string): boolean {
  const conn = requireDb();
  const res = conn.executeSync(
    'SELECT 1 FROM transactions WHERE category = ? LIMIT 1',
    [category],
  );
  return (res.rows ?? []).length > 0;
}

export function getTopMerchants(
  range: Range,
  limit = 5,
): { merchant: string; total: number; count: number }[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT COALESCE(merchant, counterparty, source, 'Unknown') AS merchant,
            SUM(amount) AS total, COUNT(*) AS count
       FROM transactions
      WHERE type = 'expense' AND timestamp BETWEEN ? AND ?
      GROUP BY merchant
      ORDER BY total DESC
      LIMIT ?`,
    [range.from, range.to, limit],
  );
  return (res.rows ?? []).map(row => ({
    merchant: String(row.merchant ?? 'Unknown'),
    total: Number(row.total ?? 0),
    count: Number(row.count ?? 0),
  }));
}

// ─── merchant rules (learned categorization) ──────────────────────────────────

export function getMerchantRule(key: string): string | null {
  const conn = requireDb();
  const res = conn.executeSync(
    'SELECT category FROM merchant_rules WHERE key = ? LIMIT 1',
    [key],
  );
  const row = (res.rows ?? [])[0];
  return row != null ? String(row.category) : null;
}

export function getAllMerchantRules(): Record<string, string> {
  const conn = requireDb();
  const res = conn.executeSync('SELECT key, category FROM merchant_rules');
  const out: Record<string, string> = {};
  for (const row of res.rows ?? []) {
    out[String(row.key)] = String(row.category);
  }
  return out;
}

export function upsertMerchantRule(key: string, category: string): void {
  const conn = requireDb();
  conn.executeSync(
    `INSERT INTO merchant_rules (key, category, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET category = excluded.category,
                                    updated_at = excluded.updated_at`,
    [key, category, Date.now()],
  );
}

export function deleteMerchantRule(key: string): void {
  const conn = requireDb();
  conn.executeSync('DELETE FROM merchant_rules WHERE key = ?', [key]);
}

// ─── budgets ──────────────────────────────────────────────────────────────────

export function getBudgets(): Budget[] {
  const conn = requireDb();
  const res = conn.executeSync('SELECT category, monthly_limit FROM budgets');
  return (res.rows ?? []).map(row => ({
    category: String(row.category),
    monthly_limit: Number(row.monthly_limit ?? 0),
  }));
}

export function setBudget(category: string, monthlyLimit: number): void {
  const conn = requireDb();
  if (monthlyLimit <= 0) {
    conn.executeSync('DELETE FROM budgets WHERE category = ?', [category]);
    return;
  }
  conn.executeSync(
    `INSERT INTO budgets (category, monthly_limit)
     VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
    [category, monthlyLimit],
  );
}

// ─── settings suggestions (aggregates; shaped by src/suggestions.ts) ──────────

/** Distinct own-account fragments seen on stored rows, with message counts. */
export function getAccountCounts(): { account: string; count: number }[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT account, COUNT(*) AS n FROM transactions
      WHERE account IS NOT NULL AND account != ''
      GROUP BY account ORDER BY n DESC`,
  );
  return (res.rows ?? []).map(r => ({
    account: String(r.account),
    count: Number(r.n ?? 0),
  }));
}

/** Income merchants/counterparties by all-time total (self transfers excluded). */
export function getIncomeSources(
  limit = 200,
): { merchant: string | null; counterparty: string | null; total: number }[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT merchant, counterparty, SUM(amount) AS total FROM transactions
      WHERE type = 'income'
      GROUP BY merchant, counterparty ORDER BY total DESC LIMIT ?`,
    [limit],
  );
  return (res.rows ?? []).map(r => ({
    merchant: r.merchant != null ? String(r.merchant) : null,
    counterparty: r.counterparty != null ? String(r.counterparty) : null,
    total: Number(r.total ?? 0),
  }));
}

// ─── key/value settings store ─────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const conn = requireDb();
  const res = conn.executeSync(
    'SELECT value FROM app_settings WHERE key = ? LIMIT 1',
    [key],
  );
  const row = (res.rows ?? [])[0];
  return row != null && row.value != null ? String(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  const conn = requireDb();
  conn.executeSync(
    `INSERT INTO app_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

// ─── Recurring detection ──────────────────────────────────────────────────────

export interface RecurringEntry {
  merchant: string;
  amount: number;
  count: number;
  avgIntervalDays: number;
  lastSeen: number;
}

/**
 * Detect likely recurring charges in a range.
 * A merchant qualifies when it has ≥ minOccurrences expense rows with amounts
 * within ±5% of each other. Interval is estimated from first/last occurrence.
 * All aggregation happens in SQL; only the tiny result set enters JS.
 */
export function getRecurring(range: Range, minOccurrences = 2): RecurringEntry[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT
        COALESCE(merchant, counterparty, source, 'Unknown') AS merchant,
        ROUND(AVG(amount), 2) AS avg_amount,
        COUNT(*) AS cnt,
        MIN(timestamp) AS first_ts,
        MAX(timestamp) AS last_ts
       FROM transactions
      WHERE type = 'expense'
        AND timestamp BETWEEN ? AND ?
      GROUP BY COALESCE(merchant, counterparty, source, 'Unknown')
      HAVING COUNT(*) >= ?
      ORDER BY cnt DESC`,
    [range.from, range.to, minOccurrences],
  );
  return (res.rows ?? []).map(row => {
    const cnt = Number(row.cnt ?? 0);
    const firstTs = Number(row.first_ts ?? 0);
    const lastTs = Number(row.last_ts ?? 0);
    const spanDays = cnt > 1 ? (lastTs - firstTs) / 86_400_000 : 0;
    return {
      merchant: String(row.merchant ?? 'Unknown'),
      amount: Number(row.avg_amount ?? 0),
      count: cnt,
      avgIntervalDays: cnt > 1 ? Math.round(spanDays / (cnt - 1)) : 0,
      lastSeen: lastTs,
    };
  });
}

/** Count transactions with category='Other' (the uncategorized review queue). */
export function getUncategorizedCount(): number {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT COUNT(*) AS cnt FROM transactions WHERE category = 'Other' AND type = 'expense'`,
    [],
  );
  return Number((res.rows ?? [])[0]?.cnt ?? 0);
}

// ─── transfer pairing support ────────────────────────────────────────────────

/** Highest row id (0 when empty). Rows inserted after a snapshot have id > it. */
export function getMaxTransactionId(): number {
  const conn = requireDb();
  const res = conn.executeSync('SELECT MAX(id) AS m FROM transactions');
  return Number((res.rows ?? [])[0]?.m ?? 0);
}

/** Raw rows with timestamp in [from, to], oldest first (no netting columns). */
export function getTransactionsBetween(from: number, to: number): TransactionRow[] {
  const conn = requireDb();
  const res = conn.executeSync(
    'SELECT * FROM transactions WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    [from, to],
  );
  return (res.rows ?? []).map(mapRow);
}

/** Raw rows inserted after `afterId`. */
export function getTransactionsAfterId(afterId: number): TransactionRow[] {
  const conn = requireDb();
  const res = conn.executeSync('SELECT * FROM transactions WHERE id > ? ORDER BY id ASC', [afterId]);
  return (res.rows ?? []).map(mapRow);
}

/** One raw row by id, or null. */
export function getTransactionById(id: number): TransactionRow | null {
  const conn = requireDb();
  const res = conn.executeSync('SELECT * FROM transactions WHERE id = ? LIMIT 1', [id]);
  const row = (res.rows ?? [])[0];
  return row ? mapRow(row) : null;
}
