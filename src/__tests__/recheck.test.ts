import {
  PHANTOM_NOTE,
  appendNote,
  buildLog,
  groupChanges,
  planRecheck,
  planUndo,
} from '../recheck';
import type { RecheckCtx, RecheckRow } from '../recheck';

const ctx: RecheckCtx = {
  identity: { name: 'Test User', phones: [], upiHandles: [], accountLast4: ['1111'] },
  rules: {},
  family: [],
};

const T = 1_700_000_000_000;
let n = 1;
const row = (over: Partial<RecheckRow>): RecheckRow => ({
  id: n++,
  amount: 250,
  merchant: 'CAFE ONE',
  source: 'HDFCBK',
  raw_text: 'Rs.250.00 debited from A/c XX9999 on 01-01-26 to CAFE ONE. UPI Ref 101041477098',
  category: 'Other',
  timestamp: T,
  type: 'expense',
  category_source: 'auto',
  channel: 'sms',
  ...over,
});

describe('planRecheck', () => {
  it('reports nothing when stored values already match the current logic', () => {
    // Classify once to learn what the pipeline says, then store exactly that.
    const first = planRecheck([row({ category: 'zzz' })], ctx)[0];
    expect(first).toBeDefined();
    const settled = row({ category: first.category, type: first.type });
    expect(planRecheck([settled], ctx)).toEqual([]);
  });

  it('proposes a category change for an auto row', () => {
    const [c] = planRecheck([row({ category: 'Shopping' })], ctx);
    expect(c.category).not.toBe('Shopping');
    expect(c.phantom).toBe(false);
    expect(c.group).toBe(`Shopping → ${c.category}`);
  });

  it('skips manual rows (category_source or channel)', () => {
    expect(planRecheck([row({ category: 'zzz', category_source: 'manual' })], ctx)).toEqual([]);
    expect(planRecheck([row({ category: 'zzz', channel: 'manual' })], ctx)).toEqual([]);
  });

  it('skips rows without raw text', () => {
    expect(planRecheck([row({ category: 'zzz', raw_text: null })], ctx)).toEqual([]);
  });

  it('skips linked rows, as parent and as child', () => {
    const parent = row({ category: 'zzz' });
    const child = row({ category: 'zzz', type: 'income', settles_id: parent.id });
    expect(planRecheck([parent, child], ctx)).toEqual([]);
    expect(planRecheck([parent], ctx)).toHaveLength(1); // alone it would change
  });

  it('never flips a historical card_bill / wallet_load expense to self', () => {
    const bill = row({
      raw_text: 'Payment of Rs.5000.00 received towards your Credit Card XX1111. Thank you',
      type: 'expense',
      category: 'Other',
    });
    const wallet = row({
      raw_text: 'Rs.500.00 debited from A/c XX9999 on 01-01-26 for Paytm Wallet load. UPI Ref 102339986250',
      type: 'expense',
      category: 'Other',
    });
    for (const r of [bill, wallet]) {
      const changes = planRecheck([r], ctx);
      expect(changes.filter(c => c.type === 'self' && c.row.type === 'expense')).toEqual([]);
    }
  });

  it('turns a phantom into type self with a note, never a delete', () => {
    const r = row({ raw_text: 'Your OTP for txn of Rs.250.00 is 123456', note: 'mine' });
    const [c] = planRecheck([r], ctx);
    expect(c.phantom).toBe(true);
    expect(c.type).toBe('self');
    expect(c.category).toBe(r.category);
    expect(c.note).toBe(`mine\n${PHANTOM_NOTE}`);
    expect(c.group).toBe('phantom → hidden');
  });

  it('ignores a phantom that is already hidden', () => {
    expect(planRecheck([row({ raw_text: 'Your OTP is 123456', type: 'self' })], ctx)).toEqual([]);
  });

  it('never changes a row that is already self, even when classify() would', () => {
    // Empty identity: classify() alone would call this a plain expense.
    expect(planRecheck([row({ type: 'self', category: 'Other' })], ctx)).toEqual([]);
    expect(planRecheck([row({ type: 'self', category: 'zzz', amount: 100000 })], ctx)).toEqual([]);
  });

  it('never changes rows listed in protectedIds (auto-paired transfers)', () => {
    const r = row({ category: 'zzz' });
    expect(planRecheck([r], ctx)).toHaveLength(1);
    expect(planRecheck([r], { ...ctx, protectedIds: [r.id as number] })).toEqual([]);
  });

  it('keeps category_source auto and leaves raw_text alone in the log', () => {
    const [c] = planRecheck([row({ category: 'Shopping' })], ctx);
    const log = buildLog([c], 5);
    expect(log.entries[0].set.category_source).toBe('auto');
    expect(log.entries[0].prev).toEqual({ type: 'expense', category: 'Shopping', note: null, category_source: 'auto' });
  });
});

describe('groupChanges / appendNote', () => {
  it('groups by label, biggest first', () => {
    const rows = [
      row({ category: 'Shopping' }),
      row({ category: 'Shopping' }),
      row({ raw_text: 'OTP is 123456 Rs.1' }),
    ];
    const groups = groupChanges(planRecheck(rows, ctx));
    expect(groups[0].changes.length).toBe(2);
    expect(groups.map(g => g.label)).toContain('phantom → hidden');
  });

  it('appendNote does not duplicate', () => {
    expect(appendNote(null, 'x')).toBe('x');
    expect(appendNote('a', 'x')).toBe('a\nx');
    expect(appendNote('a\nx', 'x')).toBe('a\nx');
  });
});

describe('planUndo', () => {
  it('restores only rows still holding the values the re-check set', () => {
    const rows = [row({ category: 'Shopping' }), row({ category: 'Shopping' }), row({ category: 'Shopping' })];
    const changes = planRecheck(rows, ctx);
    const log = buildLog(changes, 1);
    const current = new Map(
      changes.map(c => [c.id, { type: c.type, category: c.category, note: c.note }]),
    );
    current.set(changes[1].id, { type: changes[1].type, category: 'Edited by user', note: null });
    current.delete(changes[2].id); // deleted since
    const undo = planUndo(log, current);
    expect(undo.map(e => e.id)).toEqual([changes[0].id]);
  });
});
