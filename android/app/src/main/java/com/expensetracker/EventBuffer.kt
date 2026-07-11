package com.expensetracker

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Battery-safe raw-event buffer backed by SharedPreferences.
 *
 * Written from broadcast/binder threads with NO React context and NO wake lock
 * (works even when the process was cold-started just to deliver an SMS broadcast).
 * Drained by JS via SmsModule.drainBuffer() when the app is opened.
 *
 * See RULES.md §1 (battery architecture) and §2 (EventBuffer contract).
 * Event shape: { kind: "sms"|"notification", sender?, pkg?, title?, body, ts }
 */
object EventBuffer {
    private const val PREFS = "expense_buffer"
    private const val KEY = "events"
    private const val CAP = 500
    private val lock = Any()

    /** Append one raw event. Enforces the ring-buffer cap by dropping oldest. */
    fun append(context: Context, event: JSONObject) {
        synchronized(lock) {
            val prefs = context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY, "[]"))
            } catch (e: Exception) {
                JSONArray()
            }
            arr.put(event)
            val out = if (arr.length() > CAP) {
                val trimmed = JSONArray()
                for (i in (arr.length() - CAP) until arr.length()) trimmed.put(arr.get(i))
                trimmed
            } else {
                arr
            }
            prefs.edit().putString(KEY, out.toString()).apply()
        }
    }

    /**
     * Return all buffered events WITHOUT clearing them. Pair with [ack] once the
     * caller has durably processed (or safely given up on) the returned events —
     * this two-phase contract means a crash between peek and ack leaves the
     * events in the buffer for the next drain cycle instead of losing them.
     */
    fun peek(context: Context): JSONArray {
        synchronized(lock) {
            val prefs = context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return try {
                JSONArray(prefs.getString(KEY, "[]"))
            } catch (e: Exception) {
                JSONArray()
            }
        }
    }

    /**
     * Remove the first [count] entries from the buffer. Re-reads the current
     * array under the same lock (rather than trusting the caller's stale copy)
     * so events appended between [peek] and [ack] are preserved, not dropped.
     */
    fun ack(context: Context, count: Int) {
        if (count <= 0) return
        synchronized(lock) {
            val prefs = context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY, "[]"))
            } catch (e: Exception) {
                JSONArray()
            }
            val keepFrom = count.coerceAtMost(arr.length())
            val remaining = JSONArray()
            for (i in keepFrom until arr.length()) remaining.put(arr.get(i))
            prefs.edit().putString(KEY, remaining.toString()).apply()
        }
    }

    /**
     * Return all buffered events and clear the buffer atomically.
     * Kept for backward compatibility — delegates to peek + ack-all so any
     * remaining caller behaves exactly as before.
     */
    fun drain(context: Context): JSONArray {
        synchronized(lock) {
            val arr = peek(context)
            ack(context, arr.length())
            return arr
        }
    }
}
