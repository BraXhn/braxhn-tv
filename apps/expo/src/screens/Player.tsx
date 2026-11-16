// Spelaren: enhetens egen spelare (AVPlayer på iPhone, ExoPlayer på Android) med dess reglage, helskärm och bild-i-bild.
// Appen frågar servern hur titeln ska spelas (/playback med startpositionen, så att strömmen förbereds där),
// börjar på rätt ställe, skickar framsteg var 10:e sekund och vid paus/stängning, och fortsätter med nästa avsnitt.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../theme';
import { absolute, api, playbackQuery, resumeAt, sxe, type ItemDetail, type MediaItem, type Playback } from '../api';
import { Button } from '../components/ui';
import type { Props } from '../nav';

const PROGRESS_EVERY = 10; // sekunder mellan framsteg till servern (som webbspelaren)

export default function PlayerScreen({ navigation, route }: Props<'Player'>) {
  const { id, start } = route.params;
  const insets = useSafeAreaInsets();
  const [pb, setPb] = useState<Playback | null>(null);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [next, setNext] = useState<MediaItem | null>(null);
  const [error, setError] = useState('');
  const [chrome, setChrome] = useState(true);
  const [pos, setPos] = useState(start);
  const sought = useRef(false), lastSent = useRef(0), closed = useRef(false), ended = useRef(false);

  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = 1; p.staysActiveInBackground = true; });
  const { status, error: playerError } = useEvent(player, 'statusChange', { status: player.status });

  // Liggande läge går bra i spelaren; resten av appen är stående
  useEffect(() => {
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); };
  }, []);

  // Titeln (förvalt ljudspår, längd, nästa avsnitt) och sedan hur den ska spelas
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const it = await api<ItemDetail>('/api/items/' + id);
        if (!live) return;
        setItem(it);
        const p = await api<Playback>(`/api/items/${id}/playback?${playbackQuery({ start, audio: it.defaultAudio ?? null })}`);
        if (!live) return;
        setPb(p);
        await player.replaceAsync({ uri: absolute(p.url), contentType: p.mode === 'direct' ? 'auto' : 'hls',
          metadata: { title: it.kind === 'episode' ? `${it.showTitle || ''} – ${sxe(it)} ${it.title}` : it.title } });
        if (!live) return;
        if (it.kind === 'episode' && it.show) {
          const show = await api<ItemDetail>('/api/items/' + it.show).catch(() => null);
          const eps = show?.children || [], i = eps.findIndex((e) => e.id === it.id);
          if (live && i >= 0 && eps[i + 1]) setNext(eps[i + 1]);
        }
      } catch (e: any) { if (live) setError(e?.message || 'Uppspelningen kunde inte startas'); }
    })();
    return () => { live = false; };
  }, [id, start, player]);

  // När spelaren är redo: börja där man slutade (spellistan kan redan ha satt positionen – då görs inget) och spela.
  // Uppspelningen startas här och inte direkt efter att källan satts – då avbryts den av laddningen.
  useEffect(() => {
    if (status !== 'readyToPlay' || sought.current || !pb) return;
    sought.current = true;
    if (start > 0 && Math.abs(player.currentTime - start) > 2) player.currentTime = start;
    player.play();
  }, [status, start, player, pb]);

  const send = useCallback(async (force = false) => {
    const t = player.currentTime || 0, d = player.duration || item?.duration || 0;
    if (!pb || !(t > 0) || !(d > 0)) return;
    if (!force && Math.abs(t - lastSent.current) < PROGRESS_EVERY) return;
    lastSent.current = t;
    try {
      const r = await api<{ stop?: boolean | string; error?: string }>(`/api/items/${id}/progress`, { method: 'POST', body: { position: t, duration: d } });
      // Servern kan stoppa uppspelningen (föräldraöversikten, skärmtid, administratören)
      if (r?.stop && !closed.current) { player.pause(); setError(typeof r.stop === 'string' ? r.stop : r.error || 'Uppspelningen stoppades'); }
    } catch {}
  }, [player, pb, item, id]);

  useEventListener(player, 'timeUpdate', (e) => { setPos(e.currentTime); send(); });
  useEventListener(player, 'playingChange', (e) => { if (!e.isPlaying) send(true); });
  useEventListener(player, 'playToEnd', () => {
    if (ended.current) return;
    ended.current = true;
    send(true).finally(() => {
      if (next && !closed.current) navigation.replace('Player', { id: next.id, start: resumeAt(next.position, next.duration), title: `${next.showTitle || ''} · ${sxe(next)}` });
      else if (!closed.current) navigation.goBack();
    });
  });

  // Stängning: sista framsteget och stopp av strömmen på servern
  useEffect(() => () => {
    closed.current = true;
    const t = player.currentTime || 0, d = player.duration || 0;
    if (t > 0 && d > 0) api(`/api/items/${id}/progress`, { method: 'POST', body: { position: t, duration: d } }).catch(() => {});
    api(`/api/stream/${id}/stop`, { method: 'POST' }).catch(() => {});
  }, [id, player]);

  const intro = pb?.intro && pos >= pb.intro.start && pos < pb.intro.end - 1 ? pb.intro : null;
  const msg = error || (status === 'error' ? playerError?.message || 'Uppspelningen misslyckades' : '');
  return (
    <View style={st.root}>
      <StatusBar hidden />
      <VideoView player={player} style={st.video} contentFit="contain" nativeControls allowsPictureInPicture
        fullscreenOptions={{ enable: true }} onFirstFrameRender={() => setChrome(false)} />
      {(status === 'loading' || !pb) && !msg ? (
        <View style={st.center} pointerEvents="none">
          <ActivityIndicator color={C.accent} size="large" />
          <Text style={st.wait}>{pb?.mode === 'transcode' ? 'Servern förbereder strömmen…' : 'Laddar…'}</Text>
        </View>
      ) : null}
      {msg ? (
        <View style={st.center}>
          <Ionicons name="alert-circle-outline" size={40} color={C.err} />
          <Text style={st.msg}>{msg}</Text>
          <Button label="Stäng" kind="primary" onPress={() => navigation.goBack()} />
        </View>
      ) : null}
      {chrome || msg ? (
        <View style={[st.top, { paddingTop: insets.top + 6, paddingLeft: insets.left + 6 }]} pointerEvents="box-none">
          <Pressable onPress={() => navigation.goBack()} style={st.close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Tillbaka"><Ionicons name="chevron-back" size={24} color="#fff" /></Pressable>
          <Text style={st.title} numberOfLines={1}>{route.params.title || item?.title || ''}</Text>
        </View>
      ) : (
        <Pressable onPress={() => navigation.goBack()} style={[st.close, st.closeFloat, { top: insets.top + 6, left: insets.left + 6 }]} hitSlop={10} accessibilityRole="button" accessibilityLabel="Tillbaka">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </Pressable>
      )}
      {intro ? <Button label="Hoppa över intro" kind="primary" small onPress={() => { player.currentTime = intro.end; }} style={[st.skip, { bottom: insets.bottom + 90, right: insets.right + 16 }]} /> : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1, alignSelf: 'stretch', width: '100%', height: '100%' },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  wait: { color: '#fff', fontSize: 14, opacity: 0.8 },
  msg: { color: '#fff', fontSize: 16, textAlign: 'center', lineHeight: 22 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 16, paddingBottom: 10, backgroundColor: 'rgba(0,0,0,.45)' },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  closeFloat: { position: 'absolute', backgroundColor: 'rgba(0,0,0,.45)' },
  title: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1 },
  skip: { position: 'absolute' },
});
