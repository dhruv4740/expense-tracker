import {
  SUGGESTION_CUTOFF,
  scoreCandidate,
  suggestSettlements,
  type CandidateTx,
  type RideTarget,
  type ScoreContext,
} from '../settle';

const DAY_MS = 86_400_000;

function makeRide(overrides: Partial<RideTarget> = {}): RideTarget {
  return {
    id: 1,
    amount: 300,
    timestamp: 1_700_000_000_000,
    outstanding: 150,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateTx> = {}): CandidateTx {
  return {
    id: 99,
    amount: 150,
    timestamp: 1_700_000_000_000 + DAY_MS,
    type: 'income',
    category: 'Other',
    ...overrides,
  };
}

// ─── Hard disqualifiers ───────────────────────────────────────────────────────

describe('scoreCandidate — hard disqualifiers (always score 0)', () => {
  it('rejects type "self"', () => {
    const ride = makeRide();
    const candidate = makeCandidate({ type: 'self' });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });

  it('rejects a candidate already settling something else (settles_id set)', () => {
    const ride = makeRide();
    const candidate = makeCandidate({ settles_id: 42 });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });

  it('rejects a candidate whose id equals the ride id (cannot settle itself)', () => {
    const ride = makeRide({ id: 7 });
    const candidate = makeCandidate({ id: 7 });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });

  it('rejects category Investment', () => {
    const ride = makeRide();
    const candidate = makeCandidate({ category: 'Investment' });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });

  it('rejects a candidate timestamped more than 12h before the ride', () => {
    const ride = makeRide({ timestamp: 1_700_000_000_000 });
    const candidate = makeCandidate({
      timestamp: 1_700_000_000_000 - 13 * 3600_000,
    });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });

  it('rejects a candidate more than 30 days after the ride', () => {
    const ride = makeRide({ timestamp: 1_700_000_000_000 });
    const candidate = makeCandidate({
      timestamp: 1_700_000_000_000 + 31 * DAY_MS,
    });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });

  it('rejects a candidate whose amount exceeds 5x the target', () => {
    const ride = makeRide({ outstanding: 100 });
    const candidate = makeCandidate({ amount: 501, type: 'income' });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });
});

// ─── Mode selection ───────────────────────────────────────────────────────────

describe('scoreCandidate — mode selection', () => {
  it('income candidates get mode "reimbursement" and score against ride.outstanding', () => {
    const ride = makeRide({ amount: 300, outstanding: 120 });
    const candidate = makeCandidate({ type: 'income', amount: 120 });
    const result = scoreCandidate(candidate, ride);
    expect(result.mode).toBe('reimbursement');
    expect(result.score).toBeGreaterThan(0);
  });

  it('expense candidates get mode "repayment" and score against ride.amount', () => {
    const ride = makeRide({ amount: 200, outstanding: 0 });
    const candidate = makeCandidate({ type: 'expense', amount: 200 });
    const result = scoreCandidate(candidate, ride);
    expect(result.mode).toBe('repayment');
    expect(result.score).toBeGreaterThan(0);
  });

  it('an outgoing expense (repayment) can score above the cutoff — the old income-only query could never surface this', () => {
    const ride = makeRide({
      amount: 200,
      timestamp: 1_700_000_000_000,
      outstanding: 0,
    });
    // Friend paid the fare; user is now paying their own share back as an expense.
    const candidate = makeCandidate({
      type: 'expense',
      amount: 200,
      timestamp: 1_700_000_000_000 + DAY_MS, // 1 day later
    });
    const result = scoreCandidate(candidate, ride);
    expect(result.mode).toBe('repayment');
    expect(result.score).toBeGreaterThan(SUGGESTION_CUTOFF);
  });
});

// ─── Amount tiers ─────────────────────────────────────────────────────────────

describe('scoreCandidate — amount tiers', () => {
  const baseTimestamp = 1_700_000_000_000;

  it('exact match to target scores highest', () => {
    const ride = makeRide({ amount: 300, outstanding: 100, timestamp: baseTimestamp });
    const candidate = makeCandidate({
      type: 'income',
      amount: 100, // == outstanding (target)
      timestamp: baseTimestamp + DAY_MS,
    });
    const exact = scoreCandidate(candidate, ride);

    const shareCandidate = makeCandidate({
      type: 'income',
      amount: 300, // == ride.amount, not target
      timestamp: baseTimestamp + DAY_MS,
    });
    const share = scoreCandidate(shareCandidate, ride);

    expect(exact.score).toBeGreaterThan(share.score);
    expect(exact.score).toBeGreaterThan(SUGGESTION_CUTOFF);
  });

  it('a match to one equal share (ride.amount) scores lower but still above cutoff', () => {
    const ride = makeRide({ amount: 150, outstanding: 100, timestamp: baseTimestamp });
    const candidate = makeCandidate({
      type: 'income',
      amount: 150, // == ride.amount, not == outstanding(target)
      timestamp: baseTimestamp + DAY_MS,
    });
    const result = scoreCandidate(candidate, ride);
    expect(result.score).toBeGreaterThan(SUGGESTION_CUTOFF);
    expect(result.score).toBeLessThan(55 + 25); // less than exact-match ceiling
  });

  it('a partial payback (>=20% of target) scores lower again', () => {
    const ride = makeRide({ amount: 150, outstanding: 100, timestamp: baseTimestamp });
    const candidate = makeCandidate({
      type: 'income',
      amount: 30, // 30% of target(100), not equal to target or ride.amount
      timestamp: baseTimestamp + DAY_MS,
    });
    const result = scoreCandidate(candidate, ride);
    expect(result.score).toBeGreaterThan(0);
    // Clearly weaker than the "one equal share" tier (45 + recency), which is
    // itself weaker than an exact match (55 + recency).
    expect(result.score).toBeLessThan(45 + 25);
  });

  it('an amount with no meaningful relationship returns 0', () => {
    const ride = makeRide({ amount: 150, outstanding: 100, timestamp: baseTimestamp });
    const candidate = makeCandidate({
      type: 'income',
      amount: 5, // 5% of target — below the 20% partial-payback floor
      timestamp: baseTimestamp + DAY_MS,
    });
    expect(scoreCandidate(candidate, ride).score).toBe(0);
  });
});

// ─── Recency relative to the ride ─────────────────────────────────────────────

describe('scoreCandidate — recency is relative to the ride, not to now', () => {
  it('a candidate 2 days after the ride outscores an otherwise-identical one 10 days after', () => {
    const ride = makeRide({ amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });
    const near = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: ride.timestamp + 2 * DAY_MS,
    });
    const far = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: ride.timestamp + 10 * DAY_MS,
    });
    const nearScore = scoreCandidate(near, ride).score;
    const farScore = scoreCandidate(far, ride).score;
    expect(nearScore).toBeGreaterThan(farScore);
    // 2 days -> +25 recency bucket, 10 days -> +5 recency bucket
    expect(nearScore - farScore).toBe(20);
  });
});

// ─── Counterparty history ─────────────────────────────────────────────────────

describe('scoreCandidate — counterparty history', () => {
  const ride = makeRide({ amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });

  it('adds score and appends to reason when counterparty is known', () => {
    const candidateNoHistory = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: ride.timestamp + DAY_MS,
      counterparty: 'rahul',
    });
    const withoutCtx = scoreCandidate(candidateNoHistory, ride, {});

    const candidateWithHistory = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: ride.timestamp + DAY_MS,
      counterparty: 'rahul',
    });
    const ctx: ScoreContext = { knownCounterparties: ['rahul'] };
    const withCtx = scoreCandidate(candidateWithHistory, ride, ctx);

    expect(withCtx.score).toBeGreaterThan(withoutCtx.score);
    expect(withCtx.score - withoutCtx.score).toBe(30);
    expect(withCtx.reason).toMatch(/settled a ride before/);
  });

  it('matches case-insensitively (candidate counterparty is lowercased before lookup)', () => {
    const candidate = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: ride.timestamp + DAY_MS,
      counterparty: 'RAHUL',
    });
    const ctx: ScoreContext = { knownCounterparties: ['rahul'] };
    const result = scoreCandidate(candidate, ride, ctx);
    expect(result.reason).toMatch(/settled a ride before/);
  });
});

// ─── Negative signals ─────────────────────────────────────────────────────────

describe('scoreCandidate — negative signals', () => {
  const ride = makeRide({ amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });

  it.each(['salary', 'cashback', 'interest', 'dividend'])(
    'penalizes raw_text containing "%s"',
    (keyword) => {
      const clean = makeCandidate({
        type: 'income',
        amount: 100,
        timestamp: ride.timestamp + DAY_MS,
        raw_text: 'Rs.100 credited to your account',
      });
      const flagged = makeCandidate({
        type: 'income',
        amount: 100,
        timestamp: ride.timestamp + DAY_MS,
        raw_text: `Rs.100 ${keyword} credited to your account`,
      });
      const cleanScore = scoreCandidate(clean, ride).score;
      const flaggedScore = scoreCandidate(flagged, ride).score;
      expect(flaggedScore).toBeLessThan(cleanScore);
      expect(cleanScore - flaggedScore).toBe(45);
    },
  );

  it('penalizes an implausibly large amount relative to ctx.typicalFare', () => {
    const bigRide = makeRide({ amount: 700, outstanding: 700, timestamp: 1_700_000_000_000 });
    const candidate = makeCandidate({
      type: 'income',
      amount: 700, // exact match to target, but 4.67x typicalFare
      timestamp: bigRide.timestamp + DAY_MS,
    });
    const withoutFare = scoreCandidate(candidate, bigRide, {}).score;
    const withFare = scoreCandidate(candidate, bigRide, { typicalFare: 150 }).score;
    expect(withFare).toBeLessThan(withoutFare);
    expect(withoutFare - withFare).toBe(25);
  });
});

// ─── suggestSettlements ───────────────────────────────────────────────────────

describe('suggestSettlements', () => {
  it('returns [] for empty candidates or empty rides', () => {
    const ride = makeRide();
    const candidate = makeCandidate();
    expect(suggestSettlements([], [ride])).toEqual([]);
    expect(suggestSettlements([candidate], [])).toEqual([]);
    expect(suggestSettlements([], [])).toEqual([]);
  });

  it('returns at most one suggestion per candidate (its best-scoring ride)', () => {
    const weakRide = makeRide({
      id: 1,
      amount: 300,
      outstanding: 30, // candidate amount(100) is 3.3x target -> disqualified (>5x not triggered, but weak tier)
      timestamp: 1_700_000_000_000,
    });
    const strongRide = makeRide({
      id: 2,
      amount: 300,
      outstanding: 100, // exact match
      timestamp: 1_700_000_000_000,
    });
    const candidate = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: 1_700_000_000_000 + DAY_MS,
    });

    const results = suggestSettlements([candidate], [weakRide, strongRide]);
    const matchesForCandidate = results.filter((s) => s.candidate === candidate);
    expect(matchesForCandidate.length).toBe(1);
    expect(matchesForCandidate[0].ride.id).toBe(2); // picked the higher-scoring ride
  });

  it('sorts strongest-first', () => {
    const ride = makeRide({ id: 1, amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });
    const strong = makeCandidate({
      id: 201,
      type: 'income',
      amount: 100, // exact match, recent
      timestamp: ride.timestamp + DAY_MS,
    });
    const weaker = makeCandidate({
      id: 202,
      type: 'income',
      amount: 30, // partial payback, recent
      timestamp: ride.timestamp + DAY_MS,
    });
    const results = suggestSettlements([weaker, strong], [ride]);
    expect(results.length).toBe(2);
    expect(results[0].candidate).toBe(strong);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('drops everything below SUGGESTION_CUTOFF', () => {
    const ride = makeRide({ amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });
    const belowCutoff = makeCandidate({
      id: 3,
      type: 'income',
      amount: 25, // 25% of target, far out (>14 days) -> no recency bonus -> score 25, below 40
      timestamp: ride.timestamp + 20 * DAY_MS,
    });
    const results = suggestSettlements([belowCutoff], [ride]);
    expect(results).toEqual([]);
    // sanity-check the assumption behind this test
    expect(scoreCandidate(belowCutoff, ride).score).toBeLessThan(SUGGESTION_CUTOFF);
  });

  it('respects limit', () => {
    const ride = makeRide({ amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });
    const candidates = [1, 2, 3, 4, 5, 6].map((n) =>
      makeCandidate({
        id: 100 + n,
        type: 'income',
        amount: 100,
        timestamp: ride.timestamp + DAY_MS,
        counterparty: `friend${n}`,
      }),
    );
    const results = suggestSettlements(candidates, [ride], {}, 3);
    expect(results.length).toBe(3);
  });

  it('every returned suggestion above cutoff has a non-empty reason string', () => {
    const ride = makeRide({ amount: 300, outstanding: 100, timestamp: 1_700_000_000_000 });
    const candidate = makeCandidate({
      type: 'income',
      amount: 100,
      timestamp: ride.timestamp + DAY_MS,
    });
    const results = suggestSettlements([candidate], [ride]);
    expect(results.length).toBe(1);
    for (const suggestion of results) {
      expect(suggestion.reason.length).toBeGreaterThan(0);
    }
  });
});

// ─── generic pair-to-cancel ───────────────────────────────────────────────────

import { suggestPairs, scorePair, isBannerWorthy, pickRepaymentBanner, pairKey, PAIR_CUTOFF } from '../settle';
import type { PairParent, CandidateTx as PairCandidate, BannerRow } from '../settle';

describe('suggestPairs', () => {
  const DAY = 86_400_000;
  const parent: PairParent = { id: 1, type: 'expense', amount: 500, timestamp: 1_700_000_000_000, counterparty: 'anita@okaxis' };
  const cand = (over: Partial<PairCandidate>): PairCandidate => ({
    id: 10, type: 'income', amount: 500, category: 'Friend Transfer',
    timestamp: parent.timestamp + DAY, ...over,
  });

  it('an exact opposite-direction match outranks a partial one', () => {
    const r = suggestPairs(parent, [cand({ id: 11, amount: 130 }), cand({ id: 12 })]);
    expect(r.map(x => x.candidate.id)).toEqual([12, 11]);
    expect(r[0].score).toBeGreaterThan(r[1].score);
  });

  it('works for an income parent cancelled by an expense', () => {
    const inc: PairParent = { ...parent, type: 'income' };
    expect(suggestPairs(inc, [cand({ type: 'expense' })])).toHaveLength(1);
    expect(suggestPairs(inc, [cand({ type: 'income' })])).toHaveLength(0);
  });

  it.each([
    ['same direction', { type: 'expense' as const }],
    ['self', { type: 'self' as const }],
    ['Investment', { category: 'Investment' }],
    ['already linked', { settles_id: 99 }],
    ['itself', { id: 1 }],
    ['larger than the remainder', { amount: 800 }],
    ['before the parent', { timestamp: parent.timestamp - 2 * DAY }],
  ])('rejects %s', (_n, over) => {
    expect(suggestPairs(parent, [cand(over)])).toEqual([]);
  });

  it('has no time limit: a payback months later is still listed, ranked lower', () => {
    const r = suggestPairs(parent, [
      cand({ id: 30, timestamp: parent.timestamp + 90 * DAY }),
      cand({ id: 31, timestamp: parent.timestamp + 2 * DAY }),
    ]);
    expect(r.map(x => x.candidate.id)).toEqual([31, 30]);
    expect(r[1].reason).toMatch(/90 days later/);
  });

  it('recognises 1/2, 1/3 and 1/4 shares', () => {
    for (const a of [250, 166.67, 125]) {
      expect(suggestPairs(parent, [cand({ amount: a })])[0].reason).toMatch(/Equal share/);
    }
  });

  it('measures against what is left after earlier payments', () => {
    const half = { ...parent, alreadyPaid: 300 };
    expect(suggestPairs(half, [cand({ amount: 200 })])[0].reason).toMatch(/Same amount/);
    expect(suggestPairs(half, [cand({ amount: 500 })])).toEqual([]);
  });

  it('same person boosts the score, different person is labelled honestly', () => {
    const diff = suggestPairs(parent, [cand({ counterparty: 'arun@okicici' })])[0];
    const same = suggestPairs(parent, [cand({ counterparty: 'anita@okaxis' })])[0];
    expect(same.score).toBeGreaterThan(diff.score);
    expect(same.reason).toMatch(/same person/);
    expect(diff.reason).toBe('Same amount · 1 day later · different person');
  });

  it('salary/interest/refund wording is penalised', () => {
    const plain = scorePair(parent, cand({}));
    const sal = scorePair(parent, cand({ raw_text: 'Salary credited' }));
    expect(sal.score).toBeLessThan(plain.score);
    expect(sal.penalized).toBe(true);
  });

  it('limit applies', () => {
    const many = Array.from({ length: 8 }, (_, i) => cand({ id: 20 + i }));
    expect(suggestPairs(parent, many)).toHaveLength(5);
    expect(PAIR_CUTOFF).toBeGreaterThan(0);
  });
});

describe('repayment banner (proactive, strict)', () => {
  const DAY = 86_400_000;
  const T = 1_700_000_000_000;
  const row = (over: Partial<BannerRow>): BannerRow => ({
    id: 1, type: 'expense', amount: 100, category: 'Friend Transfer',
    timestamp: T, counterparty: 'p1@upi', ...over,
  });

  it('₹100 paid, unrelated ₹100 from a different person 10 days later → no banner', () => {
    const rows = [row({}), row({ id: 2, type: 'income', timestamp: T + 10 * DAY, counterparty: 'p2@upi' })];
    expect(pickRepaymentBanner(rows, {}, new Set())).toBeNull();
    // ...but it is still findable on demand, labelled honestly.
    const r = suggestPairs({ ...rows[0], type: 'expense' }, [rows[1]]);
    expect(r).toHaveLength(1);
    expect(r[0].reason).toMatch(/different person/);
  });

  it('same amount within 3 days from a different person → no banner', () => {
    const rows = [row({}), row({ id: 2, type: 'income', timestamp: T + 2 * DAY, counterparty: 'p2@upi' })];
    expect(pickRepaymentBanner(rows, {}, new Set())).toBeNull();
  });

  it('same amount within 3 days from the same person → banner', () => {
    const rows = [row({}), row({ id: 2, type: 'income', timestamp: T + 2 * DAY, counterparty: 'p1@upi' })];
    const b = pickRepaymentBanner(rows, {}, new Set());
    expect(b?.parent.id).toBe(1);
    expect(b?.candidate.id).toBe(2);
  });

  it('never pairs a shop payment with a friend credit, even for a known person', () => {
    const rows = [
      row({ amount: 1200, merchant: 'RELIANCE RETAIL LIMITE', counterparty: 'reliance@upi' }),
      row({ id: 2, amount: 1200, type: 'income', merchant: 'TESTA A', counterparty: 'testa@upi' }),
    ];
    expect(pickRepaymentBanner(rows, { knownCounterparties: ['testa@upi'] }, new Set())).toBeNull();
    // ...still available on demand.
    expect(suggestPairs({ ...rows[0], type: 'expense' }, [rows[1]])).toHaveLength(1);
  });

  it('same person, equal amount, 20 days later → banner; known person too', () => {
    const same = [row({}), row({ id: 2, type: 'income', timestamp: T + 20 * DAY, counterparty: 'p1@upi' })];
    expect(pickRepaymentBanner(same, {}, new Set())).not.toBeNull();
    const known = [row({}), row({ id: 2, type: 'income', timestamp: T + 20 * DAY, counterparty: 'p2@upi' })];
    expect(pickRepaymentBanner(known, {}, new Set())).toBeNull();
    expect(pickRepaymentBanner(known, { knownCounterparties: ['p2@upi'] }, new Set())).not.toBeNull();
  });

  it('dismissed pairs are not offered again; salary-like text never qualifies', () => {
    const rows = [row({}), row({ id: 2, type: 'income', timestamp: T + DAY, counterparty: 'p2@upi' })];
    expect(pickRepaymentBanner(rows, {}, new Set([pairKey(1, 2)]))).toBeNull();
    const sal = [row({}), row({ id: 2, type: 'income', timestamp: T + DAY, raw_text: 'cashback credited' })];
    expect(pickRepaymentBanner(sal, {}, new Set())).toBeNull();
  });

  it('a partial amount is never banner-worthy', () => {
    const s = scorePair(
      { id: 1, type: 'expense', amount: 500, timestamp: T },
      { id: 2, type: 'income', amount: 130, category: 'x', timestamp: T + DAY },
    );
    expect(isBannerWorthy(s)).toBe(false);
  });
});

describe('splitOwed', () => {
  const { splitOwed } = require('../settle');
  it('friends owe (n-1)/n of the fare, rounded to paise', () => {
    expect(splitOwed(300, 2)).toBe(150);
    expect(splitOwed(300, 3)).toBe(200);
    expect(splitOwed(250, 4)).toBe(187.5);
    expect(splitOwed(100, 3)).toBe(66.67);
  });
  it('returns 0 for fewer than 2 people or non-positive amounts', () => {
    expect(splitOwed(300, 1)).toBe(0);
    expect(splitOwed(0, 3)).toBe(0);
  });
});
