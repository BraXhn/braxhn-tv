// BraXhn TV för Expo Go: samma server och API som de andra apparna, och webbappens utseende.
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { C } from './src/theme';
import { api, currentServer, listProfiles, loadServers, rememberProfile, selectServer, servers, setProfile, setUnauthorizedHandler, signOut, goHomeIfHere, type Server, type UserInfo } from './src/api';
import type { Stack as StackParams } from './src/nav';
import Login from './src/screens/Login';
import Servers from './src/screens/Servers';
import Profiles from './src/screens/Profiles';
import Main from './src/screens/Main';
import LibraryScreen from './src/screens/Library';
import ItemScreen from './src/screens/Item';
import PlayerScreen from './src/screens/Player';
import { Loading } from './src/components/ui';
import { AlbumScreen, ArtistScreen, PlaylistScreen } from './src/screens/Music';
import { BookScreen, PodcastScreen } from './src/screens/Books';
import NowPlaying from './src/screens/NowPlaying';
import { reset as resetAudio, restoreQueue } from './src/music';

const Stack = createNativeStackNavigator<StackParams>();
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.chrome, text: C.text, border: C.line, primary: C.accent } };

export default function App() {
  // add = Lägg till server (eller logga in igen på en sparad), pick = välj bland flera, profiles = Vem tittar?,
  // in = inne i en server
  const [state, setState] = useState<'loading' | 'add' | 'pick' | 'profiles' | 'in'>('loading');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [again, setAgain] = useState<Server | null>(null);
  const [, redraw] = useState(0);

  /** Öppnar den valda servern: kontrollerar inloggningen och hämtar vem som är inloggad. Direkt efter inloggningen
   *  visas Vem tittar? när kontot har flera profiler (som webben). */
  const enter = useCallback(async (afterLogin = false) => {
    try {
      const s = await api<{ user: UserInfo | null }>('/api/status');
      if (!s.user) { await signOut(); setAgain(currentServer()); setState('add'); return; }
      // Hemma via den publika adressen: provas i bakgrunden (startsidan väntar inte) – svarar hemadressen går allt
      // efter det direkt dit, strömmar och bilder också
      goHomeIfHere().catch(() => {});
      await setProfile(s.user.id); rememberProfile(s.user.name);
      // Profilens färg (till rutan uppe till höger) står bara i profillistan
      if ((s.user.profiles || 0) > 1) await listProfiles().then((l) => { s.user!.color = l.profiles.find((p) => p.id === s.user!.id)?.color; }).catch(() => {});
      setUser(s.user); setAgain(null); setState(afterLogin && (s.user.profiles || 0) > 1 ? 'profiles' : 'in');
      // Musikkön från förra gången (eller från webben) visas pausad i minispelaren
      restoreQueue();
    } catch (e: any) {
      // Servern nås inte just nu: gå in ändå (startsidan visar felet och Försök igen). 401 sköts av hanteraren nedan.
      if (e?.status !== 401) { const sv = currentServer(); setUser({ id: 0, name: sv?.profile || sv?.user || '' }); setState('in'); }
    }
  }, []);
  const open = useCallback(async (sv: Server) => {
    setState('loading');
    if (await selectServer(sv.id)) await enter(false);
    else { setAgain(sv); setState('add'); } // ingen sparad inloggning: lösenordet behövs igen
  }, [enter]);
  /** Vid start och efter att en server tagits bort: ingen → lägg till, en → öppna den, flera → välj */
  const start = useCallback(async () => {
    const only = await loadServers();
    if (only) return open(only);
    setAgain(null); setState(servers.length ? 'pick' : 'add');
  }, [open]);
  const logout = useCallback(async () => {
    await resetAudio(); // spara kön eller bokens plats med den gamla inloggningen, stoppa och töm
    api('/api/logout', { method: 'POST' }).catch(() => {});
    const sv = currentServer();
    await signOut(); setUser(null);
    if (servers.length > 1) setState('pick'); else { setAgain(sv); setState('add'); }
  }, []);

  /** Efter Vem tittar?: ny profil → läs dess uppgifter (barnprofil m.m. står bara i /api/status), annars tillbaka */
  const afterProfile = useCallback(async (u: UserInfo | null) => {
    if (!u) { setState('in'); return; }
    resetAudio(false); // Profiles sparade före bytet; den nya profilen får sin egen kö
    setUser(u); setState('loading');
    await enter(false);
  }, [enter]);

  useEffect(() => {
    setUnauthorizedHandler(() => { const sv = currentServer(); resetAudio(); signOut(); setUser(null); setAgain(sv); setState('add'); });
    start();
    return () => setUnauthorizedHandler(null);
  }, [start]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {state === 'loading' ? <Loading />
          : state === 'add' ? <Login key={again?.id || 'ny'} again={again} onDone={() => enter(true)} onCancel={servers.length > (again ? 1 : 0) ? () => { setAgain(null); setState('pick'); } : undefined} />
          : state === 'profiles' ? <Profiles current={user?.name || ''} onDone={afterProfile} />
          : state === 'pick' ? <Servers onPick={open} onAdd={() => { setAgain(null); setState('add'); }} onChanged={() => (servers.length ? redraw((n) => n + 1) : setState('add'))} />
          : (
          <NavigationContainer theme={theme} key={user?.id || 0 /* ny profil: börja om på startsidan */}>
            <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'slide_from_right' }}>
              <Stack.Screen name="Main">{(p) => <Main {...p} user={user} onLogout={logout} onSwitch={() => { resetAudio(); setState('pick'); }} onProfiles={() => setState('profiles')} onAdd={() => { setAgain(null); setState('add'); }} />}</Stack.Screen>
              <Stack.Screen name="Library" component={LibraryScreen} />
              <Stack.Screen name="Item" component={ItemScreen} />
              <Stack.Screen name="Player" component={PlayerScreen} options={{ animation: 'fade', orientation: 'all', gestureEnabled: false }} />
              <Stack.Screen name="Album" component={AlbumScreen} />
              <Stack.Screen name="Artist" component={ArtistScreen} />
              <Stack.Screen name="Playlist" component={PlaylistScreen} />
              <Stack.Screen name="Book" component={BookScreen} />
              <Stack.Screen name="Podcast" component={PodcastScreen} />
              <Stack.Screen name="NowPlaying" component={NowPlaying} options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal' }} />
            </Stack.Navigator>
          </NavigationContainer>
        )}
      </View>
    </SafeAreaProvider>
  );
}
