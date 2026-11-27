// BraXhn TV för Expo Go: samma server och API som de andra apparna, och webbappens utseende.
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { C } from './src/theme';
import { api, currentServer, listProfiles, loadPref, loadServers, rememberProfile, selectServer, servers, setProfile, setUnauthorizedHandler, signOut, goHomeIfHere, type Server, type UserInfo } from './src/api';
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
import DownloadsScreen from './src/screens/Downloads';
import * as off from './src/offline';
import { startView } from './src/offlinecore';
import { confirm } from './src/components/download';
import { FeedbackScreen, TicketsScreen } from './src/screens/Feedback';
import { noteRoute } from './src/feedback';
import { lang, onLangChange, setLangChoice, t, type LangChoice } from './src/i18n';

/** Skärmen som syns just nu (förvalet i Feedback följer den) */
const focused = (s: any): string => { const r = s?.routes?.[s.index ?? 0]; return r?.state ? focused(r.state) : r?.name || ''; };

const Stack = createNativeStackNavigator<StackParams>();
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.chrome, text: C.text, border: C.line, primary: C.accent } };

export default function App() {
  // add = Lägg till server (eller logga in igen på en sparad), pick = välj bland flera, profiles = Vem tittar?,
  // in = inne i en server
  const [state, setState] = useState<'loading' | 'add' | 'pick' | 'profiles' | 'in'>('loading');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [again, setAgain] = useState<Server | null>(null);
  // Servern svarade inte vid start och profilen har något nedladdat: appen öppnar Nedladdat
  const [offlineStart, setOfflineStart] = useState(false);
  const [, redraw] = useState(0);
  // Språket: valet under Konto (sparat i telefonen) läses före allt annat. Ett byte ritar om appen och öppnar Konto.
  const [langKey, setLangKey] = useState(lang);
  const [afterLang, setAfterLang] = useState(false);
  useEffect(() => onLangChange(() => { setLangKey(lang); setAfterLang(true); }), []);

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
      // Nedladdningarna för den här servern och profilen: kön fortsätter, positioner skickas, behörigheten kontrolleras
      const sv = currentServer();
      if (sv) { off.openScope(sv.id, s.user); off.online(s.user.canDownload).catch(() => {}); }
      setOfflineStart(false);
      // Profilens färg (till rutan uppe till höger) står bara i profillistan
      if ((s.user.profiles || 0) > 1) await listProfiles().then((l) => { s.user!.color = l.profiles.find((p) => p.id === s.user!.id)?.color; }).catch(() => {});
      setUser(s.user); setAgain(null); setState(afterLogin && (s.user.profiles || 0) > 1 ? 'profiles' : 'in');
      // Musikkön från förra gången (eller från webben) visas pausad i minispelaren
      restoreQueue();
    } catch (e: any) {
      // Servern nås inte just nu: gå in ändå (startsidan visar felet och Försök igen). 401 sköts av hanteraren nedan.
      // Har profilen som senast var inloggad något nedladdat öppnas Nedladdat direkt (fungerar utan nät).
      if (e?.status !== 401) {
        const sv = currentServer();
        const last = sv ? off.openLast(sv.id) : null;
        setUser({ id: last?.uid || 0, name: last?.name || sv?.profile || sv?.user || '', kid: last?.kid });
        setOfflineStart(startView({ reachable: false, downloads: off.count() }) === 'Downloads');
        setState('in');
      }
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
    const sv = currentServer();
    const go = async () => {
      await resetAudio(); // spara kön eller bokens plats med den gamla inloggningen, stoppa och töm
      await off.syncPending().catch(() => {}); // positioner som väntar skickas medan inloggningen gäller
      api('/api/logout', { method: 'POST' }).catch(() => {});
      if (sv) off.removeServer(sv.id); // nedladdningarna hör till inloggningen
      await signOut(); setUser(null);
      if (servers.length > 1) setState('pick'); else { setAgain(sv); setState('add'); }
    };
    // Nedladdat tas bort vid utloggning – fråga först
    if (sv && off.hasServerDownloads(sv.id)) confirm(t('Logga ut?'), t('Allt som laddats ner från den här servern tas bort från telefonen. Du kan ladda ner det igen när du loggat in.'), t('Logga ut och ta bort'), () => { go(); });
    else await go();
  }, []);

  /** Efter Vem tittar?: ny profil → läs dess uppgifter (barnprofil m.m. står bara i /api/status), annars tillbaka */
  const afterProfile = useCallback(async (u: UserInfo | null) => {
    if (!u) { setState('in'); return; }
    resetAudio(false); // Profiles sparade före bytet; den nya profilen får sin egen kö
    off.closeScope(); // den nya profilen har sina egna nedladdningar
    setUser(u); setState('loading'); setAfterLang(false); // ny profil börjar på startsidan
    await enter(false);
  }, [enter]);

  useEffect(() => {
    // Inloggningen gäller inte längre: nedladdningarna ligger kvar och syns igen när samma profil loggar in
    setUnauthorizedHandler(() => { const sv = currentServer(); resetAudio(); off.closeScope(); signOut(); setUser(null); setAgain(sv); setState('add'); });
    loadPref('bx.lang').then((v) => setLangChoice((v || '') as LangChoice)).catch(() => {}).then(() => { setAfterLang(false); start(); });
    return () => setUnauthorizedHandler(null);
  }, [start]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: C.bg }} key={langKey /* nytt språk: allt ritas om med de nya texterna */}>
        {state === 'loading' ? <Loading />
          : state === 'add' ? <Login key={again?.id || 'new'} again={again} onDone={() => enter(true)} onCancel={servers.length > (again ? 1 : 0) ? () => { setAgain(null); setState('pick'); } : undefined} />
          : state === 'profiles' ? <Profiles current={user?.name || ''} onDone={afterProfile} />
          : state === 'pick' ? <Servers onPick={open} onAdd={() => { setAgain(null); setState('add'); }} onChanged={() => (servers.length ? redraw((n) => n + 1) : setState('add'))} />
          : (
          <NavigationContainer theme={theme} onStateChange={(s) => noteRoute(focused(s))} key={`${user?.id || 0}${offlineStart ? '-off' : ''}` /* ny profil: börja om på startsidan */}>
            <Stack.Navigator initialRouteName={offlineStart ? 'Downloads' : 'Main'} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'slide_from_right' }}>
              <Stack.Screen name="Main" initialParams={afterLang ? { tab: 'account' } : undefined}>{(p) => <Main {...p} user={user} onLogout={logout} onSwitch={() => { resetAudio(); off.closeScope(); setState('pick'); }} onProfiles={() => setState('profiles')} onAdd={() => { setAgain(null); setState('add'); }} />}</Stack.Screen>
              <Stack.Screen name="Library" component={LibraryScreen} />
              <Stack.Screen name="Item" component={ItemScreen} />
              <Stack.Screen name="Player" component={PlayerScreen} options={{ animation: 'fade', orientation: 'all', gestureEnabled: false }} />
              <Stack.Screen name="Album" component={AlbumScreen} />
              <Stack.Screen name="Artist" component={ArtistScreen} />
              <Stack.Screen name="Playlist" component={PlaylistScreen} />
              <Stack.Screen name="Book" component={BookScreen} />
              <Stack.Screen name="Podcast" component={PodcastScreen} />
              <Stack.Screen name="Downloads">{(p) => <DownloadsScreen {...p} offline={offlineStart} onRetry={() => { setState('loading'); enter(false); }} />}</Stack.Screen>
              <Stack.Screen name="NowPlaying" component={NowPlaying} options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal' }} />
              <Stack.Screen name="Feedback" options={{ animation: 'slide_from_bottom' }}>{(p) => <FeedbackScreen {...p} user={user} />}</Stack.Screen>
              <Stack.Screen name="Tickets">{(p) => <TicketsScreen {...p} user={user} />}</Stack.Screen>
            </Stack.Navigator>
          </NavigationContainer>
        )}
      </View>
    </SafeAreaProvider>
  );
}
