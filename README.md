# ExpenseTracker

Personal Android expense tracker. Intercepts SMS and bank/UPI app notifications, parses
transaction data locally, stores it in SQLite, and shows it in a minimal UI. Android only,
fully local — no backend, no accounts, no cloud backup. See [CLAUDE.md](CLAUDE.md) for the
product spec and [RULES.md](RULES.md) for the engineering contract.

## Requirements

- Node 22+, JDK 21, Android SDK (`android/local.properties`, gitignored)
- A physical Android phone for real testing — SMS/notification capture doesn't work on the
  emulator in any useful way (no real bank traffic).

## Running it

There are two build variants with **different package IDs**, so installing one never touches
the other's data:

| Variant | Package ID | Needs Metro? | Where to install |
|---|---|---|---|
| **release** | `com.expensetracker` | No — JS is bundled + Hermes-compiled in | The real phone (only variant to use here) |
| **debug** | `com.expensetracker.debug` | Yes — fetches JS from Metro (`localhost:8081`) | Emulator / dev device only |

### On the phone (release, standalone)

```sh
cd android
./gradlew assembleRelease
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`-r` replaces in place and preserves app data (same signing key across builds). **Never**
`adb uninstall` — that deletes local transaction history with no undo. Never install the
debug APK on the phone — it shows a red "unable to load script" screen without Metro running.

### On an emulator / dev device (debug, with Metro)

```sh
npx react-native start        # Metro, in one terminal
npx react-native run-android  # in another
```

## Testing

```sh
npm run typecheck   # tsc --noEmit
npm test            # jest
```

## Architecture (battery-first)

Capture (native Kotlin, no RN bridge, no wake lock) is split from parsing (JS, only runs when
the app is open). See [RULES.md §1](RULES.md#1-battery-first-architecture-the-core-design) for
the full design and the reasoning behind it.

## Backups

The app has no cloud backup (`allowBackup=false` — financial data must stay on-device). Use
Settings → Export CSV/JSON to make your own backup, and Settings → Restore from JSON to
import one back in.
