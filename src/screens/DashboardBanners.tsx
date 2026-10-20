// ─── Dashboard action banners (in-app only) ──────────────────────────────────
//
// Three kinds, at most TWO shown at once (priority = order below), above the cards:
//  1. Auto-applied own-account transfer  — "Marked ₹X A → B as a transfer · Undo"
//     (stays until seen/dismissed; Undo restores the rows' previous types)
//  2. Suggested own-account transfer     — "Looks like a transfer … · Link / Not this"
//  2b. Suggested cancel-out (friend's payment ↔ a spend; Link / Not this)
//  2c. Suggested refund (amount-only match to a spend; Link / Not this)
//  3. Suggested repayment                — only high-confidence pairs (settle.isBannerWorthy)
// No Android notifications and no background work (RULES.md §1): this runs when
// the Dashboard is focused or data changes while the app is open.

import React, { useCallback, useEffect, useState } from 'react';
import { DeviceEventEmitter, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { setSettlement } from '../db';
import { dismissCancel, getCancelSuggestions, linkCancel } from '../cancelSync';
import { dismissRefund, getRefundSuggestions, linkRefund } from '../refundSync';
import type { RefundSuggestion } from '../refundSync';
import type { CancelPair } from '../cancelOut';
import { getFriends, getIdentity } from '../settings';
import { DATA_CHANGED } from '../sync';
import {
  dismissAutoApplied,
  dismissRepaymentBanner,
  dismissTransferSuggestion,
  getAutoAppliedBanners,
  getRepaymentBanner,
  getTransferSuggestions,
  linkTransfer,
  undoAutoApplied,
} from '../transferSync';
import type { AutoSelfEntry } from '../transferLog';
import { legLabel } from '../transferPair';
import type { TransferPair } from '../transferPair';
import type { RepaymentBanner } from '../settle';
import { theme } from '../theme';
import { displayMerchant } from '../merchantDisplay';

function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function who(r: { counterparty?: string | null; merchant?: string | null; source?: string | null }): string {
  return r.counterparty ?? displayMerchant(r.merchant) ?? r.source ?? 'someone';
}

interface BannerState {
  auto: AutoSelfEntry | null;
  autoMore: number;
  suggestion: TransferPair | null;
  cancel: CancelPair | null;
  refund: RefundSuggestion | null;
  repay: RepaymentBanner | null;
}

const EMPTY: BannerState = { auto: null, autoMore: 0, suggestion: null, cancel: null, refund: null, repay: null };

function load(): BannerState {
  try {
    const autos = getAutoAppliedBanners();
    return {
      auto: autos[0] ?? null,
      autoMore: Math.max(autos.length - 1, 0),
      suggestion: getTransferSuggestions(getIdentity())[0] ?? null,
      cancel: getCancelSuggestions(getIdentity(), getFriends())[0] ?? null,
      refund: getRefundSuggestions()[0] ?? null,
      repay: getRepaymentBanner(),
    };
  } catch {
    return EMPTY;
  }
}

export default function DashboardBanners() {
  const [state, setState] = useState<BannerState>(EMPTY);
  const reload = useCallback(() => setState(load()), []);

  useFocusEffect(reload);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(DATA_CHANGED, reload);
    return () => sub.remove();
  }, [reload]);

  // A change to rows must refresh every screen's totals, not just the banners.
  const changed = useCallback(() => {
    DeviceEventEmitter.emit(DATA_CHANGED);
  }, []);

  // At most two banners, highest confidence first: auto-applied (Undo) →
  // repayment (high confidence only) → medium transfer suggestion.
  const { autoMore } = state;
  let slots = 2;
  const take = <T,>(x: T | null): T | null => (x && slots > 0 ? (slots--, x) : null);
  const auto = take(state.auto);
  const cancel = take(state.cancel);
  const refund = take(state.refund);
  const repay = take(state.repay);
  const suggestion = take(state.suggestion);

  return (
    <>
      {auto && (
        <View style={[styles.banner, styles.autoBanner]}>
          <Text style={styles.text}>
            {auto.kind === 'cancel'
              ? `Linked ${rupees(auto.amount)} ${auto.from} ↔ ${auto.to}`
              : `Marked ${rupees(auto.amount)} ${auto.from} → ${auto.to} as a transfer between your accounts`}
            {autoMore > 0 ? ` (+${autoMore} more)` : ''}
          </Text>
          <TouchableOpacity
            onPress={() => {
              undoAutoApplied(auto.id);
              changed();
            }}
          >
            <Text style={styles.action}>Undo</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              dismissAutoApplied(auto.id);
              reload();
            }}
          >
            <Text style={styles.dim}>OK</Text>
          </TouchableOpacity>
        </View>
      )}

      {cancel && (
        <View style={styles.banner}>
          <Text style={styles.text}>
            {rupees(cancel.income.amount)} from {who(cancel.income)} may cancel out your{' '}
            {rupees(cancel.expense.amount)} {displayMerchant(cancel.expense.merchant ?? null) ?? 'spend'}
          </Text>
          <TouchableOpacity
            onPress={() => {
              linkCancel(cancel.expense.id, cancel.income.id);
              changed();
            }}
          >
            <Text style={styles.action}>Link</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              dismissCancel(cancel.expense.id, cancel.income.id);
              reload();
            }}
          >
            <Text style={styles.dim}>Not this</Text>
          </TouchableOpacity>
        </View>
      )}

      {refund && (
        <View style={styles.banner}>
          <Text style={styles.text}>
            {rupees(refund.refund.amount)} credit may be a refund of your{' '}
            {displayMerchant(refund.parent.merchant ?? null) ?? 'payment'}
          </Text>
          <TouchableOpacity
            onPress={() => {
              linkRefund(refund.parent.id, refund.refund.id);
              changed();
            }}
          >
            <Text style={styles.action}>Link</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              dismissRefund(refund.parent.id, refund.refund.id);
              reload();
            }}
          >
            <Text style={styles.dim}>Not this</Text>
          </TouchableOpacity>
        </View>
      )}

      {suggestion && (
        <View style={styles.banner}>
          <Text style={styles.text}>
            Looks like a transfer between your accounts: {rupees(suggestion.expense.amount)}{' '}
            {legLabel(suggestion.expense)} → {legLabel(suggestion.income)}
          </Text>
          <TouchableOpacity
            onPress={() => {
              linkTransfer(suggestion.expense.id, suggestion.income.id);
              changed();
            }}
          >
            <Text style={styles.action}>Link</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              dismissTransferSuggestion(suggestion.expense.id, suggestion.income.id);
              reload();
            }}
          >
            <Text style={styles.dim}>Not this</Text>
          </TouchableOpacity>
        </View>
      )}

      {repay && (
        <View style={styles.banner}>
          <Text style={styles.text}>
            {rupees(repay.candidate.amount)} {repay.candidate.type === 'income' ? 'from' : 'to'}{' '}
            {who(repay.candidate)} may {repay.parent.type === 'expense' ? 'repay' : 'return'} your{' '}
            {rupees(repay.parent.amount)} {repay.parent.type === 'expense' ? 'to' : 'from'}{' '}
            {who(repay.parent)} ({repay.reason})
          </Text>
          <TouchableOpacity
            onPress={() => {
              setSettlement(repay.candidate.id, repay.parent.id);
              changed();
            }}
          >
            <Text style={styles.action}>Link</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              dismissRepaymentBanner(repay.parent.id, repay.candidate.id);
              reload();
            }}
          >
            <Text style={styles.dim}>Not this</Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.accent + '18',
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  autoBanner: {
    backgroundColor: theme.colors.success + '18',
    borderLeftColor: theme.colors.success,
  },
  text: {
    color: theme.colors.textSecondary,
    fontSize: theme.font.size.sm,
    flex: 1,
  },
  action: {
    color: theme.colors.accent,
    fontWeight: theme.font.weight.bold,
    fontSize: theme.font.size.sm,
  },
  dim: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
});
