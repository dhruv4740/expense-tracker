const store: Record<string, string> = {};
const mockWrite = jest.fn(async () => true);
const mockList = jest.fn(async (): Promise<string[]> => []);
const mockDelete = jest.fn(async () => 0);

jest.mock('../db', () => ({
  getAll: jest.fn(() => []),
  getSetting: (k: string) => store[k] ?? null,
  setSetting: (k: string, v: string) => {
    store[k] = v;
  },
}));
jest.mock('../native/FileModule', () => ({
  writeToFolder: (...a: unknown[]) => (mockWrite as jest.Mock)(...a),
  listBackups: (...a: unknown[]) => (mockList as jest.Mock)(...a),
  deleteBackups: (...a: unknown[]) => (mockDelete as jest.Mock)(...a),
}));

import {
  BACKUP_INTERVAL_MS,
  backupFileName,
  backupNow,
  backupsToDelete,
  folderLabel,
  isBackupDue,
  maybeAutoBackup,
  setBackupFolder,
} from '../autoBackup';

const NOW = new Date(2026, 9, 20, 9, 5).getTime();

beforeEach(() => {
  for (const k of Object.keys(store)) {
    delete store[k];
  }
  jest.clearAllMocks();
});

describe('pure helpers', () => {
  it('is due when never backed up or 7+ days ago', () => {
    expect(isBackupDue(null, NOW)).toBe(true);
    expect(isBackupDue(NOW - BACKUP_INTERVAL_MS, NOW)).toBe(true);
    expect(isBackupDue(NOW - BACKUP_INTERVAL_MS + 1, NOW)).toBe(false);
  });
  it('names files by local date and time', () => {
    expect(backupFileName(NOW)).toBe('expense-tracker-backup-2026-10-20-0905.json');
  });
  it('keeps the newest 8 of OUR files and never names anything else', () => {
    const ours = Array.from({ length: 10 }, (_, i) => `expense-tracker-backup-2026-0${(i % 9) + 1}-01-${String(i).padStart(4, '0')}.json`);
    const names = [...ours, 'holiday.jpg', 'expenses-2026-01-01.json', 'expense-tracker-backup-notes.txt'];
    const del = backupsToDelete(names);
    expect(del).toHaveLength(2);
    expect(del.every(n => ours.includes(n))).toBe(true);
    expect(del).toEqual([...ours].sort().slice(0, 2));
    expect(backupsToDelete(ours.slice(0, 8))).toEqual([]);
  });
  it('shows a readable folder name', () => {
    expect(folderLabel('content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FBackups')).toBe('Documents/Backups');
  });
});

describe('maybeAutoBackup', () => {
  it('does nothing without a folder', async () => {
    expect(await maybeAutoBackup(NOW)).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('writes when due, records the time, and prunes', async () => {
    setBackupFolder('content://tree/x');
    mockList.mockResolvedValueOnce(
      Array.from({ length: 9 }, (_, i) => `expense-tracker-backup-2026-09-0${i + 1}-1200.json`),
    );
    expect(await maybeAutoBackup(NOW)).toBe(true);
    expect(mockWrite).toHaveBeenCalledWith('content://tree/x', 'expense-tracker-backup-2026-10-20-0905.json', 'application/json', expect.any(String));
    expect(mockDelete).toHaveBeenCalledWith('content://tree/x', ['expense-tracker-backup-2026-09-01-1200.json']);
    expect(await maybeAutoBackup(NOW + 3 * 86_400_000)).toBe(false); // not due again yet
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
  it('a failed write is swallowed and not recorded', async () => {
    setBackupFolder('content://tree/x');
    mockWrite.mockRejectedValueOnce(new Error('revoked'));
    expect(await maybeAutoBackup(NOW)).toBe(false);
    expect(await maybeAutoBackup(NOW)).toBe(true); // retried next open
  });
  it('a pruning failure does not lose the backup', async () => {
    setBackupFolder('content://tree/x');
    mockList.mockRejectedValueOnce(new Error('gone'));
    await expect(backupNow(NOW)).resolves.toContain('backup');
  });
});
