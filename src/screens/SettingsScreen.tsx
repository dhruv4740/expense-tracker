// ─── SettingsScreen ───────────────────────────────────────────────────────────
//
// Profile, budgets, notification allowlist, permissions, data export/import,
// and about section. ScrollView with SectionHeader-divided Card groups.

import React, { useCallback, useEffect, useState } from 'react';
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
} from '../db';
import type { Budget } from '../db';
import { CATEGORIES } from '../categories';
import { getIdentity, setIdentity, getDismissedApps, setDismissedApps } from '../settings';
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
import { Card, SectionHeader, Icon } from '../components';
import { theme } from '../theme';

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
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: 'default' | 'numeric' | 'email-address';
  placeholder?: string;
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
    </View>
  );
});

const inputStyles = StyleSheet.create({
  row: {
    marginBottom: theme.spacing.md,
  },
  label: {
    fontSize: theme.font.size.sm,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.xs,
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

  // ── Budgets ─────────────────────────────────────────────────────────────────
  const [overallBudget, setOverallBudget] = useState('');
  const [categoryBudgets, setCategoryBudgets] = useState<Record<string, string>>({});

  // ── Notification allowlist ───────────────────────────────────────────────────
  const [allowlist, setAllowlistState] = useState<AllowlistEntry[]>([]);
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [allInstalledApps, setAllInstalledApps] = useState<InstalledApp[]>([]);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);

  // ── Permissions ─────────────────────────────────────────────────────────────
  const [notifGranted, setNotifGranted] = useState<boolean | null>(null);

  // ── Data buttons ────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    // Profile
    const identity: Identity = getIdentity();
    setName(identity.name ?? '');
    setPhones((identity.phones ?? []).join(', '));
    setUpiHandles((identity.upiHandles ?? []).join(', '));
    setAccountLast4((identity.accountLast4 ?? []).join(', '));

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
  }, []);

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
        <InputRow label="Name" value={name} onChangeText={setName} placeholder="Your name" />
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
        <TouchableOpacity style={styles.saveBtn} onPress={handleSaveProfile}>
          <Text style={styles.saveBtnText}>Save Profile</Text>
        </TouchableOpacity>
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
      <SectionHeader title="Apps to Capture Notifications From" />
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
      <SectionHeader title="Permissions" />
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
      </Card>

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
