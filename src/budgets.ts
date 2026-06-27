// ─── Budget status helper ─────────────────────────────────────────────────────
//
// Computes current-month spend against configured budgets.
// Pure: no side effects, no UI, no RN imports.

import { getBudgets, getSummary, OVERALL_BUDGET_KEY } from './db';
import type { Budget } from './db';
import { monthRange } from './dates';

export interface CategoryBudgetStatus {
  category: string;
  limit: number;
  spent: number;
}

export interface BudgetStatus {
  /** Overall monthly budget (null when no overall limit is configured). */
  overall: { limit: number; spent: number } | null;
  /** Per-category budgets (only categories with limit > 0 are included). */
  categories: CategoryBudgetStatus[];
}

/**
 * Load budgets + this month's summary and return spend-vs-limit status.
 * Categories without a limit (monthly_limit === 0) are omitted.
 * The overall key (OVERALL_BUDGET_KEY) is handled separately.
 *
 * @param ref Optional reference date (defaults to now) for monthRange().
 */
export function computeBudgetStatus(ref?: Date): BudgetStatus {
  const budgets: Budget[] = getBudgets();
  const range = monthRange(ref);
  const summary = getSummary(range);

  const totalSpent = summary.spent;

  // Per-category spend map
  const spendByCategory = new Map<string, number>(
    summary.byCategory.map(bc => [bc.category, bc.total]),
  );

  let overall: BudgetStatus['overall'] = null;
  const categories: CategoryBudgetStatus[] = [];

  for (const b of budgets) {
    if (b.monthly_limit <= 0) {
      continue;
    }
    if (b.category === OVERALL_BUDGET_KEY) {
      overall = { limit: b.monthly_limit, spent: totalSpent };
    } else {
      categories.push({
        category: b.category,
        limit: b.monthly_limit,
        spent: spendByCategory.get(b.category) ?? 0,
      });
    }
  }

  return { overall, categories };
}
