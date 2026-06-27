/**
 * Export and restore utilities for expense data.
 *
 * CSV/JSON is built entirely in JS from the op-sqlite DB (no raw .db file
 * copy — WAL mode makes that fragile). Restore re-inserts rows via
 * insertTransaction so dedup applies and no duplicates are created.
 *
 * File I/O is delegated to FileModule (Android SAF) — no extra permissions
 * are required and scoped storage / Android 11+ is handled natively.
 */

import { getAll, insertTransaction } from './db';
import type { TransactionRow, TransactionType } from './db';
import { saveTextFile, pickTextFile } from './native/FileModule';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Return an ISO-8601 date string for a timestamp (used in file names). */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Return the current local date as "YYYY-MM-DD" for suggested file names. */
function todayLabel(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Escape a single CSV field value per RFC 4180:
 *  - Wrap in double quotes if the value contains a comma, double-quote, or newline.
 *  - Escape interior double-quotes by doubling them.
 */
function csvField(value: string | number | null | undefined): string {
  if (value == null) {
    return '';
  }
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

const CSV_HEADER =
  'id,timestamp,amount,type,category,merchant,counterparty,source,note,raw_text\r\n';

/**
 * Serialize an array of TransactionRow objects to a CSV string.
 *
 * Columns: id, timestamp (ISO-8601), amount, type, category, merchant,
 *          counterparty, source, note, raw_text.
 *
 * Fields are RFC 4180-escaped (commas, quotes, and newlines inside values are
 * properly quoted so the output is safe to open in any spreadsheet app).
 */
export function buildCsv(rows: TransactionRow[]): string {
  const lines: string[] = [CSV_HEADER];
  for (const r of rows) {
    const line =
      [
        csvField(r.id ?? ''),
        csvField(isoDate(r.timestamp)),
        csvField(r.amount),
        csvField(r.type),
        csvField(r.category),
        csvField(r.merchant),
        csvField(r.counterparty),
        csvField(r.source),
        csvField(r.note),
        csvField(r.raw_text),
      ].join(',') + '\r\n';
    lines.push(line);
  }
  return lines.join('');
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

interface JsonExport {
  version: 1;
  exportedAt: string; // ISO-8601
  transactions: TransactionRow[];
}

/**
 * Serialize an array of TransactionRow objects to a JSON string.
 *
 * The output is wrapped in a versioned envelope so restore code can evolve
 * independently of the raw row shape:
 * ```json
 * { "version": 1, "exportedAt": "2024-06-28T10:30:00.000Z", "transactions": [...] }
 * ```
 */
export function buildJson(rows: TransactionRow[]): string {
  const envelope: JsonExport = {
    version: 1,
    exportedAt: new Date().toISOString(),
    transactions: rows,
  };
  return JSON.stringify(envelope, null, 2);
}

// ─── export helpers ───────────────────────────────────────────────────────────

/**
 * Fetch all transactions from the DB, build a CSV string, and write it to a
 * user-chosen file via the Android SAF picker.
 *
 * @returns  true on success, false if the user dismissed the picker.
 */
export async function exportCsv(): Promise<boolean> {
  const rows = getAll();
  const csv = buildCsv(rows);
  const name = `expenses-${todayLabel()}.csv`;
  return saveTextFile(name, 'text/csv', csv);
}

/**
 * Fetch all transactions from the DB, build a JSON envelope, and write it to
 * a user-chosen file via the Android SAF picker.
 *
 * @returns  true on success, false if the user dismissed the picker.
 */
export async function exportJson(): Promise<boolean> {
  const rows = getAll();
  const json = buildJson(rows);
  const name = `expenses-${todayLabel()}.json`;
  return saveTextFile(name, 'application/json', json);
}

// ─── restore ──────────────────────────────────────────────────────────────────

/** Minimum fields required for a row to be considered valid for restore. */
function isValidRow(r: unknown): r is TransactionRow {
  if (r == null || typeof r !== 'object') {
    return false;
  }
  const obj = r as Record<string, unknown>;
  return (
    typeof obj.amount === 'number' &&
    typeof obj.timestamp === 'number' &&
    typeof obj.category === 'string' &&
    (obj.type === 'expense' || obj.type === 'income' || obj.type === 'self')
  );
}

/**
 * Open the system file picker, read the selected JSON backup, and re-insert
 * each transaction row into the DB via insertTransaction (dedup applies —
 * rows already present will not be duplicated).
 *
 * @returns  { added: number of newly inserted rows, total: number of valid
 *             rows found in the backup file }.
 * @throws   If the user picks an unreadable file, if JSON is malformed, or
 *           if the envelope version is unrecognised.
 */
export async function restoreFromJson(): Promise<{ added: number; total: number }> {
  const text = await pickTextFile();
  if (text == null) {
    // User cancelled — treat as a no-op.
    return { added: 0, total: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The selected file is not valid JSON');
  }

  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== 1
  ) {
    throw new Error(
      'Unrecognised backup format — only version 1 JSON exports are supported',
    );
  }

  const envelope = parsed as Record<string, unknown>;
  const rawRows = Array.isArray(envelope.transactions) ? envelope.transactions : [];

  let added = 0;
  let total = 0;

  for (const raw of rawRows) {
    if (!isValidRow(raw)) {
      // Skip malformed / incomplete rows silently — partial backups are
      // still useful; don't abort the whole restore for one bad row.
      continue;
    }
    total += 1;

    // Map the restored row defensively: only pass fields the DB knows about,
    // and strip the surrogate id so SQLite generates a fresh one.
    const tx: Omit<TransactionRow, 'id' | 'dedup_key'> = {
      amount: raw.amount,
      merchant: typeof raw.merchant === 'string' ? raw.merchant : null,
      source: typeof raw.source === 'string' ? raw.source : null,
      raw_text: typeof raw.raw_text === 'string' ? raw.raw_text : null,
      category: raw.category,
      timestamp: raw.timestamp,
      type: raw.type as TransactionType,
      counterparty:
        typeof raw.counterparty === 'string' ? raw.counterparty : null,
      account: typeof raw.account === 'string' ? raw.account : null,
      note: typeof raw.note === 'string' ? raw.note : null,
      category_source:
        raw.category_source === 'manual' ? 'manual' : 'auto',
    };

    const inserted = insertTransaction(tx);
    if (inserted) {
      added += 1;
    }
  }

  return { added, total };
}
