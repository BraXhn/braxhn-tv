// Fliken Musik (som webbens musiksida på en telefon): bibliotek, ljudböcker och poddar som chips överst, sedan
// Översikt · Album · Artister · Spellistor och sökning i musiken. Album-, artist- och spellistesidorna ligger här också.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, type NavigationProp } from '@react-navigation/native';
import { C, R } from '../theme';
import { api, ensureImageToken, fmtDur, session, type Library } from '../api';
import { playTracks, startRadio, type Album, type Track } from '../music';
import { Button, Empty, ErrorState, Loading } from '../components/ui';
import { AlbumCard, Cover, Header, MiniPlayer, TrackRow, s as as } from '../components/audio';
import { BooksSection, PodcastsSection } from './Books';
import type { Props, Stack } from '../nav';
import { t, tn } from '../i18n';

type Nav = NavigationProp<Stack>;
interface MusicHome { recentAlbums: Album[]; recentlyPlayed: Album[]; favorites: Track[]; playlists: { id: number; name: string; tracks: number; duration: number | null }[]; smart: { id: string; name: string; count: number; covers?: number[] }[] }
interface Artist { id: number; name: string; albums: number; cover_album?: number | null; image?: boolean }
type Section = { kind: 'music' | 'audiobook'; lib: Library } | { kind: 'podcast' };
// Servern skickar de fasta smarta listornas och stationernas namn på svenska (server/listening.js SMART, server/sonic.js);
// webben översätter dem i klienten, och appen gör likadant efter listans id. Egna listor (u1, u2 …) visas som de heter.
const SMART_NAMES = (): Record<string, string> => ({
  top30: t('Mest spelat senaste 30 dagarna'), forgotten: t('Favoriter du inte hört på länge'), recent: t('Nyligen tillagt'), never: t('Aldrig spelat'),
  'sonic-calm': t('Lugnt'), 'sonic-energy': t('Energi'), 'sonic-focus': t('Fokus'), 'sonic-party': t('Fest'),
});
const smartName = (x: { id: string; name: string }) => SMART_NAMES()[x.id] || x.name;

/** Fliken: välj bibliotek (musik, ljudböcker) eller poddar. Barnprofiler ser bara de bibliotek servern ger dem. */
export function Listen() {
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [pods, setPods] = useState(false);
  const [sel, setSel] = useState(0); // index i sections
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      await ensureImageToken();
      const [l, p] = await Promise.all([api<Library[]>('/api/libraries'), api<{ podcasts: unknown[]; canAdd: boolean }>('/api/podcasts').catch(() => null)]);
      setLibs(l.filter((x) => x.type === 'music' || x.type === 'audiobook'));
      setPods(!!p && (p.podcasts.length > 0 || p.canAdd));
      setError('');
    } catch (e: any) { setError(e?.message || t('Kunde inte hämta biblioteken')); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const sections: Section[] = useMemo(() => [
    ...(libs || []).filter((l) => l.type === 'music').map((lib) => ({ kind: 'music' as const, lib })),
    ...(libs || []).filter((l) => l.type === 'audiobook').map((lib) => ({ kind: 'audiobook' as const, lib })),
    ...(pods ? [{ kind: 'podcast' as const }] : []),
  ], [libs, pods]);
  if (error && !libs) return <ErrorState error={error} onRetry={load} />;
  if (!libs) return <Loading />;
  if (!sections.length) return <Empty text={t('Här finns ingen musik, inga ljudböcker och inga poddar som den här profilen får lyssna på.')} />;
  const cur = sections[Math.min(sel, sections.length - 1)];
  return (
    <View style={{ flex: 1 }}>
      {sections.length > 1 ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips}>
            {sections.map((x, i) => {
              const on = x === cur;
              const icon = x.kind === 'music' ? 'musical-notes-outline' : x.kind === 'audiobook' ? 'book-outline' : 'mic-outline';
              const name = x.kind === 'podcast' ? t('Poddar') : x.lib.name;
              return (
                <Pressable key={i} onPress={() => setSel(i)} style={[st.chip, on && st.chipOn]} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={name}>
                  <Ionicons name={icon} size={16} color={on ? C.accent : C.dim} /><Text style={[st.chipText, on && { color: C.accent }]}>{name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        {cur.kind === 'music' ? <MusicLib key={cur.lib.id} lib={cur.lib} /> : cur.kind === 'audiobook' ? <BooksSection key={cur.lib.id} lib={cur.lib} /> : <PodcastsSection />}
      </View>
    </View>
  );
}

const TABS = ['home', 'albums', 'artists', 'playlists'] as const;
const tabLabel = (k: (typeof TABS)[number]) => (k === 'home' ? t('Översikt') : k === 'albums' ? t('Album') : k === 'artists' ? t('Artister') : t('Spellistor'));
function MusicLib({ lib }: { lib: Library }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('home');
  const [q, setQ] = useState('');
  return (
    <View style={{ flex: 1 }}>
      <View style={st.msearch}>
        <Ionicons name="search" size={16} color={C.dim} />
        <TextInput style={st.msearchIn} value={q} onChangeText={setQ} placeholder={t('Sök artist, album, låt')} placeholderTextColor={C.dim} autoCorrect={false} autoCapitalize="none" returnKeyType="search" accessibilityLabel={t('Sök i musiken')} />
        {q ? <Pressable onPress={() => setQ('')} hitSlop={10} accessibilityLabel={t('Rensa sökningen')}><Ionicons name="close-circle" size={16} color={C.dim} /></Pressable> : null}
      </View>
      {q.trim().length >= 2 ? <MusicSearch lib={lib.id} q={q.trim()} /> : (<>
        <View style={st.tabs} accessibilityRole="tablist">
          {TABS.map((k) => (
            <Pressable key={k} onPress={() => setTab(k)} style={[st.tab, tab === k && st.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
              <Text style={[st.tabText, tab === k && { color: C.text }]}>{tabLabel(k)}</Text>
            </Pressable>
          ))}
        </View>
        {tab === 'home' ? <MusicHomeView lib={lib.id} /> : tab === 'albums' ? <Albums lib={lib.id} /> : tab === 'artists' ? <Artists lib={lib.id} /> : <Playlists lib={lib.id} />}
      </>)}
    </View>
  );
}

function useLoad<T>(path: string): { data: T | null; error: string; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { await ensureImageToken(); setData(await api<T>(path)); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta musiken')); }
  }, [path]);
  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  return { data, error, reload };
}

function AlbumShelf({ title, items }: { title: string; items: Album[] }) {
  const nav = useNavigation<Nav>();
  if (!items.length) return null;
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={st.h2}>{title}</Text>
      <FlatList horizontal data={items} keyExtractor={(x) => String(x.id)} showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }} initialNumToRender={4}
        renderItem={({ item }) => <AlbumCard a={item} width={140} onPress={() => nav.navigate('Album', { id: item.id })} />} />
    </View>
  );
}

function MusicHomeView({ lib }: { lib: number }) {
  const { data, error, reload } = useLoad<MusicHome>(`/api/music/${lib}/home`);
  const nav = useNavigation<Nav>();
  const [refreshing, setRefreshing] = useState(false);
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const smart = data.smart.filter((x) => x.count > 0);
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }} refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await reload(); setRefreshing(false); }} />}>
      <AlbumShelf title={t('Spelat nyligen')} items={data.recentlyPlayed} />
      {smart.length ? (
        <View style={{ marginTop: 22 }}>
          <Text style={st.h2}>{t('Smarta listor')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }}>
            {smart.map((x) => (
              <Pressable key={x.id} style={{ width: 140 }} onPress={() => nav.navigate('Playlist', { id: 0, lib, smart: x.id, name: smartName(x) })} accessibilityRole="button" accessibilityLabel={smartName(x)}>
                <Cover uri={x.covers?.[0] ? `${session.server}/api/music/cover/${x.covers[0]}?w=300${session.imgToken ? '&t=' + session.imgToken : ''}` : null} size={140} icon="sparkles-outline" />
                <Text style={as.cardT} numberOfLines={1}>{smartName(x)}</Text>
                <Text style={as.cardS}>{tn(x.count, '{n} låt', '{n} låtar')}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <AlbumShelf title={t('Nytt i biblioteket')} items={data.recentAlbums} />
      {!data.recentAlbums.length ? <Text style={[st.dim, { padding: 24 }]}>{t('Inga album ännu.')}</Text> : null}
      {data.favorites.length ? (
        <View style={{ marginTop: 22 }}>
          <View style={st.headRow}>
            <Text style={[st.h2, { paddingHorizontal: 0, flex: 1 }]}>{t('Favoriter')}</Text>
            <Button small icon="play" label={t('Spela')} onPress={() => playTracks(data.favorites, 0)} />
            <Button small icon="shuffle" label={t('Blanda')} onPress={() => playTracks(data.favorites, Math.floor(Math.random() * data.favorites.length), { shuffle: true })} />
          </View>
          {data.favorites.slice(0, 50).map((t, i) => <TrackRow key={t.id} t={t} i={i} showCover onPress={() => playTracks(data.favorites, i)} />)}
        </View>
      ) : null}
    </ScrollView>
  );
}

/** Rutnät med album (fliken Album, artistsidan, sökningen) */
function AlbumGrid({ items, header }: { items: Album[]; header?: React.ReactElement }) {
  const nav = useNavigation<Nav>();
  const [w, setW] = useState(0);
  const cols = Math.max(2, Math.floor((w - 14) / (150 + 14)));
  const cw = w ? Math.floor((w - 14 * (cols + 1)) / cols) : 0;
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {cw > 0 ? <FlatList key={cols} data={items} numColumns={cols} keyExtractor={(x) => String(x.id)} ListHeaderComponent={header}
        contentContainerStyle={{ padding: 14, gap: 18 }} columnWrapperStyle={{ gap: 14 }}
        renderItem={({ item }) => <AlbumCard a={item} width={cw} onPress={() => nav.navigate('Album', { id: item.id })} />} /> : null}
    </View>
  );
}

const SORTS = ['artist', 'title', 'added', 'year'] as const;
const sortLabel = (k: (typeof SORTS)[number]) => (k === 'artist' ? t('Artist') : k === 'title' ? t('Titel') : k === 'added' ? t('Senast tillagda') : t('År'));
function Albums({ lib }: { lib: number }) {
  const [sort, setSort] = useState<(typeof SORTS)[number]>('artist');
  const { data, error, reload } = useLoad<Album[]>(`/api/music/${lib}/albums?sort=${sort}`);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[st.chips, { paddingTop: 2 }]} style={{ flexGrow: 0 }}>
        {SORTS.map((k) => (
          <Pressable key={k} onPress={() => setSort(k)} style={[st.chip, sort === k && st.chipOn]} accessibilityRole="button" accessibilityState={{ selected: sort === k }}>
            <Text style={[st.chipText, sort === k && { color: C.accent }]}>{sortLabel(k)}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {error && !data ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : !data.length ? <Empty text={t('Inga album ännu.')} /> : <AlbumGrid items={data} />}
    </View>
  );
}

const artistImage = (a: Artist) => a.image ? `${session.server}/api/music/artists/${a.id}/image?w=200${session.imgToken ? '&t=' + session.imgToken : ''}`
  : a.cover_album ? `${session.server}/api/music/cover/${a.cover_album}?w=200${session.imgToken ? '&t=' + session.imgToken : ''}` : null;
function Artists({ lib }: { lib: number }) {
  const { data, error, reload } = useLoad<Artist[]>(`/api/music/${lib}/artists`);
  const nav = useNavigation<Nav>();
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.length) return <Empty text={t('Inga artister ännu.')} />;
  return (
    <FlatList data={data} keyExtractor={(x) => String(x.id)} contentContainerStyle={{ paddingVertical: 6 }}
      renderItem={({ item }) => (
        <Pressable onPress={() => nav.navigate('Artist', { id: item.id })} style={({ pressed }) => [as.row, pressed && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={item.name}>
          <Cover uri={artistImage(item)} size={48} round icon="person" />
          <View style={{ flex: 1 }}><Text style={as.rowT} numberOfLines={1}>{item.name}</Text><Text style={as.rowS}>{tn(item.albums, '1 album', '{n} album')}</Text></View>
          <Ionicons name="chevron-forward" size={18} color={C.dim} />
        </Pressable>
      )} />
  );
}

function Playlists({ lib }: { lib: number }) {
  const { data, error, reload } = useLoad<MusicHome>(`/api/music/${lib}/home`);
  const nav = useNavigation<Nav>();
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const rows = [
    ...data.playlists.map((p) => ({ key: 'p' + p.id, name: p.name, sub: tn(p.tracks, '{n} låt', '{n} låtar') + (p.duration ? ' · ' + fmtDur(p.duration) : ''), icon: 'list' as const, go: () => nav.navigate('Playlist', { id: p.id, name: p.name }) })),
    ...data.smart.map((x) => ({ key: 's' + x.id, name: smartName(x), sub: tn(x.count, '{n} låt', '{n} låtar') + ' · ' + t('uppdateras automatiskt'), icon: 'sparkles-outline' as const, go: () => nav.navigate('Playlist', { id: 0, lib, smart: x.id, name: smartName(x) }) })),
  ];
  if (!rows.length) return <Empty text={t('Inga spellistor ännu. Spellistor skapas i webbgränssnittet.')} />;
  return (
    <FlatList data={rows} keyExtractor={(x) => x.key} contentContainerStyle={{ paddingVertical: 6 }}
      renderItem={({ item }) => (
        <Pressable onPress={item.go} style={({ pressed }) => [as.row, pressed && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={item.name}>
          <Cover size={48} icon={item.icon} />
          <View style={{ flex: 1 }}><Text style={as.rowT} numberOfLines={1}>{item.name}</Text><Text style={as.rowS}>{item.sub}</Text></View>
          <Ionicons name="chevron-forward" size={18} color={C.dim} />
        </Pressable>
      )} />
  );
}

function MusicSearch({ lib, q }: { lib: number; q: string }) {
  const [r, setR] = useState<{ artists: Artist[]; albums: Album[]; tracks: Track[] } | null>(null);
  const [error, setError] = useState('');
  const nav = useNavigation<Nav>();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try { await ensureImageToken(); const x = await api<{ artists: Artist[]; albums: Album[]; tracks: Track[] }>(`/api/music/${lib}/search?q=${encodeURIComponent(q)}`); if (live) { setR(x); setError(''); } }
      catch (e: any) { if (live) setError(e?.message || t('Sökningen misslyckades')); }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [lib, q]);
  if (error) return <ErrorState error={error} />;
  if (!r) return <Loading />;
  if (!r.artists.length && !r.albums.length && !r.tracks.length) return <Empty text={t('Inga träffar på "{q}".', { q })} />;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {r.artists.length ? <Text style={[st.h2, { marginTop: 14 }]}>{t('Artister')}</Text> : null}
      {r.artists.map((a) => (
        <Pressable key={a.id} onPress={() => nav.navigate('Artist', { id: a.id })} style={as.row} accessibilityRole="button" accessibilityLabel={a.name}>
          <Cover size={44} round icon="person" /><Text style={[as.rowT, { flex: 1 }]} numberOfLines={1}>{a.name}</Text>
        </Pressable>
      ))}
      <AlbumShelf title={t('Album')} items={r.albums} />
      {r.tracks.length ? <Text style={[st.h2, { marginTop: 22 }]}>{t('Låtar')}</Text> : null}
      {r.tracks.map((t, i) => <TrackRow key={t.id} t={t} i={i} showCover onPress={() => playTracks(r.tracks, i)} />)}
    </ScrollView>
  );
}

// ---------- undersidor ----------
/** Sida med omslag, rubrik, knappar och låtlista (album, spellista) */
function TrackPage({ title, header, tracks, numbered, error, reload, onBack }: { title: string; header: React.ReactNode; tracks: Track[] | null; numbered?: boolean; error: string; reload: () => void; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <Header title={title} onBack={onBack} />
      <View style={st.body}>
        {error && !tracks ? <ErrorState error={error} onRetry={reload} /> : !tracks ? <Loading /> : (
          <FlatList data={tracks} keyExtractor={(x) => String(x.id)} ListHeaderComponent={<>{header}</>} contentContainerStyle={{ paddingBottom: 24 }}
            ListEmptyComponent={<Text style={[st.dim, { padding: 24 }]}>{t('Listan är tom just nu.')}</Text>}
            renderItem={({ item, index }) => <TrackRow t={item} i={index} numbered={numbered} onPress={() => playTracks(tracks, index)} />} />
        )}
      </View>
      <MiniPlayer bottomInset={insets.bottom} />
    </View>
  );
}

function PlayButtons({ tracks, radio }: { tracks: Track[]; radio?: { seed: { albumId?: number; artistId?: number }; name: string } }) {
  const [err, setErr] = useState('');
  return (
    <>
      <View style={st.btns}>
        <Button kind="primary" icon="play" label={t('Spela')} disabled={!tracks.length} onPress={() => playTracks(tracks, 0)} />
        <Button icon="shuffle" label={t('Blanda')} disabled={!tracks.length} onPress={() => playTracks(tracks, Math.floor(Math.random() * tracks.length), { shuffle: true })} />
        {radio ? <Button icon="radio-outline" label={t('Låtradio')} onPress={() => startRadio(radio.seed, radio.name).then(() => setErr('')).catch((e) => setErr(e?.message || t('Låtradion gick inte att starta')))} /> : null}
      </View>
      {err ? <Text style={[st.dim, { color: C.err, paddingHorizontal: 14, textAlign: 'left' }]}>{err}</Text> : null}
    </>
  );
}

export function AlbumScreen({ navigation, route }: Props<'Album'>) {
  const [a, setA] = useState<(Album & { trackList: Track[]; type?: string }) | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { await ensureImageToken(); setA(await api(`/api/music/albums/${route.params.id}`)); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta albumet')); }
  }, [route.params.id]);
  useEffect(() => { load(); }, [load]);
  const discs = new Set((a?.trackList || []).map((t) => t.disc || 1)).size;
  const header = a ? (
    <View>
      <View style={st.hero}>
        <Cover uri={a.cover ? `${session.server}/api/music/cover/${a.id}?w=600${session.imgToken ? '&t=' + session.imgToken : ''}` : null} size={220} icon="disc-outline" />
        <Text style={st.h1}>{a.title}</Text>
        {a.artistId ? <Pressable onPress={() => navigation.push('Artist', { id: a.artistId! })} accessibilityRole="link"><Text style={st.artistLink}>{a.artist}</Text></Pressable> : <Text style={st.artistLink}>{a.artist}</Text>}
        <Text style={st.meta}>{[a.year, tn(a.trackList.length, '{n} låt', '{n} låtar'), fmtDur(a.duration), a.genre].filter(Boolean).join(' · ')}</Text>
      </View>
      <PlayButtons tracks={a.trackList} radio={{ seed: { albumId: a.id }, name: a.title }} />
    </View>
  ) : null;
  return <TrackPage title={a?.title || ''} header={header} tracks={a?.trackList || null} numbered={discs <= 1} error={error} reload={load} onBack={() => navigation.goBack()} />;
}

export function PlaylistScreen({ navigation, route }: Props<'Playlist'>) {
  const { id, lib, smart, name } = route.params;
  const [p, setP] = useState<{ name: string; trackList: Track[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { await ensureImageToken(); setP(await api(smart ? `/api/music/${lib}/smart/${encodeURIComponent(smart)}` : `/api/music/playlists/${id}`)); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta spellistan')); }
  }, [id, lib, smart]);
  useEffect(() => { load(); }, [load]);
  const header = p ? (
    <View>
      <View style={st.hero}>
        <Cover size={160} icon={smart ? 'sparkles-outline' : 'list'} />
        <Text style={st.small}>{smart ? t('SMART LISTA') : t('SPELLISTA')}</Text>
        <Text style={st.h1}>{smart ? smartName({ id: smart, name: p.name || name || '' }) : p.name || name}</Text>
        <Text style={st.meta}>{tn(p.trackList.length, '{n} låt', '{n} låtar') + ' · ' + (fmtDur(p.trackList.reduce((x, tr) => x + (tr.duration || 0), 0)) || '0 min')}</Text>
      </View>
      <PlayButtons tracks={p.trackList} />
    </View>
  ) : null;
  return <TrackPage title={smart ? smartName({ id: smart, name: p?.name || name || '' }) : p?.name || name || ''} header={header} tracks={p?.trackList || null} error={error} reload={load} onBack={() => navigation.goBack()} />;
}

export function ArtistScreen({ navigation, route }: Props<'Artist'>) {
  const insets = useSafeAreaInsets();
  const [a, setA] = useState<{ id: number; name: string; albums: Album[]; popular: Track[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { await ensureImageToken(); setA(await api(`/api/music/artists/${route.params.id}`)); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta artisten')); }
  }, [route.params.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <Header title={a?.name || ''} onBack={() => navigation.goBack()} />
      <View style={st.body}>
        {error && !a ? <ErrorState error={error} onRetry={load} /> : !a ? <Loading /> : (
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
            <View style={st.hero}>
              <Cover uri={artistImage({ id: a.id, name: a.name, albums: a.albums.length, image: true })} size={150} round icon="person" />
              <Text style={st.h1}>{a.name}</Text>
              <Text style={st.meta}>{tn(a.albums.length, '1 album', '{n} album')}</Text>
            </View>
            <PlayButtons tracks={a.popular} radio={{ seed: { artistId: a.id }, name: a.name }} />
            {a.popular.length ? <Text style={[st.h2, { marginTop: 18 }]}>{t('Populärt')}</Text> : null}
            {a.popular.map((t, i) => <TrackRow key={t.id} t={t} i={i} showCover onPress={() => playTracks(a.popular, i)} />)}
            <AlbumShelf title={t('Album')} items={a.albums} />
          </ScrollView>
        )}
      </View>
      <MiniPlayer bottomInset={insets.bottom} />
    </View>
  );
}

export const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome },
  body: { flex: 1, backgroundColor: C.bg },
  chips: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.bg2 },
  chipOn: { backgroundColor: C.bg3 },
  chipText: { color: C.dim, fontSize: 14, fontWeight: '600' },
  msearch: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, borderRadius: R.md, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.line, marginHorizontal: 14, marginTop: 12, paddingHorizontal: 12 },
  msearchIn: { flex: 1, color: C.text, fontSize: 15, paddingVertical: 0 },
  tabs: { flexDirection: 'row', gap: 18, paddingHorizontal: 14, marginTop: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  tab: { paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
  tabOn: { borderBottomColor: C.accent },
  tabText: { color: C.dim, fontSize: 14.5, fontWeight: '600' },
  h1: { color: C.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 14 },
  h2: { color: C.text, fontSize: 19, fontWeight: '700', paddingHorizontal: 14, marginBottom: 10 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, marginBottom: 6 },
  hero: { alignItems: 'center', paddingHorizontal: 20, paddingTop: 20 },
  artistLink: { color: C.accent2, fontSize: 15.5, fontWeight: '600', marginTop: 4 },
  meta: { color: C.dim, fontSize: 13.5, marginTop: 6, textAlign: 'center' },
  small: { color: C.dim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginTop: 12 },
  btns: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, padding: 14 },
  dim: { color: C.dim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
