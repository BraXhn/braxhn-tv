// BraXhn TV för Expo Go: samma server och API som de andra apparna, och webbappens utseende.
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { C } from './src/theme';
import { api, currentServer, loadServers, selectServer, servers, setUnauthorizedHandler, signOut, type Server } from './src/api';
import type { Stack as StackParams } from './src/nav';
import Login from './src/screens/Login';
import Servers from './src/screens/Servers';
import Main from './src/screens/Main';
import LibraryScreen from './src/screens/Library';
import ItemScreen from './src/screens/Item';
import PlayerScreen from './src/screens/Player';
import { Loading } from './src/components/ui';

const Stack = createNativeStackNavigator<StackParams>();
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.chrome, text: C.text, border: C.line, primary: C.accent } };

export default function App() {
  // add = Lägg till server (eller logga in igen på en sparad), pick = välj bland flera, in = inne i en server
  const [state, setState] = useState<'loading' | 'add' | 'pick' | 'in'>('loading');
  const [user, setUser] = useState<{ name: string } | null>(null);
  const [again, setAgain] = useState<Server | null>(null);
  const [, redraw] = useState(0);

  /** Öppnar den valda servern: kontrollerar inloggningen och hämtar vem som är inloggad */
  const enter = useCallback(async () => {
    try {
      const s = await api<{ user: { name: string } | null }>('/api/status');
      if (!s.user) { await signOut(); setAgain(currentServer()); setState('add'); return; }
      setUser(s.user); setAgain(null); setState('in');
    } catch (e: any) {
      // Servern nås inte just nu: gå in ändå (startsidan visar felet och Försök igen). 401 sköts av hanteraren nedan.
      if (e?.status !== 401) { setUser({ name: currentServer()?.user || '' }); setState('in'); }
    }
  }, []);
  const open = useCallback(async (sv: Server) => {
    setState('loading');
    if (await selectServer(sv.id)) await enter();
    else { setAgain(sv); setState('add'); } // ingen sparad inloggning: lösenordet behövs igen
  }, [enter]);
  /** Vid start och efter att en server tagits bort: ingen → lägg till, en → öppna den, flera → välj */
  const start = useCallback(async () => {
    const only = await loadServers();
    if (only) return open(only);
    setAgain(null); setState(servers.length ? 'pick' : 'add');
  }, [open]);
  const logout = useCallback(async () => {
    api('/api/logout', { method: 'POST' }).catch(() => {});
    const sv = currentServer();
    await signOut(); setUser(null);
    if (servers.length > 1) setState('pick'); else { setAgain(sv); setState('add'); }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { const sv = currentServer(); signOut(); setUser(null); setAgain(sv); setState('add'); });
    start();
    return () => setUnauthorizedHandler(null);
  }, [start]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {state === 'loading' ? <Loading />
          : state === 'add' ? <Login key={again?.id || 'ny'} again={again} onDone={enter} onCancel={servers.length > (again ? 1 : 0) ? () => { setAgain(null); setState('pick'); } : undefined} />
          : state === 'pick' ? <Servers onPick={open} onAdd={() => { setAgain(null); setState('add'); }} onChanged={() => (servers.length ? redraw((n) => n + 1) : setState('add'))} />
          : (
          <NavigationContainer theme={theme}>
            <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'slide_from_right' }}>
              <Stack.Screen name="Main">{(p) => <Main {...p} user={user} onLogout={logout} onSwitch={() => setState('pick')} onAdd={() => { setAgain(null); setState('add'); }} />}</Stack.Screen>
              <Stack.Screen name="Library" component={LibraryScreen} />
              <Stack.Screen name="Item" component={ItemScreen} />
              <Stack.Screen name="Player" component={PlayerScreen} options={{ animation: 'fade', orientation: 'all', gestureEnabled: false }} />
            </Stack.Navigator>
          </NavigationContainer>
        )}
      </View>
    </SafeAreaProvider>
  );
}
