// Nedladdning för offline – logiken utan telefonens filsystem: posterna i Nedladdat, kön, positioner som väntar på att
// skickas, val av lokal fil, undertexter och skärmtid utan nät. Inga importer: testas med Node (test/expo-offline.test.js).
// Filerna, nedladdningen och serveranropen sköter offline.ts.

export type Kind = 'movie' | 'episode' | 'book';
export type DlState = 'queued' | 'preparing' | 'downloading' | 'paused' | 'error' | 'done';
/** En fil i posten: filmen, eller en av bokens ljudfiler (offset = var filen börjar i boken) */
export interface DlFile { name: string; size: number; done: boolean; id?: number; offset?: number; duration?: number }
export interface DlSub { name: string; lang: string | null; label: string; forced: boolean }
/** Position som sparats utan kontakt med servern: skickas med at (Unix-sekunder) när nätet är tillbaka */
export interface Pending { pos: number; at: number; dur?: number; speed?: number }
export interface Chapter { start: number; end?: number; title: string }
export interface DlEntry {
  key: string; kind: Kind; id: number; title: string; sub: string;
  show?: { id: number; title: string } | null; season?: number | null; episode?: number | null;
  q: string; state: DlState; prep: number; got: number; size: number; error?: string | null;
  files: DlFile[]; subs: DlSub[]; duration: number; position: number;
  author?: string | null; narrator?: string | null; chapters?: Chapter[]; speed?: number;
  /** Omslaget/affischen finns som fil (key + '.jpg') */
  art?: boolean;
  added: number; done?: number; finished?: number; played?: number;
  pending?: Pending | null;
  /** Väntande nedladdning som kan fortsätta (DownloadTask.savable() på iPhone) */
  resume?: { url: string; fileUri: string; isDirectory: boolean; headers?: Record<string, string>; resumeData?: string } | null;
  /** Filens storlek enligt servern när nedladdningen började – en annan storlek betyder en ny fil: börja om */
  expect?: number;
}

export const ACTIVE: DlState[] = ['queued', 'preparing', 'downloading'];
export const isActive = (e: DlEntry) => ACTIVE.includes(e.state);
export const keyOf = (kind: Kind | string, id: number) => (kind === 'book' ? 'b' : 'v') + (Math.floor(+id) || 0);
/** Mappen för en server och profil: nedladdningar gäller alltid en profil på en server */
const cleanId = (serverId: string) => String(serverId).replace(/[^a-z0-9]/gi, '').slice(0, 40) || 'x';
export const scopeOf = (serverId: string, uid: number) => `${cleanId(serverId)}-${Math.floor(+uid) || 0}`;
/** Hör mappen till servern (alla dess profiler)? */
export const scopeOfServer = (scope: string, serverId: string) => scope.startsWith(cleanId(serverId) + '-');

// ---------- kvalitet ----------
// Servern gör en mobilanpassad MP4 (server/offline.js): orig (full upplösning, originalfilen när den redan passar),
// 1080, 720 och 480 – med de här bithastigheterna (kbit/s) plus 160 för ljudet.
const KBPS: Record<string, number> = { '1080': 6000, '720': 3000, '480': 1200 };
export const estimateBytes = (q: string, dur?: number | null) => (KBPS[q] && dur && dur > 0 ? Math.round(((KBPS[q] + 160) * 1000) / 8 * dur) : 0);
export interface QualityOption { q: string; label: string; hint: string; bytes: number }
/** Kvaliteterna som går att välja för en titel (inga steg över filmens egen höjd, utom 480 som alltid finns) */
export function qualityOptions(height?: number | null, duration?: number | null): QualityOption[] {
  const all: QualityOption[] = [
    { q: '480', label: '480p', hint: 'minst – räcker på telefonen', bytes: estimateBytes('480', duration) },
    { q: '720', label: '720p', hint: 'skarpare', bytes: estimateBytes('720', duration) },
    { q: '1080', label: '1080p', hint: 'för surfplatta', bytes: estimateBytes('1080', duration) },
    { q: 'orig', label: 'Full upplösning', hint: 'störst', bytes: 0 },
  ];
  return all.filter((o) => o.q === '480' || o.q === 'orig' || !height || +o.q <= Math.max(480, height));
}
export const qualityLabel = (q: string) => (q === 'orig' ? 'Full upplösning' : q + 'p');

// ---------- poster ----------
interface VideoLike { id: number; kind: string; title: string; year?: number | null; showTitle?: string; show?: number; season?: number; episode?: number; duration?: number | null; position?: number; watched?: boolean }
export function videoEntry(it: VideoLike, q: string, now = Date.now()): DlEntry {
  const ep = it.kind === 'episode';
  return {
    key: keyOf(it.kind, it.id), kind: ep ? 'episode' : 'movie', id: it.id, title: it.title,
    sub: ep ? [it.showTitle || '', it.season != null && it.episode != null ? `S${it.season} · A${it.episode}` : ''].filter(Boolean).join(' · ') : it.year ? String(it.year) : '',
    show: ep && it.show ? { id: it.show, title: it.showTitle || '' } : null, season: it.season ?? null, episode: it.episode ?? null,
    q, state: 'queued', prep: 0, got: 0, size: 0, error: null, files: [{ name: keyOf(it.kind, it.id) + '.mp4', size: 0, done: false }], subs: [],
    duration: it.duration || 0, position: it.watched ? 0 : it.position || 0, added: now,
  };
}
interface BookLike { id: number; title: string; author?: string | null; narrator?: string | null; duration?: number | null; position?: number; speed?: number; chapters?: Chapter[]; files: { id: number; offset: number; duration: number }[] }
export function bookEntry(b: BookLike, now = Date.now()): DlEntry {
  const key = keyOf('book', b.id);
  return {
    key, kind: 'book', id: b.id, title: b.title, sub: b.author || '', author: b.author || null, narrator: b.narrator || null,
    q: 'a', state: 'queued', prep: 100, got: 0, size: 0, error: null, subs: [],
    files: b.files.map((f, i) => ({ name: `${key}.${i}.audio`, size: 0, done: false, id: f.id, offset: f.offset, duration: f.duration })),
    duration: b.duration || 0, position: b.position || 0, speed: b.speed || 1,
    chapters: (b.chapters || []).slice(0, 500).map((c) => ({ start: c.start, end: c.end, title: c.title })), added: now,
  };
}

// ---------- kön ----------
/** Det som ska laddas ner, i den ordning det lades till */
export const todo = (list: DlEntry[]) => list.filter(isActive).sort((a, b) => a.added - b.added);
export function pauseEntry(e: DlEntry): DlEntry { return isActive(e) ? { ...e, state: 'paused' } : e; }
export function resumeEntry(e: DlEntry): DlEntry { return e.state === 'paused' || e.state === 'error' ? { ...e, state: 'queued', error: null } : e; }
/** Läsningen vid start: en nedladdning som pågick när appen stängdes fortsätter (köas igen) */
export function afterRestart(e: DlEntry): DlEntry { return e.state === 'downloading' || e.state === 'preparing' ? { ...e, state: 'queued' } : e; }
/** Andel klar (0–1) och en text, t.ex. "Servern förbereder filen 40 %" eller "Laddar ner 300 MB av 1,2 GB" */
export function progressOf(e: DlEntry): { part: number; text: string } {
  if (e.state === 'done') return { part: 1, text: fmtSize(e.size) };
  if (e.state === 'error') return { part: 0, text: e.error || 'Nedladdningen misslyckades' };
  const files = e.files.length || 1, doneFiles = e.files.filter((f) => f.done).length;
  const part = e.size > 0 ? Math.min(1, e.got / e.size) : files > 1 ? doneFiles / files : 0;
  const amount = e.size > 0 ? `${fmtSize(e.got)} av ${fmtSize(e.size)}` : e.got > 0 ? fmtSize(e.got) : '';
  if (e.state === 'paused') return { part, text: ['Pausad', amount].filter(Boolean).join(' · ') };
  if (e.state === 'queued') return { part, text: e.error || 'Väntar på sin tur' };
  if (e.state === 'preparing') return { part: 0, text: `Servern förbereder filen ${Math.round(e.prep || 0)} %` };
  return { part, text: ['Laddar ner', amount || (files > 1 ? `${doneFiles} av ${files} filer` : '')].filter(Boolean).join(' ') };
}

// ---------- fortsätt en avbruten nedladdning ----------
/**
 * Hur en fil ska laddas ner: från början, vidare från filens längd (Android skriver direkt i filen och fortsätter med
 * Range från den längden – med en ny adress, så att en gammal token inte gör något) eller med det sparade läget
 * (iPhone: systemets egna data, gäller bara samma adress, tokenen gäller ett dygn).
 * Har servern en fil med en annan storlek nu (gjorts om) börjar den om.
 */
export function resumePlan(o: { os: string; partial: number; expect?: number; size?: number; saved?: DlEntry['resume'] }):
  { how: 'fresh' } | { how: 'offset'; offset: number } | { how: 'saved' } {
  if (o.expect && o.size && o.expect !== o.size) return { how: 'fresh' };
  if (o.os === 'android') return o.partial > 0 && (!o.size || o.partial < o.size) ? { how: 'offset', offset: o.partial } : { how: 'fresh' };
  return o.saved?.resumeData ? { how: 'saved' } : { how: 'fresh' };
}
/** Statuskoden ur nedladdningens felmeddelande ("HTTP 403", "server returned HTTP 401", "response has status 404") – 0 = inget svar (nätet) */
export function httpStatusOf(message: string): number {
  const m = /(?:HTTP|status)\s*(\d{3})\b/i.exec(String(message || ''));
  return m ? +m[1] : 0;
}
/** Adresserna att ladda ner från, i ordning: hemadressen när den är bekräftad (snabbare hemma), sedan den sparade */
export function downloadBases(saved: string, current: string): string[] {
  return [...new Set([current, saved].filter(Boolean))];
}
export const joinUrl = (base: string, rel: string) => (/^https?:\/\//i.test(rel) ? rel : base.replace(/\/+$/, '') + rel);

// ---------- positioner som väntar på nätet ----------
/** Sparar positionen i posten. sent = servern har redan fått den (inget väntar). done = slutet nått. */
export function recordPosition(e: DlEntry, pos: number, o: { now?: number; done?: boolean; sent?: boolean; speed?: number } = {}): DlEntry {
  const now = o.now ?? Date.now(), p = Math.max(0, Math.round(pos || 0));
  const out: DlEntry = { ...e, position: o.done ? 0 : p, played: now, ...(o.speed ? { speed: o.speed } : {}) };
  if (o.done) out.finished = now;
  if (o.sent) out.pending = null;
  else out.pending = { pos: o.done ? e.duration || p : p, at: Math.floor(now / 1000), ...(e.duration ? { dur: e.duration } : {}), ...(e.kind === 'book' ? { speed: o.speed || e.speed || 1 } : {}) };
  return out;
}
/** Anropet som skickar en väntande position (servern behåller ett senare framsteg från en annan enhet) */
export function progressRequest(e: DlEntry): { path: string; body: Record<string, number> } | null {
  const p = e.pending;
  if (!p) return null;
  if (e.kind === 'book') return { path: `/api/audiobooks/book/${e.id}/progress`, body: { position: p.pos, speed: p.speed || 1, at: p.at } };
  return { path: `/api/items/${e.id}/progress`, body: { position: p.pos, at: p.at, ...(p.dur ? { duration: p.dur } : {}) } };
}
/** Efter att positionen skickats: klart (eller titeln finns inte/får inte ses längre) tar bort den – om ingen ny har sparats under tiden */
export function ackSent(e: DlEntry, sent: Pending, status: number): DlEntry {
  const finished = (status >= 200 && status < 300) || status === 403 || status === 404;
  if (!finished || !e.pending || e.pending.at !== sent.at || e.pending.pos !== sent.pos) return e;
  return { ...e, pending: null };
}
export const pendingCount = (list: DlEntry[]) => list.filter((e) => e.pending).length;

// ---------- uppspelning ----------
/** Den nedladdade posten för titeln, om den är klar */
export function localEntry(list: DlEntry[], kind: Kind | string, id: number): DlEntry | null {
  const e = list.find((x) => x.key === keyOf(kind, id));
  return e && e.state === 'done' && e.files.length && e.files.every((f) => f.done) ? e : null;
}
/** Bokens fil för en position: index och platsen i filen */
export function bookFileAt(files: { offset?: number }[], pos: number): { index: number; at: number } {
  let index = 0;
  files.forEach((f, i) => { if (pos >= (f.offset || 0) - 0.01) index = i; });
  return { index, at: Math.max(0, pos - (files[index]?.offset || 0)) };
}
/** Nästa nedladdade avsnitt i samma serie (säsong, avsnitt) – för att gå vidare utan nät */
export function nextLocalEpisode(list: DlEntry[], cur: DlEntry): DlEntry | null {
  if (cur.kind !== 'episode' || !cur.show) return null;
  const n = (e: DlEntry) => (e.season ?? 0) * 10000 + (e.episode ?? 0);
  return list.filter((e) => e.kind === 'episode' && e.state === 'done' && e.show?.id === cur.show!.id && n(e) > n(cur)).sort((a, b) => n(a) - n(b))[0] || null;
}
/** Var uppspelningen ska börja (som api.ts resumeAt): under två minuter, eller en fjärdedel av korta klipp, börjar den om */
export function startAt(e: DlEntry): number {
  const p = e.position || 0, d = e.duration > 0 ? e.duration : 1e9;
  return p > 0 && p >= Math.min(120, d * 0.25) ? p : 0;
}

// ---------- undertexter (WebVTT från servern) ----------
export interface Cue { start: number; end: number; text: string }
const vttTime = (s: string) => { const p = s.replace(',', '.').split(':').map(Number); return p.reduce((a, x) => a * 60 + x, 0); };
export function parseVtt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of String(text || '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n'), i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/.exec(lines[i]);
    if (!m) continue;
    const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    if (t) out.push({ start: vttTime(m[1]), end: vttTime(m[2]), text: t });
  }
  return out.sort((a, b) => a.start - b.start);
}
/** Texten som ska visas vid t sekunder ('' = ingen) */
export function cueAt(cues: Cue[], t: number): string {
  let lo = 0, hi = cues.length - 1, last = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) { last = mid; lo = mid + 1; } else hi = mid - 1; }
  const hit: string[] = [];
  for (let i = last; i >= 0 && i > last - 8; i--) if (cues[i].end > t) hit.unshift(cues[i].text);
  return hit.join('\n');
}

// ---------- skärmtid utan nät ----------
// Servern räknar skärmtiden (server/screentime.js) och säger stopp i svaret på framstegen. Utan nät följer appen den
// senaste statusen den fick (GET /api/screentime eller screenTime i framstegssvaret) och räknar själv tiden som spelats
// utan kontakt. Servern räknar inte framsteg som skickas i efterhand (med at), så den tiden finns bara i telefonen.
export interface ScreenStatus {
  limited: boolean; day?: string; daily?: number | null; used?: number; extra?: number; remaining?: number | null;
  from?: string | null; until?: string | null; audio?: boolean; allowed?: boolean; reason?: string | null; message?: string | null;
}
export interface ScreenCache { status: ScreenStatus; at: number; off: { day: string; seconds: number } | null }
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = (s?: string | null) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '')); return m ? +m[1] * 60 + +m[2] : null; };
/** Ny status från servern: den räknade tiden ersätter det som räknats i telefonen */
export const freshScreen = (status: ScreenStatus | null | undefined, now = Date.now()): ScreenCache | null => (status && typeof status === 'object' ? { status, at: now, off: null } : null);
/** Lägger till tid som spelats utan kontakt (högst 45 s per gång, som servern räknar glapp) */
export function addOfflineTime(c: ScreenCache | null, d: Date, seconds: number): ScreenCache | null {
  if (!c || !c.status?.limited || !(seconds > 0)) return c;
  const day = localDay(d), prev = c.off && c.off.day === day ? c.off.seconds : 0;
  return { ...c, off: { day, seconds: prev + Math.min(45, seconds) } };
}
/**
 * Får profilen spela nu, utan kontakt med servern? left = sekunder kvar (null = ingen gräns). Samma dag som statusen
 * gäller dess tid kvar och klockslag (med extra tid); en ny dag samma dagliga gräns och klockslag utan extra tid –
 * veckodagarnas egna regler känner appen inte till utan nät.
 */
export function screenGate(c: ScreenCache | null, d: Date, audio = false): { allowed: boolean; left: number | null; message: string } {
  const ok = { allowed: true, left: null, message: '' };
  const s = c?.status;
  if (!s || !s.limited || (audio && !s.audio)) return ok;
  const day = localDay(d), same = s.day === day;
  const off = c!.off && c!.off.day === day ? c!.off.seconds : 0;
  const remaining = same ? (s.remaining == null ? null : s.remaining - off) : s.daily == null ? null : s.daily * 60 - off;
  const from = toMin(s.from);
  let until = toMin(s.until);
  if (until != null && !same) until = Math.max(0, until - (s.extra || 0)); // statusens sluttid har dagens extra tid
  const nowMin = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  let inWindow = true, windowLeft: number | null = null;
  if (from != null || until != null) {
    const f = from ?? 0, e = until ?? 1440;
    if (f <= e) { inWindow = nowMin >= f && nowMin < e; if (inWindow && until != null) windowLeft = Math.round((e - nowMin) * 60); }
    else { inWindow = nowMin >= f || nowMin < e; if (inWindow && until != null) windowLeft = Math.round(((nowMin >= f ? e + 1440 : e) - nowMin) * 60); }
  }
  if (remaining != null && remaining <= 0) return { allowed: false, left: 0, message: 'Tiden är slut för i dag. Fråga en vuxen om du behöver mer tid.' };
  if (!inWindow) {
    const win = s.from && s.until ? `mellan ${s.from} och ${until != null ? hhmm(until) : s.until}` : s.from ? `från ${s.from}` : `fram till ${until != null ? hhmm(until) : s.until}`;
    return { allowed: false, left: 0, message: `Det går inte att titta just nu. I dag går det att titta ${win}.` };
  }
  const left = remaining == null ? windowLeft : windowLeft == null ? Math.round(remaining) : Math.min(Math.round(remaining), windowLeft);
  return { allowed: true, left, message: '' };
}
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

// ---------- start och behörighet ----------
/** Vart appen går när servern inte svarar vid start: Nedladdat om profilen har något där, annars startsidan med felet */
export const startView = (o: { reachable: boolean; downloads: number }) => (!o.reachable && o.downloads > 0 ? 'Downloads' : 'Main');
/** Kontrollen av en nedladdad titel mot servern: 403/404 = profilen får inte se den längre (eller den är borttagen) */
export const accessVerdict = (status: number) => (status === 403 || status === 404 ? 'remove' : 'keep');

// ---------- storlek ----------
export function fmtSize(b: number): string {
  if (!(b > 0)) return '0 MB';
  if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1).replace('.', ',') + ' GB';
  return Math.max(1, Math.round(b / 1e6)) + ' MB';
}
/** Utrymmet som nedladdningarna tar (klara och påbörjade) */
export const usedBytes = (list: DlEntry[]) => list.reduce((s, e) => s + (e.state === 'done' ? e.size : e.got || 0), 0);
