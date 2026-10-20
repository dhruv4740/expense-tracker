# ExpenseTracker — CLAUDE.md

## Project
Personal Android expense tracker. Intercepts SMS and app notifications, parses transaction data, stores locally, displays in a clean UI.

## Stack
- React Native 0.86 (bare workflow, TypeScript, **New Architecture ON**)
- Kotlin native modules (SMS + Notification access — cannot use JS for these)
- SQLite via **@op-engineering/op-sqlite** (the deprecated `react-native-quick-sqlite` is replaced by its maintained, New-Arch-ready successor by the same author)
- React Navigation v7 (bottom tabs)
- Charts: `react-native-gifted-charts` (donut, trend line, bars) + `react-native-svg`

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
- Amount: `Rs./INR/₹` + digits, with optional lakh/crore magnitude suffix; amounts <= 0 rejected
- Direction: "debited"/"spent"/"charged"/"sent"/"paid"/"purchase"/"withdrawn" = expense, "credited"/"received"/"refund" = income (income is tracked, not ignored — see RULES.md §3 for refund-direction handling)
- Negative guard rejects promo "will be debited/credited", failed/OTP/autopay-registration messages before they become fake transactions
- Merchant: text after "at "/"to "/"towards " (or "from " for income) before next punctuation/end
- Source: sender ID (e.g. HDFCBK, ICICIB, Paytm)
- Timestamp: system time at intercept (single read shared by buffer + live emit)

## DB Schema (v4 — see RULES.md §4 for full migration history)
transactions(id, amount, merchant, source, raw_text, category, timestamp, type,
  counterparty, account, note, category_source, channel, settles_id, owed_amount, dedup_key UNIQUE)
- `type`: 'expense' | 'income' | 'self'
- `channel`: 'sms' | 'notification' | 'manual' | NULL (NULL for all pre-v3 history) — used only for cross-channel soft dedup
- `settles_id` links a repayment/refund to its parent; opposite-direction children net the parent's effective amount (`EFFECTIVE_AMOUNT` in db.ts). `owed_amount` = others' share of a split (Uber)
- `dedup_key` = hash(source + amount + minute-bucket + raw_text); insert with `INSERT OR IGNORE` for idempotency (strict, always applies)
- Soft cross-channel dedup (separate from dedup_key): drops an incoming row only when an existing row's channel is known and different from the incoming one — same-channel repeats are always kept
- indices on timestamp, category, type; WAL mode
- auxiliary tables: app_settings (key/value; legacy `__balance__*` rows are inert), merchant_rules (learned categorization), budgets
categories: Food, Groceries, Transport, Uber, Shopping, Bills, Entertainment, Health, Investment, Education, UPI, Cash, Income, Family, Friend Transfer, Loan/Dues, Other (auto-assign by keyword, editable; Uber checked before Transport, Investment/Education checked before Bills/UPI). Grouped for display (Essentials/Transport/Lifestyle/Education/Transfers/Investments/Income/Other) via `groupOf()` in categories.ts — display-only, no DB column. Investment is excluded from spend totals (tracked separately as `invested`). Family is income from `family_members` (Settings) and shows as "From family"; type/category come from `classify()` in classify.ts (shared by sync and Re-check). Balance estimation was removed. Own-account transfers auto-pair — see RULES.md §4b.

## Permissions needed
- android.permission.RECEIVE_SMS
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

**Always build and install in the same session as the fix — don't leave a fix un-verified on-device.**
- Once code changes for a task are complete (tests/typecheck/lint passing), ask the user to plug in the phone and confirm they're ready before building — don't assume the phone is connected.
- Then run the assembleRelease + `adb install -r` sequence above. `-r` reinstalls over the existing app and preserves its data (SQLite DB, settings) — never uninstall first.