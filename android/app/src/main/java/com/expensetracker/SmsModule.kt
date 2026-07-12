package com.expensetracker

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Native module that exposes the shared EventBuffer to JS and provides
 * a live-emit path for SMS events while the app is open.
 *
 * Uses legacy ReactContextBaseJavaModule + RCTDeviceEventEmitter, which is
 * supported under New Architecture via the interop layer (no TurboModule
 * codegen needed). See RULES.md §6.
 *
 * Register this module in ExpensePackage.createNativeModules().
 */
class SmsModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        // Store a reference so SmsReceiver can reach a live context via emitSms().
        instance = this
    }

    override fun getName(): String = "SmsModule"

    companion object {
        @Volatile
        private var instance: SmsModule? = null

        /**
         * Called by SmsReceiver when a new SMS arrives while the app is open.
         * No-ops silently if no React instance is alive — the EventBuffer
         * guarantees no events are lost.
         */
        @JvmStatic
        fun emitSms(map: WritableMap) {
            try {
                val mod = instance ?: return
                val ctx = mod.reactContext
                if (ctx.hasActiveReactInstance()) {
                    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("SmsReceived", map)
                }
            } catch (_: Exception) {
                // No-op: guard against any bridge state during hot-reload or restart.
            }
        }
    }

    /**
     * Drains the shared EventBuffer for ALL event kinds (sms + notifications).
     * Each event is tagged with a `kind` field so JS can route accordingly.
     * Resolves with a WritableArray of WritableMap objects.
     *
     * @deprecated Prefer [peekBuffer] + [ackBuffer] — this clears the buffer
     * before the caller has processed anything, so a crash mid-processing loses
     * events. Kept only so an old call path (if any) keeps working.
     */
    @ReactMethod
    fun drainBuffer(promise: Promise) {
        try {
            val jsonArray = EventBuffer.drain(reactContext)
            promise.resolve(toWritableArray(jsonArray))
        } catch (e: Exception) {
            promise.reject("DRAIN_ERROR", e.message, e)
        }
    }

    /**
     * Returns all buffered events WITHOUT clearing the buffer. Pair with
     * [ackBuffer] after the caller has durably processed the events so a
     * crash mid-processing leaves them for the next sync cycle instead of
     * losing them.
     */
    @ReactMethod
    fun peekBuffer(promise: Promise) {
        try {
            val jsonArray = EventBuffer.peek(reactContext)
            promise.resolve(toWritableArray(jsonArray))
        } catch (e: Exception) {
            promise.reject("PEEK_ERROR", e.message, e)
        }
    }

    /**
     * Removes the first [count] events from the buffer (in the same order
     * returned by [peekBuffer]). Call after successfully processing them.
     */
    @ReactMethod
    fun ackBuffer(count: Double, promise: Promise) {
        try {
            EventBuffer.ack(reactContext, count.toInt())
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ACK_ERROR", e.message, e)
        }
    }

    /**
     * Reads SMS from the device inbox with date >= [sinceTs] (ms), oldest first.
     * Requires READ_SMS — the caller (JS) requests it via PermissionsAndroid
     * before calling this. A SecurityException (permission somehow not
     * granted) resolves an empty array rather than rejecting, since a scan
     * finding nothing and a scan that can't run are both "nothing recovered"
     * from the caller's perspective.
     */
    @ReactMethod
    fun readInbox(sinceTs: Double, promise: Promise) {
        try {
            val resolver = reactContext.contentResolver
            val uri = android.provider.Telephony.Sms.Inbox.CONTENT_URI
            val projection = arrayOf(
                android.provider.Telephony.Sms.ADDRESS,
                android.provider.Telephony.Sms.BODY,
                android.provider.Telephony.Sms.DATE,
            )
            val selection = "${android.provider.Telephony.Sms.DATE} >= ?"
            val selectionArgs = arrayOf(sinceTs.toLong().toString())
            val sortOrder = "${android.provider.Telephony.Sms.DATE} ASC"

            val out = Arguments.createArray()
            resolver.query(uri, projection, selection, selectionArgs, sortOrder)?.use { cursor ->
                val addressIdx = cursor.getColumnIndexOrThrow(android.provider.Telephony.Sms.ADDRESS)
                val bodyIdx = cursor.getColumnIndexOrThrow(android.provider.Telephony.Sms.BODY)
                val dateIdx = cursor.getColumnIndexOrThrow(android.provider.Telephony.Sms.DATE)
                while (cursor.moveToNext()) {
                    out.pushMap(Arguments.createMap().apply {
                        putString("kind", "sms")
                        putString("sender", cursor.getString(addressIdx) ?: "")
                        putString("body", cursor.getString(bodyIdx) ?: "")
                        putDouble("ts", cursor.getLong(dateIdx).toDouble())
                    })
                }
            }
            promise.resolve(out)
        } catch (e: SecurityException) {
            promise.resolve(Arguments.createArray())
        } catch (e: Exception) {
            promise.reject("READ_INBOX_ERROR", e.message, e)
        }
    }

    private fun toWritableArray(jsonArray: org.json.JSONArray) = Arguments.createArray().apply {
        for (i in 0 until jsonArray.length()) {
            val obj = jsonArray.optJSONObject(i) ?: continue
            pushMap(Arguments.createMap().apply {
                putString("kind", obj.optString("kind", "sms"))
                putString("sender", obj.optString("sender", ""))
                putString("pkg", obj.optString("pkg", ""))
                putString("title", obj.optString("title", ""))
                putString("body", obj.optString("body", ""))
                putDouble("ts", obj.optLong("ts", 0L).toDouble())
            })
        }
    }

    override fun invalidate() {
        if (instance === this) instance = null
        super.invalidate()
    }

    /**
     * Required no-op stub for React Native's NativeEventEmitter.
     * Without this RN 0.86 will log a warning about missing listener registration.
     */
    @ReactMethod
    fun addListener(eventName: String) {
        // No-op: RCTDeviceEventEmitter manages subscriptions automatically.
    }

    /**
     * Required no-op stub for React Native's NativeEventEmitter.
     */
    @ReactMethod
    fun removeListeners(count: Int) {
        // No-op.
    }
}
