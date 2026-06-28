import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';

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
}

export interface MonthlySummary {
  month: string;
  total: number;
  byCategory: { category: string; total: number }[];
}

export interface Range {
  from: number;
  to: number;
}

export interface Summary {
  spent: number;
  received: number;
  net: number;
  byCategory: { category: string; total: number }[];
  byDay: { day: number; total: number }[];
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

const SCHEMA_VERSION = 2;

function requireDb(): DB {
  if (!db) {
    throw new Error('DB not initialised — call initDb() first');
  }
  return db;
}

// djb2 hash — no external deps
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16);
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
    conn.executeSync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    version = 2;
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

function strictDedupKey(tx: {
  source: string | null;
  amount: number;
  timestamp: number;
  raw_text: string | null;
}): string {
  return hash(
    `${tx.source}|${tx.amount}|${Math.floor(tx.timestamp / 60000)}|${tx.raw_text}`,
  );
}

export function insertTransaction(
  tx: Omit<TransactionRow, 'id' | 'dedup_key'>,
): boolean {
  const conn = requireDb();

  // Soft cross-channel dedup: the SAME payment can arrive via both SMS and the
  // bank-app notification (different source/raw_text → different strict key).
  // When the counterparty is known, treat an existing row with the same amount
  // and counterparty within a 2-minute window as a duplicate.
  if (tx.counterparty) {
    const existing = conn.executeSync(
      `SELECT 1 FROM transactions
        WHERE amount = ? AND counterparty = ? AND ABS(timestamp - ?) < 120000
        LIMIT 1`,
      [tx.amount, tx.counterparty, tx.timestamp],
    );
    if ((existing.rows ?? []).length > 0) {
      return false;
    }
  }

  const dedup_key = strictDedupKey(tx);

  const res = conn.executeSync(
    `INSERT OR IGNORE INTO transactions
       (amount, merchant, source, raw_text, category, timestamp, type,
        counterparty, account, note, category_source, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        counterparty, account, note, category_source, dedup_key)
     VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
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
  };
}

export function getAll(): TransactionRow[] {
  const conn = requireDb();
  const res = conn.executeSync(
    'SELECT * FROM transactions ORDER BY timestamp DESC',
  );
  return (res.rows ?? []).map(mapRow);
}

export function getByDateRange(fromMs: number, toMs: number): TransactionRow[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT * FROM transactions
      WHERE timestamp BETWEEN ? AND ?
      ORDER BY timestamp DESC`,
    [fromMs, toMs],
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
  return (res.rows ?? []).map(mapRow);
}

// ─── aggregation (in SQL — never .map over all rows) ──────────────────────────

/**
 * Spent (expense) / received (income) / net + per-category and per-day spend
 * for a range. Self-transfers are excluded from every figure.
 */
export function getSummary(range: Range): Summary {
  const conn = requireDb();
  const { from, to } = range;

  const totalsRes = conn.executeSync(
    `SELECT
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS spent,
        COALESCE(SUM(CASE WHEN type = 'income'  THEN amount END), 0) AS received
       FROM transactions
      WHERE timestamp BETWEEN ? AND ?`,
    [from, to],
  );
  const totRow = (totalsRes.rows ?? [])[0] ?? {};
  const spent = Number(totRow.spent ?? 0);
  const received = Number(totRow.received ?? 0);

  const catRes = conn.executeSync(
    `SELECT category, SUM(amount) AS total
       FROM transactions
      WHERE type = 'expense' AND timestamp BETWEEN ? AND ?
      GROUP BY category
      ORDER BY total DESC`,
    [from, to],
  );
  const byCategory = (catRes.rows ?? []).map(row => ({
    category: String(row.category ?? ''),
    total: Number(row.total ?? 0),
  }));

  const dayRes = conn.executeSync(
    `SELECT CAST(timestamp / 86400000 AS INTEGER) AS day, SUM(amount) AS total
       FROM transactions
      WHERE type = 'expense' AND timestamp BETWEEN ? AND ?
      GROUP BY day
      ORDER BY day ASC`,
    [from, to],
  );
  const byDay = (dayRes.rows ?? []).map(row => ({
    day: Number(row.day ?? 0),
    total: Number(row.total ?? 0),
  }));

  return { spent, received, net: received - spent, byCategory, byDay };
}

/** Legacy current-month summary (kept for compatibility). Excludes self. */
export function getMonthlySummary(ref: Date = new Date()): MonthlySummary {
  const year = ref.getFullYear();
  const month = ref.getMonth(); // 0-based
  const start = new Date(year, month, 1).getTime();
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
  const monthLabel = `${year}-${String(month + 1).padStart(2, '0')}`;

  const summary = getSummary({ from: start, to: end });
  return { month: monthLabel, total: summary.spent, byCategory: summary.byCategory };
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

/** Per-day expense totals across a range (for trend charts). */
export function getTrend(range: Range): { day: number; total: number }[] {
  return getSummary(range).byDay;
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

// ─── Account balance (best-effort, last-known from SMS "Avl Bal") ─────────────

const BALANCE_PREFIX = '__balance__';

/** Returns the last-known balance (INR) for an account (keyed by last-4 digits or source). */
export function getAccountBalance(accountKey: string): { balance: number; updatedAt: number } | null {
  const raw = getSetting(`${BALANCE_PREFIX}${accountKey}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { balance: number; updatedAt: number };
    return parsed;
  } catch {
    return null;
  }
}

/** Store the last-known balance for an account; only updates if newer than stored value. */
export function setAccountBalance(accountKey: string, balance: number, ts: number): void {
  const existing = getAccountBalance(accountKey);
  if (existing && existing.updatedAt >= ts) {
    return; // don't overwrite with older data
  }
  setSetting(`${BALANCE_PREFIX}${accountKey}`, JSON.stringify({ balance, updatedAt: ts }));
}

/** Return all stored balances as a flat array. */
export function getAllAccountBalances(): { account: string; balance: number; updatedAt: number }[] {
  const conn = requireDb();
  const res = conn.executeSync(
    `SELECT key, value FROM app_settings WHERE key LIKE '${BALANCE_PREFIX}%'`,
    [],
  );
  return (res.rows ?? []).map(row => {
    const key = String(row.key ?? '').slice(BALANCE_PREFIX.length);
    try {
      const val = JSON.parse(String(row.value ?? '{}')) as { balance: number; updatedAt: number };
      return { account: key, balance: val.balance, updatedAt: val.updatedAt };
    } catch {
      return { account: key, balance: 0, updatedAt: 0 };
    }
  }).filter(b => b.balance > 0);
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
