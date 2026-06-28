# ExpenseTracker — Rules, Best Practices & Engineering Context

This is the durable engineering doc. `CLAUDE.md` holds the high-level product spec; this file holds the *how* and the *why*, the non-obvious decisions, and the guardrails every change must respect.

---

## 0. Golden rules (do not break)
1. **Battery is the #1 constraint.** No wake locks, no `AlarmManager`/`JobScheduler` polling, no foreground service, no background JS, no network. If a change adds any persistent background work, it is wrong by default.
2. **Commit after every change.** Local commits only (no remote configured yet). One logical change = one commit, present-tense imperative subject.
3. **Parser stays in TypeScript.** Native (Kotlin) only captures raw bytes; all parsing + categorization + DB writes happen in JS via `src/parser.ts` and `src/db.ts`.
4. **Android only.** No iOS code (the `ios/` folder was removed). No Play Store compliance concerns (sideloaded APK).
5. **No LLM calls, no backend, fully local.**

---

## 1. Battery-first architecture (the core design)
The naive "native emits event → JS parses → JS inserts" path **only works while a JS context is alive**. When the app is swiped away the event is dropped, and forcing JS awake per event drains battery. So we split capture from processing:

```
SMS arrives (app CLOSED)            Notification posted (app CLOSED)
  manifest BroadcastReceiver          NotificationListenerService
  -> minimal onReceive                -> packageName allowlist check FIRST
  -> write raw {sender,body,ts}          (return before any work for 99% of notifs)
     to SharedPreferences queue       -> write raw {pkg,title,body,ts}
  NO RN bridge, NO wake lock             to the SAME SharedPreferences queue

App OPENED / foregrounded
  -> JS calls NativeModule.drainBuffer() -> array of raw events
  -> parser.ts on each -> dedup -> op-sqlite insert (db.ts) -> buffer cleared

While app is OPEN (live UX only)
  -> module ALSO emits 'SmsReceived'/'NotificationReceived' for instant list update
  -> same parser + dedup path; UNIQUE constraint prevents double counts
```

**Why this is battery-safe:** the only always-on pieces are (a) a manifest receiver that the OS invokes *solely* when an SMS arrives, and (b) the system-bound `NotificationListenerService`, whose cost is minimized by a native package allowlist that returns before any string work or bridge crossing. All parsing/DB work is deferred to app-open. The `EventBuffer` writes use plain Android `SharedPreferences` APIs and require **no React context**, so they work even when the process was cold-started just to deliver the broadcast.

### Hard rules for native capture code
- SMS receiver: **manifest-registered** (`android:exported="true"`), not runtime-registered. Survives app death, needs no persistent process.
- `onReceive` / `onNotificationPosted`: do the **minimum** — extract fields, append to buffer, return. No threads, no timers, no DB, no bridge calls.
- NotificationListenerService: **allowlist `sbn.packageName` first**; return immediately for anything not in the banking/UPI set. Capture must be user-toggleable.
- `EventBuffer`: bounded ring buffer (cap ~500 entries) in `SharedPreferences` as a JSON array. Never unbounded.

---

## 2. EventBuffer contract (shared by SMS + Notification modules)
Single source of truth so Agents A and B can build independently.

- Store: `SharedPreferences("expense_buffer", MODE_PRIVATE)`, key `"events"`, value = JSON array string.
- Event shape (raw, unparsed):
  ```json
  { "kind": "sms" | "notification", "sender": "HDFCBK", "pkg": "com.phonepe.app",
    "title": "...", "body": "Rs.499 debited ...", "ts": 1719500000000 }
  ```
  `sender` set for sms; `pkg`/`title` set for notifications; `body` always the text to parse.
- Methods: `EventBuffer.append(context, jsonObject)` and `EventBuffer.drain(context): JSONArray` (returns all + clears atomically). Cap enforced on append (drop oldest).
- Thread-safety: synchronize on a lock; appends can come from binder threads.

---

## 3. Parser rules (`src/parser.ts`)
Input: `(sender: string, body: string)`. Output: `Transaction | null` (null when not a transaction or not an expense).
- Amount: `/(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i` → strip commas → Number.
- Direction: `debited|spent|charged|sent|paid` ⇒ expense; `credited|received|refund` ⇒ income → **return null** (income ignored for now).
- Merchant: text after `at `/`to `/`towards ` up to next punctuation or end; trim; fallback to sender.
- Source: the sender id / package.
- Timestamp: event `ts` (capture time).
- Category: keyword map in `src/categories.ts` (Food, Transport, Shopping, Bills, UPI, Other). Default Other.
- **Explicitly handle null/unmatched**: no amount match ⇒ null; income ⇒ null; empty body ⇒ null.

---

## 4. DB rules (`src/db.ts`, op-sqlite)
- Library: `@op-engineering/op-sqlite` (replaces deprecated `react-native-quick-sqlite`; New-Arch ready).
- One connection, opened once; enable **WAL** (`PRAGMA journal_mode=WAL`).
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    merchant TEXT,
    source TEXT,
    raw_text TEXT,
    category TEXT,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'expense',
    dedup_key TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);
  ```
- **Idempotency:** `dedup_key = sha/hash(source + amount + floor(ts/60000) + raw_text)`; insert with `INSERT OR IGNORE`. Prevents live-emit + buffer-drain double counts.
- API: `initDb()`, `insertTransaction(tx)`, `getAll()`, `getByDateRange(from,to)`, `getMonthlySummary()` (total + per-category for current month). Batch inserts on drain.

---

## 5. Permissions & manifest
- `RECEIVE_SMS`, `READ_SMS` (uses-permission).
- SMS `<receiver>` with `android.provider.Telephony.SMS_RECEIVED` intent-filter, `android:permission="android.permission.BROADCAST_SMS"`, `android:exported="true"`.
- `<service>` for NotificationListenerService with `android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"` and the `android.service.notification.NotificationListenerService` intent-filter.
- **Notification Access cannot be auto-granted** — user enables it in Settings → Notification access. App should detect and prompt.

---

## 6. RN / build environment
- React Native **0.86.0**, React 19.2.3, **New Architecture ON** (`newArchEnabled=true`), Hermes ON.
- Native modules use **legacy `ReactContextBaseJavaModule`** + `DeviceEventManagerModule.RCTDeviceEventEmitter` — supported under New Arch via the interop layer (no TurboModule codegen needed). Register via `ExpensePackage : ReactPackage` added in `MainApplication.kt`'s `PackageList(this).packages.apply { add(ExpensePackage()) }`.
- App id / package: `com.expensetracker`.
- Toolchain: Node 22, JDK 21, Android SDK at `C:/Users/hp/AppData/Local/Android/Sdk` (see `android/local.properties`, gitignored). `ANDROID_HOME` is unset in shell → call `adb`/`emulator` by full path.

### Build variants — read this before shipping anything to the phone

> ⚠️ **NEVER install the debug APK on the physical phone.** Debug is for emulators and development only.

Two separate packages:
| Variant | Package ID | App label | Standalone? |
|---|---|---|---|
| **release** | `com.expensetracker` | Expense Tracker | ✅ (JS bundle baked in) |
| **debug** | `com.expensetracker.debug` | Expense (Debug) | ❌ (fetches JS from Metro) |

They have **different package IDs** — a debug install cannot overwrite or interfere with the release app in any way. If the red "unable to load script / Reload" screen appears, you installed the debug build. Uninstall `com.expensetracker.debug` (not `.release`) and it won't affect your data.

- **Debug APK** (`assembleDebug` / `npx react-native run-android` / IDE Run button): fetches the JS bundle from the Metro dev server (`localhost:8081`). Works only while Metro is running on the dev machine, over USB or Wi-Fi ADB. Shows the Metro error screen on a real phone away from the dev machine. Use only on emulators or a dedicated dev device.
- **Release APK** (`assembleRelease`): JS is bundled + Hermes-compiled into the APK. Runs fully offline. This is the only variant to install on the real phone.

Build command: `cd android && ./gradlew assembleRelease` → `android/app/build/outputs/apk/release/app-release.apk`

Signing: both variants use the same `debug` keystore (`signingConfigs.debug`) so a new release APK can be installed with `adb install -r` (replace-in-place) without losing data. The `-r` flag is important — it preserves app data across updates.

`minifyEnabled` is currently **false** (`enableProguardInReleaseBuilds=false`) → no R8 stripping risk for the Kotlin native modules.

---

## 7. Optimization checklist (apply to every UI/data change)
- FlatList: `keyExtractor`, stable `renderItem`, windowing; never `.map()` a large list into views.
- Subscribe to native events **once** (top-level effect), remove on unmount; no re-subscribe storms.
- Lazy tab screens; memoize summary aggregation; query the DB, don't aggregate in JS over all rows when SQL can.
- Release build: Hermes + R8/ProGuard.

---

## 8. Known risks
- New-Arch ↔ legacy-module interop edge cases → fallback pin RN 0.81 if friction appears.
- Emulator covers functional verification; true battery profiling needs a real device.
- SMS formats vary by bank; parser is best-effort regex, extend the keyword/merchant rules as real samples appear.
