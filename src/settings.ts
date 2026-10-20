// ─── Typed settings wrapper over db.getSetting / db.setSetting ───────────────
//
// All values are JSON-serialised strings in the app_settings table.
// This module is the single place that knows about setting key names and their
// expected shapes — consumers import typed helpers, never raw string keys.

import { getSetting, setSetting } from './db';
import type { Identity } from './identity';

// ─── Generic JSON helpers ─────────────────────────────────────────────────────

/**
 * Read a JSON-encoded setting and return it as T, or `fallback` if the key is
 * absent or the stored value cannot be parsed.
 */
export function getJSON<T>(key: string, fallback: T): T {
  try {
    const raw = getSetting(key);
    if (raw == null) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * JSON-encode `value` and persist it under `key`.
 */
export function setJSON(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

// ─── Identity ─────────────────────────────────────────────────────────────────

const IDENTITY_KEY = 'identity';

const IDENTITY_DEFAULTS: Identity = {
  name: '',
  phones: [],
  upiHandles: [],
  accountLast4: [],
};

/**
 * Load the user's Identity from the settings store.
 * Returns safe defaults (all arrays empty, name empty) when no identity has
 * been configured yet.
 */
export function getIdentity(): Identity {
  const stored = getJSON<Partial<Identity>>(IDENTITY_KEY, {});
  return {
    name: stored.name ?? IDENTITY_DEFAULTS.name,
    phones: Array.isArray(stored.phones)
      ? stored.phones
      : IDENTITY_DEFAULTS.phones,
    upiHandles: Array.isArray(stored.upiHandles)
      ? stored.upiHandles
      : IDENTITY_DEFAULTS.upiHandles,
    accountLast4: Array.isArray(stored.accountLast4)
      ? stored.accountLast4
      : IDENTITY_DEFAULTS.accountLast4,
  };
}

/**
 * Persist the user's Identity to the settings store.
 */
export function setIdentity(identity: Identity): void {
  setJSON(IDENTITY_KEY, identity);
}

// ─── Family members ───────────────────────────────────────────────────────────

const FAMILY_KEY = 'family_members';

/** Names or VPAs of family members whose credits are categorized 'Family'. */
export function getFamilyMembers(): string[] {
  const stored = getJSON<unknown>(FAMILY_KEY, []);
  return Array.isArray(stored)
    ? stored.filter((x): x is string => typeof x === 'string')
    : [];
}

export function setFamilyMembers(members: string[]): void {
  setJSON(FAMILY_KEY, members);
}

// ─── Friends ──────────────────────────────────────────────────────────────────

const FRIENDS_KEY = 'friends';

/** Names or VPAs of friends; any payment to/from them is categorized 'Friend Transfer'. */
export function getFriends(): string[] {
  const stored = getJSON<unknown>(FRIENDS_KEY, []);
  return Array.isArray(stored)
    ? stored.filter((x): x is string => typeof x === 'string')
    : [];
}

export function setFriends(friends: string[]): void {
  setJSON(FRIENDS_KEY, friends);
}

// ─── Dismissed capture apps ────────────────────────────────────────────────────

const DISMISSED_APPS_KEY = 'dismissedApps';

/**
 * Package names the user has explicitly removed from the notification
 * capture allowlist screen. Separate from the allowlist itself (SharedPreferences
 * on the native side) because a bank-detected app would otherwise always
 * reappear in the list regardless of its enabled/disabled toggle state.
 */
export function getDismissedApps(): string[] {
  const stored = getJSON<string[]>(DISMISSED_APPS_KEY, []);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Persist the set of dismissed package names.
 */
export function setDismissedApps(pkgs: string[]): void {
  setJSON(DISMISSED_APPS_KEY, pkgs);
}
