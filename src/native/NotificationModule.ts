import { NativeModules, NativeEventEmitter } from 'react-native';

const { NotificationModule } = NativeModules;

/** Returns true if the user has granted Notification Listener access in system Settings. */
export function isNotificationAccessGranted(): Promise<boolean> {
  return NotificationModule.isNotificationAccessGranted();
}

/** Opens the system Notification Access settings screen for the user to grant permission. */
export function openNotificationAccessSettings(): void {
  NotificationModule.openNotificationAccessSettings();
}

const emitter = new NativeEventEmitter(NotificationModule);

/** Raw notification event shape as captured by NotificationService.kt (unparsed). */
export interface NotificationEvent {
  kind: 'notification';
  pkg?: string;
  title?: string;
  body: string;
  ts: number;
}

/**
 * Subscribe to live notification events emitted while the app is open.
 * Returns the subscription — call `.remove()` on unmount to avoid leaks.
 *
 * Events are also written to the shared EventBuffer (drained by SmsModule.drainBuffer)
 * so events captured while the app is closed are not lost.
 */
export function onNotificationReceived(
  cb: (e: NotificationEvent) => void,
): ReturnType<typeof emitter.addListener> {
  return emitter.addListener('NotificationReceived', cb);
}

// ---------------------------------------------------------------------------
// Phase 9 — user-editable allowlist (persisted in SharedPreferences on the
// native side so NotificationService can read it with zero RN bridge cost).
// ---------------------------------------------------------------------------

/**
 * Entry in the default banking/UPI app allowlist.
 * `pkg` is the Android package name; `label` is the human-readable app name shown in UI.
 */
export interface AllowlistEntry {
  pkg: string;
  label: string;
}

/**
 * Retrieve the built-in default allowlist with human-readable labels.
 * Use this to pre-populate the Settings screen allowlist editor so the user can
 * see which apps are covered and toggle individual entries.
 *
 * @returns Array of {pkg, label} for every entry in NotificationService.DEFAULT_ALLOWLIST.
 */
export function getDefaultAllowlist(): Promise<AllowlistEntry[]> {
  return NotificationModule.getDefaultAllowlist();
}

/**
 * Retrieve the currently active package allowlist from SharedPreferences.
 * Falls back to DEFAULT_ALLOWLIST package names if the user has not yet saved a custom list.
 *
 * @returns Array of package name strings that NotificationService will accept.
 */
export function getAllowlist(): Promise<string[]> {
  return NotificationModule.getAllowlist();
}

/**
 * Persist a new user-defined package allowlist to SharedPreferences and immediately
 * invalidate the in-process cache in NotificationService so the change takes effect
 * on the very next notification without requiring an app restart.
 *
 * @param packages - Array of Android package name strings to allow.
 * @returns true on success.
 */
export function setAllowlist(packages: string[]): Promise<boolean> {
  return NotificationModule.setAllowlist(packages);
}
