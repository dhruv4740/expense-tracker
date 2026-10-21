// ─── Weekly auto-backup ──────────────────────────────────────────────────────
//
// On app open, if a backup folder was picked and the last backup is 7+ days
// old, write a JSON export (same envelope as Settings → Export JSON) into that
// folder and keep only the newest 8 of OUR backup files there. No background
// scheduling: it runs when the app is opened (RULES.md §1).

import { getAll } from './db';
import { buildJson } from './export';
import { getJSON, setJSON } from './settings';
import { deleteBackups, listBackups, writeToFolder } from './native/FileModule';

export const BACKUP_INTERVAL_MS = 7 * 86_400_000;
const BACKUP_KEEP = 8;
const FOLDER_KEY = 'backup_folder_uri';
const LAST_KEY = 'backup_last_ts';
const NAME_RE = /^expense-tracker-backup-\d{4}-\d{2}-\d{2}-\d{4}(?: \(\d+\))?\.json$/;

export function isBackupDue(last: number | null, now: number): boolean {
  // A last-backup time in the future (clock was wrong) must not suppress backups.
  return last == null || last > now || now - last >= BACKUP_INTERVAL_MS;
}

/** expense-tracker-backup-YYYY-MM-DD-HHmm.json (local time; sorts chronologically). */
export function backupFileName(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `expense-tracker-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** Oldest backup files beyond `keep`. Anything not named like our backups is never returned. */
export function backupsToDelete(names: string[], keep: number = BACKUP_KEEP): string[] {
  // Sort by date stem, then by the " (n)" suffix of same-minute duplicates
  // (a plain string sort would put "… (1).json" before "….json").
  const stem = (n: string) => n.replace(/(?: \(\d+\))?\.json$/, '');
  const dup = (n: string) => Number(/ \((\d+)\)\.json$/.exec(n)?.[1] ?? 0);
  const ours = names
    .filter(n => NAME_RE.test(n))
    .sort((a, b) => (stem(a) < stem(b) ? -1 : stem(a) > stem(b) ? 1 : dup(a) - dup(b)));
  return ours.length > keep ? ours.slice(0, ours.length - keep) : [];
}

export function getBackupFolder(): string | null {
  return getJSON<string | null>(FOLDER_KEY, null);
}

export function setBackupFolder(uri: string): void {
  setJSON(FOLDER_KEY, uri);
}

export function getLastBackupTs(): number | null {
  return getJSON<number | null>(LAST_KEY, null);
}

/** Readable folder label from a tree URI ("primary:Documents/Backups" → "Documents/Backups"). */
export function folderLabel(uri: string): string {
  try {
    const last = decodeURIComponent(uri.split('/tree/')[1] ?? uri);
    return last.replace(/^[^:]*:/, '') || last;
  } catch {
    return uri;
  }
}

/** Write a backup now and prune old ones. Throws if the folder is unavailable. */
export async function backupNow(now: number = Date.now()): Promise<string> {
  const folder = getBackupFolder();
  if (!folder) {
    throw new Error('No backup folder chosen');
  }
  const name = backupFileName(now);
  await writeToFolder(folder, name, 'application/json', buildJson(getAll()));
  setJSON(LAST_KEY, now);
  try {
    const old = backupsToDelete(await listBackups(folder));
    if (old.length > 0) {
      await deleteBackups(folder, old);
    }
  } catch {
    // The new backup is safely written; pruning is retried on the next one.
  }
  return name;
}

/** App-open hook: back up if a folder is set and one is due. Never throws. */
export async function maybeAutoBackup(now: number = Date.now()): Promise<boolean> {
  try {
    if (!getBackupFolder() || !isBackupDue(getLastBackupTs(), now)) {
      return false;
    }
    await backupNow(now);
    return true;
  } catch {
    return false;
  }
}
