// Ljudböcker och poddar: listorna under fliken Musik, boksidan (kapitel, Fortsätt) och poddsidan (avsnitt).
// Positionen sparas på servern (samma som webben och de andra apparna), så boken fortsätter där man slutade.
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, type NavigationProp } from '@react-navigation/native';
import { C } from '../theme';
import { api, ensureImageToken, fmtDur, fmtTime, type Library } from '../api';
import { bookCoverUrl, playBook, playEpisode, podImageUrl, useNowPlayingPart, type Chapter } from '../music';
import { Button, Empty, ErrorState, Loading } from '../components/ui';
import { Cover, Header, MiniPlayer, s as as } from '../components/audio';
import { DownloadBook } from '../components/download';
import { st } from './Music';
import type { Props, Stack } from '../nav';
import { locale, t } from '../i18n';

type Nav = NavigationProp<Stack>;
interface Book { id: number; title: string; author?: string | null; narrator?: string | null; duration?: number | null; cover?: boolean; position?: number; finished?: boolean; series?: string | null; seriesNo?: string | null }
interface BookDetail extends Book { description?: string | null; chapters: Chapter[]; speed?: number }
interface Episode { id: number; podcast: number; podcastTitle?: string | null; title: string; published?: number | null; duration?: number | null; position?: number; played?: boolean }

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { await ensureImageToken(); setData(await api<T>(path)); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta listan')); }
  }, [path]);
  // Hämtas igen när man kommer tillbaka: positionen kan ha ändrats
  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  return { data, error, reload };
}
const left = (b: { duration?: number | null; position?: number }) => (b.duration && b.position ? Math.max(0, b.duration - b.position) : 0);

function BookCard({ b, width }: { b: Book; width: number }) {
  const nav = useNavigation<Nav>();
  const frac = b.duration && b.position ? Math.min(1, b.position / b.duration) : 0;
  return (
    <Pressable onPress={() => nav.navigate('Book', { id: b.id })} style={({ pressed }) => [{ width }, pressed && { opacity: 0.75 }]} accessibilityRole="button" accessibilityLabel={`${b.title}, ${b.author || ''}`}>
      <View>
        <Cover uri={b.cover ? bookCoverUrl(b.id, 300) : null} size={width} icon="book-outline" />
        {frac > 0 && !b.finished ? <View style={bs.barBg}><View style={[bs.barFill, { width: `${frac * 100}%` }]} /></View> : null}
      </View>
      <Text style={as.cardT} numberOfLines={2}>{b.title}</Text>
      <Text style={as.cardS} numberOfLines={1}>{b.author || ''}</Text>
    </Pressable>
  );
}

/** Ett ljudboksbibliotek: Fortsätt lyssna överst, sedan alla böcker */
export function BooksSection({ lib }: { lib: Library }) {
  const { data, error, reload } = useLoad<{ continue: Book[]; books: Book[] }>(`/api/audiobooks/${lib.id}`);
  const [w, setW] = useState(0);
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.books.length) return <Empty text={t('Inga ljudböcker ännu.')} />;
  const cols = Math.max(2, Math.floor((w - 14) / (140 + 14)));
  const cw = w ? Math.floor((w - 14 * (cols + 1)) / cols) : 0;
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {cw > 0 ? <FlatList key={cols} data={data.books} numColumns={cols} keyExtractor={(x) => String(x.id)}
        contentContainerStyle={{ padding: 14, gap: 18 }} columnWrapperStyle={{ gap: 14 }}
        ListHeaderComponent={data.continue.length ? (
          <View style={{ marginHorizontal: -14 }}>
            <Text style={st.h2}>{t('Fortsätt lyssna')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }}>
              {data.continue.map((b) => <BookCard key={b.id} b={b} width={130} />)}
            </ScrollView>
            <Text style={[st.h2, { marginTop: 22, marginBottom: 0 }]}>{t('Alla böcker')}</Text>
          </View>
        ) : undefined}
        renderItem={({ item }) => <BookCard b={item} width={cw} />} /> : null}
    </View>
  );
}

export function BookScreen({ navigation, route }: Props<'Book'>) {
  const insets = useSafeAreaInsets();
  const { data: b, error, reload } = useLoad<BookDetail>(`/api/audiobooks/book/${route.params.id}`);
  const [err, setErr] = useState('');
  const playingThis = useNowPlayingPart((x) => x.mode === 'book' && x.book?.id === route.params.id);
  const start = (from?: number) => playBook(route.params.id, from).then(() => setErr('')).catch((e) => setErr(e?.message || t('Boken gick inte att spela')));
  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <Header title={b?.title || ''} onBack={() => navigation.goBack()} />
      <View style={st.body}>
        {error && !b ? <ErrorState error={error} onRetry={reload} /> : !b ? <Loading /> : (
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
            <View style={st.hero}>
              <Cover uri={b.cover ? bookCoverUrl(b.id, 600) : null} size={200} icon="book-outline" />
              <Text style={st.h1}>{b.title}</Text>
              {b.author ? <Text style={st.artistLink}>{b.author}</Text> : null}
              <Text style={st.meta}>{[b.narrator ? t('Uppläsare: {v}', { v: b.narrator }) : '', b.series ? `${b.series}${b.seriesNo ? ' ' + b.seriesNo : ''}` : '', fmtDur(b.duration)].filter(Boolean).join(' · ')}</Text>
              {b.finished ? <Text style={st.meta}>{t('Utläst')}</Text> : b.position ? <Text style={st.meta}>{t('{v} kvar', { v: fmtDur(left(b)) })}</Text> : null}
            </View>
            <View style={st.btns}>
              {b.position && !b.finished ? (<>
                <Button kind="primary" icon="play" label={t('Fortsätt från {v}', { v: fmtTime(b.position) })} onPress={() => start()} />
                <Button label={t('Börja om')} onPress={() => start(0)} />
              </>) : <Button kind="primary" icon="play" label={playingThis ? t('Spelas nu') : t('Spela')} onPress={() => start(b.finished ? 0 : undefined)} />}
            </View>
            {err ? <Text style={[st.dim, { color: C.err, paddingHorizontal: 14 }]}>{err}</Text> : null}
            <DownloadBook id={b.id} cover={!!b.cover} />
            {b.description ? <Text style={bs.desc}>{b.description.replace(/<[^>]+>/g, '')}</Text> : null}
            {b.chapters.length > 1 ? <Text style={[st.h2, { marginTop: 18 }]}>{t('Kapitel')}</Text> : null}
            {b.chapters.length > 1 ? b.chapters.map((c, i) => (
              <Pressable key={i} onPress={() => start(c.start)} style={({ pressed }) => [as.row, pressed && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={t('Spela från {v}', { v: c.title })}>
                <View style={as.num}><Text style={as.numT}>{i + 1}</Text></View>
                <Text style={[as.rowT, { flex: 1, fontWeight: '500' }]} numberOfLines={2}>{c.title}</Text>
                <Text style={as.rowD}>{fmtTime(c.start)}</Text>
              </Pressable>
            )) : null}
          </ScrollView>
        )}
      </View>
      <MiniPlayer bottomInset={insets.bottom} />
    </View>
  );
}

// ---------- poddar ----------
const pubDate = (s?: number | null) => (s ? new Date(s * 1000).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
function EpisodeRow({ e, showPod }: { e: Episode; showPod?: boolean }) {
  const [err, setErr] = useState('');
  const on = useNowPlayingPart((x) => x.mode === 'podcast' && x.episode?.id === e.id);
  const sub = [showPod ? e.podcastTitle : '', pubDate(e.published), e.played ? t('Lyssnat') : e.position ? t('{v} kvar', { v: fmtDur(left(e)) }) : fmtDur(e.duration)].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={() => playEpisode(e.id).then(() => setErr('')).catch((x) => setErr(x?.message || t('Avsnittet gick inte att spela')))} style={({ pressed }) => [as.row, pressed && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={t('Spela {title}', { title: e.title })}>
      {showPod ? <Cover uri={podImageUrl(e.podcast, 120)} size={48} icon="mic" /> : <Ionicons name={on ? 'volume-high' : e.played ? 'checkmark-circle' : 'play-circle-outline'} size={26} color={on || !e.played ? C.accent : C.dim} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[as.rowT, on && { color: C.accent }, e.played && !on && { color: C.dim }]} numberOfLines={2}>{e.title}</Text>
        <Text style={[as.rowS, err ? { color: C.err } : null]} numberOfLines={1}>{err || sub}</Text>
      </View>
    </Pressable>
  );
}

/** Poddarna: nya avsnitt och alla poddar. Poddar läggs till i webbgränssnittet. Barnprofiler får inga poddar av servern. */
export function PodcastsSection() {
  const { data, error, reload } = useLoad<{ podcasts: { id: number; title: string; author?: string | null; unplayed?: number }[]; latest: Episode[] }>('/api/podcasts');
  const nav = useNavigation<Nav>();
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.podcasts.length) return <Empty text={t('Inga poddar ännu. Poddar läggs till i webbgränssnittet.')} />;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <Text style={[st.h2, { marginTop: 14 }]}>{t('Poddar')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }}>
        {data.podcasts.map((p) => (
          <Pressable key={p.id} style={{ width: 120 }} onPress={() => nav.navigate('Podcast', { id: p.id })} accessibilityRole="button" accessibilityLabel={p.title}>
            <Cover uri={podImageUrl(p.id, 300)} size={120} icon="mic" />
            <Text style={as.cardT} numberOfLines={2}>{p.title}</Text>
            {p.unplayed ? <Text style={as.cardS}>{t('{n} nya', { n: p.unplayed })}</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
      {data.latest.length ? <Text style={[st.h2, { marginTop: 22 }]}>{t('Nya avsnitt')}</Text> : null}
      {data.latest.map((e) => <EpisodeRow key={e.id} e={e} showPod />)}
    </ScrollView>
  );
}

export function PodcastScreen({ navigation, route }: Props<'Podcast'>) {
  const insets = useSafeAreaInsets();
  const { data: p, error, reload } = useLoad<{ id: number; title: string; author?: string | null; description?: string | null; episodes: Episode[] }>(`/api/podcasts/${route.params.id}`);
  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <Header title={p?.title || ''} onBack={() => navigation.goBack()} />
      <View style={st.body}>
        {error && !p ? <ErrorState error={error} onRetry={reload} /> : !p ? <Loading /> : (
          <FlatList data={p.episodes} keyExtractor={(x) => String(x.id)} contentContainerStyle={{ paddingBottom: 24 }}
            ListHeaderComponent={
              <View style={[st.hero, { paddingBottom: 14 }]}>
                <Cover uri={podImageUrl(p.id, 600)} size={180} icon="mic" />
                <Text style={st.h1}>{p.title}</Text>
                {p.author ? <Text style={st.meta}>{p.author}</Text> : null}
                {p.description ? <Text style={[bs.desc, { paddingHorizontal: 0 }]} numberOfLines={4}>{p.description.replace(/<[^>]+>/g, '')}</Text> : null}
              </View>}
            ListEmptyComponent={<Text style={[st.dim, { padding: 24 }]}>{t('Inga avsnitt än.')}</Text>}
            renderItem={({ item }) => <EpisodeRow e={item} />} />
        )}
      </View>
      <MiniPlayer bottomInset={insets.bottom} />
    </View>
  );
}

const bs = StyleSheet.create({
  barBg: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(0,0,0,.6)' },
  barFill: { height: 4, backgroundColor: C.accent },
  desc: { color: C.dim, fontSize: 14, lineHeight: 21, paddingHorizontal: 14, marginTop: 6 },
});
