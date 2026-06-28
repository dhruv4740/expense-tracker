# ExpenseTracker — CLAUDE.md

## Project
Personal Android expense tracker. Intercepts SMS and app notifications, parses transaction data, stores locally, displays in a clean UI.

## Stack
- React Native 0.86 (bare workflow, TypeScript, **New Architecture ON**)
- Kotlin native modules (SMS + Notification access — cannot use JS for these)
- SQLite via **@op-engineering/op-sqlite** (the deprecated `react-native-quick-sqlite` is replaced by its maintained, New-Arch-ready successor by the same author)
- React Navigation v7 (bottom tabs)
- Charts: later (start with numbers; Victory Native / Skia optional)

## Architecture (battery-first — see RULES.md §1)
Capture is split from processing so the app works when closed WITHOUT draining battery:

- SMS BroadcastReceiver (Kotlin, manifest-registered) → writes raw event to a SharedPreferences `EventBuffer` (no RN bridge, no wake lock)
- NotificationListenerService (Kotlin) → packageName allowlist FIRST → writes raw event to the same `EventBuffer`
- On app open/foreground: JS drains the buffer → Parser (TS) → dedup → op-sqlite (db.ts) → UI
- While app is open: modules ALSO emit `SmsReceived`/`NotificationReceived` via RCTDeviceEventEmitter for live updates (same parser + dedup path)

The naive "emit to JS on every event" path is intentionally NOT the primary path — it loses events when the app is closed and wastes battery waking JS. **Read RULES.md before touching native capture code.**

## Native Modules to build
1. SmsReceiver.kt (manifest BroadcastReceiver) + SmsModule.kt (drainBuffer + live emit)
2. NotificationService.kt (NotificationListenerService, allowlist) + NotificationModule.kt (drainBuffer + live emit)
3. EventBuffer.kt (shared SharedPreferences ring buffer) + ExpensePackage.kt (registers both modules in MainApplication.kt)

## Parser rules (TypeScript)
- Amount: match `(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)` 
- Direction: "debited"/"spent"/"charged"/"sent" = expense, "credited"/"received" = income (ignore income for now)
- Merchant: text after "at " or "to " or "towards " before next punctuation/end
- Source: sender ID (e.g. HDFCBK, ICICIB, Paytm)
- Timestamp: system time at intercept

## DB Schema
transactions(id, amount, merchant, source, raw_text, category, timestamp, type, dedup_key UNIQUE)
- `dedup_key` = hash(source + amount + minute-bucket + raw_text); insert with `INSERT OR IGNORE` for idempotency
- indices on timestamp and category; WAL mode
categories: Food, Transport, Shopping, Bills, UPI, Other (auto-assign by keyword, editable)

## Permissions needed
- android.permission.RECEIVE_SMS
- android.permission.READ_SMS
- Notification Access (NotificationListenerService — user grants manually in Settings)

## Rules
- Android only, no iOS considerations
- No backend, no auth, fully local
- No LLM calls
- Sideloaded APK, Play Store compliance not a concern
- Keep UI minimal: transaction list, basic filters (date/category), one summary chart
- **Battery is the primary constraint** — no wake locks, no polling, no background JS, no foreground service (see RULES.md)
- **Commit after every change** (local only; no remote configured yet)
- See **RULES.md** for the full engineering contract (EventBuffer shape, parser/db details, build env)

## ⚠️ Build / install rule (read before touching the phone)
**NEVER install the debug APK (`assembleDebug` / `run-android`) on the physical phone.**
- Debug = `com.expensetracker.debug`, shows Metro "unable to load script" error without a running dev server.
- Release = `com.expensetracker`, fully standalone (no Metro needed).
- The two packages are SEPARATE — installing debug does NOT touch the release app or its data.
- Only command to push to the real phone: `cd android && ./gradlew assembleRelease` then `adb install -r .../app-release.apk`