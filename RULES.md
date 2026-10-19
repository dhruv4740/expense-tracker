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

- Store: `SharedPreferences("expense_buffer", MODE_PRIVATE)`, key `"events"`, value = JSON array string. Storage format is a single JSON array (deliberately NOT per-event keys — see "known risks" for why that rewrite was skipped).
- Event shape (raw, unparsed):
  ```json
  { "kind": "sms" | "notification", "sender": "HDFCBK", "pkg": "com.phonepe.app",
    "title": "...", "body": "Rs.499 debited ...", "ts": 1719500000000 }
  ```
  `sender` set for sms; `pkg`/`title` set for notifications; `body` always the text to parse.
  Both the buffered event and the live-emitted event for the same notification/SMS share a
  **single timestamp read** — this matters because dedup keys bucket by minute, and two
  separate `System.currentTimeMillis()` calls can straddle a minute boundary.
- Methods:
  - `EventBuffer.append(context, jsonObject)` — cap enforced on append (drop oldest, cap 500).
  - `EventBuffer.peek(context): JSONArray` — returns all buffered events WITHOUT clearing.
  - `EventBuffer.ack(context, count)` — removes the first `count` entries, re-reading the
    current array under the lock so events appended between peek and ack survive.
  - `EventBuffer.drain(context): JSONArray` — legacy: peek + ack-all in one call. JS should
    prefer peek+ack (`SmsModule.peekBuffer()` / `ackBuffer(count)`): drain-then-process can
    lose events if processing crashes mid-loop; peek-then-ack only marks events as consumed
    after they were actually looped over.
- Thread-safety: synchronize on a lock (reentrant — nested peek/ack calls from `drain()` are safe); appends can come from binder threads.
- SMS pre-filter (`SmsReceiver.kt`): before appending, the body must match a single
  pre-compiled regex for a currency amount (`(?i)(?:rs\.?|inr|₹)\s*[\d,]`). OTPs, personal
  texts, and spam never enter the buffer — cheaper writes, no ring-buffer eviction of real
  bank SMS by chatty days, and less sensitive data sitting in SharedPreferences. No allowlist
  prefs read on this path on purpose (sender IDs vary too much to allowlist, and reading prefs
  would add I/O to a path that must stay minimal).
- Notification allowlist has three states, not two: key **absent** → `DEFAULT_ALLOWLIST`; key
  present but an **empty array** (`"[]"`) → capture is intentionally OFF (no fallback to
  defaults) — this is how unchecking every app in Settings actually disables capture; key
  present with entries → that exact set.

---

## 3. Parser rules (`src/parser.ts`)
Input: `(sender: string, body: string, ts?: number)`. Output: `ParsedTransaction | null`.
- Negative guard (checked first): promo "will be debited/credited", failed/declined/
  unsuccessful payments, OTP prompts, e-mandate/autopay registration notices, and
  money-request messages all return `null` — they contain a real-looking amount but aren't a
  settled transaction.
- Amount: `Rs./INR/₹` + digits, with an optional `lakh|lac|lakhs|crore|cr` magnitude suffix
  (`₹1.5 Lakh` → 150000). Amounts `<= 0` are rejected (catches `Rs.0.00 debited` failed-auth
  messages).
- Direction: `debited|spent|charged|sent|paid|purchase|withdrawn` ⇒ expense;
  `credited|received|refund` ⇒ income. Income is tracked now (not dropped) — a refund message
  containing both "debited" (the original charge) and a credit keyword is always income; if
  both keyword sets appear and it's not a refund, whichever keyword sits textually closer to
  the amount wins.
- Counterparty: UPI VPA (rejects anything followed by a `.tld`, so it can't grab an email like
  `care@hdfcbank.com`) > 10-digit phone (digit-boundaried so it can't match inside a longer
  reference number, and skipped if preceded by ref/utr/rrn/txn context) > account fragment.
- Merchant: text after `at `/`to `/`towards ` (+ `from ` for income messages, e.g. a refund
  sender) up to the next punctuation/newline; skips "your ..." clauses and purely-numeric
  leftovers from a truncated time expression (`10:30 at SWIGGY` → `SWIGGY`, not `10`).
- Source: the sender id / package. Timestamp: event `ts` (capture time).
- Category: keyword map in `src/categories.ts` (Food, Groceries, Transport, Uber, Shopping,
  Bills, Entertainment, Health, UPI, Cash, Income, Other — Uber checked before Transport so
  rides get their own category). Income transactions default straight to `Income` instead of
  matching spend keywords in the body, unless a learned merchant rule overrides it.

---

## 4. DB rules (`src/db.ts`, op-sqlite)
- Library: `@op-engineering/op-sqlite` (replaces deprecated `react-native-quick-sqlite`; New-Arch ready).
- One connection, opened once; enable **WAL** (`PRAGMA journal_mode=WAL`).
- Migrations are linear and gated by `PRAGMA user_version` (currently v3) — every step is
  `ALTER TABLE ... ADD COLUMN` or `CREATE TABLE IF NOT EXISTS`, never a rebuild/DROP/UPDATE of
  existing rows. This is a hard rule, not just current practice: existing installs carry real
  transaction history and balances that must survive every update untouched.
  ```sql
  CREATE TABLE IF NOT EXISTS transactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    amount           REAL    NOT NULL,
    merchant         TEXT,
    source           TEXT,
    raw_text         TEXT,
    category         TEXT,
    timestamp        INTEGER NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'expense',  -- 'expense' | 'income' | 'self'
    counterparty     TEXT,                                 -- v2
    account          TEXT,                                 -- v2 (user's own account hint)
    note             TEXT,                                 -- v2
    category_source  TEXT DEFAULT 'auto',                   -- v2 ('auto' | 'manual')
    channel          TEXT,                                  -- v3 ('sms' | 'notification' | 'manual' | NULL)
    dedup_key        TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);
  CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
  -- v2 auxiliary tables: app_settings (key/value; legacy '__balance__*' rows are inert, the balance feature was removed),
  -- merchant_rules (learned categorization), budgets.
  ```
- **Strict idempotency:** `dedup_key = hash(source + amount + floor(ts/60000) + raw_text)`; insert with `INSERT OR IGNORE`. Prevents live-emit + buffer-drain double counts of the exact same message. Unaffected by the soft-dedup rule below — always applies.
- **Soft cross-channel dedup** (user-chosen policy — see §8 for why "cross-channel only"): the same payment can arrive via SMS *and* a bank-app notification with different raw text (different strict key). An incoming row is dropped only when an *existing* row has a **known, different** channel (same-channel repeats are always kept), amount matches, timestamps are within 2 minutes, and counterparties agree or are unknown. Every pre-v3 row has `channel = NULL` and is exempt — NULL never triggers a drop. Manual entries (`channel = 'manual'`) never soft-dedup. Restore (`export.ts`) bypasses soft dedup entirely (`skipSoftDedup: true`) so it can't merge two genuine close-together payments; the strict key still keeps a restore idempotent.
- API: `initDb()`, `insertTransaction(tx, options?)`, `insertManual(tx)`, `getAll()`, `queryTransactions(filters)`, `getSummary(range)` (spent/received/net + per-local-day and per-category breakdowns). No dead `getByDateRange`/`getMonthlySummary`/`getTrend` — removed, use `queryTransactions`/`getSummary`.
- `getSummary`'s per-day bucket uses **local-calendar-day** arithmetic (`dates.ts` `localTzOffsetMs()`), not raw UTC-day division — otherwise a transaction between local midnight and the UTC offset (00:00–05:30 on an IST device) lands in yesterday's chart bucket while the transaction list correctly shows it under "Today". Convert a `day` index back to a `Date` with `localDayIndexToDate()`, never `new Date(day * 86400000)`.

---

## 5. Permissions & manifest
- `RECEIVE_SMS` only — `READ_SMS` was removed (nothing ever reads the inbox; only the
  broadcast is consumed). Don't re-add it without an actual inbox-reading use case.
- SMS `<receiver>` with `android.provider.Telephony.SMS_RECEIVED` intent-filter, `android:permission="android.permission.BROADCAST_SMS"`, `android:exported="true"`.
- `<service>` for NotificationListenerService with `android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"` and the `android.service.notification.NotificationListenerService` intent-filter.
- **Notification Access cannot be auto-granted** — user enables it in Settings → Notification access. App should detect and prompt.
- `<queries>` block for `ACTION_MAIN`/`CATEGORY_LAUNCHER` lets `getInstalledApps()` enumerate
  launcher activities for the "Add App" picker — query with flag `0`, not
  `MATCH_DEFAULT_ONLY` (that flag filters to `CATEGORY_DEFAULT` activities, which most
  launcher activities don't declare, making the picker look empty/frozen).
- `android:allowBackup="false"` — this is fully local financial data; it must never go into
  Google's cloud backup. `backup_rules.xml` is kept empty (not deleted) as a guard against a
  future accidental `allowBackup="true"` silently re-including the database.

---

## 6. RN / build environment
- React Native **0.86.0**, React 19.2.3, **New Architecture ON** (`newArchEnabled=true`), Hermes ON.
- Native modules use **legacy `ReactContextBaseJavaModule`** + `DeviceEventManagerModule.RCTDeviceEventEmitter` — supported under New Arch via the interop layer (no TurboModule codegen needed). Register via `ExpensePackage : ReactPackage` added in `MainApplication.kt`'s `PackageList(this).packages.apply { add(ExpensePackage()) }`.
- App id / package: `com.expensetracker`.
- Toolchain: Node 22, JDK 21, Android SDK (configured in `android/local.properties`, gitignored, or via `ANDROID_HOME`).

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
- Release build: Hermes ON, R8/ProGuard **deliberately OFF** (`enableProguardInReleaseBuilds=false`, see §6) — this is a personal sideloaded app; the keep-rule risk to the native modules isn't worth the size savings. Don't turn it on without writing keep rules for the Kotlin native modules first.
- APK is built for `arm64-v8a` + `x86_64` only (`reactNativeArchitectures` in `gradle.properties`) — the phone's actual ABI plus the emulator, not all four architectures.

---

## 8. Known risks & decisions

- **Dedup policy is cross-channel-only, by explicit user choice.** A duplicate is only ever
  dropped when the same payment arrives via two *different* channels (SMS vs notification).
  Two genuine payments on the *same* channel are always kept, even if they look identical
  (same amount, close together) — the user hasn't hit false duplicates in practice, so the
  rule stays maximally conservative: when unsure, keep the row rather than risk losing a real
  transaction. See §4's soft-dedup rule for the exact predicate.
- EventBuffer's storage format is deliberately still a single JSON array, not per-event keys —
  a per-event rewrite was scoped out because it's a minor efficiency gain with real breakage
  risk on the capture path (a storage-format migration touching code that must never lose
  events). The SMS pre-filter (§2) removes most of the write volume for free instead.
- New-Arch ↔ legacy-module interop edge cases → fallback pin RN 0.81 if friction appears.
- Emulator covers functional verification; true battery profiling needs a real device.
- SMS formats vary by bank; parser is best-effort regex, extend the keyword/merchant rules as real samples appear.
