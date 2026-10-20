// ─── Safe to spend (pure) ────────────────────────────────────────────────────
//
// (From family + Earned this month) − Spent − upcoming autopays still due this
// month. Investment autopays are committed money, not spend, so they reduce
// "left" through the upcoming total rather than through `spent`.

export interface SafeToSpend {
  income: number;
  spent: number;
  committed: number;
  /** Can be negative: shown plainly as an overspend. */
  left: number;
  daysLeft: number;
  /** Per-day allowance; 0 when nothing is left. */
  perDay: number;
}

/** Days from `now` to the end of its month, counting today. */
export function daysLeftInMonth(now: number): number {
  const d = new Date(now);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return last - d.getDate() + 1;
}

export function safeToSpend(
  input: { fromFamily: number; earned: number; spent: number; committed: number },
  now: number,
): SafeToSpend {
  const income = input.fromFamily + input.earned;
  const left = Math.round((income - input.spent - input.committed) * 100) / 100;
  const daysLeft = daysLeftInMonth(now);
  return {
    income,
    spent: input.spent,
    committed: input.committed,
    left,
    daysLeft,
    perDay: left > 0 ? Math.floor(left / daysLeft) : 0,
  };
}

function rupees(n: number): string {
  return `₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

export function safeToSpendLine(s: SafeToSpend): string {
  if (s.left < 0) {
    return `${rupees(s.left)} over this month's income`;
  }
  return `${rupees(s.left)} left · ~${rupees(s.perDay)}/day for ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}`;
}
