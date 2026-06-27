package com.expensetracker

import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native native module for notification-access control.
 *
 * Battery architecture (RULES.md §1):
 *  - drainBuffer() is intentionally NOT here. Draining the shared EventBuffer is owned by
 *    SmsModule.drainBuffer(), which returns both SMS and notification events in one call.
 *  - This module only handles: live event emission (called by NotificationService when the
 *    app is open), and the Settings helpers so the user can grant/check notification access.
 *
 * New-Arch note (RULES.md §6): ReactContextBaseJavaModule + RCTDeviceEventEmitter is the
 * correct pattern under RN 0.86 New Architecture via the legacy interop layer.
 * No TurboModule codegen is needed.
 */
class NotificationModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        // Store a reference to the live ReactApplicationContext so NotificationService
        // (which has no RN context) can reach DeviceEventManagerModule for live emits.
        activeContext = reactContext
    }

    override fun getName(): String = "NotificationModule"

    companion object {
        /**
         * Nullable reference to the most-recently-constructed ReactApplicationContext.
         * Set on module construction; used by NotificationService to emit live events
         * without holding a strong reference that would prevent GC after reload.
         */
        @Volatile
        private var activeContext: ReactApplicationContext? = null

        /**
         * Emit a live 'NotificationReceived' event to JS.
         * Called by NotificationService when the app is open and a JS instance is alive.
         * No-ops gracefully if there is no active React instance.
         */
        @JvmStatic
        fun emitNotification(map: WritableMap) {
            try {
                val ctx = activeContext ?: return
                if (!ctx.hasActiveReactInstance()) return
                ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("NotificationReceived", map)
            } catch (_: Exception) {
                // Silently swallow — the event is already in EventBuffer as a fallback.
            }
        }
    }

    /**
     * Resolve true if notification listener access has been granted by the user.
     * The user must enable it manually via Settings → Notification access.
     */
    @ReactMethod
    fun isNotificationAccessGranted(promise: Promise) {
        try {
            val enabledListeners = Settings.Secure.getString(
                reactContext.contentResolver,
                "enabled_notification_listeners"
            )
            val granted = enabledListeners?.contains(reactContext.packageName) == true
            promise.resolve(granted)
        } catch (e: Exception) {
            promise.reject("ERR_NOTIFICATION_CHECK", e.message, e)
        }
    }

    /**
     * Open the system Notification Access settings screen so the user can grant permission.
     * Required because notification listener access cannot be auto-granted at runtime.
     */
    @ReactMethod
    fun openNotificationAccessSettings() {
        try {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
        } catch (_: Exception) {
            // Settings screen unavailable on this device — ignore.
        }
    }

    // Required no-op stubs for NativeEventEmitter subscription bookkeeping on the JS side.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
