package com.expensetracker

import android.app.Activity
import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native module that exposes Android Storage Access Framework (SAF) file
 * picking and saving to JS without requiring any extra runtime permissions.
 * Works correctly on Android 11+ scoped storage.
 *
 * Two operations are exposed:
 *  - saveTextFile: shows the system "create document" picker, writes UTF-8
 *    content to the user-chosen URI via ContentResolver.
 *  - pickTextFile: shows the system "open document" picker, reads the
 *    user-chosen file fully as UTF-8 text and resolves with the string.
 *
 * Uses legacy ReactContextBaseJavaModule + ActivityEventListener, which is
 * supported under New Architecture via the interop layer. See RULES.md §6.
 *
 * Register this module in ExpensePackage.createNativeModules().
 */
class FileModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val REQ_CREATE = 8001
        private const val REQ_OPEN   = 8002

        private const val ERR_NO_ACTIVITY  = "ERR_NO_ACTIVITY"
        private const val ERR_BUSY         = "ERR_BUSY"
        private const val ERR_WRITE        = "ERR_WRITE"
        private const val ERR_READ         = "ERR_READ"
    }

    // ── pending-request state ─────────────────────────────────────────────────
    // Only one SAF request can be in flight at a time. Both fields are
    // written/read on the UI thread (startActivityForResult + onActivityResult
    // are UI-thread-bound), so no additional synchronization is needed.

    @Volatile private var pendingContent: String? = null
    @Volatile private var pendingPromise: Promise? = null

    // ── ActivityEventListener ─────────────────────────────────────────────────

    private val activityEventListener: ActivityEventListener =
        object : BaseActivityEventListener() {
            override fun onActivityResult(
                activity: Activity,
                requestCode: Int,
                resultCode: Int,
                data: Intent?,
            ) {
                when (requestCode) {
                    REQ_CREATE -> handleCreateResult(resultCode, data)
                    REQ_OPEN   -> handleOpenResult(resultCode, data)
                }
            }
        }

    // If the host (Activity) is torn down while a picker is in flight — e.g. the
    // OS kills the backgrounded app for memory, or a JS reload tears down the
    // bridge — onActivityResult above never fires for the old request code, and
    // pendingPromise would otherwise stay set forever, wedging every later
    // saveTextFile/pickTextFile call with ERR_BUSY until the app is force-restarted.
    // Clearing on host destroy makes the picker recoverable across that case.
    private val lifecycleEventListener: LifecycleEventListener =
        object : LifecycleEventListener {
            override fun onHostResume() {}
            override fun onHostPause() {}
            override fun onHostDestroy() {
                pendingPromise?.reject(ERR_BUSY, "Host destroyed while file operation was pending")
                clearPending()
            }
        }

    init {
        reactContext.addActivityEventListener(activityEventListener)
        reactContext.addLifecycleEventListener(lifecycleEventListener)
    }

    override fun invalidate() {
        pendingPromise?.reject(ERR_BUSY, "Module invalidated while file operation was pending")
        clearPending()
        super.invalidate()
    }

    override fun getName(): String = "FileModule"

    // ── @ReactMethod: saveTextFile ────────────────────────────────────────────

    /**
     * Open the system "Save file" picker (ACTION_CREATE_DOCUMENT).
     * On user confirmation, write [content] as UTF-8 to the chosen URI.
     *
     * @param suggestedName  File name pre-filled in the picker (e.g. "expenses-2024-06-28.csv").
     * @param mimeType       MIME type displayed to the picker (e.g. "text/csv",
     *                       "application/json").
     * @param content        UTF-8 text to write into the new file.
     * @param promise        Resolves true on success, false on user cancel; rejects on error.
     */
    @ReactMethod
    fun saveTextFile(
        suggestedName: String,
        mimeType: String,
        content: String,
        promise: Promise,
    ) {
        if (pendingPromise != null) {
            promise.reject(ERR_BUSY, "A file operation is already in progress")
            return
        }

        val activity = getCurrentActivity()
        if (activity == null) {
            promise.reject(ERR_NO_ACTIVITY, "No foreground Activity available — open the app first")
            return
        }

        pendingContent = content
        pendingPromise = promise

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, suggestedName)
        }

        try {
            activity.startActivityForResult(intent, REQ_CREATE)
        } catch (e: Exception) {
            clearPending()
            promise.reject(ERR_WRITE, "Failed to launch file picker: ${e.message}", e)
        }
    }

    // ── @ReactMethod: pickTextFile ────────────────────────────────────────────

    /**
     * Open the system "Open file" picker (ACTION_OPEN_DOCUMENT).
     * On user confirmation, read the chosen file fully as UTF-8 text.
     *
     * @param promise  Resolves with the file contents as a String on success;
     *                 resolves with null on user cancel; rejects on read error.
     */
    @ReactMethod
    fun pickTextFile(promise: Promise) {
        if (pendingPromise != null) {
            promise.reject(ERR_BUSY, "A file operation is already in progress")
            return
        }

        val activity = getCurrentActivity()
        if (activity == null) {
            promise.reject(ERR_NO_ACTIVITY, "No foreground Activity available — open the app first")
            return
        }

        pendingPromise = promise

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }

        try {
            activity.startActivityForResult(intent, REQ_OPEN)
        } catch (e: Exception) {
            clearPending()
            promise.reject(ERR_READ, "Failed to launch file picker: ${e.message}", e)
        }
    }

    // ── result handlers ───────────────────────────────────────────────────────

    private fun handleCreateResult(resultCode: Int, data: Intent?) {
        val promise = pendingPromise ?: return
        val content = pendingContent
        clearPending()

        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            promise.resolve(false) // user cancelled
            return
        }

        val uri: Uri = data.data!!
        try {
            reactContext.contentResolver.openOutputStream(uri)?.use { stream ->
                stream.write((content ?: "").toByteArray(Charsets.UTF_8))
            } ?: run {
                promise.reject(ERR_WRITE, "ContentResolver returned null OutputStream for $uri")
                return
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject(ERR_WRITE, "Failed to write file: ${e.message}", e)
        }
    }

    private fun handleOpenResult(resultCode: Int, data: Intent?) {
        val promise = pendingPromise ?: return
        clearPending()

        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            promise.resolve(null) // user cancelled
            return
        }

        val uri: Uri = data.data!!
        try {
            val text = reactContext.contentResolver.openInputStream(uri)?.use { stream ->
                stream.readBytes().toString(Charsets.UTF_8)
            } ?: run {
                promise.reject(ERR_READ, "ContentResolver returned null InputStream for $uri")
                return
            }
            promise.resolve(text)
        } catch (e: Exception) {
            promise.reject(ERR_READ, "Failed to read file: ${e.message}", e)
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private fun clearPending() {
        pendingContent = null
        pendingPromise = null
    }
}
