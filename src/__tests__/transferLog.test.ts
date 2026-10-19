import {
  MAX_BATCHES,
  addDismissed,
  appendBatch,
  findEntry,
  markSeen,
  markUndone,
  unseenEntries,
} from '../transferLog';
import type { AutoSelfBatch, AutoSelfEntry } from '../transferLog';

const entry = (id: string): AutoSelfEntry => ({
  id,
  amount: 100,
  from: 'BANKA',
  to: 'BANKB',
  basis: 'time',
  prev: [
    { id: 1, type: 'expense' },
    { id: 2, type: 'income' },
  ],
  seen: false,
  undone: false,
});

describe('transferLog', () => {
  it('keeps only the last 50 batches and ignores empty batches', () => {
    let log: AutoSelfBatch[] = [];
    for (let i = 0; i < MAX_BATCHES + 10; i++) {
      log = appendBatch(log, { at: i, entries: [entry(`e${i}`)] });
    }
    expect(log).toHaveLength(MAX_BATCHES);
    expect(log[0].at).toBe(10);
    expect(appendBatch(log, { at: 999, entries: [] })).toBe(log);
  });

  it('unseenEntries is newest first and drops seen / undone ones', () => {
    let log = appendBatch([], { at: 1, entries: [entry('a'), entry('b')] });
    log = appendBatch(log, { at: 2, entries: [entry('c')] });
    expect(unseenEntries(log).map(e => e.id)).toEqual(['c', 'b', 'a']);
    log = markSeen(log, 'c');
    log = markUndone(log, 'a');
    expect(unseenEntries(log).map(e => e.id)).toEqual(['b']);
    expect(findEntry(log, 'a')?.undone).toBe(true);
    expect(findEntry(log, 'zzz')).toBeNull();
  });

  it('addDismissed de-duplicates and caps', () => {
    expect(addDismissed(['1:2'], '1:2')).toEqual(['1:2']);
    expect(addDismissed(['1:2', '3:4'], '5:6', 2)).toEqual(['3:4', '5:6']);
  });
});
