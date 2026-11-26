// Ljudspelaren: musik (kön delas med webben via /api/me/queue), ljudböcker och poddar i samma spelare.
// Ligger utanför React så att musiken fortsätter när man byter sida; skärmarna läser läget med useNowPlaying().
// Två spelare för musik: den som spelar och nästa låt som laddas i förväg, så att bytet blir så kort det går.
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { absolute, api, ApiError, audioCaps, session } from './api';
import * as off from './offline';

// ---------- typer (det appen använder ur serverns svar) ----------
export interface Track {
  id: number; title: string; artist?: string | null; artistId?: number | null; album?: string | null; albumId?: number | null;
  duration?: number | null; cover?: boolean; codec?: string | null; track?: number | null; disc?: number | null; favorite?: boolean;
}
export interface Album { id: number; title: string; year?: number | null; artist?: string | null; artistId?: number | null; cover?: boolean; tracks?: number; duration?: number | null; genre?: string | null }
export interface Radio { seed: { trackId?: number; albumId?: number; artistId?: number }; name?: string }
export interface Chapter { start: number; end?: number; title: string }
interface BookFile { id: number; offset: number; duration: number; codec?: string | null; url: string; local?: boolean }
export interface BookInfo { id: number; title: string; author?: string | null; narrator?: string | null; cover?: boolean; duration?: number | null; chapters: Chapter[] }
export interface EpisodeInfo { id: number; podcast: number; podcastTitle?: string | null; title: string; duration?: number | null }
type Mode = 'music' | 'book' | 'podcast';

export interface NowPlaying {
  mode: Mode | null;
  // musik
  queue: Track[]; idx: number; repeat: boolean; radio: Radio | null;
  // tal
  book: BookInfo | null; episode: EpisodeInfo | null;
  // gemensamt: pos/dur i hela låten, boken eller avsnittet (sekunder)
  playing: boolean; buffering: boolean; pos: number; dur: number; rate: number;
  error: string; stopped: string; // stopped = servern stoppade (skärmtid eller en vuxen)
}
const EMPTY: NowPlaying = { mode: null, queue: [], idx: -1, repeat: false, radio: null, book: null, episode: null, playing: false, buffering: false, pos: 0, dur: 0, rate: 1, error: '', stopped: '' };
let S: NowPlaying = EMPTY;
const listeners = new Set<() => void>();
function set(p: Partial<NowPlaying>) { S = { ...S, ...p }; listeners.forEach((fn) => fn()); }
export const nowPlaying = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => S,
};
/** Spelarens läge för skärmarna (minispelaren, helskärmsspelaren, albumsidan) */
export const useNowPlaying = () => useSyncExternalStore(nowPlaying.subscribe, nowPlaying.get, nowPlaying.get);
/** En del av läget (ett tal eller en sträng), så att t.ex. varje låtrad bara ritas om när just den ändras */
export const useNowPlayingPart = <T extends string | number | boolean | null>(sel: (s: NowPlaying) => T) => useSyncExternalStore(nowPlaying.subscribe, () => sel(S), () => sel(S));
export const currentTrack = () => (S.mode === 'music' ? S.queue[S.idx] || null : null);

// ---------- ljudformat och adresser ----------
export { audioCaps };
const direct = (codec?: string | null) => !!codec && codec !== 'alac' && audioCaps().split(',').includes(codec);
export const coverUrl = (aid: number, w = 300) => `${session.server}/api/music/cover/${aid}?w=${w}${session.imgToken ? '&t=' + session.imgToken : ''}`;
export const bookCoverUrl = (bid: number, w = 300) => off.localArt('book', bid) || `${session.server}/api/audiobooks/cover/${bid}?w=${w}${session.imgToken ? '&t=' + session.imgToken : ''}`;
export const podImageUrl = (pid: number, w = 300) => `${session.server}/api/podcasts/${pid}/image?w=${w}${session.imgToken ? '&t=' + session.imgToken : ''}`;

// Kortlivade länkar per spår (GET /play ger en mediatoken som gäller ett dygn) – återanvänds i 12 timmar
const urls = new Map<number, { url: string; at: number; server: string; uid: number }>();
async function trackUrl(id: number): Promise<string> {
  const c = urls.get(id);
  if (c && c.server === session.server && c.uid === session.userId && Date.now() - c.at < 12 * 3600e3) return c.url;
  const r = await api<{ url: string }>(`/api/music/tracks/${id}/play`);
  const url = absolute(r.url) + '&a=' + encodeURIComponent(audioCaps());
  if (urls.size > 500) urls.clear();
  urls.set(id, { url, at: Date.now(), server: session.server, uid: session.userId });
  return url;
}

// ---------- ljudläget ----------
let modeSet = false;
async function audioMode() {
  if (modeSet) return;
  modeSet = true;
  // Spela i bakgrunden och med ljudet avstängt (iPhone), och pausa annan musik (krävs för låsskärmens knappar)
  try { await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }); } catch {}
}

// ---------- spelarna ----------
type Sub = { remove(): void };
let cur: { player: AudioPlayer; sub: Sub; key: string; offset: number; seek: number; started: boolean } | null = null;
let pre: { player: AudioPlayer; key: string } | null = null;
let gen = 0; // ökar vid varje laddning: svar som kommer för sent från en tidigare laddning kastas

function drop(p: { player: AudioPlayer; sub?: Sub } | null) {
  if (!p) return;
  try { p.sub?.remove(); } catch {}
  try { p.player.pause(); } catch {}
  try { p.player.clearLockScreenControls(); } catch {}
  try { p.player.remove(); } catch {}
}
function dropAll() { drop(cur); cur = null; drop(pre); pre = null; }

function lockMeta() {
  if (S.mode === 'music') {
    const t = currentTrack();
    return t ? { title: t.title, artist: t.artist || '', albumTitle: t.album || '', artworkUrl: t.cover && t.albumId ? coverUrl(t.albumId, 600) : undefined } : {};
  }
  if (S.mode === 'book' && S.book) return { title: S.book.title, artist: S.book.author || '', albumTitle: chapterAt(S.pos)?.title || '', artworkUrl: S.book.cover ? bookCoverUrl(S.book.id, 600) : undefined };
  if (S.mode === 'podcast' && S.episode) return { title: S.episode.title, artist: S.episode.podcastTitle || '', artworkUrl: podImageUrl(S.episode.podcast, 600) };
  return {};
}

/** Startar en ljudfil. offset = var filen börjar i boken; at = position i filen; ss = servern börjar där (omkodat) */
function attach(player: AudioPlayer, key: string, offset: number, at: number, play: boolean) {
  const g = ++gen;
  const c = { player, sub: null as unknown as Sub, key, offset, seek: at, started: false };
  c.sub = player.addListener('playbackStatusUpdate', (st: AudioStatus) => { if (g === gen) onStatus(st); });
  cur = c;
  try { player.setPlaybackRate(S.rate, 'high'); } catch {}
  try {
    player.setActiveForLockScreen(true, lockMeta(), S.mode === 'music'
      ? { showSeekBackward: true, showSeekForward: true, seekBackwardIntervalSeconds: 10, seekForwardIntervalSeconds: 10 }
      : { showSeekBackward: true, showSeekForward: true, seekBackwardIntervalSeconds: 15, seekForwardIntervalSeconds: 30 });
  } catch {}
  if (play) player.play();
  // Redan laddad (förladdad nästa låt): spola direkt
  if (player.isLoaded && at > 0) { c.seek = 0; player.seekTo(at).catch(() => {}); }
}

function onStatus(st: AudioStatus) {
  const c = cur; if (!c) return;
  if (st.isLoaded && c.seek > 0) { const at = c.seek; c.seek = 0; c.player.seekTo(at).catch(() => {}); }
  if (st.playing) c.started = true;
  const fileDur = st.duration > 0 ? st.duration : 0;
  const p: Partial<NowPlaying> = { playing: st.playing, buffering: st.isBuffering && st.playing };
  if (!c.seek) p.pos = c.offset + (st.currentTime || 0);
  if (S.mode === 'music') {
    const t = currentTrack();
    p.dur = t?.duration || (fileDur ? fileDur + c.offset : 0);
  }
  const err = (st as any).error;
  if (err && !st.playing) p.error = 'Det gick inte att spela – kontrollera nätet och försök igen.';
  set(p);
  if (st.playing && S.error && !err) set({ error: '' });
  if (S.mode === 'music' && st.playing) preloadNext();
  if (st.didJustFinish) ended();
  tick();
}

// ---------- musik ----------
/** Kön sparas på servern (server/musicqueue.js) – samma kö som webben visar efter omladdning eller på en annan enhet.
 *  owner = profilen kön hör till; touched = någon har spelat på den här enheten (en kö som bara visas skrivs inte). */
const Q = { owner: 0, touched: false, timer: 0 as any, last: 0 };
async function saveQueue(final = false) {
  clearTimeout(Q.timer); Q.timer = 0;
  if (S.mode !== 'music' || !Q.owner || !Q.touched || !S.queue.length || Q.owner !== session.userId) return;
  Q.last = Date.now();
  let ids = S.queue.map((t) => t.id), idx = S.idx;
  if (ids.length > 1000) { const from = Math.max(0, Math.min(idx - 200, ids.length - 1000)); ids = ids.slice(from, from + 1000); idx -= from; }
  const owner = Q.owner;
  try {
    await api('/api/me/queue', { method: 'PUT', body: { uid: owner, ids, idx, pos: Math.round(S.pos * 10) / 10, repeat: S.repeat, radio: S.radio }, timeout: final ? 8000 : 20000 });
  } catch (e) {
    // 409 = en annan profil är inloggad nu: den här kön hör inte till den – stäng spelaren utan att röra serverns kö
    if (e instanceof ApiError && e.status === 409 && owner === Q.owner) { Q.owner = 0; stopAll(); }
  }
}
const queueSoon = () => { if (!Q.owner || !Q.touched) return; clearTimeout(Q.timer); Q.timer = setTimeout(saveQueue, 1000); };

async function loadTrack(i: number, at = 0, play = true) {
  const t = S.queue[i]; if (!t) return;
  restored = false;
  set({ idx: i, pos: at, dur: t.duration || 0, error: '', stopped: '', buffering: play });
  const key = 'm' + t.id;
  // Nästa låt är redan laddad: ta den
  if (pre && pre.key === key && at === 0) {
    const p = pre; pre = null;
    drop(cur); cur = null;
    attach(p.player, key, 0, 0, play);
    if (play) played(t.id);
    queueSoon();
    return;
  }
  const g = ++gen;
  drop(cur); cur = null;
  let url: string;
  try { url = await trackUrl(t.id); } catch (e: any) { if (g === gen) set({ error: e?.message || 'Kunde inte spela låten', playing: false, buffering: false }); return; }
  if (g !== gen) return;
  // Omkodat (formatet spelas inte direkt): servern börjar på rätt ställe, positionen räknas från där
  const ss = !direct(t.codec) && at > 0 ? Math.floor(at) : 0;
  const player = createAudioPlayer({ uri: ss ? url + '&ss=' + ss : url }, { updateInterval: 500 });
  attach(player, key, ss, ss ? 0 : at, play);
  if (play) played(t.id);
  queueSoon();
}
/** Lyssningen räknas (historik, ListenBrainz/Last.fm) – som webben, när en låt startar */
const played = (id: number) => { api(`/api/music/tracks/${id}/played`, { method: 'POST' }).catch(() => {}); };

let preloading = 0;
async function preloadNext() {
  const n = S.idx + 1 < S.queue.length ? S.idx + 1 : S.repeat && S.queue.length > 1 ? 0 : -1;
  const t = S.queue[n];
  if (!t || (pre && pre.key === 'm' + t.id) || preloading === t.id) return;
  // Börja ladda när det är under 30 s kvar (sparar mobildata om man byter låt tidigt)
  if (S.dur && S.dur - S.pos > 30) return;
  preloading = t.id;
  try {
    const url = await trackUrl(t.id);
    if (S.mode !== 'music' || S.queue[n]?.id !== t.id) return;
    drop(pre);
    pre = { player: createAudioPlayer({ uri: url }, { updateInterval: 500 }), key: 'm' + t.id };
  } catch {} finally { preloading = 0; }
}

function ended() {
  if (S.mode === 'music') {
    if (S.idx + 1 < S.queue.length) loadTrack(S.idx + 1);
    else if (S.repeat) loadTrack(0);
    else { set({ playing: false, pos: 0 }); try { cur?.player.pause(); cur?.player.seekTo(0); } catch {} saveQueue(); }
  } else if (S.mode === 'book' && bookFiles.length) {
    const i = bookFiles.findIndex((f) => cur && cur.key === 'b' + f.id);
    if (i >= 0 && i + 1 < bookFiles.length) { playBookAt(bookFiles[i + 1].offset, true); return; }
    set({ playing: false }); progress(true);
  } else if (S.mode === 'podcast') {
    set({ playing: false }); progress(true, true);
  }
}

/** Spelar en lista låtar från plats i (albumet, spellistan, favoriterna). shuffle = blandad ordning, den valda först. */
export async function playTracks(tracks: Track[], i = 0, opts: { shuffle?: boolean; radio?: Radio | null } = {}) {
  if (!tracks.length) return;
  await leaveSpoken();
  let list = tracks.slice(), at = Math.max(0, Math.min(i, list.length - 1));
  if (opts.shuffle) {
    const first = list.splice(at, 1)[0];
    for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
    list = [first, ...list]; at = 0;
  }
  await audioMode();
  drop(pre); pre = null;
  Q.owner = session.userId; Q.touched = true;
  set({ ...EMPTY, mode: 'music', queue: list, idx: at, repeat: S.mode === 'music' ? S.repeat : false, radio: opts.radio || null, rate: 1 });
  await loadTrack(at);
}
/** Lägg låtar sist i kön (eller starta en ny kö om inget spelar) */
export function enqueue(tracks: Track[]) {
  if (S.mode !== 'music' || !S.queue.length) return playTracks(tracks, 0);
  set({ queue: [...S.queue, ...tracks] });
  Q.touched = true; queueSoon();
}
/** Spela härnäst: direkt efter låten som spelas */
export function playNext(tracks: Track[]) {
  if (S.mode !== 'music' || !S.queue.length) return playTracks(tracks, 0);
  const q = S.queue.slice(); q.splice(S.idx + 1, 0, ...tracks);
  drop(pre); pre = null;
  set({ queue: q });
  Q.touched = true; queueSoon();
}
export function jumpTo(i: number) { if (S.mode === 'music' && S.queue[i]) { Q.touched = true; drop(pre); pre = null; loadTrack(i); } }
export function next() {
  if (S.mode === 'music') { Q.touched = true; if (S.idx + 1 < S.queue.length) loadTrack(S.idx + 1); else if (S.repeat) loadTrack(0); }
  else skip(30);
}
/** Föregående: början av låten om mer än 3 s har spelats, annars låten före */
export function prev() {
  if (S.mode !== 'music') return skip(-15);
  Q.touched = true;
  if (S.pos > 3 || S.idx === 0) seek(0); else loadTrack(S.idx - 1);
}
export function toggleRepeat() { if (S.mode === 'music') { set({ repeat: !S.repeat }); drop(pre); pre = null; Q.touched = true; queueSoon(); } }
/** Blanda resten av kön (låten som spelas ligger kvar) */
export function shuffleRest() {
  if (S.mode !== 'music') return;
  const head = S.queue.slice(0, S.idx + 1), rest = S.queue.slice(S.idx + 1);
  for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; }
  drop(pre); pre = null;
  set({ queue: [...head, ...rest] }); Q.touched = true; queueSoon();
}
export function removeAt(i: number) {
  if (S.mode !== 'music' || i === S.idx || !S.queue[i]) return;
  const q = S.queue.slice(); q.splice(i, 1);
  drop(pre); pre = null;
  set({ queue: q, idx: i < S.idx ? S.idx - 1 : S.idx }); Q.touched = true; queueSoon();
}
/** Låtradio: liknande låtar efter den som spelas (servern väljer med ljudanalysen, POST /api/music/radio) */
export async function startRadio(seed: Radio['seed'], name: string) {
  const r = await api<{ trackList: Track[] }>('/api/music/radio', { method: 'POST', body: { ...seed, count: 25 } });
  if (!r?.trackList?.length) throw new ApiError('Hittade inga liknande låtar än – ljudanalysen kan behöva mer tid.');
  await playTracks(r.trackList, 0, { radio: { seed, name } });
}
async function moreRadio() {
  if (S.mode !== 'music' || !S.radio || S.queue.length - S.idx > 3) return;
  try {
    const r = await api<{ trackList: Track[] }>('/api/music/radio', { method: 'POST', body: { ...S.radio.seed, history: S.queue.slice(0, S.idx + 1).map((t) => t.id).slice(-30), exclude: S.queue.map((t) => t.id).slice(-1000), count: 20 } });
    const have = new Set(S.queue.map((t) => t.id));
    if (S.mode === 'music' && S.radio) set({ queue: [...S.queue, ...r.trackList.filter((t) => !have.has(t.id))] });
  } catch {}
}

/** Vid start: visa den sparade kön (från webben eller förra gången) pausad på platsen. Inget händer om något spelar. */
export async function restoreQueue() {
  const uid = session.userId;
  if (!uid || S.mode) return;
  let q: { tracks: Track[]; idx: number; pos: number; repeat: boolean; radio: Radio | null };
  try { q = await api('/api/me/queue'); } catch { return; }
  if (S.mode || uid !== session.userId || !q?.tracks?.length) return;
  const i = Math.max(0, Math.min(q.idx | 0, q.tracks.length - 1));
  Q.owner = uid; Q.touched = false;
  set({ ...EMPTY, mode: 'music', queue: q.tracks, idx: i, repeat: !!q.repeat, radio: q.radio?.seed ? q.radio : null, pos: Math.max(0, +q.pos || 0), dur: q.tracks[i].duration || 0 });
  restored = true;
}
let restored = false; // kön är visad men ingen ljudfil laddad än: Spela laddar låten på sparad plats

// ---------- ljudböcker och poddar ----------
let bookFiles: BookFile[] = [];
const P = { timer: 0 as any, last: 0, sent: 0, beat: 0 };

/** Lämnar musiken innan en bok eller ett avsnitt startar: kön sparas, och tas sedan bort som i webben (talet tar över) */
async function leaveSpoken() {
  if (S.mode === 'book' || S.mode === 'podcast') await progress(true);
}
async function leaveMusic() {
  if (S.mode !== 'music') return;
  if (Q.owner && Q.owner === session.userId) api('/api/me/queue', { method: 'DELETE' }).catch(() => {});
  Q.owner = 0; Q.touched = false; clearTimeout(Q.timer);
}

/** Spelar en ljudbok där profilen slutade (positionen sparas på servern). En nedladdad bok spelas från telefonen. */
export async function playBook(bid: number, from?: number) {
  await leaveSpoken(); await leaveMusic();
  await audioMode();
  const local = off.localBook(bid);
  if (local) return playLocalBook(local, from);
  localBook = 0;
  const ca = encodeURIComponent(audioCaps());
  const b = await api<BookInfo & { position?: number; speed?: number; finished?: boolean; files: BookFile[] }>(`/api/audiobooks/book/${bid}/play?a=${ca}`);
  dropAll();
  bookFiles = (b.files || []).map((f) => ({ ...f, url: absolute(f.url) }));
  if (!bookFiles.length) throw new ApiError('Boken har inga ljudfiler.');
  const pos = from ?? (b.finished ? 0 : b.position || 0);
  set({ ...EMPTY, mode: 'book', book: { id: b.id, title: b.title, author: b.author, narrator: b.narrator, cover: b.cover, duration: b.duration, chapters: b.chapters || [] },
    pos, dur: b.duration || 0, rate: b.speed || 1 });
  P.sent = Date.now();
  playBookAt(pos, true);
}
// Nedladdad bok: filerna spelas från telefonen. Positionen går till servern som vanligt när den svarar (skärmtiden räknas
// och kan säga stopp), annars sparas den i telefonen och skickas med "at" när nätet är tillbaka (offline.ts).
let localBook = 0;
async function playLocalBook(local: NonNullable<ReturnType<typeof off.localBook>>, from?: number) {
  const e = local.entry;
  // Skärmtid: hämta statusen om servern svarar, annars gäller den senaste och tiden som räknats i telefonen
  const reachable = await off.refreshScreen(3000);
  const gate = off.screenGate(true);
  if (!gate.allowed) throw new ApiError(gate.message);
  // Servern har den senaste positionen (även från webben) – om den svarar och inget väntar på att skickas härifrån
  let pos = e.finished && !e.pending ? 0 : e.position || 0;
  if (reachable && !e.pending) {
    try { const b = await api<{ position?: number; finished?: boolean }>(`/api/audiobooks/book/${e.id}`, { timeout: 4000 }); pos = b.finished ? 0 : b.position || 0; } catch {}
  }
  if (from != null) pos = from;
  dropAll();
  bookFiles = local.files.map((f) => ({ id: f.id, offset: f.offset, duration: f.duration, codec: null, url: f.uri, local: true }));
  localBook = e.id;
  set({ ...EMPTY, mode: 'book', book: { id: e.id, title: e.title, author: e.author, narrator: e.narrator, cover: !!local.cover, duration: e.duration, chapters: e.chapters || [] },
    pos, dur: e.duration || 0, rate: e.speed || 1 });
  P.sent = Date.now(); P.beat = Date.now();
  playBookAt(pos, true);
}
function playBookAt(pos: number, play: boolean) {
  let f = bookFiles[0];
  for (const x of bookFiles) if (pos >= x.offset - 0.01) f = x;
  const at = Math.max(0, pos - f.offset);
  const key = 'b' + f.id;
  // Samma fil som spelar och formatet spelas direkt: bara spola
  if (cur && cur.key === key && (f.local || direct(f.codec))) { cur.player.seekTo(at).catch(() => {}); set({ pos }); if (play) cur.player.play(); return; }
  drop(cur); cur = null;
  const ss = !f.local && !direct(f.codec) && at > 0 ? Math.floor(at) : 0;
  const player = createAudioPlayer({ uri: ss ? f.url + '&ss=' + ss : f.url }, { updateInterval: 500 });
  set({ pos, buffering: play });
  attach(player, key, f.offset + ss, ss ? 0 : at, play);
}
export const chapterAt = (pos: number): Chapter | null => {
  const ch = S.book?.chapters || [];
  let c: Chapter | null = null;
  for (const x of ch) if (pos >= x.start - 0.5) c = x;
  return c;
};

/** Spelar ett poddavsnitt där profilen slutade */
export async function playEpisode(eid: number) {
  await leaveSpoken(); await leaveMusic();
  await audioMode();
  const [e, p] = await Promise.all([api<EpisodeInfo & { position?: number; played?: boolean }>(`/api/podcasts/episodes/${eid}`), api<{ url: string }>(`/api/podcasts/episodes/${eid}/play`)]);
  dropAll(); bookFiles = []; localBook = 0;
  const pos = e.played ? 0 : e.position || 0;
  set({ ...EMPTY, mode: 'podcast', episode: { id: e.id, podcast: e.podcast, podcastTitle: e.podcastTitle, title: e.title, duration: e.duration }, pos, dur: e.duration || 0 });
  P.sent = Date.now();
  attach(createAudioPlayer({ uri: absolute(p.url) }, { updateInterval: 500 }), 'p' + e.id, 0, pos, true);
}

/** Positionen till servern. Svaret kan säga stop (skärmtiden slut eller en vuxen stoppade) – då pausar spelaren. */
async function progress(final = false, played?: boolean) {
  clearTimeout(P.timer); P.timer = 0;
  const pos = S.pos;
  P.sent = Date.now();
  let r: { stop?: boolean; screenTime?: { allowed?: boolean; message?: string } } | null = null;
  const lb = S.mode === 'book' && S.book && S.book.id === localBook ? localBook : 0;
  const beat = P.beat; P.beat = Date.now();
  try {
    if (S.mode === 'book' && S.book) r = await api(`/api/audiobooks/book/${S.book.id}/progress`, { method: 'POST', body: { position: pos, speed: S.rate }, timeout: final || lb ? 8000 : 20000 });
    else if (S.mode === 'podcast' && S.episode) r = await api(`/api/podcasts/episodes/${S.episode.id}/progress`, { method: 'POST', body: played != null ? { position: pos, played } : { position: pos }, timeout: final ? 8000 : 20000 });
  } catch (err: any) {
    if (!lb || err?.status !== 0) return;
    // Nedladdad bok utan nät: positionen i telefonen (skickas senare), tiden räknas för skärmtiden, och den senaste
    // statusen från servern avgör om det får spelas vidare
    off.savePosition('book', lb, pos, { speed: S.rate });
    if (beat) off.countOffline((Date.now() - beat) / 1000);
    const g = off.screenGate(true);
    if (!g.allowed && S.playing) { try { cur?.player.pause(); } catch {} set({ playing: false, stopped: g.message }); }
    return;
  }
  if (lb) { off.savePosition('book', lb, pos, { speed: S.rate, sent: true }); if (r?.screenTime) off.noteScreen(r.screenTime as any); }
  if (r?.stop && S.playing) {
    try { cur?.player.pause(); } catch {}
    const st = r.screenTime;
    set({ playing: false, stopped: st && st.allowed === false ? st.message || 'Skärmtiden är slut för i dag.' : 'Uppspelningen stoppades av en vuxen.' });
  }
}

// ---------- reglage (samma för musik och tal) ----------
export async function toggle() {
  if (!S.mode) return;
  if (S.playing) { pause(); return; }
  await audioMode();
  if (S.mode === 'music') {
    Q.touched = true;
    if (restored || !cur) { restored = false; await loadTrack(S.idx, S.pos); return; }
  } else if (!cur) {
    if (S.mode === 'book') { playBookAt(S.pos, true); return; }
  }
  if (S.mode === 'book' && localBook) {
    const g = off.screenGate(true);
    if (!g.allowed) { set({ stopped: g.message }); return; }
  }
  set({ stopped: '' });
  P.beat = Date.now();
  cur?.player.play();
}
export function pause() {
  try { cur?.player.pause(); } catch {}
  set({ playing: false, buffering: false });
  if (S.mode === 'music') saveQueue(); else progress(true);
}
export function seek(to: number) {
  if (!S.mode) return;
  const p = Math.max(0, S.dur ? Math.min(to, S.dur - 0.5) : to);
  if (S.mode === 'book') { playBookAt(p, S.playing); return; }
  if (S.mode === 'music') {
    Q.touched = true;
    const t = currentTrack();
    if (!cur || restored) { set({ pos: p }); queueSoon(); return; }
    // Omkodad låt: spolning = ny ström från servern på den platsen
    if (t && !direct(t.codec)) { loadTrack(S.idx, p, S.playing); return; }
  }
  set({ pos: p });
  cur?.player.seekTo(Math.max(0, p - (cur?.offset || 0))).catch(() => {});
  if (S.mode === 'music') queueSoon();
}
export const skip = (d: number) => seek(S.pos + d);
export function setRate(rate: number) {
  set({ rate });
  try { cur?.player.setPlaybackRate(rate, 'high'); } catch {}
  if (S.mode === 'book') progress();
}

/** Stänger spelaren (krysset): musikens kö tas bort på servern, som när webbens spelare stängs */
export async function close() {
  if (S.mode === 'music') await leaveMusic();
  else await progress(true);
  stopAll();
}
/** Stoppar och tömmer utan att röra serverns kö (profilbyte, utloggning, 409) */
function stopAll() {
  clearTimeout(Q.timer); clearTimeout(P.timer);
  dropAll(); bookFiles = []; restored = false; localBook = 0;
  set(EMPTY);
}
/** Sparar kön eller platsen i boken/avsnittet nu (före ett profilbyte, medan den gamla inloggningen gäller) */
export async function saveNow() {
  if (S.mode === 'music') { if (S.playing) Q.touched = true; await saveQueue(true); }
  else if (S.mode) await progress(true);
}
/** Profilbyte och utloggning: spara det som spelas (save = false när inloggningen redan är bytt), stoppa och töm */
export async function reset(save = true) {
  if (save) await saveNow();
  Q.owner = 0;
  stopAll();
}

// ---------- tider ----------
// Musik: kön sparas var 20:e sekund medan den spelar. Tal: positionen var 15:e sekund.
function tick() {
  if (!S.playing) return;
  const now = Date.now();
  if (S.mode === 'music') {
    if (Q.touched && now - Q.last > 20000) saveQueue();
    if (S.radio) moreRadio();
  } else if (now - P.sent > 15000) progress();
}
// Appen går i bakgrunden eller stängs: spara direkt (telefonen kan avsluta appen när som helst efter det)
AppState.addEventListener('change', (st) => {
  if (st !== 'background' && st !== 'inactive') return;
  if (S.mode === 'music') { if (Q.touched) saveQueue(true); }
  else if (S.mode) progress(true);
});
