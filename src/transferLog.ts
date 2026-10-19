// ─── Undo log for auto-applied own-account transfers (pure) ──────────────────
//
// Stored as JSON in app_settings under `auto_self_log` (NOT in the note column:
// notes are user-visible text and would need cleaning up on undo; a settings
// key keeps the audit trail in one place and can be capped cheaply). One batch
// per sync run that auto-marked something; the last MAX_BATCHES are kept.

export const AUTO_SELF_LOG_KEY = 'auto_self_log';
export const MAX_BATCHES = 50;

export interface AutoSelfEntry {
  id: string;
  amount: number;
  /** Debit-side and credit-side labels for the banner text. */
  from: string;
  to: string;
  basis: 'ref' | 'time' | 'near';
  /** The rows' type before we changed them, so Undo can restore it exactly. */
  prev: Array<{ id: number; type: 'expense' | 'income' | 'self' }>;
  seen: boolean;
  undone: boolean;
}

export interface AutoSelfBatch {
  at: number;
  entries: AutoSelfEntry[];
}

export function appendBatch(log: AutoSelfBatch[], batch: AutoSelfBatch): AutoSelfBatch[] {
  if (batch.entries.length === 0) {
    return log;
  }
  return [...log, batch].slice(-MAX_BATCHES);
}

function mapEntries(
  log: AutoSelfBatch[],
  id: string,
  patch: Partial<AutoSelfEntry>,
): AutoSelfBatch[] {
  return log.map(b => ({
    ...b,
    entries: b.entries.map(e => (e.id === id ? { ...e, ...patch } : e)),
  }));
}

export const markSeen = (log: AutoSelfBatch[], id: string) => mapEntries(log, id, { seen: true });
export const markUndone = (log: AutoSelfBatch[], id: string) =>
  mapEntries(log, id, { undone: true, seen: true });

/** Entries still waiting for the user to see them, newest first. */
export function unseenEntries(log: AutoSelfBatch[]): AutoSelfEntry[] {
  const out: AutoSelfEntry[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    for (let j = log[i].entries.length - 1; j >= 0; j--) {
      const e = log[i].entries[j];
      if (!e.seen && !e.undone) {
        out.push(e);
      }
    }
  }
  return out;
}

export function findEntry(log: AutoSelfBatch[], id: string): AutoSelfEntry | null {
  for (const b of log) {
    const e = b.entries.find(x => x.id === id);
    if (e) {
      return e;
    }
  }
  return null;
}

/** Keep a capped list of dismissed keys (newest last). */
export function addDismissed(list: string[], key: string, cap = 500): string[] {
  return list.includes(key) ? list : [...list, key].slice(-cap);
}
