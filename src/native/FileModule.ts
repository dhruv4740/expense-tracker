/**
 * JS bridge for the FileModule native module.
 *
 * Wraps Android Storage Access Framework (SAF) file operations so JS can
 * save and pick files without requiring any extra runtime permissions.
 * Works correctly on Android 11+ with scoped storage.
 *
 * Only one operation can be in flight at a time — the native side enforces
 * this and will reject a second call while the first picker is open.
 */

import { NativeModules } from 'react-native';

const { FileModule } = NativeModules;

/**
 * Open the system "Save file" picker and write [content] as UTF-8 text to
 * the user-chosen location.
 *
 * @param suggestedName  File name pre-filled in the picker
 *                       (e.g. "expenses-2024-06-28.csv").
 * @param mimeType       MIME type for the picker filter
 *                       (e.g. "text/csv", "application/json").
 * @param content        UTF-8 text to write into the new file.
 * @returns              Resolves true on success, false if the user cancelled.
 * @throws               Rejects with a native error code if writing fails or
 *                       no foreground Activity is available.
 */
export function saveTextFile(
  suggestedName: string,
  mimeType: string,
  content: string,
): Promise<boolean> {
  return FileModule.saveTextFile(suggestedName, mimeType, content);
}

/**
 * Open the system "Open file" picker and read the user-chosen file as UTF-8
 * text.
 *
 * @returns  Resolves with the file contents as a string on success;
 *           resolves with null if the user cancelled the picker;
 *           rejects if the file cannot be read or no Activity is available.
 */
export function pickTextFile(): Promise<string | null> {
  return FileModule.pickTextFile();
}

/**
 * Let the user pick the backup folder (system folder picker). The app keeps
 * read/write access to it across restarts.
 *
 * @returns  The folder's tree URI, or null if the user cancelled.
 */
export function pickBackupFolder(): Promise<string | null> {
  return FileModule.pickBackupFolder();
}

/** Write a new UTF-8 file inside the picked folder. */
export function writeToFolder(
  treeUri: string,
  name: string,
  mimeType: string,
  content: string,
): Promise<boolean> {
  return FileModule.writeToFolder(treeUri, name, mimeType, content);
}

/** Names of the app's own backup files in the picked folder (other files are never listed). */
export function listBackups(treeUri: string): Promise<string[]> {
  return FileModule.listBackups(treeUri);
}

/** Delete the named backup files from the picked folder; resolves the count deleted. */
export function deleteBackups(treeUri: string, names: string[]): Promise<number> {
  return FileModule.deleteBackups(treeUri, names);
}
