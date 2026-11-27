// Nedladdat: det som finns på telefonen för den här profilen och servern – fungerar helt utan nät. Lista, spela,
// pausa/fortsätt, ta bort och hur mycket plats det tar. Startar appen utan kontakt med servern öppnas den här sidan.
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R } from '../theme';
import * as off from '../offline';
import { fmtSize, pendingCount, qualityLabel, startAt, type DlEntry } from '../offlinecore';
import { fmtDur, fmtTime } from '../api';
import { playBook } from '../music';
import { Button, Empty } from '../components/ui';
import { askRemove, confirm, EntryActions, Progress } from '../components/download';
import { MiniPlayer } from '../components/audio';
import type { Props } from '../nav';
import { t, tn } from '../i18n';

export default function Downloads({ navigation, offline, onRetry }: Props<'Downloads'> & { offline?: boolean; onRetry?: () => void }) {
  const insets = useSafeAreaInsets();
  const list = off.useDownloads();
  const [err, setErr] = useState('');
  const back = () => (navigation.canGoBack() ? navigation.goBack() : navigation.replace('Main'));
  const play = (e: DlEntry) => {
    setErr('');
    if (e.kind === 'book') playBook(e.id).then(() => navigation.navigate('NowPlaying')).catch((x) => setErr(x?.message || t('Boken gick inte att spela')));
    else navigation.push('Player', { id: e.id, start: startAt(e), title: e.kind === 'episode' ? `${e.show?.title || ''} · ${e.title}` : e.title });
  };
  const active = list.filter((e) => e.state !== 'done');
  const done = list.filter((e) => e.state === 'done');
  const movies = done.filter((e) => e.kind === 'movie'), books = done.filter((e) => e.kind === 'book');
  // Avsnitten per serie, i ordning
  const shows = new Map<number, DlEntry[]>();
  for (const e of done.filter((x) => x.kind === 'episode').sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
    const k = e.show?.id || 0; shows.set(k, [...(shows.get(k) || []), e]);
  }
  const { used, free } = off.storage();
  const waiting = pendingCount(list);
  const notice = off.getNotice();

  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <View style={st.top}>
        <Pressable onPress={back} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Tillbaka')} style={st.backBtn}><Ionicons name="chevron-back" size={24} color={C.text} /></Pressable>
        <Text style={st.topTitle}>{t('Nedladdat')}</Text>
      </View>
      <ScrollView style={st.body} contentContainerStyle={{ padding: 14, paddingBottom: 32, gap: 12 }}>
        {offline ? (
          <View style={st.banner}>
            <Ionicons name="cloud-offline-outline" size={22} color={C.warn} />
            <View style={{ flex: 1, gap: 8 }}>
              <Text style={st.bannerT}>{t('Ingen kontakt med servern. Det här finns på telefonen och spelas utan nät.')}</Text>
              {onRetry ? <Button small label={t('Försök igen')} onPress={onRetry} /> : null}
            </View>
          </View>
        ) : null}
        {notice ? <Pressable onPress={off.clearNotice} style={st.banner} accessibilityRole="button" accessibilityLabel={notice + ' ' + t('Tryck för att stänga.')}><Ionicons name="information-circle-outline" size={22} color={C.dim} /><Text style={[st.bannerT, { flex: 1 }]}>{notice}</Text></Pressable> : null}
        {!off.supported ? <Empty text={t('Nedladdning finns i appen på telefonen (Expo Go eller ett eget bygge), inte i webbläsaren.')} /> : null}
        {off.supported && !list.length ? <Text style={st.dim}>{t('Inget nedladdat än. Tryck Ladda ner på en film, ett avsnitt eller en ljudbok när du har nät – sedan kan du titta och lyssna här utan nät, till exempel på resan.')}</Text> : null}
        {list.length ? <Text style={st.dim}>{t('Nedladdningarna tar {v}', { v: fmtSize(used) }) + (free ? ' · ' + t('ledigt på telefonen: {v}', { v: fmtSize(free) }) : '')}</Text> : null}
        {waiting ? <Text style={st.dim}>{tn(waiting, 'En position skickas till servern när nätet är tillbaka.', '{n} positioner skickas till servern när nätet är tillbaka.')}</Text> : null}
        {err ? <Text style={{ color: C.err }}>{err}</Text> : null}

        {active.length ? <Text style={st.h2}>{t('På gång')}</Text> : null}
        {active.map((e) => (
          <View key={e.key} style={st.row}>
            <Art e={e} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={st.t} numberOfLines={2}>{e.title}</Text>
              <Text style={st.s} numberOfLines={1}>{[e.sub, e.kind !== 'book' ? qualityLabel(e.q) : ''].filter(Boolean).join(' · ')}</Text>
              <Progress e={e} />
              <EntryActions e={e} />
            </View>
          </View>
        ))}

        {movies.length ? <Text style={st.h2}>{t('Filmer')}</Text> : null}
        {movies.map((e) => <DoneRow key={e.key} e={e} onPlay={() => play(e)} />)}
        {[...shows.values()].map((eps) => (
          <View key={eps[0].key} style={{ gap: 12 }}>
            <Text style={st.h2}>{eps[0].show?.title || t('Serie')}</Text>
            {eps.map((e) => <DoneRow key={e.key} e={e} onPlay={() => play(e)} />)}
          </View>
        ))}
        {books.length ? <Text style={st.h2}>{t('Ljudböcker')}</Text> : null}
        {books.map((e) => <DoneRow key={e.key} e={e} onPlay={() => play(e)} />)}

        {list.length > 1 ? (
          <Button kind="danger" icon="trash-outline" label={t('Ta bort allt')} style={{ marginTop: 18, alignSelf: 'flex-start' }}
            onPress={() => confirm(t('Ta bort allt nedladdat?'), tn(list.length, '1 titel ({size}) tas bort från telefonen.', '{n} titlar ({size}) tas bort från telefonen.', { size: fmtSize(used) }), t('Ta bort allt'), () => off.removeAll())} />
        ) : null}
      </ScrollView>
      <MiniPlayer bottomInset={insets.bottom} />
    </View>
  );
}

function Art({ e }: { e: DlEntry }) {
  const uri = off.artUri(e);
  const land = e.kind === 'episode';
  return (
    <View style={[st.art, land ? { width: 112, aspectRatio: 16 / 9 } : { width: 64, aspectRatio: e.kind === 'book' ? 1 : 2 / 3 }]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        : <Ionicons name={e.kind === 'book' ? 'book-outline' : 'film-outline'} size={22} color={C.dim} />}
    </View>
  );
}

function DoneRow({ e, onPlay }: { e: DlEntry; onPlay: () => void }) {
  const at = startAt(e);
  const facts = [e.kind === 'episode' ? e.sub.split(' · ').slice(1).join(' · ') : e.sub, fmtDur(e.duration), at > 0 ? t('fortsätt från {v}', { v: fmtTime(at) }) : e.finished ? (e.kind === 'book' ? t('utläst') : t('sedd')) : '', fmtSize(e.size)].filter(Boolean);
  return (
    <Pressable onPress={onPlay} onLongPress={() => askRemove(e)} style={({ pressed }) => [st.row, pressed && { opacity: 0.75 }]} accessibilityRole="button" accessibilityLabel={t('Spela {title}', { title: e.title })} accessibilityHint={t('Håll inne för att ta bort')}>
      <Art e={e} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={st.t} numberOfLines={2}>{e.title}</Text>
        <Text style={st.s} numberOfLines={2}>{facts.join(' · ')}</Text>
        {e.pending ? <Text style={st.s}>{t('Positionen skickas när nätet är tillbaka')}</Text> : null}
      </View>
      <Ionicons name="play-circle" size={32} color={C.accent} />
      <Pressable onPress={() => askRemove(e)} hitSlop={8} style={st.trash} accessibilityRole="button" accessibilityLabel={t('Ta bort {v}', { v: e.title })}>
        <Ionicons name="trash-outline" size={20} color={C.dim} />
      </Pressable>
    </Pressable>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome },
  top: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,.4)' },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topTitle: { color: C.text, fontSize: 17, fontWeight: '700', flex: 1 },
  body: { flex: 1, backgroundColor: C.bg },
  banner: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: R.lg, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.line, alignItems: 'flex-start' },
  bannerT: { color: C.text, fontSize: 14, lineHeight: 20 },
  dim: { color: C.dim, fontSize: 14, lineHeight: 20 },
  h2: { color: C.text, fontSize: 18, fontWeight: '700', marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  art: { borderRadius: R.art, overflow: 'hidden', backgroundColor: C.bg3, alignItems: 'center', justifyContent: 'center' },
  t: { color: C.text, fontSize: 15, fontWeight: '700' },
  s: { color: C.dim, fontSize: 13, lineHeight: 18 },
  trash: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
});
