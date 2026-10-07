import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { NavigationContainer, DarkTheme, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';

import { AuthProvider, useAuth } from './src/store/auth';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { theme } from './src/theme';
import type { RootStackParamList, TabsParamList } from './src/navigation/types';

import PairScreen from './src/screens/PairScreen';
import BrainScreen from './src/screens/BrainScreen';
import SnippetDetailScreen from './src/screens/SnippetDetailScreen';
import DivesScreen from './src/screens/DivesScreen';
import DiveChatScreen from './src/screens/DiveChatScreen';
import BuildScreen from './src/screens/BuildScreen';
import NewAgentScreen from './src/screens/NewAgentScreen';
import NewSkillScreen from './src/screens/NewSkillScreen';
import HomeScreen from './src/screens/HomeScreen';
import CaptureScreen from './src/screens/CaptureScreen';
import QuickActionScreen from './src/screens/QuickActionScreen';
import MoreScreen from './src/screens/MoreScreen';
import { TabIcon } from './src/components/TabIcon';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabsParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.surface,
    border: theme.border,
    primary: theme.accent,
    text: theme.text,
  },
};

const screenHeader = {
  headerStyle: { backgroundColor: theme.surface },
  headerTintColor: theme.text,
  headerTitleStyle: { fontWeight: '700' as const },
  contentStyle: { backgroundColor: theme.bg },
};

function Tabs() {
  // Edge-to-edge Android draws under the system navigation bar; pad the tab
  // bar by that inset instead of a fixed height so its buttons stay tappable.
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...screenHeader,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border, height: 56 + insets.bottom, paddingBottom: insets.bottom + 4, paddingTop: 6 },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textFaint,
        tabBarIcon: ({ color }) => <TabIcon route={route.name} color={color} />,
      })}
    >
      {/* Landing tab: Howie / Ask Second Brain chat under a collapsible 3D brain. */}
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Home', headerShown: false }} />
      <Tab.Screen name="Brain" component={BrainScreen} options={{ title: 'Second Brain', headerShown: false }} />
      <Tab.Screen name="Dives" component={DivesScreen} options={{ title: 'DeepDives' }} />
      <Tab.Screen name="Build" component={BuildScreen} options={{ title: 'Build' }} />
      <Tab.Screen name="More" component={MoreScreen} options={{ title: 'More' }} />
    </Tab.Navigator>
  );
}

// An image shared to AIOS from Android's share sheet opens Capture, which OCRs
// it and saves it straight to Second Brain.
function ShareIntentRouter() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  React.useEffect(() => {
    if (!hasShareIntent) return;
    const file = shareIntent.files?.find((f) => (f.mimeType || '').startsWith('image/'));
    if (file) nav.navigate('Capture', { imageUri: file.path, mimeType: file.mimeType });
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent, nav]);
  return null;
}

function Root() {
  const { creds, ready } = useAuth();

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} />
        <Text style={{ color: theme.textFaint, marginTop: 12 }}>AIOS</Text>
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={screenHeader}>
        {!creds ? (
          <Stack.Screen name="Pair" component={PairScreen} options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen name="Tabs" options={{ headerShown: false }}>
              {() => <><ShareIntentRouter /><Tabs /></>}
            </Stack.Screen>
            <Stack.Screen name="SnippetDetail" component={SnippetDetailScreen} options={{ title: 'Neuron' }} />
            <Stack.Screen name="DiveChat" component={DiveChatScreen} options={{ title: 'DeepDive' }} />
            <Stack.Screen name="NewAgent" component={NewAgentScreen} options={{ title: 'New Agent' }} />
            <Stack.Screen name="NewSkill" component={NewSkillScreen} options={{ title: 'New Skill' }} />
            <Stack.Screen name="Capture" component={CaptureScreen} options={{ title: 'Capture → OCR' }} />
            <Stack.Screen name="QuickAction" component={QuickActionScreen} options={{ title: 'Quick Action' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ShareIntentProvider>
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ErrorBoundary>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
    </ShareIntentProvider>
  );
}
