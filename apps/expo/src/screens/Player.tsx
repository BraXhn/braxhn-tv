// Spelaren: enhetens egen spelare (AVPlayer på iPhone, ExoPlayer på Android) med dess reglage, helskärm och bild-i-bild.
// Appen frågar servern hur titeln ska spelas (/playback med startpositionen, så att strömmen förbereds där) samtidigt
// som titelns uppgifter hämtas (startcore.ts), börjar på rätt ställe, skickar framsteg var 10:e sekund och vid
// paus/stängning, och fortsätter med nästa avsnitt. Sammanfattning, intro och eftertexter har knappar (eftertexterna =
// Nästa avsnitt), som trycks av sig själva efter en kort nedräkning när kontot valt det (skipcore.ts, som webben); när
// eftertexterna börjar förvärms nästa avsnitt, och när avsnittet är slut visas kortet med nedräkning (autoNext).
// En nedladdad titel spelas från telefonen (fungerar utan nät), med de nedladdade undertexterna ritade ovanpå bilden.
// Positionen går till servern som vanligt när den svarar (skärmtiden räknas och kan säga stopp); utan nät sparas den i
// telefonen och skickas med "at" senare, och den senaste skärmtidsstatusen avgör om det får spelas (offline.ts).
// Spolning utanför bufferten i en omkodning startar om strömmen vid målet med korta segment där (seekcore.ts).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useVideoPlayer, VideoView, type AudioTrack, type SubtitleTrack } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../theme';
import { absolute, api, currentBw, playBw, playbackQuery, resumeAt, sxe, warmPlay, type ItemDetail, type MediaItem, type Playback } from '../api';
import { Button } from '../components/ui';
import { nowPlaying, pause as pauseAudio } from '../music';
import * as off from '../offline';
import { cueAt, isWatched, parseVtt, startAt, type Cue, type ScreenStatus } from '../offlinecore';
import { gateLeft, leftView, playerLeft, type Left } from '../screenleft';
import { decideSeek, fragAt, indexUrl, parseFrags, pidOf, READY_EVERY_MS, readyFrom, readyUrl, restartsOn, runAfterSeek, seekJump, type Frag, type Known, type Sample } from '../seekcore';
import type { Props } from '../nav';
import { notePlayback } from '../feedback';
import { startPlayback } from '../startcore';
import { nextPlan, SKIP_DELAY, skipPlan, type SkipKind, type SkipPlan } from '../skipcore';
import { t } from '../i18n';

const PROGRESS_EVERY = 10; // sekunder mellan framsteg till servern (som webbspelaren)
/** Knappen och nedräkningens text per del (som webben) */
const SKIP_TEXT: Record<SkipKind, () => [string, string]> = {
  recap: () => [t('Hoppa över sammanfattning'), t('Hoppar över sammanfattningen…')],
  intro: () => [t('Hoppa över intro'), t('Hoppar över intro…')],
  credits: () => [t('Nästa avsnitt'), t('Nästa avsnitt startar…')],
};
const titleOf = (it: ItemDetail) => (it.kind === 'episode' ? `${it.showTitle || ''} – ${sxe(it)} ${it.title}` : it.title);

// Omkodad ström: adressen, spellistans segment, segmentet där omkodningen på servern började, om bild har visats,
// serverns senaste svar om vad den har klart (/hls/ready) och ett nummer som ändras när svaret blir inaktuellt
type Stream = { url: string; frags: Frag[]; runSeg: number; started: boolean; known: Known | null; seq: number };

export default function PlayerScreen({ navigation, route }: Props<'Player'>) {
  const { id, start } = route.params;
  const insets = useSafeAreaInsets();
  const [pb, setPb] = useState<Playback | null>(null);
  const pbNow = useRef(pb); pbNow.current = pb; // senaste pb i återanrop som inte byggs om (eftertexterna för isWatched)
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
  const lastSent = useRef(0), closed = useRef(false), ended = useRef(false);
  // Nästa avsnitt är nedladdat (spelas från telefonen: inget att förvärma)
  const nextLocal = useRef(false);
  // Delar som hoppats över eller där nedräkningen avbrutits (högst en gång per uppspelning), nedräkningen som pågår och
  // kortet när avsnittet är slut
  const skipDone = useRef(new Set<string>());
  const [skipCd, setSkipCd] = useState<{ kind: SkipKind; n: number } | null>(null);
  const [endCard, setEndCard] = useState<{ auto: boolean; n: number } | null>(null);
  // Var och om spelaren ska börja när källan är redo (start, och efter en omstart vid en spolning)
  const want = useRef<{ t: number; play: boolean } | null>({ t: start, play: true });
  // Omkodad ström (Stream ovan)
  const stream = useRef<Stream | null>(null);
  const sample = useRef<Sample | null>(null);
  // Omstart vid spolning: pågår (nummer, så att en äldre som blir klar senare inte tar över), ljudspåret som skickas,
  // spåren i spelaren som väljs igen i den nya strömmen
  const restartGen = useRef(0), audioParam = useRef<number | null>(null);
  const keepTracks = useRef<{ audio: AudioTrack | null; sub: SubtitleTrack | null } | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Skärmtiden kvar idag (screenleft.ts): först den senast kända statusen och tiden räknad utan nät, sedan serverns svar
  // på varje framstegsrapport och utan nät appens egen räkning. null = ingen skärmtid eller ingen gräns idag.
  const [left, setLeft] = useState<Left | null>(() => gateLeft(off.screenGate(false)));
  const leftFromProgress = useRef(false);
  const { width } = useWindowDimensions();

  // Mätningen var 0,25 s (inte 1 s) så att en spolning märks direkt – annars hinner spelaren börja hämta 6 s-segmentet
  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = 0.25; p.staysActiveInBackground = true; });
  const { status, error: playerError } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

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
        setLeft(gateLeft(g));
        setPb({ mode: 'direct', url: local.uri, duration: e.duration || null });
        await player.replaceAsync({ uri: local.uri, contentType: 'auto', metadata: { title: e.kind === 'episode' ? `${e.show?.title || ''} – ${e.title}` : e.title } }).catch(() => {});
        const loaded: { label: string; cues: Cue[]; forced: boolean }[] = [];
        for (const s of local.subs) { try { loaded.push({ label: s.label, forced: s.forced, cues: parseVtt(await off.readText(s.name)) }); } catch {} }
        if (!live) return;
        setSubs(loaded); setSubIdx(loaded.findIndex((x) => x.forced));
        const nl = off.nextLocalEpisode(e);
        nextLocal.current = !!nl;
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
      // Skärmtiden kvar direkt (bredvid starten, väntar inte på den): serverns status, sparad för uppspelning utan nät.
      // Framstegssvaren tar över; ett svar som kommer efter ett av dem gäller inte.
      api<ScreenStatus>('/api/screentime', { timeout: 6000 }).then((sc) => {
        off.noteScreen(sc);
        if (live && !leftFromProgress.current) setLeft(playerLeft(sc));
      }).catch(() => {});
      try {
        // Titeln och /playback samtidigt (startcore.ts): den tidiga frågan är förvärmningens (utan ljudspår) och tar
        // över en förvärmd ström. Väljer servern ett annat ljud än titelns förval frågar appen igen med prev.
        // Utanför hemmet: samma bw som förvärmningen (eller färsk mätning, högst 1,5 s väntan) i båda frågorna.
        const bw = playBw(id, start);
        const r = await startPlayback({
          early: async () => api<Playback>(`/api/items/${id}/playback?${playbackQuery({ start, bw: await bw })}`),
          item: () => api<ItemDetail>('/api/items/' + id),
          again: async (audio, first) => api<Playback>(`/api/items/${id}/playback?${playbackQuery({ start, audio, prev: pidOf(first?.url), bw: await bw })}`),
          drop: (x) => { const pid = pidOf(x.url); if (pid) api(`/api/stream/${id}/stop?pid=${pid}`, { method: 'POST' }).catch(() => {}); },
          live: () => live,
        });
        if (!r || !live) return;
        const it = r.item, p = r.pb;
        setItem(it);
        audioParam.current = r.audio;
        setPb(p);
        if (p.mode === 'transcode' && restartsOn(Platform.OS)) watchStream(p.url, start);
        await player.replaceAsync({ uri: absolute(p.url), contentType: p.mode === 'direct' ? 'auto' : 'hls',
          metadata: { title: titleOf(it) } });
        if (!live) return;
        if (it.kind === 'episode' && it.show) {
          const show = await api<ItemDetail>('/api/items/' + it.show).catch(() => null);
          const eps = show?.children || [], i = eps.findIndex((e) => e.id === it.id);
          if (live && i >= 0 && eps[i + 1]) setNext(nextOf(eps[i + 1]));
        }
      } catch (e: any) { if (live) { setError(e?.message || t('Uppspelningen kunde inte startas')); setStartFailed(true); } }
    })();
    return () => { live = false; };
  }, [id, start, player, local]);

  // När spelaren är redo: börja där man slutade (spellistan kan redan ha satt positionen – då görs inget) och spela.
  // Uppspelningen startas här och inte direkt efter att källan satts – då avbryts den av laddningen.
  // Efter en omstart vid en spolning: till målet, och spela bara om spelaren spelade (en pausad film förblir pausad).
  useEffect(() => {
    const w = want.current;
    if (status !== 'readyToPlay' || !w || !pb || restarting) return;
    want.current = null;
    if (w.t > 0 && Math.abs(player.currentTime - w.t) > 2) player.currentTime = w.t;
    if (w.play) player.play();
  }, [status, player, pb, restarting]);

  /** Omkodad ström: spellistans segment (för beslutet vid en spolning). Hämtas bredvid spelaren, påverkar inte starten. */
  const watchStream = useCallback((url: string, from: number) => {
    const s: Stream = { url, frags: [], runSeg: -1, started: false, known: null, seq: 0 };
    stream.current = s; sample.current = null;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
    fetch(absolute(indexUrl(url)), { signal: ctl.signal }).then((r) => (r.ok ? r.text() : '')).then((txt) => {
      if (stream.current !== s) return;
      s.frags = parseFrags(txt);
      s.runSeg = Math.max(0, fragAt(s.frags, from));
    }).catch(() => {}).finally(() => clearTimeout(timer));
  }, []);

  /**
   * Spolning utanför bufferten i en omkodning: strömmen startas om vid målet (/playback med start och prev). Servern
   * ger korta segment där och stoppar den gamla strömmen; ljudspåret är detsamma, spåren i spelaren väljs igen.
   */
  const restartAt = useCallback(async (to: number, play: boolean) => {
    const it = item, old = stream.current;
    if (!it || !old) return;
    const gen = ++restartGen.current;
    stream.current = null; sample.current = null;
    keepTracks.current = { audio: player.audioTrack, sub: player.subtitleTrack };
    want.current = { t: to, play };
    setRestarting(true);
    // Den gamla källan bort direkt: spelaren slutar hämta 6 s-segmentet (servern stoppar den strömmen ändå)
    player.replace(null);
    let p: Playback;
    try { p = await api<Playback>(`/api/items/${id}/playback?${playbackQuery({ start: to, audio: audioParam.current, prev: pidOf(old.url), bw: currentBw() })}`); }
    catch (e: any) {
      if (gen !== restartGen.current || closed.current) return;
      setRestarting(false);
      setError(e?.message || t('Uppspelningen kunde inte startas')); setStartFailed(true);
      return;
    }
    // Ett nyare försök (en spolning till) eller stängning: strömmen som just startades behövs inte
    if (gen !== restartGen.current || closed.current) { stopReplaced(p.url); return; }
    setPb(p);
    if (p.mode === 'transcode' && restartsOn(Platform.OS)) watchStream(p.url, to);
    await player.replaceAsync({ uri: absolute(p.url), contentType: p.mode === 'direct' ? 'auto' : 'hls', metadata: { title: titleOf(it) } }).catch(() => {});
    if (gen === restartGen.current) setRestarting(false);
  }, [item, id, player, watchStream]);

  /** Strömmen ersattes innan den användes: bara den stoppas (replaced=1 – uppspelningen fortsätter, inget stopp räknas) */
  const stopReplaced = useCallback((url: string) => {
    const pid = pidOf(url);
    if (pid) api(`/api/stream/${id}/stop?pid=${pid}&replaced=1`, { method: 'POST' }).catch(() => {});
  }, [id]);

  /** Bilden visas i strömmen: spolningar räknas från nu (hoppet till startpositionen är spelarens eget) */
  const markStarted = useCallback(() => {
    const s = stream.current;
    if (s && !s.started) { s.started = true; sample.current = null; }
  }, []);

  /** Varje mätning: har positionen hoppat (spolning)? Utanför bufferten i en omkodning startas strömmen om vid målet. */
  const watchSeek = useCallback((pos: number, buf: number) => {
    const s = stream.current;
    if (!s) return;
    const prev = sample.current;
    const now: Sample = { pos, buf: Number.isFinite(buf) ? buf : 0, at: Date.now(), playing: player.playing, rate: player.playbackRate };
    sample.current = now;
    if (!prev || !s.started || !seekJump(prev, now)) return;
    const at = Date.now();
    if (decideSeek(prev, pos, s, at)) { restartAt(pos, prev.playing || player.playing); return; }
    s.runSeg = runAfterSeek(prev, pos, s, at);
    // Servern kan ha startat om omkodningen vid målet: svaret (och ett som är på väg) gäller inte längre
    s.known = null; s.seq++;
  }, [player, restartAt]);

  // Vad servern har klart frågas i förväg, var 4:e sekund medan en omkodad ström spelar (inte under en omstart, då är
  // stream.current tom). Vid spolningen har spelaren redan bett om segmentet vid målet – då är det för sent att fråga.
  // Misslyckas frågan (äldre server, inget nät) gäller gissningen i seekcore.ts.
  useEffect(() => {
    if (local) return;
    let busy = false;
    const iv = setInterval(async () => {
      const s = stream.current;
      if (busy || !s || !s.started || !s.frags.length || !player.playing) return;
      busy = true;
      const seq = s.seq, sent = Date.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
      try {
        const r = await fetch(absolute(readyUrl(s.url)), { headers: { Accept: 'application/json' }, signal: ctl.signal });
        const j = r.ok ? await r.json() : null;
        if (j && stream.current === s && s.seq === seq) s.known = { range: readyFrom(s.frags, j), at: sent };
      } catch {} finally { clearTimeout(timer); busy = false; }
    }, READY_EVERY_MS);
    return () => clearInterval(iv);
  }, [local, player]);

  const send = useCallback(async (force = false) => {
    const secs = player.currentTime || 0, d = player.duration || item?.duration || 0;
    if (!pb || !(secs > 0) || !(d > 0)) return;
    if (!force && Math.abs(secs - lastSent.current) < PROGRESS_EVERY) return;
    lastSent.current = secs;
    if (local) { await sendLocal(secs, d); return; }
    try {
      const r = await api<{ stop?: boolean | string; error?: string; screenTime?: ScreenStatus | null }>(`/api/items/${id}/progress`, { method: 'POST', body: { position: secs, duration: d } });
      // Skärmtiden kvar (null = ingen skärmtid), och sparad för uppspelning utan nät
      if (!closed.current) { off.noteScreen(r?.screenTime || { limited: false }); leftFromProgress.current = true; setLeft(playerLeft(r?.screenTime)); }
      // Servern kan stoppa uppspelningen (föräldraöversikten, skärmtid, administratören)
      if (r?.stop && !closed.current) { player.pause(); setError(typeof r.stop === 'string' ? r.stop : r.error || t('Uppspelningen stoppades')); }
    } catch {}
  }, [player, pb, item, id, local]);

  /** Nedladdad titel: till servern när den svarar, annars i telefonen (skickas med "at" senare) och skärmtiden räknas här */
  const sendLocal = useCallback(async (secs: number, d: number) => {
    const done = isWatched(secs, d, pbNow.current?.credits);
    const now = Date.now(), played = beat.current ? (now - beat.current) / 1000 : 0;
    beat.current = player.playing ? now : 0;
    try {
      const r = await api<{ stop?: boolean | string; error?: string; screenTime?: any }>(`/api/items/${id}/progress`, { method: 'POST', body: { position: secs, duration: d }, timeout: 6000 });
      off.savePosition('movie', id, secs, { sent: true, done });
      off.noteScreen(r?.screenTime || { limited: false });
      if (!closed.current) setLeft(playerLeft(r?.screenTime));
      if (r?.stop && !closed.current) { player.pause(); setError(r?.screenTime?.allowed === false ? r.screenTime.message || t('Skärmtiden är slut för i dag.') : typeof r.stop === 'string' ? r.stop : r.error || t('Uppspelningen stoppades')); }
    } catch (err: any) {
      if (err?.status !== 0) return; // servern svarade (secs.ex. 403): inget att spara här
      off.savePosition('movie', id, secs, { done });
      off.countOffline(played);
      const g = off.screenGate(false);
      if (!closed.current) setLeft(gateLeft(g));
      if (!g.allowed && !closed.current) { player.pause(); setError(g.message); }
    }
  }, [player, id]);

  // Positionen på hela sekunder (introknappen) – med nedladdade undertexter exakt, för texten
  useEventListener(player, 'timeUpdate', (e) => {
    setPos(subs.length ? e.currentTime : Math.floor(e.currentTime)); send();
    if (!restarting) watchSeek(e.currentTime, e.bufferedPosition ?? player.bufferedPosition);
  });
  useEventListener(player, 'playingChange', (e) => {
    if (e.isPlaying) { beat.current = Date.now(); markStarted(); }
    else send(true);
  });
  // Den nya strömmen efter en omstart: samma ljud- och undertextspår som förut (om spelaren visar några)
  useEventListener(player, 'sourceLoad', () => {
    const k = keepTracks.current;
    if (!k) return;
    keepTracks.current = null;
    const same = (a: { language?: string; label?: string } | null, b: { language?: string; label?: string }) => !!a && a.language === b.language && a.label === b.label;
    try {
      if (k.sub) { const x = player.availableSubtitleTracks.find((s) => same(k.sub, s)); if (x) player.subtitleTrack = x; }
      if (k.audio) { const x = player.availableAudioTracks.find((s) => same(k.audio, s)); if (x) player.audioTrack = x; }
    } catch {}
  });
  // ---------- sammanfattning, intro, eftertexter och nästa avsnitt ----------
  const plan = skipPlan(pb, pos, { hasNext: !!next, done: skipDone.current });
  const planRef = useRef<SkipPlan | null>(null);
  planRef.current = plan;
  /** Förvärm nästa avsnitt (samma fråga som starten i startcore.ts, plus warm=1). warmPlay frågar högst var 15:e s. */
  const warmNext = useCallback(() => { if (next && !nextLocal.current) warmPlay(next.id, next.start); }, [next]);
  const openNext = useCallback(() => { if (next && !closed.current) navigation.replace('Player', next); }, [next, navigation]);
  /** Till nästa avsnitt mitt i eftertexterna: positionen först (som när avsnittet tar slut) */
  const goNext = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    send(true).finally(openNext);
  }, [send, openNext]);
  const doSkip = useCallback((p: SkipPlan) => {
    skipDone.current.add(p.kind); setSkipCd(null);
    if (p.to === 'next') goNext(); else player.currentTime = p.to;
  }, [goNext, player]);
  // En ny del börjar: nedräkningen när kontot valt att hoppa över den, annars bara knappen
  const planKey = plan ? `${plan.kind}:${plan.auto ? 1 : 0}` : '';
  useEffect(() => { setSkipCd(plan?.auto ? { kind: plan.kind, n: SKIP_DELAY } : null); }, [planKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Eftertexterna går: nästa avsnitt förvärms (och hålls varmt) redan nu
  useEffect(() => { if (plan?.to === 'next') warmNext(); }, [pos, plan?.to, warmNext]);
  // Nedräkningen väntar medan spelaren är pausad
  useEffect(() => {
    if (!skipCd) return;
    const iv = setInterval(() => { if (player.playing && !closed.current) setSkipCd((c) => (c ? { ...c, n: c.n - 1 } : c)); }, 1000);
    return () => clearInterval(iv);
  }, [skipCd?.kind, player]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!skipCd || skipCd.n > 0) return;
    const p = planRef.current;
    setSkipCd(null);
    if (p && p.kind === skipCd.kind) doSkip(p);
  }, [skipCd, doSkip]);
  const cancelSkip = () => { if (skipCd) skipDone.current.add(skipCd.kind); setSkipCd(null); };

  // Slut: kortet med nedräkning till nästa avsnitt (kontots val, autoNext), direkt med 0 s, annars tillbaka
  useEventListener(player, 'playToEnd', () => {
    if (ended.current) return;
    ended.current = true;
    setSkipCd(null);
    send(true).finally(() => {
      if (closed.current) return;
      const np = nextPlan(pb, !!next);
      if (!np) { navigation.goBack(); return; }
      if (np.auto && np.seconds === 0) { openNext(); return; }
      warmNext();
      setEndCard({ auto: np.auto, n: np.seconds });
    });
  });
  useEffect(() => {
    if (!endCard?.auto) return;
    const iv = setInterval(() => { warmNext(); setEndCard((c) => (c ? { ...c, n: c.n - 1 } : c)); }, 1000);
    return () => clearInterval(iv);
  }, [endCard?.auto, warmNext]);
  useEffect(() => { if (endCard?.auto && endCard.n <= 0) { setEndCard(null); openNext(); } }, [endCard, openNext]);

  // Stängning: sista framsteget och stopp av strömmen på servern
  useEffect(() => () => {
    closed.current = true;
    const secs = player.currentTime || 0, d = player.duration || 0;
    if (local) {
      // Sparas i telefonen först (appen kan stängas innan servern svarat), skickas sedan
      if (secs > 0 && d > 0) { off.savePosition('movie', id, secs, { done: isWatched(secs, d, pbNow.current?.credits) }); off.syncSoon(300); }
      return;
    }
    if (secs > 0 && d > 0) api(`/api/items/${id}/progress`, { method: 'POST', body: { position: secs, duration: d } }).catch(() => {});
    restartGen.current++; // en omstart som pågår ska inte ta över efter stängningen
    api(`/api/stream/${id}/stop`, { method: 'POST' }).catch(() => {});
  }, [id, player, local]);

  // Undertexter (nedladdade): tryck för att byta mellan spåren och av
  const ccBtn = subs.length ? (
    <Pressable onPress={() => setSubIdx((i) => (i + 1 < subs.length ? i + 1 : -1))} style={st.cc} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('Undertexter: {v}. Tryck för att byta.', { v: subIdx >= 0 ? subs[subIdx].label : t('av') })}>
      <Ionicons name="text" size={16} color="#fff" /><Text style={st.ccText} numberOfLines={1}>{subIdx >= 0 ? subs[subIdx].label : t('Av')}</Text>
    </Pressable>
  ) : null;
  const cue = subIdx >= 0 && subs[subIdx] ? cueAt(subs[subIdx].cues, pos) : '';
  // Under en omstart vid spolning kan den gamla strömmens fel komma fram – det gäller inte längre
  const msg = error || (status === 'error' && !restarting ? playerError?.message || t('Uppspelningen misslyckades') : '');
  const failed = !!msg && (startFailed || status === 'error');
  // Skärmtiden: tiden kvar medan appens överkant syns och när filmen är pausad, varningen de sista fem minuterna hela tiden
  const lv = msg ? null : leftView(left, { paused: !isPlaying && !!pb && status === 'readyToPlay', chrome, compact: width < 600 });
  const pill = lv?.pill ? <Text style={[st.left, lv.low && st.leftLow]} numberOfLines={1}>{lv.pill}</Text> : null;
  // Till Feedback: titeln som spelas och felet (förval och teknisk information i felrapporten)
  useEffect(() => { notePlayback(id, failed ? msg : ''); }, [id, failed, msg]);
  return (
    <View style={st.root}>
      <StatusBar hidden />
      <VideoView player={player} style={st.video} contentFit="contain" nativeControls allowsPictureInPicture
        fullscreenOptions={{ enable: true }} onFirstFrameRender={() => { setChrome(false); if (!want.current) markStarted(); }} />
      {(status === 'loading' || !pb || restarting) && !msg ? (
        <View style={st.center} pointerEvents="none">
          <ActivityIndicator color={C.accent} size="large" />
          <Text style={st.wait}>{pb?.mode === 'transcode' ? t('Servern förbereder strömmen…') : t('Laddar…')}</Text>
        </View>
      ) : null}
      {msg ? (
        <View style={st.center}>
          <Ionicons name="alert-circle-outline" size={40} color={C.err} />
          <Text style={st.msg}>{msg}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {failed ? <Button label={t('Rapportera felet')} icon="chatbox-ellipses-outline" onPress={() => navigation.replace('Feedback', { kind: 'bug', area: 'uppspelning' })} /> : null}
            <Button label={t('Stäng')} kind="primary" onPress={() => navigation.goBack()} />
          </View>
        </View>
      ) : null}
      {chrome || msg ? (
        <View style={[st.top, { paddingTop: insets.top + 6, paddingLeft: insets.left + 6 }]} pointerEvents="box-none">
          <Pressable onPress={() => navigation.goBack()} style={st.close} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Tillbaka')}><Ionicons name="chevron-back" size={24} color="#fff" /></Pressable>
          <Text style={st.title} numberOfLines={1}>{route.params.title || item?.title || local?.entry.title || ''}</Text>
          {pill}
          {local ? <Ionicons name="download" size={18} color={C.ok} accessibilityLabel={t('Spelas från telefonen')} /> : null}
          {ccBtn}
        </View>
      ) : (
        <Pressable onPress={() => navigation.goBack()} style={[st.close, st.closeFloat, { top: insets.top + 6, left: insets.left + 6 }]} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Tillbaka')}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </Pressable>
      )}
      {!(chrome || msg) && (ccBtn || pill) ? <View style={[st.floatRight, { top: insets.top + 11, right: insets.right + 12 }]} pointerEvents="box-none">{pill}{ccBtn}</View> : null}
      {lv?.warn ? (
        <View style={[st.warnWrap, { top: insets.top + 62 }]} pointerEvents="none">
          <Text style={st.warn} accessibilityLiveRegion="polite">{lv.warn}</Text>
        </View>
      ) : null}
      {cue && !msg ? <View style={[st.subWrap, { bottom: insets.bottom + 70 }]} pointerEvents="none"><Text style={st.subText}>{cue}</Text></View> : null}
      {plan && !msg && !endCard ? (
        <View style={[st.skip, { bottom: insets.bottom + 90, right: insets.right + 16 }]} pointerEvents="box-none">
          {skipCd ? (
            <View style={st.cd}>
              <Text style={st.cdText}>{`${SKIP_TEXT[skipCd.kind]()[1]} ${Math.max(0, skipCd.n)}`}</Text>
              <Button label={t('Avbryt')} small onPress={cancelSkip} />
            </View>
          ) : null}
          <Button label={SKIP_TEXT[plan.kind]()[0]} icon="play-skip-forward" kind="primary" small
            onPressIn={plan.to === 'next' ? warmNext : undefined} onPress={() => doSkip(plan)} />
        </View>
      ) : null}
      {endCard && next && !msg ? (
        <View style={[st.next, { bottom: insets.bottom + 90, right: insets.right + 16, left: insets.left + 16 }]}>
          <Text style={st.nextHead}>{endCard.auto ? t('Nästa avsnitt om {n} s', { n: Math.max(0, endCard.n) }) : t('Nästa avsnitt')}</Text>
          <Text style={st.nextTitle} numberOfLines={1}>{next.title}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label={t('Spela nu')} icon="play" kind="primary" small onPressIn={warmNext} onPress={() => { setEndCard(null); openNext(); }} />
            <Button label={endCard.auto ? t('Avbryt') : t('Stäng')} small onPress={() => setEndCard(null)} />
          </View>
        </View>
      ) : null}
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
  skip: { position: 'absolute', alignItems: 'flex-end', gap: 8 },
  cd: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(0,0,0,.7)' },
  cdText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  next: { position: 'absolute', maxWidth: 420, alignSelf: 'flex-end', gap: 8, padding: 14, borderRadius: 14, backgroundColor: 'rgba(0,0,0,.8)' },
  nextHead: { color: '#fff', fontSize: 16, fontWeight: '700' },
  nextTitle: { color: '#fff', fontSize: 14, opacity: 0.8 },
  subWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  subText: { color: '#fff', fontSize: 18, lineHeight: 24, textAlign: 'center', backgroundColor: 'rgba(0,0,0,.6)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  cc: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: 'rgba(255,255,255,.15)', maxWidth: 140 },
  ccText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  floatRight: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 8 },
  left: { color: '#fff', fontSize: 13, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: 'rgba(0,0,0,.55)', overflow: 'hidden' },
  leftLow: { color: '#ffc857' },
  warnWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  warn: { color: '#111', backgroundColor: '#ffc857', fontSize: 15, fontWeight: '700', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, overflow: 'hidden', textAlign: 'center' },
});
