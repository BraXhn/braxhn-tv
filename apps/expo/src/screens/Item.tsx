// Titelsidan: affisch, titel och fakta, Spela/Fortsätt, Markera som sedd, Min lista – och för serier nästa avsnitt
// och avsnittslistan per säsong. Fingret på en Spela-knapp förvärmer strömmen (servern startar den före klicket).
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { C, R } from '../theme';
import { api, ensureImageToken, fmtDur, fmtTime, resumeAt, sxe, warmPlay, type ItemDetail, type MediaItem } from '../api';
import { Art, Button, ErrorState, Loading, Shelf } from '../components/ui';
import { DownloadSeason, DownloadVideo, EpisodeDownload } from '../components/download';
import type { Props } from '../nav';
import { t, tn } from '../i18n';

export default function ItemScreen({ navigation, route }: Props<'Item'>) {
  const insets = useSafeAreaInsets();
  const [it, setIt] = useState<ItemDetail | null>(null);
  const [error, setError] = useState('');
  const [season, setSeason] = useState<number | null>(null);
  const load = useCallback(async () => {
    try { await ensureImageToken(); setIt(await api<ItemDetail>('/api/items/' + route.params.id)); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta titeln')); }
  }, [route.params.id]);
  // Hämtas på nytt efter uppspelning: positionen och "sedd" har ändrats
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const play = (x: MediaItem, start: number) => navigation.push('Player', { id: x.id, start, title: x.kind === 'episode' ? `${x.showTitle || ''} · ${sxe(x)}` : x.title });
  const seasons = useMemo(() => [...new Set((it?.children || []).map((c) => c.season ?? 0))].sort((a, b) => a - b), [it]);
  const curSeason = season ?? it?.next?.season ?? seasons[0] ?? null;
  const act = async (path: string, body: any) => { try { await api(path, { method: 'POST', body }); await load(); } catch (e: any) { setError(e?.message || t('Det gick inte')); } };

  const back = (
    <View style={st.top}>
      <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Tillbaka')} style={st.back}><Ionicons name="chevron-back" size={24} color={C.text} /></Pressable>
      <Text style={st.topTitle} numberOfLines={1}>{it?.title || ''}</Text>
    </View>
  );
  if (error && !it) return <View style={[st.root, { paddingTop: insets.top }]}>{back}<View style={st.body}><ErrorState error={error} onRetry={load} /></View></View>;
  if (!it) return <View style={[st.root, { paddingTop: insets.top }]}>{back}<View style={st.body}><Loading /></View></View>;

  const show = it.kind === 'show';
  // Avsnitten i säsongen, med serien ifylld (för Nedladdat: serie, säsong och avsnitt syns utan nät)
  const epsOf = (n: number | null) => (it.children || []).filter((e) => (e.season ?? 0) === n).map((e) => ({ ...e, kind: 'episode', show: it.id, showTitle: e.showTitle || it.title }));
  const pos = resumeAt(it.position, it.duration);
  const nx = it.next || null;
  const nxPos = nx ? resumeAt(nx.position, nx.duration) : 0;
  const facts = [it.year, show ? (it.seasons ? tn(it.seasons, '1 säsong', '{n} säsonger') : '') : fmtDur(it.duration), show && it.episodes ? tn(it.episodes, '1 avsnitt', '{n} avsnitt') : '', !show && it.height ? `${it.height}p` : '', it.cert].filter(Boolean);
  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      {back}
      <ScrollView style={st.body} contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={st.head}>
          <Art it={it} width={130} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={st.h1}>{it.title}</Text>
            <Text style={st.facts}>{facts.join('   ')}</Text>
            {it.genres?.length ? <Text style={st.facts} numberOfLines={2}>{it.genres.join(' · ')}</Text> : null}
          </View>
        </View>
        <View style={st.actions}>
          {show ? (nx ? <Button kind="primary" icon="play" label={nxPos > 0 ? t('Fortsätt {v}', { v: sxe(nx) }) : t('Spela {v}', { v: sxe(nx) })} onPressIn={() => warmPlay(nx.id, nxPos)} onPress={() => play(nx, nxPos)} /> : null)
            : pos > 0 ? (<>
              <Button kind="primary" icon="play" label={t('Fortsätt från {v}', { v: fmtTime(pos) })} onPressIn={() => warmPlay(it.id, pos)} onPress={() => play(it, pos)} />
              <Button label={t('Börja om')} onPressIn={() => warmPlay(it.id, 0)} onPress={() => play(it, 0)} />
            </>) : <Button kind="primary" icon="play" label={t('Spela')} onPressIn={() => warmPlay(it.id, 0)} onPress={() => play(it, 0)} />}
          {!show ? <Button label={it.watched ? t('Markera som osedd') : t('Markera som sedd')} onPress={() => act(`/api/items/${it.id}/watched`, { watched: !it.watched })} /> : null}
          <Button label={it.inWatchlist ? '✓ ' + t('Min lista') : '+ ' + t('Min lista')} onPress={() => act(`/api/items/${it.id}/watchlist`, { add: !it.inWatchlist })} />
        </View>
        {!show ? <View style={{ paddingHorizontal: 14 }}><DownloadVideo it={it} /></View> : null}
        {error ? <Text style={st.err}>{error}</Text> : null}
        {it.overview ? <Text style={st.overview}>{it.overview}</Text> : null}

        {show && seasons.length ? (
          <View style={{ marginTop: 18 }}>
            {seasons.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.seasons}>
                {seasons.map((n) => (
                  <Pressable key={n} onPress={() => setSeason(n)} style={[st.chip, curSeason === n && st.chipOn]} accessibilityRole="button" accessibilityState={{ selected: curSeason === n }}>
                    <Text style={[st.chipText, curSeason === n && { color: C.accent }]}>{n === 0 ? t('Specialer') : t('Säsong {n}', { n })}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : <Text style={st.h2}>{curSeason === 0 ? t('Specialer') : t('Säsong {n}', { n: curSeason })}</Text>}
            <DownloadSeason eps={epsOf(curSeason)} label={curSeason === 0 ? t('specialerna') : t('säsong {n}', { n: curSeason })} />
            {epsOf(curSeason).map((e) => {
              const p = resumeAt(e.position, e.duration);
              return (
                <Pressable key={e.id} style={({ pressed }) => [st.ep, pressed && { backgroundColor: C.bg2 }]} onPressIn={() => warmPlay(e.id, p)} onPress={() => play(e, p)}
                  accessibilityRole="button" accessibilityLabel={t('Spela avsnitt {n}: {title}', { n: e.episode, title: e.title })}>
                  <Art it={e} land width={132} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={st.epT} numberOfLines={2}>{e.episode}. {e.title}</Text>
                    <Text style={st.facts}>{[fmtDur(e.duration), p > 0 ? t('fortsätt från {v}', { v: fmtTime(p) }) : ''].filter(Boolean).join(' · ')}</Text>
                  </View>
                  <EpisodeDownload it={e} />
                  <Ionicons name="play-circle" size={30} color={C.accent} />
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <Shelf title={t('Liknande')} items={it.similar || []} onOpen={(x) => navigation.push('Item', { id: x.id })} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome },
  top: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,.4)' },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topTitle: { color: C.text, fontSize: 17, fontWeight: '700', flex: 1 },
  body: { flex: 1, backgroundColor: C.bg },
  head: { flexDirection: 'row', gap: 14, padding: 14, alignItems: 'flex-end' },
  h1: { color: C.text, fontSize: 26, fontWeight: '800', lineHeight: 30 },
  h2: { color: C.text, fontSize: 19, fontWeight: '700', paddingHorizontal: 14, marginBottom: 6 },
  facts: { color: C.dim, fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14 },
  overview: { color: C.text, fontSize: 15, lineHeight: 22, paddingHorizontal: 14, marginTop: 16 },
  err: { color: C.err, fontSize: 14, paddingHorizontal: 14, marginTop: 10 },
  seasons: { paddingHorizontal: 14, gap: 8, marginBottom: 6 },
  chip: { height: 34, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.bg2, justifyContent: 'center' },
  chipOn: { backgroundColor: C.bg3 },
  chipText: { color: C.dim, fontSize: 14, fontWeight: '600' },
  ep: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line },
  epT: { color: C.text, fontSize: 15, fontWeight: '700' },
});
