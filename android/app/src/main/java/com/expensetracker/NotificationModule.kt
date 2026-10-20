package com.expensetracker

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray

/**
 * React Native native module for notification-access control and allowlist management.
 *
 * Battery architecture (RULES.md §1):
 *  - drainBuffer() is intentionally NOT here. Draining the shared EventBuffer is owned by
 *    SmsModule.drainBuffer(), which returns both SMS and notification events in one call.
 *  - This module handles: live event emission (called by NotificationService when the app is
 *    open), Settings helpers so the user can grant/check notification access, and the
 *    user-editable package allowlist (Phase 9).
 *
 * Allowlist persistence (Phase 9):
 *  - Stored in SharedPreferences("expense_settings") key "allowlist" as a JSON array string.
 *  - NotificationService reads the same prefs directly (no RN bridge) so the early-return
 *    battery check stays bridge-free. After setAllowlist() writes, invalidateAllowlistCache()
 *    is called so the service picks up the new set on the very next notification.
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
        private const val SETTINGS_PREFS = "expense_settings"
        private const val ALLOWLIST_KEY  = "allowlist"

        /**
         * Human-readable labels for each package in DEFAULT_ALLOWLIST.
         * Keyed by package name; shown in the Settings screen allowlist editor.
         */
        private val PACKAGE_LABELS: Map<String, String> = mapOf(
            "com.google.android.apps.nbu.paisa.user" to "Google Pay",
            "com.phonepe.app"                         to "PhonePe",
            "net.one97.paytm"                         to "Paytm",
            "com.snapwork.hdfc"                       to "HDFC",
            "com.csam.icici.bank.imobile"             to "ICICI iMobile",
            "com.sbi.lotusintouch"                    to "SBI YONO",
            "com.sbi.SBIFreedomPlus"                  to "SBI YONO",
            "com.axis.mobile"                         to "Axis Mobile",
            "com.msf.kbank.mobile"                    to "Kotak",
            "com.bankofbaroda.mconnect"               to "Bank of Baroda",
            "com.ubercab"                             to "Uber",
            "com.hdfcbank.android.now"                to "HDFC Bank",
            "com.kotak811mobilebankingapp.instantsavingsupiscanandpayrecharge" to "Kotak811",
            "com.fampay.in"                           to "FamPay",
            "com.nextbillion.groww"                   to "Groww",
            "in.amazon.mShop.android.shopping"        to "Amazon"
        )

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

    /**
     * Resolve an array of {pkg, label} maps for every entry in DEFAULT_ALLOWLIST.
     * The Settings screen uses this to show the built-in banking/UPI app list with
     * friendly names so the user knows what each package represents.
     *
     * @param promise Resolves with WritableArray of WritableMap({pkg:String, label:String}).
     */
    @ReactMethod
    fun getDefaultAllowlist(promise: Promise) {
        try {
            val result: WritableArray = Arguments.createArray()
            for (pkg in NotificationService.DEFAULT_ALLOWLIST) {
                val entry: WritableMap = Arguments.createMap().apply {
                    putString("pkg", pkg)
                    putString("label", PACKAGE_LABELS[pkg] ?: pkg)
                }
                result.pushMap(entry)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("ERR_GET_DEFAULT_ALLOWLIST", e.message, e)
        }
    }

    /**
     * Read the currently active allowlist from SharedPreferences.
     * If no user-defined list has been stored yet, resolves with the package names
     * from DEFAULT_ALLOWLIST (same fallback used by NotificationService).
     *
     * @param promise Resolves with WritableArray<String> of package names.
     */
    @ReactMethod
    fun getAllowlist(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
            val json = prefs.getString(ALLOWLIST_KEY, null)
            val result: WritableArray = Arguments.createArray()
            if (!json.isNullOrBlank()) {
                try {
                    val arr = JSONArray(json)
                    for (i in 0 until arr.length()) {
                        val pkg = arr.optString(i)
                        if (pkg.isNotBlank()) result.pushString(pkg)
                    }
                } catch (_: Exception) {
                    // Corrupt prefs — fall through to the default below.
                    for (pkg in NotificationService.DEFAULT_ALLOWLIST) result.pushString(pkg)
                }
            } else {
                for (pkg in NotificationService.DEFAULT_ALLOWLIST) result.pushString(pkg)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("ERR_GET_ALLOWLIST", e.message, e)
        }
    }

    /**
     * Persist a new user-defined allowlist and invalidate the in-process service cache.
     *
     * Writes [packages] as a JSON array string to SharedPreferences("expense_settings")
     * key "allowlist", then calls [NotificationService.invalidateAllowlistCache] so the
     * service picks up the new set on the very next notification (no restart required).
     *
     * @param packages ReadableArray of package name strings chosen by the user.
     * @param promise  Resolves with true on success.
     */
    @ReactMethod
    fun setAllowlist(packages: ReadableArray, promise: Promise) {
        try {
            val arr = JSONArray()
            for (i in 0 until packages.size()) {
                val pkg = packages.getString(i)
                if (!pkg.isNullOrBlank()) arr.put(pkg)
            }
            reactContext
                .getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(ALLOWLIST_KEY, arr.toString())
                .apply()

            // Invalidate the in-process cache so the next onNotificationPosted re-reads prefs.
            NotificationService.invalidateAllowlistCache()

            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_SET_ALLOWLIST", e.message, e)
        }
    }

    /**
     * Return all user-facing (LAUNCHER) apps installed on the device, with a flag
     * indicating whether each is likely a banking/UPI app. Uses the PackageManager
     * API (requires the <queries> intent-filter in AndroidManifest.xml on API 30+).
     *
     * Resolves with WritableArray<{pkg:String, label:String, isLikelyBank:Boolean}>.
     * Runs on the calling thread (React Native bridge thread) — result set is small
     * (typically <100 apps) so no async dispatch is needed.
     */
    @ReactMethod
    fun getInstalledApps(promise: Promise) {
        try {
            val pm = reactContext.packageManager
            val launcherIntent = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            // MATCH_DEFAULT_ONLY filters to activities declaring CATEGORY_DEFAULT, which
            // most launcher activities do NOT declare — that filtered the list down to
            // near-empty. Flag 0 returns every matching launcher activity instead.
            @Suppress("QueryPermissionsNeeded")
            val resolveInfoList = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.queryIntentActivities(launcherIntent, PackageManager.ResolveInfoFlags.of(0L))
            } else {
                pm.queryIntentActivities(launcherIntent, 0)
            }

            val bankKeywords = setOf("bank", "pay", "upi", "wallet", "money", "hdfc", "icici", "sbi",
                "axis", "kotak", "paytm", "phonepe", "gpay", "bhim", "freecharge", "mobikwik",
                "amazon", "flipkart", "cred", "slice", "jupiter", "fi", "navi", "niyo")

            val result: WritableArray = Arguments.createArray()
            for (ri in resolveInfoList) {
                val pkg = ri.activityInfo.packageName ?: continue
                if (pkg == reactContext.packageName) continue // skip ourselves

                val label = ri.loadLabel(pm).toString()
                val labelLower = label.lowercase()
                val pkgLower = pkg.lowercase()
                val isLikelyBank = pkg in NotificationService.DEFAULT_ALLOWLIST ||
                    bankKeywords.any { kw -> labelLower.contains(kw) || pkgLower.contains(kw) }

                val entry: WritableMap = Arguments.createMap().apply {
                    putString("pkg", pkg)
                    putString("label", label)
                    putBoolean("isLikelyBank", isLikelyBank)
                }
                result.pushMap(entry)
            }

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("ERR_GET_INSTALLED_APPS", e.message, e)
        }
    }

    // Required no-op stubs for NativeEventEmitter subscription bookkeeping on the JS side.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    override fun invalidate() {
        if (activeContext === reactContext) activeContext = null
        super.invalidate()
    }
}
