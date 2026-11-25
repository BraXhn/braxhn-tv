// Skalet som i webbappen på en telefon: menyrad med logga och sök överst, flikarna Hem · Sök · Musik · Min lista · Konto
// nederst och minispelaren ovanför flikarna när något spelas.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { C, R } from '../theme';
import { api, ensureImageToken, servers, session, type HomeResponse, type Library, type MediaItem, type UserInfo } from '../api';
import { profileColor } from './Profiles';
import { Button, Card, Empty, ErrorState, Loading, Shelf } from '../components/ui';
import type { Props, Tab } from '../nav';
import { Listen } from './Music';
import { MiniPlayer } from '../components/audio';

const LIB_ICON: Record<string, keyof typeof Ionicons.glyphMap> = { movie: 'film-outline', show: 'tv-outline', music: 'musical-notes-outline', audiobook: 'book-outline', photo: 'images-outline', ebook: 'library-outline' };
const VIDEO = (l: Library) => l.type === 'movie' || l.type === 'show';
const LISTEN = (l: Library) => l.type === 'music' || l.type === 'audiobook';

export default function Main({ navigation, route, onLogout, onSwitch, onProfiles, onAdd, user }: Props<'Main'> & { onLogout: () => void; onSwitch: () => void; onProfiles: () => void; onAdd: () => void; user: UserInfo | null }) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>(route.params?.tab || 'home');
  const [query, setQuery] = useState('');
  const searchRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [libs, setLibs] = useState<Library[]>([]);
  const open = useCallback((it: MediaItem) => navigation.push('Item', { id: it.kind === 'episode' && it.show ? it.show : it.id }), [navigation]);

  useEffect(() => { api<Library[]>('/api/libraries').then((l) => setLibs(l.filter((x) => VIDEO(x) || LISTEN(x)))).catch(() => {}); }, []);
  const goSearch = () => { setTab('search'); setTimeout(() => searchRef.current?.focus(), 50); };

  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <View style={st.top}>
        <Pressable onPress={() => setTab('home')} accessibilityLabel="Hem" hitSlop={6}><Image source={require('../../assets/logo.png')} style={st.logo} /></Pressable>
        <View style={st.search}>
          <Ionicons name="search" size={17} color={C.dim} />
          <TextInput ref={searchRef} style={st.searchInput} value={query} onChangeText={(v) => { setQuery(v); if (tab !== 'search') setTab('search'); }} onFocus={() => setTab('search')}
            placeholder="Sök" placeholderTextColor={C.dim} returnKeyType="search" autoCorrect={false} autoCapitalize="none" accessibilityLabel="Sök" />
          {query ? <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Rensa sökningen"><Ionicons name="close-circle" size={17} color={C.dim} /></Pressable> : null}
        </View>
        <Pressable onPress={() => setTab('account')} style={[st.avatar, user?.name ? { backgroundColor: profileColor(user) } : null]} accessibilityLabel="Konto"><Text style={[st.avatarText, user?.name ? { color: '#fff' } : null]}>{(user?.name || '?').slice(0, 1).toUpperCase()}</Text></Pressable>
      </View>

      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {tab === 'home' ? <Home kid={!!user?.kid} libs={libs} open={open} openLib={(l) => (LISTEN(l) ? setTab('music') : navigation.push('Library', { id: l.id, name: l.name }))} /> : null}
        {tab === 'search' ? <Search query={query} open={open} /> : null}
        {tab === 'music' ? <Listen /> : null}
        {tab === 'list' ? <Watchlist open={open} /> : null}
        {tab === 'account' ? <Account user={user} onLogout={onLogout} onSwitch={onSwitch} onProfiles={onProfiles} onAdd={onAdd} /> : null}
      </View>

      <MiniPlayer />
      <View style={[st.tabs, { paddingBottom: Math.max(insets.bottom, 6) }]}>
        {([['home', 'home', 'Hem'], ['search', 'search', 'Sök'], ['music', 'musical-notes', 'Musik'], ['list', 'bookmark', 'Min lista'], ['account', 'person', 'Konto']] as const).map(([k, icon, label]) => (
          <Pressable key={k} style={st.tab} onPress={() => (k === 'search' ? goSearch() : setTab(k))} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} accessibilityLabel={label}>
            <Ionicons name={icon} size={23} color={tab === k ? C.accent : C.dim} />
            <Text style={[st.tabText, tab === k && { color: C.accent }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Home({ kid, libs, open, openLib }: { kid: boolean; libs: Library[]; open: (it: MediaItem) => void; openLib: (l: Library) => void }) {
  const [data, setData] = useState<HomeResponse | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try { await ensureImageToken(); setData(await api<HomeResponse>('/api/home')); setError(''); }
    catch (e: any) { setError(e?.message || 'Kunde inte hämta startsidan'); }
  }, []);
  // Hämtas på nytt när man kommer tillbaka från spelaren, så att Fortsätt titta stämmer
  useFocusEffect(useCallback(() => { load(); }, [load]));
  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <Loading />;
  const empty = !data.continue.length && !data.rows.some((r) => r.items.length) && !data.watchlist.length;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 28 }} refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips}>
        <View style={[st.chip, st.chipOn]}><Ionicons name="home" size={16} color={C.accent} /><Text style={[st.chipText, { color: C.accent }]}>Hem</Text></View>
        {libs.map((l) => (
          <Pressable key={l.id} style={st.chip} onPress={() => openLib(l)} accessibilityRole="button" accessibilityLabel={l.name}>
            <Ionicons name={LIB_ICON[l.type] || 'folder-outline'} size={16} color={C.dim} /><Text style={st.chipText}>{l.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {empty ? <View style={{ padding: 24 }}><Text style={st.dim}>{libs.some(LISTEN) && !libs.some(VIDEO) ? 'Musik och ljudböcker finns under fliken Musik.' : kid ? 'Här finns inget som den här profilen får se än.' : 'Biblioteket är tomt än. Lägg till bibliotek i webbgränssnittet under Administration.'}</Text></View> : null}
      <Shelf title="Fortsätt titta" items={data.continue} onOpen={open} />
      <Shelf title="Min lista" items={data.watchlist} onOpen={open} />
      {data.rows.map((r, i) => (
        <Shelf key={i} title={r.library ? `Nyligen tillagda i ${r.library.name}` : r.title} items={r.items} onOpen={open}
          action={r.library ? { label: 'Visa alla', onPress: () => openLib(r.library!) } : undefined} />
      ))}
      <Shelf title="Rekommenderat" items={data.recommended || []} onOpen={open} />
    </ScrollView>
  );
}

function Grid({ items, open }: { items: MediaItem[]; open: (it: MediaItem) => void }) {
  const [w, setW] = useState(0);
  const cols = Math.max(3, Math.floor((w - 14) / (110 + 14)));
  const cw = w ? Math.floor((w - 14 * (cols + 1)) / cols) : 0;
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {cw > 0 ? <FlatList key={cols} data={items} numColumns={cols} keyExtractor={(x) => String(x.id)} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 14, gap: 20 }} columnWrapperStyle={{ gap: 14 }}
        renderItem={({ item }) => <Card it={item} width={cw} onPress={() => open(item)} />} /> : null}
    </View>
  );
}
export { Grid };

function Search({ query, open }: { query: string; open: (it: MediaItem) => void }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setItems(null); setError(''); return; }
    let live = true;
    // Vänta tills man slutat skriva en kvarts sekund
    const t = setTimeout(async () => {
      try { await ensureImageToken(); const r = await api<MediaItem[]>('/api/search?q=' + encodeURIComponent(q)); if (live) { setItems(r); setError(''); } }
      catch (e: any) { if (live) setError(e?.message || 'Sökningen misslyckades'); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  if (error) return <ErrorState error={error} />;
  if (query.trim().length < 2) return <Empty text="Sök efter filmer och serier i biblioteket." />;
  if (!items) return <Loading />;
  if (!items.length) return <Empty text={`Inga träffar på "${query.trim()}".`} />;
  return <Grid items={items} open={open} />;
}

function Watchlist({ open }: { open: (it: MediaItem) => void }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { await ensureImageToken(); setItems(await api<MediaItem[]>('/api/watchlist')); setError(''); }
    catch (e: any) { setError(e?.message || 'Kunde inte hämta listan'); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  if (error && !items) return <ErrorState error={error} onRetry={load} />;
  if (!items) return <Loading />;
  if (!items.length) return <Empty text="Min lista är tom. Lägg till titlar med + Min lista på titelsidan." />;
  return <Grid items={items} open={open} />;
}

function Account({ user, onLogout, onSwitch, onProfiles, onAdd }: { user: UserInfo | null; onLogout: () => void; onSwitch: () => void; onProfiles: () => void; onAdd: () => void }) {
  const [version, setVersion] = useState('');
  useEffect(() => { api<{ version?: string }>('/api/status').then((s) => setVersion(s.version || '')).catch(() => {}); }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 14 }}>
      <View style={st.panel}>
        <Text style={st.h2}>Mitt konto – {user?.name || ''}</Text>
        <Text style={st.dim2}>Server: {session.server}{version ? `\nBraXhn TV ${version}` : ''}</Text>
        {user?.kid ? <Text style={st.dim2}>Det här är en barnprofil: du ser bara det som profilen får se.</Text> : null}
        <Text style={st.dim2}>Lösenord, tvåstegsverifiering, profiler och övriga inställningar ändrar du i webbgränssnittet.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
          {(user?.profiles || 0) > 1 ? <Button label="Byt profil" icon="people-outline" onPress={onProfiles} /> : null}
          <Button label="Logga ut" kind="danger" icon="log-out-outline" onPress={onLogout} />
        </View>
      </View>
      <View style={st.panel}>
        <Text style={st.h2}>Servrar</Text>
        <Text style={st.dim2}>{servers.length > 1 ? `${servers.length} servrar är sparade. Appen frågar vilken du vill öppna när den startar.` : 'Med en enda server öppnas den direkt när appen startar. Lägger du till fler får du välja vid start.'}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          {servers.length > 1 ? <Button label="Byt server" icon="swap-horizontal" onPress={onSwitch} /> : null}
          <Button label="Lägg till server" icon="add" onPress={onAdd} />
        </View>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome },
  top: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, backgroundColor: C.chrome, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,.4)' },
  logo: { width: 30, height: 30, borderRadius: 7 },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 36, borderRadius: R.pill, backgroundColor: C.bg3, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: C.text, fontSize: 15, paddingVertical: 0 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: C.onAccent, fontWeight: '800', fontSize: 14 },
  chips: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.bg2 },
  chipOn: { backgroundColor: C.bg3 },
  chipText: { color: C.dim, fontSize: 14, fontWeight: '600' },
  tabs: { flexDirection: 'row', backgroundColor: C.chrome, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 3, minHeight: 44 },
  tabText: { color: C.dim, fontSize: 11.5 },
  panel: { backgroundColor: C.bg2, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, padding: 16, gap: 8 },
  h2: { color: C.text, fontSize: 18, fontWeight: '700' },
  dim: { color: C.dim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  dim2: { color: C.dim, fontSize: 14, lineHeight: 20 },
});
