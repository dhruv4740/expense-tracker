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
     */
    @ReactMethod
    fun drainBuffer(promise: Promise) {
        try {
            val jsonArray = EventBuffer.drain(reactContext)
            val result = Arguments.createArray()

            for (i in 0 until jsonArray.length()) {
                val obj = jsonArray.optJSONObject(i) ?: continue
                val map = Arguments.createMap().apply {
                    putString("kind", obj.optString("kind", "sms"))
                    putString("sender", obj.optString("sender", ""))
                    putString("pkg", obj.optString("pkg", ""))
                    putString("title", obj.optString("title", ""))
                    putString("body", obj.optString("body", ""))
                    putDouble("ts", obj.optLong("ts", 0L).toDouble())
                }
                result.pushMap(map)
            }

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("DRAIN_ERROR", e.message, e)
        }
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
