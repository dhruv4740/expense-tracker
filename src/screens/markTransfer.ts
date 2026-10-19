// One-tap "mark as transfer to self", shared by the Edit screen and the
// Transactions long-press menu. If the row has an obvious opposite leg
// (equal amount within 15 min) it offers to mark that one too.

import { Alert, DeviceEventEmitter } from 'react-native';

import type { TransactionRow } from '../db';
import { DATA_CHANGED } from '../sync';
import { findOppositeLeg, markAsSelf } from '../transferSync';

function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function promptMarkTransfer(row: TransactionRow, onDone?: () => void): void {
  if (row.id == null) {
    return;
  }
  const id = row.id;
  const finish = (ids: number[]) => {
    markAsSelf(ids);
    DeviceEventEmitter.emit(DATA_CHANGED);
    onDone?.();
  };
  const leg = findOppositeLeg(row);
  if (!leg || leg.id == null) {
    finish([id]);
    return;
  }
  const legId = leg.id;
  Alert.alert(
    'Mark as transfer to self',
    `Also mark the matching ${rupees(leg.amount)} ${leg.type === 'income' ? 'credit' : 'debit'}` +
      `${leg.source ? ` (${leg.source})` : ''}?`,
    [
      { text: 'Both', onPress: () => finish([id, legId]) },
      { text: 'Only this one', onPress: () => finish([id]) },
      { text: 'Cancel', style: 'cancel' },
    ],
  );
}
