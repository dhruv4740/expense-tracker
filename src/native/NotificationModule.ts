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
