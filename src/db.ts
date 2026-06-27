import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';

export interface TransactionRow {
  id?: number;
  amount: number;
  merchant: string | null;
  source: string | null;
  raw_text: string | null;
  category: string;
  timestamp: number;
  type: 'expense' | 'income';
  dedup_key?: string;
}

export interface MonthlySummary {
  month: string;
  total: number;
  byCategory: { category: string; total: number }[];
}

// op-sqlite QueryResult: rows is Array<Record<string, Scalar>>
// rowsAffected: number of rows changed (INSERT/UPDATE/DELETE)
// Scalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView

let db: DB | null = null;

// djb2 hash — no external deps
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16);
}

export function initDb(): void {
  if (db) {
    return; // idempotent
  }

  db = open({ name: 'expenses.db' });

  db.executeSync('PRAGMA journal_mode=WAL;');

  db.executeSync(`
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

  db.executeSync(
    'CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);',
  );
  db.executeSync(
    'CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);',
  );
}

export function insertTransaction(
  tx: Omit<TransactionRow, 'id' | 'dedup_key'>,
): boolean {
  if (!db) {
    throw new Error('DB not initialised — call initDb() first');
  }

  const dedup_key = hash(
    `${tx.source}|${tx.amount}|${Math.floor(tx.timestamp / 60000)}|${tx.raw_text}`,
  );

  const res = db.executeSync(
    `INSERT OR IGNORE INTO transactions
       (amount, merchant, source, raw_text, category, timestamp, type, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.amount,
      tx.merchant ?? null,
      tx.source ?? null,
      tx.raw_text ?? null,
      tx.category,
      tx.timestamp,
      tx.type,
      dedup_key,
    ],
  );

  return res.rowsAffected > 0;
}

function mapRow(row: Record<string, unknown>): TransactionRow {
  return {
    id:        row.id        != null ? Number(row.id)        : undefined,
    amount:    Number(row.amount ?? 0),
    merchant:  row.merchant  != null ? String(row.merchant)  : null,
    source:    row.source    != null ? String(row.source)    : null,
    raw_text:  row.raw_text  != null ? String(row.raw_text)  : null,
    category:  String(row.category ?? ''),
    timestamp: Number(row.timestamp ?? 0),
    type:      (row.type === 'income' ? 'income' : 'expense') as 'expense' | 'income',
    dedup_key: row.dedup_key != null ? String(row.dedup_key) : undefined,
  };
}

export function getAll(): TransactionRow[] {
  if (!db) {
    throw new Error('DB not initialised — call initDb() first');
  }

  const res = db.executeSync(
    'SELECT * FROM transactions ORDER BY timestamp DESC',
  );

  return (res.rows ?? []).map(mapRow);
}

export function getByDateRange(fromMs: number, toMs: number): TransactionRow[] {
  if (!db) {
    throw new Error('DB not initialised — call initDb() first');
  }

  const res = db.executeSync(
    `SELECT * FROM transactions
      WHERE timestamp BETWEEN ? AND ?
      ORDER BY timestamp DESC`,
    [fromMs, toMs],
  );

  return (res.rows ?? []).map(mapRow);
}

export function getMonthlySummary(ref: Date = new Date()): MonthlySummary {
  if (!db) {
    throw new Error('DB not initialised — call initDb() first');
  }

  const year  = ref.getFullYear();
  const month = ref.getMonth(); // 0-based

  const start = new Date(year, month, 1).getTime();
  const end   = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();

  const monthLabel = `${year}-${String(month + 1).padStart(2, '0')}`;

  // Total expenses for the month
  const totalRes = db.executeSync(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
      WHERE type = 'expense'
        AND timestamp BETWEEN ? AND ?`,
    [start, end],
  );

  const totalRow = (totalRes.rows ?? [])[0];
  const total = totalRow != null ? Number(totalRow.total ?? 0) : 0;

  // Per-category breakdown, descending by total
  const catRes = db.executeSync(
    `SELECT category, SUM(amount) AS total
       FROM transactions
      WHERE type = 'expense'
        AND timestamp BETWEEN ? AND ?
      GROUP BY category
      ORDER BY total DESC`,
    [start, end],
  );

  const byCategory = (catRes.rows ?? []).map((row) => ({
    category: String(row.category ?? ''),
    total:    Number(row.total ?? 0),
  }));

  return { month: monthLabel, total, byCategory };
}
