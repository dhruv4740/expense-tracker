package com.expensetracker

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.facebook.react.bridge.Arguments
import org.json.JSONArray
import org.json.JSONObject

/**
 * Battery-safe NotificationListenerService.
 *
 * Architecture (RULES.md §1):
 *  - While app is CLOSED: append raw event to EventBuffer (no RN bridge, no wake lock).
 *  - While app is OPEN:  also emit a live 'NotificationReceived' event via NotificationModule.
 *  - Allowlist check is ALWAYS the very first operation; returns immediately for ~99% of
 *    system/social/other notifications before any string work or bridge crossing.
 *
 * The allowlist is user-editable (Phase 9). Effective set resolution order:
 *  1. In-memory [cachedAllowlist] (set after first load or user edit — O(1) thereafter).
 *  2. SharedPreferences("expense_settings") key "allowlist" (JSON array of package names).
 *  3. [DEFAULT_ALLOWLIST] if the key is absent or unparseable.
 *
 * Call [invalidateAllowlistCache] after the user saves a new allowlist so the next
 * notification triggers a fresh prefs read. The cache is never stale for longer than
 * one notification event after an edit.
 */
class NotificationService : NotificationListenerService() {

    companion object {
        private const val SETTINGS_PREFS = "expense_settings"
        private const val ALLOWLIST_KEY  = "allowlist"

        /**
         * Built-in fallback allowlist for Indian banking / UPI apps.
         * Used when no user-defined allowlist is stored in SharedPreferences.
         * Exposed as DEFAULT_ALLOWLIST so NotificationModule can surface it to JS.
         */
        val DEFAULT_ALLOWLIST: Set<String> = setOf(
            "com.google.android.apps.nbu.paisa.user", // Google Pay (GPay)
            "com.phonepe.app",                         // PhonePe
            "net.one97.paytm",                         // Paytm
            "com.snapwork.hdfc",                       // HDFC MobileBanking
            "com.csam.icici.bank.imobile",             // ICICI iMobile
            "com.sbi.lotusintouch",                    // SBI YONO (one variant)
            "com.sbi.SBIFreedomPlus",                  // SBI YONO (another variant)
            "com.axis.mobile",                         // Axis Mobile
            "com.msf.kbank.mobile",                    // Kotak Mahindra Bank
            "com.bankofbaroda.mconnect",               // Bank of Baroda M-Connect
            "com.ubercab",                             // Uber
            "com.hdfcbank.android.now",                // HDFC Bank (PayZapp/NOW app)
            "com.kotak811mobilebankingapp.instantsavingsupiscanandpayrecharge", // Kotak811
            "com.fampay.in",                           // FamPay
            "com.nextbillion.groww",                   // Groww
            "in.amazon.mShop.android.shopping"         // Amazon (incl. Amazon Pay)
        )

        /**
         * In-process cache of the effective allowlist.
         * Null means "not yet loaded from SharedPreferences this process lifetime."
         * Marked @Volatile so writes from the main thread are immediately visible to
         * the binder thread that runs onNotificationPosted.
         */
        @Volatile
        private var cachedAllowlist: Set<String>? = null

        /**
         * Resolve the effective allowlist, populating [cachedAllowlist] on first access.
         *
         * Priority: user-stored prefs JSON array > DEFAULT_ALLOWLIST.
         * After the first call the result is cached; subsequent calls are O(1) set-lookup.
         * The cache is invalidated by [invalidateAllowlistCache] when the user edits the list.
         *
         * Key ABSENT (never saved) ⇒ DEFAULT_ALLOWLIST.
         * Key present but an EMPTY array ("[]") ⇒ capture is intentionally OFF — an
         * empty set, no fallback to defaults. This lets the user turn off notification
         * capture entirely by unchecking every app in Settings.
         *
         * @param context Any Context — only applicationContext is used internally.
         */
        private fun effectiveAllowlist(context: Context): Set<String> {
            cachedAllowlist?.let { return it }

            val prefs = context.applicationContext
                .getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
            val json = prefs.getString(ALLOWLIST_KEY, null)
            val resolved: Set<String> = if (!json.isNullOrBlank()) {
                try {
                    val arr = JSONArray(json)
                    val set = mutableSetOf<String>()
                    for (i in 0 until arr.length()) {
                        val pkg = arr.optString(i)
                        if (pkg.isNotBlank()) set.add(pkg)
                    }
                    // Do NOT fall back to defaults when the user explicitly saved an
                    // empty list — that is the "capture off" state.
                    set
                } catch (_: Exception) {
                    DEFAULT_ALLOWLIST
                }
            } else {
                DEFAULT_ALLOWLIST
            }

            cachedAllowlist = resolved
            return resolved
        }

        /**
         * Invalidate the in-process allowlist cache.
         * Call this immediately after writing a new allowlist to SharedPreferences so the
         * next notification triggers a fresh read. Thread-safe via @Volatile write.
         */
        @JvmStatic
        fun invalidateAllowlistCache() {
            cachedAllowlist = null
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        // BATTERY RULE: allowlist check FIRST — return before any string work or bridge crossing.
        // effectiveAllowlist() is O(1) after the first call (cache hit), matching the original
        // hardcoded set-lookup. The prefs read occurs at most once per process lifetime unless
        // the user edits the list and invalidateAllowlistCache() is called.
        if (sbn.packageName !in effectiveAllowlist(applicationContext)) return

        val extras = sbn.notification.extras

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val shortText = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        // Some banks only put the amount in the big-text expanded body — prefer
        // whichever variant is longer (falls back to whichever is non-null).
        val text: String? = when {
            !bigText.isNullOrBlank() && !shortText.isNullOrBlank() ->
                if (bigText.length >= shortText.length) bigText else shortText
            !bigText.isNullOrBlank() -> bigText
            else -> shortText
        }

        // Nothing to parse if body is absent.
        if (text.isNullOrBlank()) return

        // Single timestamp read shared by the buffered event AND the live emit so
        // both representations of the same notification agree to the millisecond —
        // otherwise a minute-boundary straddle could make the two look like separate
        // events to the dedup logic downstream.
        val ts = System.currentTimeMillis()

        val event = JSONObject().apply {
            put("kind", "notification")
            put("pkg", sbn.packageName)
            put("title", title ?: "")
            put("body", text)
            put("ts", ts)
        }

        // Always write to the shared buffer (works with app closed, no wake lock needed).
        EventBuffer.append(applicationContext, event)

        // If a live JS context is available, also emit for instant UI update.
        try {
            val map = Arguments.createMap().apply {
                putString("kind", "notification")
                putString("pkg", sbn.packageName)
                putString("title", title ?: "")
                putString("body", text)
                putDouble("ts", ts.toDouble())
            }
            NotificationModule.emitNotification(map)
        } catch (_: Exception) {
            // JS context may not be alive — buffer write above already captured the event.
        }
    }

    // onNotificationRemoved: intentionally not overridden — no action needed.
}
