// ─── Gmail notification filter (pure mirror of GmailFilter.kt) ───────────────
//
// Gmail is NOT a general capture app. The native NotificationService buffers a
// com.google.android.gm notification only when its text is an Amazon Pay wallet
// top-up confirmation ("₹2000.00 added to your Amazon Pay Wallet"); every other
// email notification is dropped before it reaches EventBuffer (privacy). The
// same predicate runs again in sync.ts as a second line of defence.
//
// Keep the two regexes below identical to GmailFilter.kt — change both together.

export const GMAIL_PKG = 'com.google.android.gm';

const TOPUP_RE = /\badded\b[\s\S]*?\bamazon\s*pay\s*wallet/i;
const RUPEE_AMOUNT_RE = /(?:₹|rs\.?|inr)\s*\d/i;

/** True when the combined title+text is an Amazon Pay wallet top-up with a rupee amount. */
export function isAmazonWalletTopUp(text: string): boolean {
  return TOPUP_RE.test(text) && RUPEE_AMOUNT_RE.test(text);
}
