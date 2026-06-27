/**
 * JS bridge for the SmsModule native module.
 *
 * drainBuffer() drains the SHARED EventBuffer — it returns ALL buffered events,
 * both SMS (kind: 'sms') and notification (kind: 'notification') events written
 * by SmsReceiver and NotificationService respectively. Call this once on app open
 * or foreground to process any events captured while the app was closed.
 *
 * onSmsReceived() subscribes to live SMS events emitted while the app is open.
 * Returns an EmitterSubscription — call .remove() on unmount to avoid leaks.
 */

import { NativeModules, NativeEventEmitter } from 'react-native';

export interface RawEvent {
  kind: 'sms' | 'notification';
  /** SMS sender ID (e.g. "HDFCBK"). Set for kind === 'sms'. */
  sender?: string;
  /** Notification source package (e.g. "com.phonepe.app"). Set for kind === 'notification'. */
  pkg?: string;
  /** Notification title. Set for kind === 'notification'. */
  title?: string;
  /** Raw message body — the text to parse for transaction data. Always present. */
  body: string;
  /** Capture timestamp in milliseconds (System.currentTimeMillis()). */
  ts: number;
}

const { SmsModule } = NativeModules;

/**
 * Drain the shared EventBuffer and return all buffered events (sms + notifications).
 * The buffer is cleared atomically on drain. Call on app open / foreground.
 */
export function drainBuffer(): Promise<RawEvent[]> {
  return SmsModule.drainBuffer();
}

const emitter = new NativeEventEmitter(SmsModule);

/**
 * Subscribe to live SMS events emitted while the app is open.
 * The callback fires immediately after SmsReceiver writes to the buffer.
 * Returns an EmitterSubscription — call .remove() in your cleanup / useEffect return.
 */
export function onSmsReceived(cb: (e: RawEvent) => void) {
  return emitter.addListener('SmsReceived', cb);
}
