// Loads insights once per app open (cached for the day); never runs in the background.

import { queryTransactions } from './db';
import { buildInsights } from './insights';
import type { Insight } from './insights';

let cache: { day: string; items: Insight[] } | null = null;

export function loadInsights(now: number = Date.now()): Insight[] {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (cache && cache.day === day) {
    return cache.items;
  }
  const from = new Date(d.getFullYear(), d.getMonth() - 3, 1).getTime();
  const rows = queryTransactions({ types: ['expense'], from, to: now + 1 });
  const items = buildInsights(rows, now);
  cache = { day, items };
  return items;
}
