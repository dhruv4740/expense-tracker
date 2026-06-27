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
