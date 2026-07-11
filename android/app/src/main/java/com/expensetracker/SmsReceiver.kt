package com.expensetracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.facebook.react.bridge.Arguments
import org.json.JSONObject

/**
 * Manifest-registered BroadcastReceiver for incoming SMS.
 *
 * Battery-safe: writes raw event to the shared EventBuffer via SharedPreferences
 * with NO React context and NO wake lock — works even when the app is killed.
 *
 * Also attempts a live emit to JS via SmsModule when a React instance is alive
 * (app is open). The live emit is always wrapped in try/catch so a missing JS
 * context never crashes the receiver.
 *
 * See RULES.md §1 (battery architecture) and §2 (EventBuffer contract).
 */
class SmsReceiver : BroadcastReceiver() {

    companion object {
        // Cheap, single pre-compiled regex gate: only SMS that look like they carry a
        // currency amount get buffered. Keeps OTPs/personal texts out of the buffer
        // entirely (privacy) and stops them from evicting real bank SMS out of the
        // 500-slot ring buffer. No allowlist/prefs read here on purpose — SMS sender
        // IDs vary too much to allowlist, and reading prefs would add I/O to this path.
        private val HAS_AMOUNT_RE = Regex("(?i)(?:rs\\.?|inr|₹)\\s*[\\d,]")
    }

    override fun onReceive(context: Context, intent: Intent) {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return

        // Concatenate multi-part SMS bodies; take sender from first part.
        val sender = messages.firstOrNull()?.displayOriginatingAddress ?: ""
        val body = messages.joinToString(separator = "") { it.messageBody ?: "" }

        if (body.isBlank() || !HAS_AMOUNT_RE.containsMatchIn(body)) return

        val ts = System.currentTimeMillis()

        // Battery-safe path: write to SharedPreferences buffer (no RN bridge needed).
        val event = JSONObject().apply {
            put("kind", "sms")
            put("sender", sender)
            put("body", body)
            put("ts", ts)
        }
        EventBuffer.append(context, event)

        // Live-emit path: only works when a React context is alive (app is open).
        // Wrapped in try/catch so any failure here is silently ignored — the buffer
        // ensures no event is lost regardless.
        try {
            val map = Arguments.createMap().apply {
                putString("kind", "sms")
                putString("sender", sender)
                putString("body", body)
                putDouble("ts", ts.toDouble())
            }
            SmsModule.emitSms(map)
        } catch (_: Exception) {
            // No-op: JS context not alive; buffer will be drained on next app open.
        }
    }
}
