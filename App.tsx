/**
 * ExpenseTracker — App entry point
 *
 * Architecture note (RULES.md §1):
 *   initDb() is called at module load (synchronous, before any component
 *   renders) so that getAll() / getSummary() are safe to call from
 *   useFocusEffect inside the tab screens.  The useEffect call below is a
 *   belt-and-suspenders guard in case the module is ever re-initialised, but
 *   the critical guarantee is the top-level call.
 */

import React, { useEffect } from 'react';
import { Alert, AppState, PermissionsAndroid, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { enableScreens } from 'react-native-screens';

import { initDb } from './src/db';
import { runCleanupIfNeeded } from './src/maintenance';
import { syncBuffer, subscribeLiveEvents } from './src/sync';
import {
  isNotificationAccessGranted,
  openNotificationAccessSettings,
} from './src/native/NotificationModule';
import { navTheme, theme } from './src/theme';
import { Icon } from './src/components';
import type { TransactionRow } from './src/db';

import DashboardScreen from './src/screens/DashboardScreen';
import TransactionsScreen from './src/screens/TransactionsScreen';
import InsightsScreen from './src/screens/InsightsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import EditTransactionScreen from './src/screens/EditTransactionScreen';
import ReviewScreen from './src/screens/ReviewScreen';
import MerchantRulesScreen from './src/screens/MerchantRulesScreen';

// Enable native screen containers for React Navigation (reduces overdraw and
// improves gesture performance on Android).
enableScreens();

// ── DB init: call synchronously at module load so screens can query safely ──
initDb();
runCleanupIfNeeded();

// ── Navigation types ─────────────────────────────────────────────────────────

export type RootStackParamList = {
  Tabs: undefined;
  EditTransaction: { tx?: TransactionRow };
  Review: undefined;
  MerchantRules: undefined;
};

type RootTabParamList = {
  Dashboard: undefined;
  Transactions: undefined;
  Insights: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<RootTabParamList>();

// ── Tab navigator ─────────────────────────────────────────────────────────────

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTitleStyle: {
          fontWeight: theme.font.weight.semibold,
          color: theme.colors.textPrimary,
        },
        headerTintColor: theme.colors.textPrimary,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.bg,
          borderTopColor: theme.colors.border,
        },
        tabBarShowLabel: true,
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          title: 'Dashboard',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Icon name="home" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Transactions"
        component={TransactionsScreen}
        options={{
          title: 'Transactions',
          tabBarLabel: 'Transactions',
          tabBarIcon: ({ color, size }) => (
            <Icon name="list" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Insights"
        component={InsightsScreen}
        options={{
          title: 'Insights',
          tabBarLabel: 'Insights',
          tabBarIcon: ({ color, size }) => (
            <Icon name="stats" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Icon name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // Belt-and-suspenders: ensure DB is ready even if module-level call is
  // skipped in a test environment or module caching edge case.
  useEffect(() => {
    initDb();
    runCleanupIfNeeded();
  }, []);

  // One-time permission setup: SMS is a runtime (dangerous) permission, and
  // Notification Access must be granted manually in Settings.
  useEffect(() => {
    (async () => {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
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
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.bg },
          }}
        >
          <Stack.Screen name="Tabs" component={TabNavigator} />
          <Stack.Screen
            name="EditTransaction"
            component={EditTransactionScreen}
            options={({ route }) => ({
              headerShown: true,
              title: route.params?.tx != null ? 'Edit Transaction' : 'Add Transaction',
              presentation: 'modal',
              headerStyle: { backgroundColor: theme.colors.bg },
              headerTitleStyle: {
                color: theme.colors.textPrimary,
                fontWeight: theme.font.weight.semibold,
              },
              headerTintColor: theme.colors.accent,
            })}
          />
          <Stack.Screen
            name="Review"
            component={ReviewScreen}
            options={{
              headerShown: true,
              title: 'Categorize Transactions',
              presentation: 'modal',
              headerStyle: { backgroundColor: theme.colors.bg },
              headerTitleStyle: {
                color: theme.colors.textPrimary,
                fontWeight: theme.font.weight.semibold,
              },
              headerTintColor: theme.colors.accent,
            }}
          />
          <Stack.Screen
            name="MerchantRules"
            component={MerchantRulesScreen}
            options={{
              headerShown: true,
              title: 'Learned Rules',
              headerStyle: { backgroundColor: theme.colors.bg },
              headerTitleStyle: {
                color: theme.colors.textPrimary,
                fontWeight: theme.font.weight.semibold,
              },
              headerTintColor: theme.colors.accent,
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
