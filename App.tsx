/**
 * ExpenseTracker — App entry point
 *
 * Architecture note (RULES.md §1):
 *   initDb() is called at module load (synchronous, before any component
 *   renders) so that getAll() / getMonthlySummary() are safe to call from
 *   useFocusEffect inside the tab screens.  The useEffect call below is a
 *   belt-and-suspenders guard in case the module is ever re-initialised, but
 *   the critical guarantee is the top-level call.
 */

import React, { useEffect } from 'react';
import { Alert, AppState, PermissionsAndroid, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { enableScreens } from 'react-native-screens';

import { initDb } from './src/db';
import { syncBuffer, subscribeLiveEvents } from './src/sync';
import {
  isNotificationAccessGranted,
  openNotificationAccessSettings,
} from './src/native/NotificationModule';
import TransactionsScreen from './src/screens/TransactionsScreen';
import SummaryScreen from './src/screens/SummaryScreen';

// Enable native screen containers for React Navigation (reduces overdraw and
// improves gesture performance on Android).
enableScreens();

// ── DB init: call synchronously at module load so screens can query safely ──
initDb();

// ── Navigation types ─────────────────────────────────────────────────────────

type RootTabParamList = {
  Transactions: undefined;
  Summary: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // Belt-and-suspenders: ensure DB is ready even if module-level call is
  // skipped in a test environment or module caching edge case.
  useEffect(() => {
    initDb();
  }, []);

  // One-time permission setup: SMS is a runtime (dangerous) permission, and
  // Notification Access must be granted manually in Settings.
  useEffect(() => {
    (async () => {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
          PermissionsAndroid.PERMISSIONS.READ_SMS,
        ]);
      } catch {
        // user denied — app still works for notifications / manual entry
      }
      try {
        const granted = await isNotificationAccessGranted();
        if (!granted) {
          Alert.alert(
            'Enable Notification Access',
            'To capture UPI/bank app notifications, grant Notification Access to ExpenseTracker.',
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Open Settings', onPress: openNotificationAccessSettings },
            ],
          );
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // Event sync: drain anything captured while closed, listen live while open,
  // and re-drain whenever the app returns to the foreground. (RULES.md §1)
  useEffect(() => {
    syncBuffer();
    const unsub = subscribeLiveEvents();
    const appSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        syncBuffer();
      }
    });
    return () => {
      unsub();
      appSub.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: true,
            headerStyle: { backgroundColor: '#FFFFFF' },
            headerTitleStyle: { fontWeight: '600', color: '#1A1A1A' },
            tabBarActiveTintColor: '#C62828',
            tabBarInactiveTintColor: '#9E9E9E',
            tabBarStyle: { backgroundColor: '#FFFFFF', borderTopColor: '#E0E0E0' },
          }}
        >
          <Tab.Screen
            name="Transactions"
            component={TransactionsScreen}
            options={{ title: 'Transactions', tabBarLabel: 'Transactions' }}
          />
          <Tab.Screen
            name="Summary"
            component={SummaryScreen}
            options={{ title: 'Summary', tabBarLabel: 'Summary' }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
