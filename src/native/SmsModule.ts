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
 *
 * @deprecated Prefer peekBuffer() + ackBuffer(count) — draining clears the buffer
 * before the caller has processed anything, so a crash mid-processing loses events.
 */
export function drainBuffer(): Promise<RawEvent[]> {
  return SmsModule.drainBuffer();
}

/**
 * Return all buffered events WITHOUT clearing the buffer. Pair with ackBuffer()
 * once the events have been durably processed (inserted into the DB) — this
 * two-phase contract means a crash mid-processing leaves events for the next
 * sync cycle instead of losing them.
 */
export function peekBuffer(): Promise<RawEvent[]> {
  return SmsModule.peekBuffer();
}

/**
 * Remove the first `count` events from the buffer (same order as peekBuffer()).
 * Call after successfully processing them.
 */
export function ackBuffer(count: number): Promise<boolean> {
  return SmsModule.ackBuffer(count);
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

/**
 * Reads SMS from the device inbox with date >= sinceTs (ms), oldest first.
 * Requires READ_SMS — request it via PermissionsAndroid before calling.
 * Used by the Settings "Scan SMS inbox" action to recover messages the
 * capture path missed (e.g. a parser gap that has since been fixed).
 */
export function readInbox(sinceTs: number): Promise<RawEvent[]> {
  return SmsModule.readInbox(sinceTs);
}
