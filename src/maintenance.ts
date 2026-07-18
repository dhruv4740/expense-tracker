// ─── One-time startup cleanup ─────────────────────────────────────────────────
//
// Fixes data already poisoned by two bugs (see categories.ts / parser.ts):
//  - merchant_rules keyed on the user's own bank account fragment (e.g.
//    "1234") instead of a real merchant, which matched nearly every SMS from
//    that bank
//  - substring keyword matching, which let unrelated text trigger a category
// Both are fixed going forward; this module repairs data written before the
// fix landed. Gated by an app_settings flag (not a schema migration —
// RULES.md §4 keeps migrations additive-only, and this needs to call the
// live TS keyword map, which a migration step can't do) so it only ever
// runs once per install.

import {
  deleteMerchantRule,
  getAllMerchantRules,
  getSetting,
  queryTransactions,
  setSetting,
  updateTransaction,
} from './db';
import type { TransactionRow } from './db';
import { categorize, isGenericMerchantKey } from './categories';
import type { Category } from './categories';
import { refreshSyncCaches } from './sync';

const CLEANUP_FLAG_KEY = 'recat_cleanup_v1';

export interface RecategorizationDiff {
  id: number;
  from: string;
  to: Category;
}

/**
 * Pure: decides which auto-categorized rows need their category corrected
 * under the given (already-purged) rules. Manual edits (category_source
 * 'manual') are never touched — the user's explicit choice always wins.
 */
export function planRecategorization(
  rows: TransactionRow[],
  rules: Record<string, string>,
): RecategorizationDiff[] {
  const diffs: RecategorizationDiff[] = [];
  for (const row of rows) {
    if (row.id == null || row.category_source === 'manual') {
      continue;
    }
    const recategorized = categorize(
      row.merchant,
      row.raw_text ?? '',
      row.counterparty ?? null,
      rules,
      row.type !== 'income',
    );
    if (recategorized !== row.category) {
      diffs.push({ id: row.id, from: row.category, to: recategorized });
    }
  }
  return diffs;
}

/**
 * Runs the purge + re-categorize pass exactly once per install. Call after
 * initDb() and before the first syncBuffer() so newly-drained transactions
 * are categorized with already-clean rules.
 */
export function runCleanupIfNeeded(): void {
  if (getSetting(CLEANUP_FLAG_KEY) != null) {
    return;
  }

  const rules = getAllMerchantRules();
  for (const key of Object.keys(rules)) {
    if (isGenericMerchantKey(key)) {
      deleteMerchantRule(key);
    }
  }

  const freshRules = getAllMerchantRules();
  const rows = queryTransactions({ includeSelf: true });
  const diffs = planRecategorization(rows, freshRules);
  for (const diff of diffs) {
    updateTransaction(diff.id, { category: diff.to });
  }

  refreshSyncCaches();
  setSetting(CLEANUP_FLAG_KEY, String(Date.now()));
}
