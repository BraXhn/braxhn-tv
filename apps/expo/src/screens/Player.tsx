// Spelaren: enhetens egen spelare (AVPlayer på iPhone, ExoPlayer på Android) med dess reglage, helskärm och bild-i-bild.
// Appen frågar servern hur titeln ska spelas (/playback med startpositionen, så att strömmen förbereds där),
// börjar på rätt ställe, skickar framsteg var 10:e sekund och vid paus/stängning, och fortsätter med nästa avsnitt.
// En nedladdad titel spelas från telefonen (fungerar utan nät), med de nedladdade undertexterna ritade ovanpå bilden.
// Positionen går till servern som vanligt när den svarar (skärmtiden räknas och kan säga stopp); utan nät sparas den i
// telefonen och skickas med "at" senare, och den senaste skärmtidsstatusen avgör om det får spelas (offline.ts).
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
import { nowPlaying, pause as pauseAudio } from '../music';
import * as off from '../offline';
import { cueAt, parseVtt, startAt, type Cue } from '../offlinecore';
import type { Props } from '../nav';
import { notePlayback } from '../feedback';

const PROGRESS_EVERY = 10; // sekunder mellan framsteg till servern (som webbspelaren)

export default function PlayerScreen({ navigation, route }: Props<'Player'>) {
  const { id, start } = route.params;
  const insets = useSafeAreaInsets();
  const [pb, setPb] = useState<Playback | null>(null);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [next, setNext] = useState<{ id: number; start: number; title: string } | null>(null);
  // Nedladdad fil (bestäms när spelaren öppnas) och dess undertexter
  const [local] = useState(() => off.localVideo(id));
  const [subs, setSubs] = useState<{ label: string; cues: Cue[] }[]>([]);
  const [subIdx, setSubIdx] = useState(-1);
  const beat = useRef(0);
  const [error, setError] = useState('');
  // Uppspelningen kunde inte startas (inte ett stopp från skärmtiden eller en vuxen): då går felet att rapportera
  const [startFailed, setStartFailed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [pos, setPos] = useState(start);
  const sought = useRef(false), lastSent = useRef(0), closed = useRef(false), ended = useRef(false);

  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = local?.subs.length ? 0.25 : 1; p.staysActiveInBackground = true; });
  const { status, error: playerError } = useEvent(player, 'statusChange', { status: player.status });

  // Liggande läge går bra i spelaren; resten av appen är stående. Musik eller en ljudbok som spelar pausas.
  useEffect(() => {
    if (nowPlaying.get().playing) pauseAudio();
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); };
  }, []);

  // Titeln (förvalt ljudspår, längd, nästa avsnitt) och sedan hur den ska spelas
  useEffect(() => {
    let live = true;
    const nextOf = (x: MediaItem) => ({ id: x.id, start: resumeAt(x.position, x.duration), title: `${x.showTitle || ''} · ${sxe(x)}` });
    (async () => {
      if (local) {
        // Nedladdad: skärmtiden först (servern om den svarar, annars den senaste statusen och tiden räknad här)
        const e = local.entry;
        const reachable = await off.refreshScreen(3000);
        if (!live) return;
        const g = off.screenGate(false);
        if (!g.allowed) { setError(g.message); return; }
        setPb({ mode: 'direct', url: local.uri, duration: e.duration || null });
        await player.replaceAsync({ uri: local.uri, contentType: 'auto', metadata: { title: e.kind === 'episode' ? `${e.show?.title || ''} – ${e.title}` : e.title } }).catch(() => {});
        const loaded: { label: string; cues: Cue[]; forced: boolean }[] = [];
        for (const s of local.subs) { try { loaded.push({ label: s.label, forced: s.forced, cues: parseVtt(await off.readText(s.name)) }); } catch {} }
        if (!live) return;
        setSubs(loaded); setSubIdx(loaded.findIndex((x) => x.forced));
        const nl = off.nextLocalEpisode(e);
        if (nl) setNext({ id: nl.id, start: startAt(nl), title: `${nl.show?.title || ''} · ${nl.sub.split(' · ').slice(1).join(' · ')}` });
        if (!reachable) return;
        // Servern svarar: titeln (nästa avsnitt) och intro/eftertexter (info=1 räknas inte som en ström)
        try {
          const [it, info] = await Promise.all([api<ItemDetail>('/api/items/' + id, { timeout: 6000 }), api<Playback>(`/api/items/${id}/playback?${playbackQuery({})}&info=1`, { timeout: 6000 }).catch(() => null)]);
          if (!live) return;
          setItem(it);
          if (info) setPb({ ...info, mode: 'direct', url: local.uri });
          if (!nl && it.kind === 'episode' && it.show) {
            const show = await api<ItemDetail>('/api/items/' + it.show, { timeout: 6000 }).catch(() => null);
            const eps = show?.children || [], i = eps.findIndex((x) => x.id === it.id);
            if (live && i >= 0 && eps[i + 1]) setNext(nextOf({ ...eps[i + 1], showTitle: it.showTitle }));
          }
        } catch {}
        return;
      }
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
          if (live && i >= 0 && eps[i + 1]) setNext(nextOf(eps[i + 1]));
        }
      } catch (e: any) { if (live) { setError(e?.message || 'Uppspelningen kunde inte startas'); setStartFailed(true); } }
    })();
    return () => { live = false; };
  }, [id, start, player, local]);

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
    if (local) { await sendLocal(t, d); return; }
    try {
      const r = await api<{ stop?: boolean | string; error?: string }>(`/api/items/${id}/progress`, { method: 'POST', body: { position: t, duration: d } });
      // Servern kan stoppa uppspelningen (föräldraöversikten, skärmtid, administratören)
      if (r?.stop && !closed.current) { player.pause(); setError(typeof r.stop === 'string' ? r.stop : r.error || 'Uppspelningen stoppades'); }
    } catch {}
  }, [player, pb, item, id, local]);

  /** Nedladdad titel: till servern när den svarar, annars i telefonen (skickas med "at" senare) och skärmtiden räknas här */
  const sendLocal = useCallback(async (t: number, d: number) => {
    const done = d > 0 && (t / d > 0.92 || (d - t < 120 && t > 60));
    const now = Date.now(), played = beat.current ? (now - beat.current) / 1000 : 0;
    beat.current = player.playing ? now : 0;
    try {
      const r = await api<{ stop?: boolean | string; error?: string; screenTime?: any }>(`/api/items/${id}/progress`, { method: 'POST', body: { position: t, duration: d }, timeout: 6000 });
      off.savePosition('movie', id, t, { sent: true, done });
      off.noteScreen(r?.screenTime || { limited: false });
      if (r?.stop && !closed.current) { player.pause(); setError(r?.screenTime?.allowed === false ? r.screenTime.message || 'Skärmtiden är slut för i dag.' : typeof r.stop === 'string' ? r.stop : r.error || 'Uppspelningen stoppades'); }
    } catch (err: any) {
      if (err?.status !== 0) return; // servern svarade (t.ex. 403): inget att spara här
      off.savePosition('movie', id, t, { done });
      off.countOffline(played);
      const g = off.screenGate(false);
      if (!g.allowed && !closed.current) { player.pause(); setError(g.message); }
    }
  }, [player, id]);

  useEventListener(player, 'timeUpdate', (e) => { setPos(e.currentTime); send(); });
  useEventListener(player, 'playingChange', (e) => { if (e.isPlaying) beat.current = Date.now(); else send(true); });
  useEventListener(player, 'playToEnd', () => {
    if (ended.current) return;
    ended.current = true;
    send(true).finally(() => {
      if (next && !closed.current) navigation.replace('Player', next);
      else if (!closed.current) navigation.goBack();
    });
  });

  // Stängning: sista framsteget och stopp av strömmen på servern
  useEffect(() => () => {
    closed.current = true;
    const t = player.currentTime || 0, d = player.duration || 0;
    if (local) {
      // Sparas i telefonen först (appen kan stängas innan servern svarat), skickas sedan
      if (t > 0 && d > 0) { off.savePosition('movie', id, t, { done: t / d > 0.92 || (d - t < 120 && t > 60) }); off.syncSoon(300); }
      return;
    }
    if (t > 0 && d > 0) api(`/api/items/${id}/progress`, { method: 'POST', body: { position: t, duration: d } }).catch(() => {});
    api(`/api/stream/${id}/stop`, { method: 'POST' }).catch(() => {});
  }, [id, player, local]);

  const intro = pb?.intro && pos >= pb.intro.start && pos < pb.intro.end - 1 ? pb.intro : null;
  // Undertexter (nedladdade): tryck för att byta mellan spåren och av
  const ccBtn = subs.length ? (
    <Pressable onPress={() => setSubIdx((i) => (i + 1 < subs.length ? i + 1 : -1))} style={st.cc} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Undertexter: ${subIdx >= 0 ? subs[subIdx].label : 'av'}. Tryck för att byta.`}>
      <Ionicons name="text" size={16} color="#fff" /><Text style={st.ccText} numberOfLines={1}>{subIdx >= 0 ? subs[subIdx].label : 'Av'}</Text>
    </Pressable>
  ) : null;
  const cue = subIdx >= 0 && subs[subIdx] ? cueAt(subs[subIdx].cues, pos) : '';
  const msg = error || (status === 'error' ? playerError?.message || 'Uppspelningen misslyckades' : '');
  const failed = !!msg && (startFailed || status === 'error');
  // Till Feedback: titeln som spelas och felet (förval och teknisk information i felrapporten)
  useEffect(() => { notePlayback(id, failed ? msg : ''); }, [id, failed, msg]);
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
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {failed ? <Button label="Rapportera felet" icon="chatbox-ellipses-outline" onPress={() => navigation.replace('Feedback', { kind: 'bug', area: 'uppspelning' })} /> : null}
            <Button label="Stäng" kind="primary" onPress={() => navigation.goBack()} />
          </View>
        </View>
      ) : null}
      {chrome || msg ? (
        <View style={[st.top, { paddingTop: insets.top + 6, paddingLeft: insets.left + 6 }]} pointerEvents="box-none">
          <Pressable onPress={() => navigation.goBack()} style={st.close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Tillbaka"><Ionicons name="chevron-back" size={24} color="#fff" /></Pressable>
          <Text style={st.title} numberOfLines={1}>{route.params.title || item?.title || local?.entry.title || ''}</Text>
          {local ? <Ionicons name="download" size={18} color={C.ok} accessibilityLabel="Spelas från telefonen" /> : null}
          {ccBtn}
        </View>
      ) : (
        <Pressable onPress={() => navigation.goBack()} style={[st.close, st.closeFloat, { top: insets.top + 6, left: insets.left + 6 }]} hitSlop={10} accessibilityRole="button" accessibilityLabel="Tillbaka">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </Pressable>
      )}
      {!(chrome || msg) && ccBtn ? <View style={{ position: 'absolute', top: insets.top + 11, right: insets.right + 12 }}>{ccBtn}</View> : null}
      {cue && !msg ? <View style={[st.subWrap, { bottom: insets.bottom + 70 }]} pointerEvents="none"><Text style={st.subText}>{cue}</Text></View> : null}
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
  subWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  subText: { color: '#fff', fontSize: 18, lineHeight: 24, textAlign: 'center', backgroundColor: 'rgba(0,0,0,.6)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  cc: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: 'rgba(255,255,255,.15)', maxWidth: 140 },
  ccText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
