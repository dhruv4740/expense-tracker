package com.expensetracker

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.facebook.react.bridge.Arguments
import org.json.JSONObject

/**
 * Battery-safe NotificationListenerService.
 *
 * Architecture (RULES.md §1):
 *  - While app is CLOSED: append raw event to EventBuffer (no RN bridge, no wake lock).
 *  - While app is OPEN:  also emit a live 'NotificationReceived' event via NotificationModule.
 *  - Allowlist check is ALWAYS the very first operation; returns immediately for ~99% of
 *    system/social/other notifications before any string work or bridge crossing.
 */
class NotificationService : NotificationListenerService() {

    companion object {
        /**
         * Package-name allowlist for Indian banking / UPI apps.
         * The allowlist-first return in onNotificationPosted is the core battery-safety mechanism.
         * Extend this list to cover additional banks your users have installed.
         */
        val ALLOWLIST: Set<String> = setOf(
            "com.google.android.apps.nbu.paisa.user", // Google Pay (GPay)
            "com.phonepe.app",                         // PhonePe
            "net.one97.paytm",                         // Paytm
            "com.snapwork.hdfc",                       // HDFC MobileBanking
            "com.csam.icici.bank.imobile",             // ICICI iMobile
            "com.sbi.lotusintouch",                    // SBI YONO (one variant)
            "com.sbi.SBIFreedomPlus",                  // SBI YONO (another variant)
            "com.axis.mobile",                         // Axis Mobile
            "com.msf.kbank.mobile",                    // Kotak Mahindra Bank
            "com.bankofbaroda.mconnect"                // Bank of Baroda M-Connect
        )
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        // BATTERY RULE: allowlist check FIRST — return before any string work or bridge crossing.
        if (sbn.packageName !in ALLOWLIST) return

        val extras = sbn.notification.extras

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text: String? = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()

        // Nothing to parse if body is absent.
        if (text.isNullOrBlank()) return

        val event = JSONObject().apply {
            put("kind", "notification")
            put("pkg", sbn.packageName)
            put("title", title ?: "")
            put("body", text)
            put("ts", System.currentTimeMillis())
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
                putDouble("ts", System.currentTimeMillis().toDouble())
            }
            NotificationModule.emitNotification(map)
        } catch (_: Exception) {
            // JS context may not be alive — buffer write above already captured the event.
        }
    }

    // onNotificationRemoved: intentionally not overridden — no action needed.
}
