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

    /** Return all buffered events and clear the buffer atomically. */
    fun drain(context: Context): JSONArray {
        synchronized(lock) {
            val prefs = context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY, "[]"))
            } catch (e: Exception) {
                JSONArray()
            }
            prefs.edit().putString(KEY, "[]").apply()
            return arr
        }
    }
}
