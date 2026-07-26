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
