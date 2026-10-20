// ─── SettingsScreen ───────────────────────────────────────────────────────────
//
// Profile, budgets, notification allowlist, permissions, data export/import,
// and about section. ScrollView with SectionHeader-divided Card groups.

import React, { useCallback, useState } from 'react';
import {
  Alert,
  Modal,
  FlatList,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

import {
  getBudgets,
  setBudget,
  OVERALL_BUDGET_KEY,
  getAccountCounts,
  getIncomeSources,
  getPeopleSources,
} from '../db';
import type { Budget } from '../db';
import { CATEGORIES } from '../categories';
import {
  getIdentity,
  setIdentity,
  getDismissedApps,
  setDismissedApps,
  getFamilyMembers,
  setFamilyMembers,
  getFriends,
  setFriends,
  getAmazonTopupFamily,
  setAmazonTopupFamily,
} from '../settings';
import { suggestOwnAccounts, suggestFamily } from '../suggestions';
import type { AccountCount, FamilySuggestion } from '../suggestions';
import type { Identity } from '../identity';
import { refreshSyncCaches } from '../sync';
import { DATA_CHANGED } from '../sync';
import { DeviceEventEmitter } from 'react-native';
import {
  isNotificationAccessGranted,
  openNotificationAccessSettings,
  getAllowlist,
  setAllowlist,
  getInstalledApps,
} from '../native/NotificationModule';
import type { InstalledApp } from '../native/NotificationModule';
import { exportCsv, exportJson, restoreFromJson } from '../export';
import { backupNow, folderLabel, getBackupFolder, getLastBackupTs, setBackupFolder } from '../autoBackup';
import { pickBackupFolder } from '../native/FileModule';
import { Card, SectionHeader, Icon } from '../components';
import { theme } from '../theme';
import { RecheckModal } from './RecheckModal';
import { applyRecheck, getRecheckLog, previewRecheck, undoRecheck } from '../recheckSync';
import type { RecheckChange } from '../recheck';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AllowlistEntry {
  pkg: string;
  label: string;
  enabled: boolean;
  isLikelyBank: boolean;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const InputRow = React.memo(function InputRow({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: 'default' | 'numeric' | 'email-address';
  placeholder?: string;
  hint?: string;
}) {
  return (
    <View style={inputStyles.row}>
      <Text style={inputStyles.label}>{label}</Text>
      <TextInput
        style={inputStyles.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder ?? ''}
        placeholderTextColor={theme.colors.textMuted}
      />
      {hint ? <Text style={inputStyles.hint}>{hint}</Text> : null}
    </View>
  );
});

/** ₹61k / ₹1.2L style short amount for chips. */
function shortRupees(n: number): string {
  if (n >= 100000) {
    return `₹${(n / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  }
  if (n >= 1000) {
    return `₹${Math.round(n / 1000)}k`;
  }
  return `₹${Math.round(n)}`;
}

const inputStyles = StyleSheet.create({
  row: {
    marginBottom: theme.spacing.md,
  },
  label: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.xs,
  },
  hint: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
  },
  input: {
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.textPrimary,
    fontSize: theme.font.size.md,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
});

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // ── Profile ─────────────────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [phones, setPhones] = useState('');
  const [upiHandles, setUpiHandles] = useState('');
  const [accountLast4, setAccountLast4] = useState('');

  // ── Suggestions ─────────────────────────────────────────────────────────────
  const [accountSuggestions, setAccountSuggestions] = useState<AccountCount[]>([]);
  const [family, setFamily] = useState<string[]>([]);
  const [familyInput, setFamilyInput] = useState('');
  const [familySuggestions, setFamilySuggestions] = useState<FamilySuggestion[]>([]);
  const [friends, setFriendsState] = useState<string[]>([]);
  const [friendInput, setFriendInput] = useState('');
  const [amazonTopup, setAmazonTopup] = useState(true);
  const [friendSuggestions, setFriendSuggestions] = useState<FamilySuggestion[]>([]);

  // ── Budgets ─────────────────────────────────────────────────────────────────
  const [overallBudget, setOverallBudget] = useState('');
  const [categoryBudgets, setCategoryBudgets] = useState<Record<string, string>>({});

  // ── Notification allowlist ───────────────────────────────────────────────────
  const [showApps, setShowApps] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const [allowlist, setAllowlistState] = useState<AllowlistEntry[]>([]);
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [allInstalledApps, setAllInstalledApps] = useState<InstalledApp[]>([]);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);

  // ── Permissions ─────────────────────────────────────────────────────────────
  const [notifGranted, setNotifGranted] = useState<boolean | null>(null);

  // ── Data buttons ────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupFolder, setBackupFolderState] = useState<string | null>(() => getBackupFolder());
  const [lastBackup, setLastBackup] = useState<number | null>(() => getLastBackupTs());
  const [backingUp, setBackingUp] = useState(false);
  const [recheck, setRecheck] = useState<RecheckChange[] | null>(null);
  const [hasRecheckLog, setHasRecheckLog] = useState(() => getRecheckLog() != null);
  const finishRecheck = (msg: string) => {
    setHasRecheckLog(getRecheckLog() != null);
    DeviceEventEmitter.emit(DATA_CHANGED);
    Alert.alert('Re-check', msg, undefined, { cancelable: true });
  };

  const loadSuggestions = useCallback(() => {
    const identity = getIdentity();
    const fam = getFamilyMembers();
    setFamily(fam);
    setAccountSuggestions(suggestOwnAccounts(getAccountCounts(), identity));
    const fr = getFriends();
    setFriendsState(fr);
    setAmazonTopup(getAmazonTopupFamily());
    setFamilySuggestions(
      suggestFamily(getIncomeSources(), { identity, family: fam, friends: fr }),
    );
    setFriendSuggestions(
      suggestFamily(getPeopleSources(), { identity, family: fam, friends: fr }),
    );
  }, []);

  const load = useCallback(async () => {
    // Profile
    const identity: Identity = getIdentity();
    setName(identity.name ?? '');
    setPhones((identity.phones ?? []).join(', '));
    setUpiHandles((identity.upiHandles ?? []).join(', '));
    setAccountLast4((identity.accountLast4 ?? []).join(', '));
    loadSuggestions();

    // Budgets
    const budgets: Budget[] = getBudgets();
    const newCatBudgets: Record<string, string> = {};
    let overall = '';
    for (const b of budgets) {
      if (b.category === OVERALL_BUDGET_KEY) {
        overall = b.monthly_limit > 0 ? String(b.monthly_limit) : '';
      } else {
        newCatBudgets[b.category] = b.monthly_limit > 0 ? String(b.monthly_limit) : '';
      }
    }
    setOverallBudget(overall);
    setCategoryBudgets(newCatBudgets);

    // Notification allowlist — build from real installed apps
    setAllowlistError(null);
    try {
      const [installed, enabled] = await Promise.all([
        getInstalledApps(),
        getAllowlist(),
      ]);
      const enabledSet = new Set(enabled);
      const dismissedSet = new Set(getDismissedApps());
      // Store all installed for the "Add app" picker
      setAllInstalledApps(installed);
      // Show bank-likely apps + anything the user already enabled (even non-bank),
      // minus anything the user explicitly deleted from the list.
      const bankOrEnabled = installed
        .filter(a => a.isLikelyBank || enabledSet.has(a.pkg))
        .filter(a => !dismissedSet.has(a.pkg));
      setAllowlistState(
        bankOrEnabled.map(a => ({ ...a, enabled: enabledSet.has(a.pkg) })),
      );
    } catch (e) {
      // Surface the failure instead of silently looking empty/frozen.
      setAllowlistError(
        e instanceof Error ? e.message : 'Could not load installed apps.',
      );
    }

    // Permissions
    try {
      const granted = await isNotificationAccessGranted();
      setNotifGranted(granted);
    } catch {
      setNotifGranted(false);
    }
  }, [loadSuggestions]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // ── Profile save ─────────────────────────────────────────────────────────────
  function handleSaveProfile() {
    const splitTrim = (s: string) =>
      s
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);

    const identity: Identity = {
      name: name.trim(),
      phones: splitTrim(phones),
      upiHandles: splitTrim(upiHandles),
      accountLast4: splitTrim(accountLast4),
    };
    setIdentity(identity);
    refreshSyncCaches();
    Alert.alert('Saved', 'Profile updated.');
  }

  function handleAddAccount(last4: string) {
    const identity = getIdentity();
    if (!identity.accountLast4.includes(last4)) {
      identity.accountLast4 = [...identity.accountLast4, last4];
      setIdentity(identity);
      refreshSyncCaches();
    }
    setAccountLast4(identity.accountLast4.join(', '));
    loadSuggestions();
  }

  function saveFamily(next: string[]) {
    setFamilyMembers(next);
    refreshSyncCaches();
    loadSuggestions();
  }

  function handleAddFamily(value: string) {
    const v = value.trim();
    if (!v || [...family, ...friends].some(f => f.toLowerCase() === v.toLowerCase())) {
      return;
    }
    saveFamily([...family, v]);
    setFamilyInput('');
  }

  function saveFriends(next: string[]) {
    setFriends(next);
    refreshSyncCaches();
    loadSuggestions();
  }

  function handleAddFriend(value: string) {
    const v = value.trim();
    if (!v || [...family, ...friends].some(f => f.toLowerCase() === v.toLowerCase())) {
      return;
    }
    saveFriends([...friends, v]);
    setFriendInput('');
  }

  // ── Budget save ──────────────────────────────────────────────────────────────
  function handleSaveBudgets() {
    // Overall
    const overallNum = parseFloat(overallBudget);
    setBudget(OVERALL_BUDGET_KEY, isNaN(overallNum) ? 0 : overallNum);

    // Per-category. Investment is excluded — its spend is deliberately not
    // counted in getSummary().byCategory, so a budget against it could never
    // register as spent.
    for (const cat of CATEGORIES.filter(c => c !== 'Investment')) {
      const raw = categoryBudgets[cat] ?? '';
      const num = parseFloat(raw);
      setBudget(cat, isNaN(num) ? 0 : num);
    }
    Alert.alert('Saved', 'Budgets updated.');
  }

  // ── Allowlist toggle ─────────────────────────────────────────────────────────
  async function handleAllowlistToggle(pkg: string, value: boolean) {
    const updated = allowlist.map(e =>
      e.pkg === pkg ? { ...e, enabled: value } : e,
    );
    setAllowlistState(updated);
    const enabledPkgs = updated.filter(e => e.enabled).map(e => e.pkg);
    try {
      await setAllowlist(enabledPkgs);
    } catch {
      // revert on error
      setAllowlistState(allowlist);
    }
  }

  // ── Add app from picker ──────────────────────────────────────────────────────
  async function handleAddApp(app: InstalledApp) {
    setShowAppPicker(false);
    // Already in the list?
    if (allowlist.some(e => e.pkg === app.pkg)) {
      return;
    }
    const updated: AllowlistEntry[] = [
      ...allowlist,
      { pkg: app.pkg, label: app.label, enabled: true, isLikelyBank: app.isLikelyBank },
    ];
    setAllowlistState(updated);
    // Re-adding a previously deleted app un-dismisses it.
    setDismissedApps(getDismissedApps().filter(p => p !== app.pkg));
    const enabledPkgs = updated.filter(e => e.enabled).map(e => e.pkg);
    try {
      await setAllowlist(enabledPkgs);
    } catch {
      setAllowlistState(allowlist);
    }
  }

  // ── Delete app from list ─────────────────────────────────────────────────────
  async function handleDeleteApp(pkg: string) {
    const updated = allowlist.filter(e => e.pkg !== pkg);
    setAllowlistState(updated);
    setDismissedApps([...getDismissedApps(), pkg]);
    const enabledPkgs = updated.filter(e => e.enabled).map(e => e.pkg);
    try {
      await setAllowlist(enabledPkgs);
    } catch {
      setAllowlistState(allowlist);
    }
  }

  // ── Data actions ─────────────────────────────────────────────────────────────
  async function handleExportCsv() {
    setExporting(true);
    try {
      const ok = await exportCsv();
      Alert.alert(ok ? 'Exported' : 'Export failed', ok ? 'CSV saved.' : 'Could not save CSV.');
    } finally {
      setExporting(false);
    }
  }

  async function handleExportJson() {
    setExporting(true);
    try {
      const ok = await exportJson();
      Alert.alert(ok ? 'Exported' : 'Export failed', ok ? 'JSON saved.' : 'Could not save JSON.');
    } finally {
      setExporting(false);
    }
  }

  async function handlePickBackupFolder() {
    try {
      const uri = await pickBackupFolder();
      if (uri) {
        setBackupFolder(uri);
        setBackupFolderState(uri);
      }
    } catch (e) {
      Alert.alert('Folder not set', e instanceof Error ? e.message : 'Could not pick a folder.');
    }
  }

  async function handleBackupNow() {
    setBackingUp(true);
    try {
      await backupNow();
      setLastBackup(getLastBackupTs());
      Alert.alert('Backed up', 'Backup saved to the chosen folder.');
    } catch (e) {
      Alert.alert('Backup failed', e instanceof Error ? e.message : 'Could not write the backup.');
    } finally {
      setBackingUp(false);
    }
  }

  async function handleRestore() {
    Alert.alert(
      'Restore from JSON',
      'This will import transactions from a JSON file. Existing transactions are not removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pick file',
          onPress: async () => {
            setImporting(true);
            try {
              const result = await restoreFromJson();
              DeviceEventEmitter.emit(DATA_CHANGED);
              Alert.alert(
                'Restore complete',
                `Added ${result.added} of ${result.total} transactions.`,
              );
            } catch {
              Alert.alert('Restore failed', 'Could not read the selected file.');
            } finally {
              setImporting(false);
            }
          },
        },
      ],
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Profile ── */}
      <SectionHeader title="Profile" />
      <Card>
        <InputRow
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          hint="Used to spot transfers to your own accounts"
        />
        <InputRow
          label="Phone numbers (comma-separated)"
          value={phones}
          onChangeText={setPhones}
          keyboardType="default"
          placeholder="9876543210, 9123456789"
        />
        <InputRow
          label="UPI handles (comma-separated)"
          value={upiHandles}
          onChangeText={setUpiHandles}
          placeholder="you@upi, name@okaxis"
        />
        <InputRow
          label="Account last 4 digits (comma-separated)"
          value={accountLast4}
          onChangeText={setAccountLast4}
          keyboardType="numeric"
          placeholder="1234, 5678"
        />
        {accountSuggestions.length > 0 && (
          <View style={styles.chipRow}>
            {accountSuggestions.slice(0, 6).map(a => (
              <TouchableOpacity
                key={a.account}
                style={styles.chip}
                onPress={() => handleAddAccount(a.account)}
              >
                <Text style={styles.chipText}>
                  Add ••{a.account} ({a.count} msgs)
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <TouchableOpacity style={styles.saveBtn} onPress={handleSaveProfile}>
          <Text style={styles.saveBtnText}>Save Profile</Text>
        </TouchableOpacity>
      </Card>

      {/* ── Family ── */}
      <SectionHeader title="Family" />
      <Card>
        <Text style={styles.subLabel}>
          Credits from these people are tracked as Family income, not Friend Transfer.
        </Text>
        <View style={styles.chipRow}>
          {family.map(f => (
            <TouchableOpacity
              key={f}
              style={styles.chip}
              onPress={() => saveFamily(family.filter(x => x !== f))}
            >
              <Text style={styles.chipText}>{f}  ✕</Text>
            </TouchableOpacity>
          ))}
        </View>
        <InputRow
          label="Add a name or UPI handle"
          value={familyInput}
          onChangeText={setFamilyInput}
          placeholder="Full name or name@upi"
        />
        <TouchableOpacity
          style={styles.saveBtn}
          onPress={() => handleAddFamily(familyInput)}
        >
          <Text style={styles.saveBtnText}>Add</Text>
        </TouchableOpacity>
        {familySuggestions.length > 0 && (
          <>
            <Text style={[styles.subLabel, styles.suggestLabel]}>Suggestions</Text>
            <View style={styles.chipRow}>
              {familySuggestions.map(sug => (
                <TouchableOpacity
                  key={sug.value}
                  style={styles.chip}
                  onPress={() => handleAddFamily(sug.value)}
                >
                  <Text style={styles.chipText}>
                    + {sug.value} · {shortRupees(sug.total)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </Card>

      <Card>
        <View style={styles.allowRow}>
          <View style={styles.allowLabelBlock}>
            <Text style={styles.allowLabel}>Amazon Pay wallet top-ups come from family</Text>
            <Text style={styles.subLabel}>
              Needs the Gmail "added to your Amazon Pay Wallet" notification. Off: counted as
              your own money (hidden).
            </Text>
          </View>
          <Switch
            value={amazonTopup}
            onValueChange={v => {
              setAmazonTopup(v);
              setAmazonTopupFamily(v);
              refreshSyncCaches();
            }}
            trackColor={{ true: theme.colors.accent, false: theme.colors.surfaceAlt }}
            thumbColor={theme.colors.textPrimary}
          />
        </View>
      </Card>

      {/* ── Friends ── */}
      <SectionHeader title="Friends" />
      <Card>
        <Text style={styles.subLabel}>
          Payments to or from these people are categorised as Friend Transfer (family wins if
          a name is in both).
        </Text>
        <View style={styles.chipRow}>
          {friends.map(f => (
            <TouchableOpacity
              key={f}
              style={styles.chip}
              onPress={() => saveFriends(friends.filter(x => x !== f))}
            >
              <Text style={styles.chipText}>{f}  ✕</Text>
            </TouchableOpacity>
          ))}
        </View>
        <InputRow
          label="Add a name or UPI handle"
          value={friendInput}
          onChangeText={setFriendInput}
          placeholder="Full name or name@upi"
        />
        <TouchableOpacity
          style={styles.saveBtn}
          onPress={() => handleAddFriend(friendInput)}
        >
          <Text style={styles.saveBtnText}>Add</Text>
        </TouchableOpacity>
        {friendSuggestions.length > 0 && (
          <>
            <Text style={[styles.subLabel, styles.suggestLabel]}>Suggestions</Text>
            <View style={styles.chipRow}>
              {friendSuggestions.map(sug => (
                <TouchableOpacity
                  key={sug.value}
                  style={styles.chip}
                  onPress={() => handleAddFriend(sug.value)}
                >
                  <Text style={styles.chipText}>
                    + {sug.value} · {shortRupees(sug.total)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </Card>

      {/* ── Budgets ── */}
      <SectionHeader title="Budgets" />
      <Card>
        <InputRow
          label="Overall monthly budget (₹)"
          value={overallBudget}
          onChangeText={setOverallBudget}
          keyboardType="numeric"
          placeholder="e.g. 30000"
        />
        <Text style={styles.subLabel}>Per-category budgets (₹, leave blank to remove)</Text>
        {CATEGORIES.filter(cat => cat !== 'Investment').map(cat => (
          <InputRow
            key={cat}
            label={cat}
            value={categoryBudgets[cat] ?? ''}
            onChangeText={v =>
              setCategoryBudgets(prev => ({ ...prev, [cat]: v }))
            }
            keyboardType="numeric"
            placeholder="e.g. 5000"
          />
        ))}
        <TouchableOpacity style={styles.saveBtn} onPress={handleSaveBudgets}>
          <Text style={styles.saveBtnText}>Save Budgets</Text>
        </TouchableOpacity>
      </Card>

      {/* ── Banks & Apps Captured ── */}
      <TouchableOpacity style={styles.collapseRow} onPress={() => setShowApps(v => !v)} activeOpacity={0.7}>
        <Text style={styles.collapseTitle}>Apps to Capture Notifications From</Text>
        <Text style={styles.collapseMeta}>
          {allowlist.filter(e => e.enabled).length} on {showApps ? '▾' : '▸'}
        </Text>
      </TouchableOpacity>
      {showApps && (
      <Card>
        {allowlistError && (
          <Text style={styles.allowError}>⚠️ {allowlistError}</Text>
        )}
        {allowlist.length === 0 ? (
          <Text style={styles.allowEmpty}>No apps detected. Use "Add App" below.</Text>
        ) : (
          allowlist.map(entry => (
            <View key={entry.pkg} style={styles.allowRow}>
              <View style={styles.allowLabelBlock}>
                <Text style={styles.allowLabel} numberOfLines={1}>{entry.label}</Text>
                {entry.isLikelyBank && (
                  <Text style={styles.allowBankTag}>Bank / UPI</Text>
                )}
              </View>
              <View style={styles.allowRowActions}>
                <Switch
                  value={entry.enabled}
                  onValueChange={v => handleAllowlistToggle(entry.pkg, v)}
                  trackColor={{ true: theme.colors.accent, false: theme.colors.surfaceAlt }}
                  thumbColor={theme.colors.textPrimary}
                />
                <TouchableOpacity
                  onPress={() => handleDeleteApp(entry.pkg)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Icon name="trash" size={18} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
        <TouchableOpacity
          style={styles.addAppBtn}
          onPress={() => setShowAppPicker(true)}
        >
          <Text style={styles.addAppBtnText}>+ Add App</Text>
        </TouchableOpacity>
      </Card>
      )}

      {/* ── Add App Picker Modal ── */}
      <Modal
        visible={showAppPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAppPicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>Add App to Capture</Text>
            <Text style={styles.pickerSub}>Select any installed app</Text>
            <FlatList
              data={allInstalledApps
                .filter(a => !allowlist.some(e => e.pkg === a.pkg))
                .sort((a, b) => {
                  if (a.isLikelyBank !== b.isLikelyBank) {
                    return a.isLikelyBank ? -1 : 1;
                  }
                  return a.label.localeCompare(b.label);
                })}
              keyExtractor={item => item.pkg}
              style={styles.pickerList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.pickerRow}
                  onPress={() => handleAddApp(item)}
                  activeOpacity={0.7}
                >
                  <View style={styles.pickerRowMain}>
                    <Text style={styles.pickerLabel} numberOfLines={1}>{item.label}</Text>
                    {item.isLikelyBank && (
                      <Text style={styles.allowBankTag}>Bank / UPI</Text>
                    )}
                  </View>
                  <Text style={styles.pickerPkg} numberOfLines={1}>{item.pkg}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.pickerEmpty}>
                  No apps found — check notification access is granted, or reopen Settings.
                </Text>
              }
            />
            <TouchableOpacity
              style={styles.pickerCancel}
              onPress={() => setShowAppPicker(false)}
            >
              <Text style={styles.pickerCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Permissions ── */}
      <TouchableOpacity style={styles.collapseRow} onPress={() => setShowPerms(v => !v)} activeOpacity={0.7}>
        <Text style={styles.collapseTitle}>Permissions</Text>
        <Text style={styles.collapseMeta}>
          {notifGranted === null ? '…' : notifGranted ? 'Granted' : 'Not granted'} {showPerms ? '▾' : '▸'}
        </Text>
      </TouchableOpacity>
      {showPerms && (
      <Card>
        <View style={styles.permRow}>
          <View style={styles.permLeft}>
            <Icon
              name="person"
              size={20}
              color={
                notifGranted === true
                  ? theme.colors.success
                  : theme.colors.danger
              }
            />
            <View>
              <Text style={styles.permTitle}>Notification Access</Text>
              <Text style={styles.permStatus}>
                {notifGranted === null
                  ? 'Checking…'
                  : notifGranted
                  ? 'Granted'
                  : 'Not granted'}
              </Text>
            </View>
          </View>
          {!notifGranted && (
            <TouchableOpacity
              style={styles.permBtn}
              onPress={openNotificationAccessSettings}
            >
              <Text style={styles.permBtnText}>Open Settings</Text>
            </TouchableOpacity>
          )}
        </View>
      </Card>
      )}

      {/* ── Categorization ── */}
      <SectionHeader title="Categorization" />
      <Card>
        <TouchableOpacity
          style={styles.dataBtn}
          onPress={() => navigation.navigate('MerchantRules')}
        >
          <Icon name="list" size={18} color={theme.colors.accent} />
          <Text style={[styles.dataBtnText, styles.dataBtnTextGrow]}>
            Learned Merchant Rules
          </Text>
          <Icon name="chevron-forward" size={16} color={theme.colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.dataBtn} onPress={() => setRecheck(previewRecheck())}>
          <Icon name="refresh" size={18} color={theme.colors.accent} />
          <Text style={[styles.dataBtnText, styles.dataBtnTextGrow]}>
            Re-check old transactions
          </Text>
        </TouchableOpacity>
        {hasRecheckLog && (
          <TouchableOpacity
            style={styles.dataBtn}
            onPress={() => {
              const r = undoRecheck();
              finishRecheck(`Restored ${r.restored} rows${r.skipped ? `; ${r.skipped} left as you edited them` : ''}.`);
            }}
          >
            <Icon name="refresh" size={18} color={theme.colors.accent} />
            <Text style={styles.dataBtnText}>Undo last re-check</Text>
          </TouchableOpacity>
        )}
      </Card>
      <RecheckModal
        changes={recheck}
        onCancel={() => setRecheck(null)}
        onApply={sel => {
          setRecheck(null);
          finishRecheck(`Updated ${applyRecheck(sel)} rows. You can undo this from Settings.`);
        }}
      />

      {/* ── Data ── */}
      <SectionHeader title="Data" />
      <Card>
        <TouchableOpacity
          style={[styles.dataBtn, exporting ? styles.dataBtnDisabled : undefined]}
          onPress={handleExportCsv}
          disabled={exporting}
        >
          {exporting ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon name="download" size={18} color={theme.colors.accent} />
          )}
          <Text style={styles.dataBtnText}>Export CSV</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.dataBtn, exporting ? styles.dataBtnDisabled : undefined]}
          onPress={handleExportJson}
          disabled={exporting}
        >
          {exporting ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon name="download" size={18} color={theme.colors.accent} />
          )}
          <Text style={styles.dataBtnText}>Export JSON</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.dataBtn, importing ? styles.dataBtnDisabled : undefined]}
          onPress={handleRestore}
          disabled={importing}
        >
          {importing ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon name="upload" size={18} color={theme.colors.accent} />
          )}
          <Text style={styles.dataBtnText}>Restore from JSON</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.dataBtn} onPress={handlePickBackupFolder}>
          <Icon name="download" size={18} color={theme.colors.accent} />
          <Text style={styles.dataBtnText}>
            {backupFolder ? 'Change backup folder' : 'Pick weekly backup folder'}
          </Text>
        </TouchableOpacity>
        {backupFolder ? (
          <>
            <Text style={styles.backupHint}>
              Folder: {folderLabel(backupFolder)} · last backup:{' '}
              {lastBackup ? new Date(lastBackup).toLocaleString('en-IN') : 'never'}. Backs up when you open the app, at most weekly; keeps the newest 8.
            </Text>
            <TouchableOpacity
              style={[styles.dataBtn, backingUp ? styles.dataBtnDisabled : undefined]}
              onPress={handleBackupNow}
              disabled={backingUp}
            >
              {backingUp ? (
                <ActivityIndicator size="small" color={theme.colors.accent} />
              ) : (
                <Icon name="download" size={18} color={theme.colors.accent} />
              )}
              <Text style={styles.dataBtnText}>Back up now</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </Card>

      {/* ── About ── */}
      <SectionHeader title="About" />
      <Card>
        <Text style={styles.aboutApp}>ExpenseTracker v1.0</Text>
        <Text style={styles.aboutSub}>
          Local-only Android SMS + notification expense tracker. No backend, no cloud.
        </Text>
      </Card>

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  collapseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.md,
  },
  collapseTitle: {
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold,
    color: theme.colors.textSecondary,
  },
  collapseMeta: { fontSize: theme.font.size.sm, color: theme.colors.accent },
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  content: {
    paddingBottom: theme.spacing.xxl,
  },
  saveBtn: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#000',
    fontWeight: theme.font.weight.bold,
    fontSize: theme.font.size.md,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.accent + '55',
  },
  chipText: {
    color: theme.colors.accent,
    fontSize: theme.font.size.sm,
  },
  suggestLabel: {
    marginTop: theme.spacing.md,
  },
  subLabel: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  allowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  allowLabelBlock: {
    flex: 1,
    marginRight: theme.spacing.md,
    gap: 2,
  },
  allowRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  allowLabel: {
    fontSize: theme.font.size.md,
    color: theme.colors.textSecondary,
  },
  allowBankTag: {
    fontSize: 9,
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
  },
  allowEmpty: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    paddingVertical: theme.spacing.sm,
    textAlign: 'center',
  },
  allowError: {
    fontSize: theme.font.size.xs,
    color: theme.colors.danger,
    paddingBottom: theme.spacing.sm,
  },
  pickerEmpty: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    textAlign: 'center',
    paddingVertical: theme.spacing.xl,
    lineHeight: 20,
  },
  addAppBtn: {
    marginTop: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.accent + '55',
    borderRadius: theme.radius.md,
    borderStyle: 'dashed',
  },
  addAppBtnText: {
    color: theme.colors.accent,
    fontWeight: theme.font.weight.medium,
    fontSize: theme.font.size.sm,
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    paddingBottom: 40,
    maxHeight: '80%',
  },
  pickerTitle: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  pickerSub: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.md,
  },
  pickerList: {
    maxHeight: 450,
  },
  pickerRow: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: 2,
  },
  pickerRowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  pickerLabel: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    flex: 1,
  },
  pickerPkg: {
    fontSize: 9,
    color: theme.colors.textMuted,
  },
  pickerCancel: {
    marginTop: theme.spacing.md,
    padding: theme.spacing.md,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
  },
  pickerCancelText: {
    color: theme.colors.textSecondary,
    fontWeight: theme.font.weight.medium,
  },
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  permLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    flex: 1,
  },
  permTitle: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
    fontWeight: theme.font.weight.medium,
  },
  permStatus: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
  },
  permBtn: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.accent,
  },
  permBtnText: {
    color: theme.colors.accent,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.medium,
  },
  dataBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  dataBtnDisabled: {
    opacity: 0.5,
  },
  backupHint: {
    fontSize: theme.font.size.xs,
    color: theme.colors.textMuted,
    marginVertical: theme.spacing.xs,
  },
  dataBtnText: {
    fontSize: theme.font.size.md,
    color: theme.colors.textPrimary,
  },
  dataBtnTextGrow: {
    flex: 1,
  },
  aboutApp: {
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xs,
  },
  aboutSub: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    lineHeight: 20,
  },
  bottomPad: {
    height: theme.spacing.xxl,
  },
});
