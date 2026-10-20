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
// income by an expense that returns it. Two surfaces use this, with different
// strictness because a wrong link hides money from the totals:
//  - on demand (Edit screen): NO time limit, ranked by score, top few shown
//    with an honest reason line, so the user can still find a late payback;
//  - proactive (Dashboard banner): only the high-confidence shapes in
//    isBannerWorthy(). Equal amounts alone are noise (₹2000/₹1000/₹50 recur),
//    so a banner also needs tight timing or a known person.
// Repayments are NEVER linked automatically.

/** Minimum score for a pair candidate to be offered on demand. */
export const PAIR_CUTOFF = 10;

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

export interface PairScore {
  score: number;
  reason: string;
  /** Candidate equals the remainder (±0.5). */
  exact: boolean;
  /** Candidate is 1/2, 1/3 or 1/4 of the remainder (an equal share). */
  share: boolean;
  deltaDays: number;
  samePerson: boolean;
  knownPerson: boolean;
  /** Salary / interest / cashback / refund wording. */
  penalized: boolean;
}

export interface PairSuggestion extends PairScore {
  candidate: CandidateTx;
}

function personKey(s?: string | null): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9@]/g, '');
}

const NO_PAIR: PairScore = {
  score: 0, reason: '', exact: false, share: false, deltaDays: 0,
  samePerson: false, knownPerson: false, penalized: false,
};

function daysLabel(d: number): string {
  if (d < 1) {
    return 'same day';
  }
  const n = Math.round(d);
  return `${n} day${n === 1 ? '' : 's'} later`;
}

export function scorePair(
  parent: PairParent,
  candidate: CandidateTx,
  ctx: ScoreContext = {},
): PairScore {
  if (candidate.type === 'self' || candidate.type === parent.type) {
    return NO_PAIR; // must be the opposite direction
  }
  if (candidate.settles_id != null || candidate.category === 'Investment') {
    return NO_PAIR;
  }
  if (candidate.id != null && candidate.id === parent.id) {
    return NO_PAIR;
  }
  const remaining = parent.amount - (parent.alreadyPaid ?? 0);
  if (!(remaining > 0) || !(candidate.amount > 0)) {
    return NO_PAIR;
  }
  if (candidate.amount > remaining + AMOUNT_EPSILON) {
    return NO_PAIR;
  }
  const deltaMs = candidate.timestamp - parent.timestamp;
  if (deltaMs < -12 * 3600_000) {
    return NO_PAIR; // a payback cannot precede what it repays
  }
  const deltaDays = Math.max(deltaMs / DAY_MS, 0);

  const exact = approxEqual(candidate.amount, remaining);
  // Equal shares of an uneven split differ by rounding, so allow ₹1 here.
  const share =
    !exact && [2, 3, 4].some(n => approxEqual(candidate.amount, remaining / n, 1));

  let score: number;
  const parts: string[] = [];
  if (exact) {
    score = 50;
    parts.push('Same amount');
  } else if (share) {
    score = 32;
    parts.push('Equal share');
  } else {
    score = 8 + Math.round((candidate.amount / remaining) * 14);
    parts.push(`Part (₹${formatAmount(candidate.amount)} of ₹${formatAmount(remaining)})`);
  }

  // Strong within 3 days, fading afterwards — never a hard stop.
  if (deltaDays <= 3) {
    score += 30;
  } else {
    score += Math.round(30 * Math.exp(-(deltaDays - 3) / 12));
  }
  parts.push(daysLabel(deltaDays));

  const candKeys = [personKey(candidate.counterparty), personKey(candidate.merchant)].filter(Boolean);
  const parentKeys = [personKey(parent.counterparty), personKey(parent.merchant)].filter(Boolean);
  const samePerson = candKeys.some(k => parentKeys.includes(k));
  const cp = candidate.counterparty?.toLowerCase();
  const knownPerson = !samePerson && !!cp && !!ctx.knownCounterparties?.includes(cp);
  if (samePerson) {
    score += 35;
    parts.push('same person');
  } else if (knownPerson) {
    score += 20;
    parts.push('has settled with you before');
  } else {
    parts.push('different person');
  }

  const penalized = NON_REIMBURSEMENT_RE.test(
    `${candidate.merchant ?? ''} ${candidate.raw_text ?? ''}`,
  );
  if (penalized) {
    score -= 40;
    parts.push('looks like salary/interest/refund');
  }

  return {
    score, reason: parts.join(' · '), exact, share, deltaDays,
    samePerson, knownPerson, penalized,
  };
}

/**
 * Best repayment candidates for one parent row (expense or income), strongest
 * first, at most `limit`. No time limit — recency only affects the ranking.
 */
export function suggestPairs(
  parent: PairParent,
  candidates: CandidateTx[],
  ctx: ScoreContext = {},
  limit = 5,
): PairSuggestion[] {
  const out: PairSuggestion[] = [];
  for (const candidate of candidates) {
    const s = scorePair(parent, candidate, ctx);
    if (s.score >= PAIR_CUTOFF) {
      out.push({ ...s, candidate });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Is this pair strong enough to raise a proactive banner? Exact (or equal-share)
 * amount AND the same or a known person, within 30 days. Same amount + same day
 * from a different person is NOT enough (it stays in the on-demand ranked list):
 * a ₹1,200 shop payment and a ₹1,200 credit from a friend are just a coincidence.
 * Anything salary/refund-like never qualifies.
 */
export function isBannerWorthy(s: PairScore): boolean {
  if (s.score <= 0 || s.penalized || !(s.exact || s.share)) {
    return false;
  }
  return (s.samePerson || s.knownPerson) && s.deltaDays <= 30;
}

/** Company-style names ("RELIANCE RETAIL LIMITE", "Acme Pvt Ltd") are never a friend to repay. */
const BUSINESS_NAME_RE =
  /\b(limite?d?|ltd|pvt|private|retail|systems?|services?|enterprises?|industries|technologies|solutions|stores?|mart|traders?|corp(?:oration)?|inc|llp|bank|payments?)\b/i;

export function isBusinessName(...names: Array<string | null | undefined>): boolean {
  return names.some(n => !!n && BUSINESS_NAME_RE.test(n));
}

export interface BannerRow extends CandidateTx {
  id: number;
  type: 'expense' | 'income' | 'self';
  /** Sum of opposite-direction rows already linked to this one. */
  paid_back?: number;
  /** Count of rows linked as children of this one. */
  has_children?: boolean;
}

export interface RepaymentBanner {
  parent: BannerRow;
  candidate: BannerRow;
  reason: string;
  score: number;
}

export function pairKey(parentId: number, candidateId: number): string {
  return `${parentId}:${candidateId}`;
}

/**
 * The single best proactive repayment banner among recent rows, or null.
 * `rows` should cover roughly the last 30 days; the earlier row of a pair is
 * treated as the parent. Dismissed pair keys are never offered again.
 */
export function pickRepaymentBanner(
  rows: BannerRow[],
  ctx: ScoreContext,
  dismissed: Set<string>,
): RepaymentBanner | null {
  let best: RepaymentBanner | null = null;
  for (const parent of rows) {
    if (parent.type === 'self' || parent.settles_id != null || parent.category === 'Investment') {
      continue;
    }
    const p: PairParent = {
      id: parent.id,
      type: parent.type,
      amount: parent.amount,
      timestamp: parent.timestamp,
      counterparty: parent.counterparty,
      merchant: parent.merchant,
      alreadyPaid: parent.paid_back ?? 0,
    };
    for (const candidate of rows) {
      if (
        candidate.has_children ||
        dismissed.has(pairKey(parent.id, candidate.id)) ||
        candidate.timestamp < parent.timestamp
      ) {
        continue;
      }
      if (
        isBusinessName(parent.merchant, parent.counterparty) ||
        isBusinessName(candidate.merchant, candidate.counterparty)
      ) {
        continue;
      }
      const s = scorePair(p, candidate, ctx);
      if (isBannerWorthy(s) && (!best || s.score > best.score)) {
        best = { parent, candidate, reason: s.reason, score: s.score };
      }
    }
  }
  return best;
}

/**
 * One-tap split: a ride of `amount` shared by `people` (including you) leaves
 * the other people owing (people-1)/people of it. Rounded to paise.
 */
export function splitOwed(amount: number, people: number): number {
  if (!(people >= 2) || !(amount > 0)) {
    return 0;
  }
  return Math.round(((amount * (people - 1)) / people) * 100) / 100;
}
