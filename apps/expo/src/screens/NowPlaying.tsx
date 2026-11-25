// Helskärmsspelaren: stort omslag, tidslinje att dra i, reglagen och kön (musik) eller kapitel och hastighet (tal).
import React, { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R } from '../theme';
import { fmtTime } from '../api';
import { bookCoverUrl, chapterAt, close, currentTrack, jumpTo, next, podImageUrl, prev, removeAt, seek, setRate, shuffleRest, toggle, toggleRepeat, useNowPlaying } from '../music';
import { albumCover, Cover, Sheet } from '../components/audio';
import type { Props } from '../nav';

const RATES = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2];

export default function NowPlaying({ navigation }: Props<'NowPlaying'>) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const np = useNowPlaying();
  const [view, setView] = useState<'cover' | 'list'>('cover');
  const [rateMenu, setRateMenu] = useState(false);
  if (!np.mode) {
    return (
      <View style={[ns.root, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => navigation.goBack()} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel="Stäng"><Ionicons name="chevron-down" size={28} color={C.text} /></Pressable>
        <Text style={[ns.sub, { textAlign: 'center', marginTop: 40 }]}>Inget spelas just nu.</Text>
      </View>
    );
  }
  const music = np.mode === 'music';
  const t = currentTrack();
  const ch = np.mode === 'book' ? chapterAt(np.pos) : null;
  const title = music ? t?.title || '' : np.mode === 'book' ? np.book?.title || '' : np.episode?.title || '';
  const sub = music ? t?.artist || '' : np.mode === 'book' ? [np.book?.author, ch?.title].filter(Boolean).join(' · ') : np.episode?.podcastTitle || '';
  const uri = music ? (t ? albumCover(t, 600) : null) : np.mode === 'book' ? (np.book?.cover ? bookCoverUrl(np.book.id, 600) : null) : np.episode ? podImageUrl(np.episode.podcast, 600) : null;
  const size = Math.min(width - 56, height * 0.42, 420);
  const label = music ? 'Kö' : 'Kapitel';
  const hasList = music ? np.queue.length > 1 : (np.book?.chapters.length || 0) > 1;

  return (
    <View style={[ns.root, { paddingTop: insets.top + 4, paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={ns.top}>
        <Pressable onPress={() => navigation.goBack()} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel="Minimera spelaren"><Ionicons name="chevron-down" size={28} color={C.text} /></Pressable>
        <Text style={ns.topT} numberOfLines={1}>{music ? (np.radio ? `Låtradio${np.radio.name ? ': ' + np.radio.name : ''}` : t?.album || '') : np.mode === 'book' ? 'Ljudbok' : 'Podd'}</Text>
        <Pressable onPress={() => { close(); navigation.goBack(); }} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel="Stäng spelaren"><Ionicons name="close" size={24} color={C.dim} /></Pressable>
      </View>

      {view === 'cover' || !hasList ? (
        <View style={ns.coverWrap}>
          <Pressable disabled={!music || !t?.albumId} onPress={() => { navigation.goBack(); if (t?.albumId) navigation.navigate('Album', { id: t.albumId }); }} accessibilityRole="button" accessibilityLabel="Gå till albumet">
            <Cover uri={uri} size={size} icon={np.mode === 'book' ? 'book' : np.mode === 'podcast' ? 'mic' : 'musical-notes'} style={{ borderRadius: R.md }} />
          </Pressable>
        </View>
      ) : music ? (
        <FlatList style={ns.list} data={np.queue} keyExtractor={(x, i) => x.id + ':' + i} initialScrollIndex={Math.max(0, np.idx - 2)} getItemLayout={(_, i) => ({ length: 54, offset: 54 * i, index: i })}
          renderItem={({ item, index }) => (
            <Pressable onPress={() => jumpTo(index)} style={[ns.qrow, index === np.idx && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={`Spela ${item.title}`}>
              <Cover uri={albumCover(item, 120)} size={38} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[ns.qT, index === np.idx && { color: C.accent }, index < np.idx && { color: C.dim }]} numberOfLines={1}>{item.title}</Text>
                <Text style={ns.qS} numberOfLines={1}>{item.artist || ''}</Text>
              </View>
              {index !== np.idx ? <Pressable onPress={() => removeAt(index)} hitSlop={8} style={ns.iconBtnSm} accessibilityRole="button" accessibilityLabel={`Ta bort ${item.title} ur kön`}><Ionicons name="close" size={18} color={C.dim} /></Pressable> : null}
            </Pressable>
          )} />
      ) : (
        <FlatList style={ns.list} data={np.book?.chapters || []} keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => {
            const on = item === ch;
            return (
              <Pressable onPress={() => seek(item.start)} style={[ns.qrow, on && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={`Gå till ${item.title}`}>
                <Text style={[ns.qT, { flex: 1 }, on && { color: C.accent }]} numberOfLines={1}>{item.title}</Text>
                <Text style={ns.qS}>{fmtTime(item.start)}</Text>
              </Pressable>
            );
          }} />
      )}

      <View style={ns.info}>
        <Text style={ns.title} numberOfLines={2} testID="np-title">{title}</Text>
        <Text style={[ns.sub, (np.error || np.stopped) ? { color: C.err } : null]} numberOfLines={2}>{np.stopped || np.error || sub}</Text>
      </View>

      <Scrubber pos={np.pos} dur={np.dur} onSeek={seek} />

      <View style={ns.controls}>
        {music ? (
          <Pressable onPress={shuffleRest} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel="Blanda resten av kön"><Ionicons name="shuffle" size={24} color={C.dim} /></Pressable>
        ) : (
          <Pressable onPress={() => setRateMenu(true)} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel={`Hastighet ${np.rate} gånger`}><Text style={ns.rate}>{np.rate}×</Text></Pressable>
        )}
        <Pressable onPress={prev} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel={music ? 'Föregående' : 'Bakåt 15 sekunder'}>
          <Ionicons name={music ? 'play-skip-back' : 'play-back'} size={30} color={C.text} />
        </Pressable>
        <Pressable onPress={toggle} style={ns.play} accessibilityRole="button" accessibilityLabel={np.playing ? 'Pausa' : 'Spela'}>
          {np.buffering ? <ActivityIndicator color={C.onAccent} /> : <Ionicons name={np.playing ? 'pause' : 'play'} size={34} color={C.onAccent} style={!np.playing ? { marginLeft: 4 } : null} />}
        </Pressable>
        <Pressable onPress={next} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel={music ? 'Nästa' : 'Framåt 30 sekunder'}>
          <Ionicons name={music ? 'play-skip-forward' : 'play-forward'} size={30} color={C.text} />
        </Pressable>
        {music ? (
          <Pressable onPress={toggleRepeat} style={ns.iconBtn} accessibilityRole="button" accessibilityLabel="Upprepa kön" accessibilityState={{ selected: np.repeat }}><Ionicons name="repeat" size={24} color={np.repeat ? C.accent : C.dim} /></Pressable>
        ) : <View style={ns.iconBtn} />}
      </View>

      {hasList ? (
        <Pressable onPress={() => setView(view === 'cover' ? 'list' : 'cover')} style={ns.listBtn} accessibilityRole="button" accessibilityLabel={view === 'cover' ? `Visa ${label.toLowerCase()}` : 'Visa omslaget'}>
          <Ionicons name={view === 'cover' ? 'list' : 'image-outline'} size={18} color={C.text} />
          <Text style={ns.listBtnT}>{view === 'cover' ? `${label}${music ? ` (${np.queue.length - np.idx - 1} kvar)` : ''}` : 'Omslag'}</Text>
        </Pressable>
      ) : <View style={{ height: 44 }} />}

      <Sheet visible={rateMenu} onClose={() => setRateMenu(false)} title="Hastighet" items={RATES.map((r) => ({ icon: r === np.rate ? 'checkmark' : 'speedometer-outline', label: `${r}×`, on: r === np.rate, onPress: () => setRate(r) }))} />
    </View>
  );
}

/** Tidslinjen: tryck eller dra för att spola. Visar platsen medan fingret drar och spolar när det släpps. */
function Scrubber({ pos, dur, onSeek }: { pos: number; dur: number; onSeek: (s: number) => void }) {
  const [w, setW] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const x0 = useRef(0);
  const at = (x: number) => Math.max(0, Math.min(1, x / w)) * dur;
  const shown = drag ?? pos;
  const frac = dur > 0 ? Math.min(1, shown / dur) : 0;
  return (
    <View style={ns.scrub}>
      <View style={ns.track} onLayout={(e) => { setW(e.nativeEvent.layout.width || 1); }}
        onStartShouldSetResponder={() => dur > 0} onMoveShouldSetResponder={() => dur > 0}
        onResponderGrant={(e) => { x0.current = e.nativeEvent.pageX - e.nativeEvent.locationX; setDrag(at(e.nativeEvent.locationX)); }}
        onResponderMove={(e) => setDrag(at(e.nativeEvent.pageX - x0.current))}
        onResponderRelease={(e) => { const s = at(e.nativeEvent.pageX - x0.current); setDrag(null); onSeek(s); }}
        onResponderTerminate={() => setDrag(null)}
        accessibilityRole="adjustable" accessibilityLabel="Tidslinje" accessibilityValue={{ min: 0, max: Math.round(dur), now: Math.round(shown), text: `${fmtTime(shown)} av ${fmtTime(dur)}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => onSeek(pos + (e.nativeEvent.actionName === 'increment' ? 15 : -15))}>
        <View style={ns.rail}><View style={[ns.fill, { width: `${frac * 100}%` }]} /></View>
        <View style={[ns.knob, { left: frac * w - 7 }, drag != null && { transform: [{ scale: 1.3 }] }]} />
      </View>
      <View style={ns.times}><Text style={ns.time} testID="np-time">{fmtTime(shown)}</Text><Text style={ns.time}>{dur > 0 ? '-' + fmtTime(Math.max(0, dur - shown)) : ''}</Text></View>
    </View>
  );
}

const ns = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome, paddingHorizontal: 20 },
  top: { flexDirection: 'row', alignItems: 'center', height: 48 },
  topT: { flex: 1, color: C.dim, fontSize: 13.5, fontWeight: '600', textAlign: 'center' },
  iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  iconBtnSm: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  coverWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1, marginHorizontal: -8, marginVertical: 8 },
  qrow: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 54, paddingHorizontal: 8, borderRadius: R.sm },
  qT: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  qS: { color: C.dim, fontSize: 12.5, marginTop: 1 },
  info: { marginTop: 8 },
  title: { color: C.text, fontSize: 21, fontWeight: '800' },
  sub: { color: C.dim, fontSize: 15, marginTop: 4 },
  scrub: { marginTop: 14 },
  track: { height: 28, justifyContent: 'center' },
  rail: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.15)', overflow: 'hidden' },
  fill: { height: 4, backgroundColor: C.accent },
  knob: { position: 'absolute', top: 7, width: 14, height: 14, borderRadius: 7, backgroundColor: C.text },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  play: { width: 70, height: 70, borderRadius: 35, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  rate: { color: C.text, fontSize: 16, fontWeight: '700' },
  listBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, marginTop: 10, alignSelf: 'center', paddingHorizontal: 16, borderRadius: R.pill, backgroundColor: C.bg2 },
  listBtnT: { color: C.text, fontSize: 14, fontWeight: '600' },
});
