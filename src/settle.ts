// ─── Settlement matching (pure, no DB/native imports) ────────────────────────
//
// Split out of db.ts/UberScreen for the same reason dedup.ts was: db.ts imports
// @op-engineering/op-sqlite at module scope, which can't be required under
// plain Jest. Everything here is pure so it's directly unit-testable.
//
// WHY THIS EXISTS
// The Uber screen used to "suggest" reimbursements by listing the 5 most recent
// income rows from the last 14 days, ranked purely by recency. Salary, refunds
// and cashback ranked identically to a ₹120 fare payback, which is why the
// suggestions were useless. The real problem was upstream: saving a fare split
// threw away how much the user was owed, so there was nothing to match against.
// With owed_amount persisted (schema v4) we can score candidates properly.

/** Minimum score for a candidate to be worth showing at all. */
export const SUGGESTION_CUTOFF = 40;

/** Amounts within this many rupees are treated as equal (rounding slack). */
const AMOUNT_EPSILON = 0.5;

const DAY_MS = 86_400_000;

/**
 * A settlement can run in either direction, and the old code only ever looked
 * at one of them — it queried types:['income'] exclusively, so it structurally
 * could not catch the reported double-count (paying a friend BACK).
 *
 *  reimbursement — money coming IN: a friend pays you their share of a ride you
 *                  paid for. Matches against the ride's outstanding balance.
 *  repayment     — money going OUT: your friend paid the fare, you recorded
 *                  your share, and now you're transferring it to them. Matches
 *                  against the recorded share itself.
 */
export type SettlementMode = 'reimbursement' | 'repayment';

export interface CandidateTx {
  id?: number;
  amount: number;
  timestamp: number;
  type: 'expense' | 'income' | 'self';
  category: string;
  counterparty?: string | null;
  merchant?: string | null;
  raw_text?: string | null;
  settles_id?: number | null;
}

export interface RideTarget {
  id: number;
  /** The recorded cost to the user (their share, or the full fare they paid). */
  amount: number;
  timestamp: number;
  /** Still owed back on this ride; 0 when nobody owes the user anything. */
  outstanding: number;
}

export interface ScoreContext {
  /** Lowercased counterparties that have settled an Uber ride before. */
  knownCounterparties?: string[];
  /** Typical single-ride cost, used to reject implausibly large candidates. */
  typicalFare?: number;
}

export interface ScoredCandidate {
  score: number;
  mode: SettlementMode;
  /** Plain-English justification shown under the suggestion. */
  reason: string;
}

/** Income that is clearly not a fare payback. */
const NON_REIMBURSEMENT_RE =
  /\b(salary|payroll|interest|cashback|dividend|refund|reversal|matured|maturity)\b/i;

function approxEqual(a: number, b: number, epsilon = AMOUNT_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

function formatAmount(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Score how likely `candidate` is to be settling `ride`. Higher is better;
 * a score of 0 means "definitely not, don't show this".
 *
 * Deliberately conservative: a wrong suggestion costs the user real money
 * (linking hides the row from spend totals), so anything ambiguous should fall
 * below SUGGESTION_CUTOFF rather than be offered with a confident label.
 */
export function scoreCandidate(
  candidate: CandidateTx,
  ride: RideTarget,
  ctx: ScoreContext = {},
): ScoredCandidate {
  const mode: SettlementMode =
    candidate.type === 'income' ? 'reimbursement' : 'repayment';
  const none: ScoredCandidate = { score: 0, mode, reason: '' };

  // ── Hard disqualifiers ────────────────────────────────────────────────────
  if (candidate.type === 'self') {
    return none; // already excluded from totals; linking would double-exclude
  }
  if (candidate.settles_id != null) {
    return none; // already settling something else
  }
  if (candidate.id != null && candidate.id === ride.id) {
    return none; // a row can never settle itself
  }
  if (candidate.category === 'Investment') {
    return none;
  }

  // A settlement cannot precede the ride it settles. Small negative slack
  // absorbs clock skew between the capture timestamp and the ride entry.
  const deltaMs = candidate.timestamp - ride.timestamp;
  if (deltaMs < -12 * 3600_000) {
    return none;
  }
  const deltaDays = deltaMs / DAY_MS;
  if (deltaDays > 30) {
    return none; // too far removed to be credible
  }

  // The amount this candidate ought to be if it settles this ride.
  const target = mode === 'reimbursement' ? ride.outstanding : ride.amount;
  if (!(target > 0)) {
    return none;
  }

  // Wildly larger than the thing it would settle — a salary credit is not a
  // fare payback no matter how recent it is.
  if (candidate.amount > target * 5) {
    return none;
  }

  let score = 0;
  let reason = '';

  // ── Amount match: the dominant signal ─────────────────────────────────────
  if (approxEqual(candidate.amount, target)) {
    score += 55;
    reason =
      mode === 'reimbursement'
        ? `₹${formatAmount(candidate.amount)} exactly covers what you're owed on this ride`
        : `₹${formatAmount(candidate.amount)} exactly matches your recorded share`;
  } else if (approxEqual(candidate.amount, ride.amount)) {
    // One equal share of the fare — the common case when several friends each
    // pay their own share separately.
    score += 45;
    reason = `₹${formatAmount(candidate.amount)} matches one share of this ride`;
  } else if (candidate.amount < target && candidate.amount / target >= 0.2) {
    // A partial payback (one of several friends settling up).
    score += 25;
    reason = `₹${formatAmount(candidate.amount)} is part of the ₹${formatAmount(target)} outstanding`;
  } else {
    return none; // no meaningful amount relationship
  }

  // ── Recency relative to the RIDE, not to now ──────────────────────────────
  // The old code sorted by "how recent is this credit", which is why a payback
  // for last week's ride ranked below an unrelated credit from yesterday.
  if (deltaDays <= 3) {
    score += 25;
  } else if (deltaDays <= 7) {
    score += 15;
  } else if (deltaDays <= 14) {
    score += 5;
  }

  // ── Counterparty history ──────────────────────────────────────────────────
  const cp = candidate.counterparty?.toLowerCase();
  if (cp && ctx.knownCounterparties?.includes(cp)) {
    score += 30;
    reason += ' · this person has settled a ride before';
  }

  // ── Negative signals ──────────────────────────────────────────────────────
  const haystack = `${candidate.merchant ?? ''} ${candidate.raw_text ?? ''}`;
  if (NON_REIMBURSEMENT_RE.test(haystack)) {
    score -= 45;
  }
  if (ctx.typicalFare != null && candidate.amount > ctx.typicalFare * 4) {
    score -= 25;
  }

  return score > 0 ? { score, mode, reason } : none;
}

export interface Suggestion extends ScoredCandidate {
  candidate: CandidateTx;
  ride: RideTarget;
}

/**
 * Best settlement suggestions across all candidates and unsettled rides.
 * At most one suggestion per candidate (its best-scoring ride), sorted
 * strongest-first, and only above SUGGESTION_CUTOFF — showing a long tail of
 * weak guesses is what made the old list feel random.
 */
export function suggestSettlements(
  candidates: CandidateTx[],
  rides: RideTarget[],
  ctx: ScoreContext = {},
  limit = 5,
): Suggestion[] {
  const best = new Map<CandidateTx, Suggestion>();

  for (const candidate of candidates) {
    for (const ride of rides) {
      const scored = scoreCandidate(candidate, ride, ctx);
      if (scored.score < SUGGESTION_CUTOFF) {
        continue;
      }
      const existing = best.get(candidate);
      if (!existing || scored.score > existing.score) {
        best.set(candidate, { ...scored, candidate, ride });
      }
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Generic pair-to-cancel ───────────────────────────────────────────────────
//
// Any expense can be cancelled (in part) by an income that repays it, and any
// income by an expense that returns it. This is the non-Uber counterpart of
// scoreCandidate: no fare heuristics, just direction, amount and timing.

/** Minimum score for a pair candidate to be offered. */
export const PAIR_CUTOFF = 30;

export interface PairParent {
  id: number;
  type: 'expense' | 'income';
  amount: number;
  timestamp: number;
  counterparty?: string | null;
  merchant?: string | null;
  /** Already cancelled by linked rows; remaining = amount - alreadyPaid. */
  alreadyPaid?: number;
}

export interface PairSuggestion {
  candidate: CandidateTx;
  score: number;
  reason: string;
}

function personKey(s?: string | null): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9@]/g, '');
}

export function scorePair(
  parent: PairParent,
  candidate: CandidateTx,
  ctx: ScoreContext = {},
): { score: number; reason: string } {
  const none = { score: 0, reason: '' };
  if (candidate.type === 'self' || candidate.type === parent.type) {
    return none; // must be the opposite direction
  }
  if (candidate.settles_id != null || candidate.category === 'Investment') {
    return none;
  }
  if (candidate.id != null && candidate.id === parent.id) {
    return none;
  }
  const remaining = parent.amount - (parent.alreadyPaid ?? 0);
  if (!(remaining > 0) || !(candidate.amount > 0)) {
    return none;
  }
  if (candidate.amount > remaining + AMOUNT_EPSILON) {
    return none;
  }
  const deltaMs = candidate.timestamp - parent.timestamp;
  if (deltaMs < -12 * 3600_000 || deltaMs / DAY_MS > 30) {
    return none;
  }
  const deltaDays = deltaMs / DAY_MS;

  let score: number;
  let reason: string;
  if (approxEqual(candidate.amount, remaining)) {
    score = 60;
    reason = `₹${formatAmount(candidate.amount)} exactly matches`;
  } else {
    score = 15 + Math.round((candidate.amount / remaining) * 30);
    reason = `₹${formatAmount(candidate.amount)} of ₹${formatAmount(remaining)}`;
  }

  if (deltaDays <= 3) {
    score += 25;
  } else if (deltaDays <= 7) {
    score += 15;
  } else if (deltaDays <= 14) {
    score += 5;
  }

  const candKeys = [personKey(candidate.counterparty), personKey(candidate.merchant)].filter(Boolean);
  const parentKeys = [personKey(parent.counterparty), personKey(parent.merchant)].filter(Boolean);
  if (candKeys.some(k => parentKeys.includes(k))) {
    score += 20;
    reason += ' · same person';
  } else {
    const cp = candidate.counterparty?.toLowerCase();
    if (cp && ctx.knownCounterparties?.includes(cp)) {
      score += 10;
      reason += ' · has settled before';
    }
  }
  return { score, reason };
}

/**
 * Best repayment candidates for one parent row (expense or income), strongest
 * first, above PAIR_CUTOFF, at most `limit`.
 */
export function suggestPairs(
  parent: PairParent,
  candidates: CandidateTx[],
  ctx: ScoreContext = {},
  limit = 5,
): PairSuggestion[] {
  const out: PairSuggestion[] = [];
  for (const candidate of candidates) {
    const { score, reason } = scorePair(parent, candidate, ctx);
    if (score >= PAIR_CUTOFF) {
      out.push({ candidate, score, reason });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
