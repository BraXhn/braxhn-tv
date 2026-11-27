// Skalet som i webbappen på en telefon: menyrad med logga och sök överst, flikarna Hem · Sök · Musik · Min lista · Konto
// nederst och minispelaren ovanför flikarna när något spelas.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { C, R } from '../theme';
import { api, ensureImageToken, savePref, servers, session, viaHome, type HomeResponse, type Library, type MediaItem, type UserInfo } from '../api';
import { langChoice, setLangChoice, t, tn, type LangChoice } from '../i18n';
import { profileColor } from './Profiles';
import { Button, Card, Empty, ErrorState, Loading, Shelf } from '../components/ui';
import type { Props, Tab } from '../nav';
import { Listen } from './Music';
import { MiniPlayer } from '../components/audio';
import * as off from '../offline';
import { fmtSize, usedBytes } from '../offlinecore';
import { needInfoCount, noteTab } from '../feedback';

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
  useEffect(() => { noteTab(tab); }, [tab]);
  const goSearch = () => { setTab('search'); setTimeout(() => searchRef.current?.focus(), 50); };

  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <View style={st.top}>
        <Pressable onPress={() => setTab('home')} accessibilityLabel={t('Hem')} hitSlop={6}><Image source={require('../../assets/logo.png')} style={st.logo} /></Pressable>
        <View style={st.search}>
          <Ionicons name="search" size={17} color={C.dim} />
          <TextInput ref={searchRef} style={st.searchInput} value={query} onChangeText={(v) => { setQuery(v); if (tab !== 'search') setTab('search'); }} onFocus={() => setTab('search')}
            placeholder={t('Sök')} placeholderTextColor={C.dim} returnKeyType="search" autoCorrect={false} autoCapitalize="none" accessibilityLabel={t('Sök')} />
          {query ? <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel={t('Rensa sökningen')}><Ionicons name="close-circle" size={17} color={C.dim} /></Pressable> : null}
        </View>
        <Pressable onPress={() => setTab('account')} style={[st.avatar, user?.name ? { backgroundColor: profileColor(user) } : null]} accessibilityLabel={t('Konto')}><Text style={[st.avatarText, user?.name ? { color: '#fff' } : null]}>{(user?.name || '?').slice(0, 1).toUpperCase()}</Text></Pressable>
      </View>

      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {tab === 'home' ? <Home kid={!!user?.kid} libs={libs} open={open} openLib={(l) => (LISTEN(l) ? setTab('music') : navigation.push('Library', { id: l.id, name: l.name }))} /> : null}
        {tab === 'search' ? <Search query={query} open={open} /> : null}
        {tab === 'music' ? <Listen /> : null}
        {tab === 'list' ? <Watchlist open={open} /> : null}
        {tab === 'account' ? <Account user={user} onLogout={onLogout} onSwitch={onSwitch} onProfiles={onProfiles} onAdd={onAdd} onDownloads={() => navigation.push('Downloads')} onFeedback={() => navigation.push('Feedback', {})} onTickets={() => navigation.push('Tickets')} /> : null}
      </View>

      <MiniPlayer />
      <View style={[st.tabs, { paddingBottom: Math.max(insets.bottom, 6) }]}>
        {([['home', 'home', t('Hem')], ['search', 'search', t('Sök')], ['music', 'musical-notes', t('Musik')], ['list', 'bookmark', t('Min lista')], ['account', 'person', t('Konto')]] as const).map(([k, icon, label]) => (
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
    catch (e: any) { setError(e?.message || t('Kunde inte hämta startsidan')); }
  }, []);
  // Hämtas på nytt när man kommer tillbaka från spelaren, så att Fortsätt titta stämmer
  useFocusEffect(useCallback(() => { load(); }, [load]));
  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <Loading />;
  const empty = !data.continue.length && !data.rows.some((r) => r.items.length) && !data.watchlist.length;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 28 }} refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips}>
        <View style={[st.chip, st.chipOn]}><Ionicons name="home" size={16} color={C.accent} /><Text style={[st.chipText, { color: C.accent }]}>{t('Hem')}</Text></View>
        {libs.map((l) => (
          <Pressable key={l.id} style={st.chip} onPress={() => openLib(l)} accessibilityRole="button" accessibilityLabel={l.name}>
            <Ionicons name={LIB_ICON[l.type] || 'folder-outline'} size={16} color={C.dim} /><Text style={st.chipText}>{l.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {empty ? <View style={{ padding: 24 }}><Text style={st.dim}>{libs.some(LISTEN) && !libs.some(VIDEO) ? t('Musik och ljudböcker finns under fliken Musik.') : kid ? t('Här finns inget som den här profilen får se än.') : t('Biblioteket är tomt än. Lägg till bibliotek i webbgränssnittet under Administration.')}</Text></View> : null}
      <Shelf title={t('Fortsätt titta')} items={data.continue} onOpen={open} />
      <Shelf title={t('Min lista')} items={data.watchlist} onOpen={open} />
      {data.rows.map((r, i) => (
        <Shelf key={i} title={r.library ? t('Nyligen tillagda i {name}', { name: r.library.name }) : r.title} items={r.items} onOpen={open}
          action={r.library ? { label: t('Visa alla'), onPress: () => openLib(r.library!) } : undefined} />
      ))}
      <Shelf title={t('Rekommenderat')} items={data.recommended || []} onOpen={open} />
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
    const timer = setTimeout(async () => {
      try { await ensureImageToken(); const r = await api<MediaItem[]>('/api/search?q=' + encodeURIComponent(q)); if (live) { setItems(r); setError(''); } }
      catch (e: any) { if (live) setError(e?.message || t('Sökningen misslyckades')); }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  if (error) return <ErrorState error={error} />;
  if (query.trim().length < 2) return <Empty text={t('Sök efter filmer och serier i biblioteket.')} />;
  if (!items) return <Loading />;
  if (!items.length) return <Empty text={t('Inga träffar på "{q}".', { q: query.trim() })} />;
  return <Grid items={items} open={open} />;
}

function Watchlist({ open }: { open: (it: MediaItem) => void }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { await ensureImageToken(); setItems(await api<MediaItem[]>('/api/watchlist')); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta listan')); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  if (error && !items) return <ErrorState error={error} onRetry={load} />;
  if (!items) return <Loading />;
  if (!items.length) return <Empty text={t('Min lista är tom. Lägg till titlar med + Min lista på titelsidan.')} />;
  return <Grid items={items} open={open} />;
}

function Account({ user, onLogout, onSwitch, onProfiles, onAdd, onDownloads, onFeedback, onTickets }: { user: UserInfo | null; onLogout: () => void; onSwitch: () => void; onProfiles: () => void; onAdd: () => void; onDownloads: () => void; onFeedback: () => void; onTickets: () => void }) {
  const [version, setVersion] = useState('');
  // Egna ärenden där teamet väntar på svar (hämtas igen när man kommer tillbaka till Konto)
  const [waiting, setWaiting] = useState(0);
  useFocusEffect(useCallback(() => { needInfoCount().then(setWaiting).catch(() => {}); }, []));
  const dl = off.useDownloads();
  useEffect(() => { api<{ version?: string }>('/api/status').then((s) => setVersion(s.version || '')).catch(() => {}); }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 14 }}>
      <View style={st.panel}>
        <Text style={st.h2}>{t('Mitt konto – {name}', { name: user?.name || '' })}</Text>
        <Text style={st.dim2}>{t('Server: {v}', { v: session.saved || session.server })}{viaHome() ? '\n' + t('Hemma: direkt via {v}', { v: session.server }) : ''}{version ? `\nBraXhn TV ${version}` : ''}</Text>
        {user?.kid ? <Text style={st.dim2}>{t('Det här är en barnprofil: du ser bara det som profilen får se.')}</Text> : null}
        <Text style={st.dim2}>{t('Lösenord, tvåstegsverifiering, profiler och övriga inställningar ändrar du i webbgränssnittet.')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
          {(user?.profiles || 0) > 1 ? <Button label={t('Byt profil')} icon="people-outline" onPress={onProfiles} /> : null}
          <Button label={t('Logga ut')} kind="danger" icon="log-out-outline" onPress={onLogout} />
        </View>
      </View>
      {off.supported ? (
        <View style={st.panel}>
          <Text style={st.h2}>{t('Nedladdat')}</Text>
          <Text style={st.dim2}>{dl.length ? tn(dl.length, '1 titel på telefonen ({size}) – spelas utan nät.', '{n} titlar på telefonen ({size}) – spelas utan nät.', { size: fmtSize(usedBytes(dl)) }) : off.mayDownload() ? t('Ladda ner filmer, avsnitt och ljudböcker på titelsidan för att se dem utan nät.') : t('Det här kontot får inte ladda ner. Det ändras i webbgränssnittet.')}</Text>
          <View style={{ flexDirection: 'row', marginTop: 6 }}><Button label={t('Visa Nedladdat')} icon="download-outline" onPress={onDownloads} /></View>
        </View>
      ) : null}
      <View style={st.panel}>
        <Text style={st.h2}>{t('Feedback')}</Text>
        <Text style={st.dim2}>{t('Har du en idé eller är det något som inte fungerar? Skicka feedback eller en felrapport.')} {user?.is_admin ? t('Du är administratör: den skickas direkt till utvecklarna.') : t('En administratör läser den först.')}</Text>
        {waiting ? <Text style={[st.dim2, { color: C.warn }]}>{tn(waiting, 'Teamet väntar på ditt svar i ett ärende.', 'Teamet väntar på ditt svar i {n} ärenden.')}</Text> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          <Button label={t('Skicka feedback')} icon="chatbox-ellipses-outline" onPress={onFeedback} />
          <Button label={waiting ? t('Mina ärenden ({n})', { n: waiting }) : t('Mina ärenden')} icon="chatbubbles-outline" onPress={onTickets} />
        </View>
      </View>
      <View style={st.panel}>
        <Text style={st.h2}>{t('Servrar')}</Text>
        <Text style={st.dim2}>{servers.length > 1 ? t('{n} servrar är sparade. Appen frågar vilken du vill öppna när den startar.', { n: servers.length }) : t('Med en enda server öppnas den direkt när appen startar. Lägger du till fler får du välja vid start.')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          {servers.length > 1 ? <Button label={t('Byt server')} icon="swap-horizontal" onPress={onSwitch} /> : null}
          <Button label={t('Lägg till server')} icon="add" onPress={onAdd} />
        </View>
      </View>
      <LanguagePanel />
    </ScrollView>
  );
}

// Språknamnen står på sitt eget språk, som i webbens språkval
const LANG_NAMES: [LangChoice, string][] = [['sv', 'Svenska'], ['en', 'English']];
/** Språk: telefonens (svenska → svenska, annars engelska) eller valt här. Sparas i telefonen; bytet ritar om appen. */
function LanguagePanel() {
  const cur = langChoice();
  const pick = (c: LangChoice) => { savePref('bx.lang', c || null); setLangChoice(c); };
  return (
    <View style={st.panel}>
      <Text style={st.h2}>{t('Språk')}</Text>
      <Text style={st.dim2}>{t('Appen följer telefonens språk: svenska om telefonen är på svenska, annars engelska.')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {([['', t('Telefonens språk')], ...LANG_NAMES] as [LangChoice, string][]).map(([c, label]) => (
          <Pressable key={c || 'auto'} onPress={() => pick(c)} style={[st.chip, cur === c && st.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur === c }} accessibilityLabel={label}>
            {cur === c ? <Ionicons name="checkmark" size={16} color={C.accent} /> : null}
            <Text style={[st.chipText, cur === c && { color: C.accent }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
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
