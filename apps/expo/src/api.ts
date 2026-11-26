// Anrop till BraXhn TV-servern: adress, inloggning (token i enhetens säkra lagring), fel på begriplig svenska
// och adresser till bilder. Samma API som iOS- och Android-apparna (test/contracts/apps.json i repot).
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { isLocalUrl, pickLocal, type LocalInfo } from './localpick';

export class ApiError extends Error {
  status: number; data: any;
  constructor(message: string, status = 0, data: any = null) { super(message); this.status = status; this.data = data; }
}

const mem: Record<string, string | null> = {};
const store = {
  async get(k: string) {
    if (Platform.OS === 'web') { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return mem[k] ?? null; } }
    try { return await SecureStore.getItemAsync(k); } catch { return mem[k] ?? null; }
  },
  async set(k: string, v: string | null) {
    mem[k] = v;
    if (Platform.OS === 'web') { try { v == null ? globalThis.localStorage?.removeItem(k) : globalThis.localStorage?.setItem(k, v); } catch {} return; }
    try { v == null ? await SecureStore.deleteItemAsync(k) : await SecureStore.setItemAsync(k, v); } catch {}
  },
};

// userId = profilen som är inloggad (från /api/status eller profilbytet); bildtoken sparas per profil.
// saved = adressen i serverlistan; server = adressen som används just nu: den sparade, eller serverns adress på
// hemnätet när appen är hemma (goHomeIfHere nedan)
export const session = { server: '', saved: '', token: '', userId: 0, imgToken: '', imgUntil: 0 };

/** Adressen som användaren skrev → fullständig adress. Domännamn får https, IP-adresser och namn i hemnätet http och port 8420. */
export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const host = s.split('/')[0].split(':')[0];
  const local = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.') || /\.(local|lan|home)$/i.test(host);
  if (!local) return 'https://' + s;
  return 'http://' + (s.includes(':') ? s : s + ':8420');
}

// ---------- sparade servrar ----------
// Listan (adress, namn, vem som är inloggad) och varje servers inloggning sparas var för sig i enhetens säkra lagring.
// user = kontot som loggade in (ifyllt när lösenordet behövs igen), profile = profilen som används just nu.
// Servern tar bort den gamla inloggningen vid profilbyte, så varje server har en token: den valda profilens.
export interface Server { id: string; url: string; user: string; profile?: string }
export const servers: Server[] = [];
let currentId = '';
export const currentServer = () => servers.find((x) => x.id === currentId) || null;
/** Namnet som visas för en server: värdnamnet utan protokoll och standardport */
export const serverLabel = (sv: Server) => sv.url.replace(/^https?:\/\//i, '').replace(/:8420$/, '');
const saveList = () => store.set('bx.servers', JSON.stringify(servers));
const tokenKey = (id: string) => 'bx.token.' + id;
const imgKey = (id: string) => 'bx.img.' + id; // bildtoken per profil: { [profilens id]: { token, until } }

/** Läser listan vid start. Svaret är servern som ska öppnas direkt (precis en sparad), annars null. */
export async function loadServers(): Promise<Server | null> {
  servers.length = 0;
  try { const l = JSON.parse((await store.get('bx.servers')) || '[]'); if (Array.isArray(l)) servers.push(...l.filter((x) => x && x.id && x.url)); } catch {}
  return servers.length === 1 ? servers[0] : null;
}
/** Väljer servern för alla anrop. false = ingen sparad inloggning (lösenordet behövs igen). */
export async function selectServer(id: string): Promise<boolean> {
  const sv = servers.find((x) => x.id === id);
  if (!sv) return false;
  currentId = id;
  session.server = sv.url; session.saved = sv.url; session.token = (await store.get(tokenKey(id))) || '';
  session.userId = 0; session.imgToken = ''; session.imgUntil = 0;
  return !!session.token;
}
/** Sparar en ny inloggning: samma adress och användare ersätter den gamla posten */
export async function addServer(url: string, user: string, token: string): Promise<Server> {
  let sv = servers.find((x) => x.url === url && x.user.toLowerCase() === user.toLowerCase());
  if (!sv) { sv = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), url, user }; servers.push(sv); }
  sv.user = user;
  await saveList();
  await store.set(tokenKey(sv.id), token);
  await selectServer(sv.id);
  return sv;
}
export async function removeServer(id: string) {
  const i = servers.findIndex((x) => x.id === id);
  if (i < 0) return;
  servers.splice(i, 1);
  await saveList();
  await store.set(tokenKey(id), null);
  await store.set(imgKey(id), null);
  if (currentId === id) { currentId = ''; session.server = ''; session.saved = ''; session.token = ''; session.userId = 0; session.imgToken = ''; session.imgUntil = 0; }
}
/** Sparar profilens namn i serverlistan (visas under servern i Välj server) */
export async function rememberProfile(name: string) {
  const sv = currentServer();
  if (!sv || sv.profile === name) return;
  sv.profile = name; await saveList();
}

// ---------- profiler (som webbens "Vem tittar?") ----------
export interface Profile { id: number; name: string; owner?: boolean; kid?: boolean; maxAge?: number | null; hasPin?: boolean; color?: string | null }
export interface UserInfo { id: number; name: string; is_admin?: number; kid?: boolean; profiles?: number; color?: string | null; canDownload?: boolean }
export const listProfiles = () => api<{ current: number; profiles: Profile[] }>('/api/profiles');
/** Byter profil. Servern tar bort den gamla inloggningen och ger en ny token för profilen, som ersätter den sparade.
 *  Barnprofilens begränsningar sköter servern efter token. Fel PIN ger ApiError med data.needPin (data.needPassword
 *  när en barnprofil byter till en profil utan PIN med högre åldersgräns – då krävs huvudkontots lösenord). */
export async function switchProfile(id: number, secret: { pin?: string; password?: string } = {}): Promise<UserInfo> {
  const r = await api<{ token: string; user: UserInfo }>('/api/profiles/switch', { method: 'POST', body: { id, ...secret } });
  if (!r?.token || !r.user) throw new ApiError('Kunde inte byta profil – försök igen.');
  session.token = r.token;
  if (currentId) await store.set(tokenKey(currentId), r.token);
  await rememberProfile(r.user.name);
  await setProfile(r.user.id);
  return r.user;
}

/** Loggar ut från den valda servern (den finns kvar i listan och frågar efter lösenordet nästa gång) */
export async function signOut() {
  if (currentId) { await store.set(tokenKey(currentId), null); await store.set(imgKey(currentId), null); }
  session.token = ''; session.userId = 0; session.imgToken = ''; session.imgUntil = 0;
}

function netError(e: any): ApiError {
  const m = String(e?.message || e);
  if (/abort|timed? ?out/i.test(m)) return new ApiError('Servern svarade inte i tid – försök igen.');
  return new ApiError('Kunde inte ansluta till servern. Kontrollera adressen och att telefonen är på samma nät. Utanför hemmet behövs en https-adress.');
}
function httpText(code: number): string {
  if (code === 401) return 'Inloggningen gäller inte längre – logga in igen.';
  if (code === 404) return 'Finns inte på servern (404). Servern kan vara äldre än appen.';
  if (code === 429) return 'För många försök – vänta en stund och försök igen.';
  if (code === 502 || code === 504) return `Servern svarar inte (${code}). Via BraXhn Relay kan hemservern vara avstängd.`;
  if (code === 503) return 'Servern är tillfälligt otillgänglig – försök igen om en stund.';
  if (code === 507) return 'Serverns disk är full – säg till den som sköter servern.';
  return `Servern svarade ${code}`;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn; }

export async function api<T = any>(path: string, opts: { method?: string; body?: any; server?: string; auth?: boolean; timeout?: number } = {}): Promise<T> {
  const base = opts.server ?? session.server;
  if (!base) throw new ApiError('Ingen server är vald.');
  const headers: Record<string, string> = { Accept: 'application/json' };
  const sent = opts.auth !== false ? session.token : '';
  if (sent) headers.Authorization = 'Bearer ' + sent;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 20000);
  let res: Response;
  try { res = await fetch(base + path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: ctl.signal }); }
  catch (e) {
    // Hemadressen svarar inte längre (t.ex. utanför hemmet nu): tillbaka till den sparade adressen och ett nytt försök
    if (opts.server === undefined && base === session.server && session.saved && base !== session.saved) { session.server = session.saved; return api<T>(path, opts); }
    throw netError(e);
  }
  finally { clearTimeout(timer); }
  let data: any = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    // Serverns egen förklaring går först (t.ex. skärmtid, rättigheter, för många strömmar)
    const err = new ApiError((data && typeof data.error === 'string' && data.error) || httpText(res.status), res.status, data);
    // Bara om token fortfarande är den som skickades: ett anrop som startade före ett profilbyte (den gamla token är
    // borttagen på servern) ska inte logga ut den nya profilen
    if (res.status === 401 && sent && sent === session.token && !data?.need2fa && !data?.needPin && !data?.needPassword) onUnauthorized?.();
    throw err;
  }
  return data as T;
}

// ---------- bildtoken ----------
// Bilder laddas via adress och kan inte skicka Authorization på alla plattformar, så de får en egen token (?t=) som
// gäller en vecka. Servern sparar högst 50 per användare och tar bort de äldsta (server/auth.js IMG_MAX), så appen
// sparar sin token per server och profil och förnyar den bara när det är mindre än ett dygn kvar, eller när servern
// svarar 401 på en bild. Annars skulle varje appstart skapa en ny och knuffa ut de andra apparnas.
const RENEW_BEFORE = 86400e3;
const imgListeners = new Set<() => void>();
let imgVersion = 0;
const imgChanged = () => { imgVersion++; imgListeners.forEach((fn) => fn()); };
/** För useSyncExternalStore: bilderna ritas om när bildtoken byts */
export const imageToken = {
  subscribe(fn: () => void) { imgListeners.add(fn); return () => { imgListeners.delete(fn); }; },
  version: () => imgVersion,
};
async function readImgTokens(): Promise<Record<string, { token: string; until: number }>> {
  if (!currentId) return {};
  try { const m = JSON.parse((await store.get(imgKey(currentId))) || '{}'); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}
async function saveImgToken(token: string, until: number) {
  if (!currentId || !session.userId) return;
  const m = await readImgTokens();
  for (const k of Object.keys(m)) if (!(m[k]?.until > Date.now())) delete m[k]; // utgångna
  if (token) m[session.userId] = { token, until }; else delete m[session.userId];
  await store.set(imgKey(currentId), Object.keys(m).length ? JSON.stringify(m) : null);
}
let imgPending: Promise<void> | null = null;
/** Ser till att det finns en bildtoken som gäller minst ett dygn till: först i minnet, sedan i lagringen, sist en ny */
export function ensureImageToken(): Promise<void> {
  if (session.imgToken && session.imgUntil - Date.now() > RENEW_BEFORE) return Promise.resolve();
  if (!imgPending) imgPending = (async () => {
    try {
      if (session.userId) {
        const t = (await readImgTokens())[session.userId];
        if (t?.token && t.until - Date.now() > RENEW_BEFORE) {
          if (t.token !== session.imgToken) { session.imgToken = t.token; session.imgUntil = t.until; imgChanged(); }
          return;
        }
      }
      const user = session.userId, server = session.server;
      const r = await api<{ token: string; ttl: number }>('/api/media-token', { method: 'POST' });
      if (user !== session.userId || server !== session.server) return; // profilen eller servern byttes under tiden
      session.imgToken = r.token; session.imgUntil = Date.now() + Math.max(60, r.ttl || 0) * 1000;
      await saveImgToken(session.imgToken, session.imgUntil);
      imgChanged();
    } catch {} finally { imgPending = null; }
  })();
  return imgPending;
}
/** Byter till profilen som /api/status eller profilbytet säger: hämtar profilens sparade bildtoken (eller en ny) */
export async function setProfile(userId: number) {
  if (userId === session.userId && session.imgToken) return;
  session.userId = userId; session.imgToken = ''; session.imgUntil = 0;
  imgChanged();
  await ensureImageToken();
}
let imgChecked = 0;
/** En bild gick inte att ladda: fråga servern om det var bildtoken (401, t.ex. utknuffad av taket) och förnya den
 *  då. Högst en kontroll per minut, så att en bild som saknas på servern (404) inte ger en ström av anrop. */
export async function imageFailed(url: string) {
  if (!session.imgToken || !url.includes('t=' + session.imgToken) || Date.now() - imgChecked < 60e3) return;
  imgChecked = Date.now();
  try {
    const res = await fetch(url, { method: 'GET' });
    if (res.status !== 401 || !url.includes('t=' + session.imgToken)) return;
  } catch { return; }
  await saveImgToken('', 0);
  session.imgToken = ''; session.imgUntil = 0;
  await ensureImageToken();
}
export function imageUrl(id: number, type: 'poster' | 'backdrop' | 'thumb' = 'poster', w = 300): string {
  return `${session.server}/api/image/${id}/${type}?w=${w}${session.imgToken ? '&t=' + session.imgToken : ''}`;
}
export const absolute = (url: string) => (/^https?:/i.test(url) ? url : session.server + url);

// ---------- typer (det appen använder ur svaren) ----------
export interface MediaItem {
  id: number; kind: 'movie' | 'show' | 'episode' | string; title: string; year: number | null; library: number;
  poster: boolean; backdrop: boolean; thumb: boolean; duration: number | null; position?: number; watched?: boolean;
  season?: number; episode?: number; show?: number; showTitle?: string; showPoster?: boolean; height?: number | null;
  overview?: string | null; genres?: string[]; rating?: number | null; cert?: string | null;
  episodes?: number; watchedEpisodes?: number; seasons?: number; phThumb?: string; showPh?: string; ph?: string;
}
export interface ItemDetail extends MediaItem {
  children?: MediaItem[]; next?: (MediaItem & { position?: number }) | null; inWatchlist?: boolean;
  defaultAudio?: number | null; audio?: { index: number }[]; similar?: MediaItem[];
}
export interface Library { id: number; name: string; type: string; count?: number }
export interface HomeResponse { continue: MediaItem[]; rows: { title: string; library?: Library; items: MediaItem[] }[]; watchlist: MediaItem[]; recommended?: MediaItem[] }
export interface Playback {
  mode: 'direct' | 'remux' | 'transcode'; url: string; duration: number | null; reasons?: string[]; quality?: string;
  intro?: { start: number; end: number } | null; credits?: number | null; remote?: boolean;
}

/** Var uppspelningen ska börja: som webben – under två minuter (eller en fjärdedel av korta klipp) börjar titeln om */
export function resumeAt(pos?: number | null, dur?: number | null): number {
  const p = pos || 0, d = dur && dur > 0 ? dur : 1e9;
  return p > 0 && p >= Math.min(120, d * 0.25) ? p : 0;
}
export const sxe = (it: MediaItem) => (it.season != null && it.episode != null ? `S${it.season} · A${it.episode}` : '');
export function fmtDur(s?: number | null): string {
  if (!s || s <= 0) return '';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`;
}
export function fmtTime(s: number): string {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

/** Ljudformat som telefonens spelare klarar – annat kodar servern om (server/music.js streamTrack, parametern a) */
export function audioCaps(): string {
  if (Platform.OS === 'ios') return 'mp3,aac,flac'; // AVPlayer: inte Ogg (Opus/Vorbis)
  return 'mp3,aac,flac,opus,vorbis'; // Android (ExoPlayer) och webbläsare
}
/** Förmågorna appen anger för /playback – som de andra apparna gör, efter vad enhetens spelare klarar */
export function playbackCaps(): Record<string, string> {
  if (Platform.OS === 'ios') return { c: 'mp4', v: 'h264,hevc', a: 'aac,ac3,eac3,mp3,flac,alac', hdr: '0', dv: '0', nhls: '1' };
  if (Platform.OS === 'android') return { c: 'mp4,webm,mkv', v: 'h264,hevc,vp9', a: 'aac,mp3,opus,vorbis,flac', hdr: '0', dv: '0' };
  return { c: 'mp4,webm', v: 'h264,vp9,vp8', a: 'aac,mp3,opus,vorbis,flac', hdr: '0', dv: '0' };
}
/** Frågesträngen till /playback. Förvärmningen (warm) skickar samma utan ljudspår – servern väljer profilens förval. */
export function playbackQuery(o: { start?: number; audio?: number | null; warm?: boolean }): string {
  const q: Record<string, string> = { ...playbackCaps() };
  if (o.start && o.start >= 1) q.start = String(Math.floor(o.start));
  if (o.warm) q.warm = '1'; else if (o.audio != null) q.audio = String(o.audio);
  return Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
/** Servern startar strömmen redan när fingret landar på Spela (se docs/api.md, warm=1) – tyst om det inte går */
const warmed = new Map<string, number>();
export function warmPlay(id: number, start = 0) {
  const key = `${id}:${Math.floor(start)}`;
  if (Date.now() - (warmed.get(key) || 0) < 15000) return;
  if (warmed.size > 100) warmed.clear();
  warmed.set(key, Date.now());
  api(`/api/items/${id}/playback?${playbackQuery({ start, warm: true })}`).catch(() => {});
}

// ---------- hemma via den publika adressen ----------
// Servern ger sina adresser på hemnätet (/api/local). Svarar en av dem rätt på provet inom 800 ms (localpick.ts)
// används den för allt – API, strömmar och bilder – så att uppspelningen går direkt i hemnätet med hemmets kvalitet
// i stället för via reläet eller routern. Den sparade adressen ändras inte; svarar hemadressen inte längre går api()
// tillbaka till den. Provet görs när servern öppnas och när appen kommer tillbaka till förgrunden.
async function getJson(url: string, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally { clearTimeout(timer); }
}
let localGen = 0, localAt = 0;
/** Byter till serverns hemadress när appen är hemma, annars tillbaka till den sparade. true = hemadressen används. */
export async function goHomeIfHere(): Promise<boolean> {
  const saved = session.saved, token = session.token, gen = ++localGen;
  localAt = Date.now();
  if (!saved || !token || isLocalUrl(saved)) return false;
  let info: LocalInfo | null = null;
  try { info = await api<LocalInfo>('/api/local', { server: saved, timeout: 5000 }); } catch { return session.server !== saved; }
  const hit = await pickLocal(info, getJson);
  // Servern, profilen eller ett nyare prov kom emellan: låt det gälla
  if (gen !== localGen || saved !== session.saved || token !== session.token) return session.server !== session.saved;
  session.server = hit || saved;
  return !!hit;
}
/** Hemadressen svarade inte (t.ex. en nedladdning som avbröts när man lämnade hemmet): tillbaka till den sparade */
export function leaveHome() { if (session.saved) session.server = session.saved; }
/** Används appen via hemadressen just nu? (visas under Konto) */
export const viaHome = () => !!session.server && !!session.saved && session.server !== session.saved;
AppState.addEventListener('change', (st) => {
  if (st === 'active' && session.token && Date.now() - localAt > 30000) goHomeIfHere().catch(() => {});
});
