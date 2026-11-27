// Feedback och felrapporter – samma som knappen Feedback i webben (web/js/views/support.js) och samma anrop
// (server/routes/support.js). En vanlig användares ärende granskas av en administratör innan det skickas till
// utvecklarna; administratörens egna skickas direkt. Här: texterna, var man är i appen (förval i "Gäller" och sidan i
// den tekniska informationen), den senaste uppspelningen och anropen. Vyerna: screens/Feedback.tsx.
//
// Den tekniska informationen: appens namn, version och plattform, sidan, skärmstorleken, språket, titeln man senast
// spelade och det senaste uppspelningsfelet. Aldrig token, adresser eller namn – servern rensar en gång till
// (buildContext i server/support.js) och lägger till sin version och den senaste uppspelningen ur tittarhistoriken.
import { Dimensions, PixelRatio, Platform } from 'react-native';
import appJson from '../app.json';
import { api } from './api';

export type Kind = 'idea' | 'bug';
export const KIND: Record<Kind, string> = { idea: 'Förslag eller synpunkt', bug: 'Något fungerar inte' };
export const KIND_SUB: Record<Kind, string> = { idea: 'Idéer, önskemål och beröm', bug: 'Rapportera ett fel' };
export const AREA: Record<string, string> = {
  film: 'Film och serier', musik: 'Musik', ljud: 'Ljudböcker och poddar', livetv: 'Live-TV', uppspelning: 'Uppspelning', appen: 'Appen i allmänhet', annat: 'Annat',
};
export type Tone = 'warn' | 'ok' | 'info' | 'err';
export const STATUS: Record<string, [string, Tone]> = {
  pending: ['Väntar på granskning', 'warn'], approved: ['Godkänt – skickat till teamet', 'info'], working: ['Åtgärdas', 'info'],
  needinfo: ['Behöver mer information', 'warn'], fixed: ['Åtgärdat', 'ok'], rejected: ['Avslaget', 'err'],
};
export const FROM: Record<string, string> = { team: 'Teamet', admin: 'Administratören', user: 'Du' };
export const MAX_TEXT = 4000;

export interface TechContext {
  version?: string; page?: string; browser?: string; screen?: string; lang?: string; installed?: boolean;
  app?: { name?: string; version?: string; platform?: string };
  title?: { id: number; name: string; year?: number; format?: string };
  lastPlayback?: { item: number; name: string; format?: string; mode?: string; quality?: string; position?: number; duration?: number; remote?: boolean; minutesAgo: number };
  pageErrors?: string[];
}
export interface TicketMsg { from: string; text: string; created: number; status: string | null; version: string | null; pending: boolean }
export interface Ticket {
  id: number; kind: Kind; area: string; title: string | null; text: string; sentTitle: string | null; sentText: string | null;
  context: TechContext | null; status: string; version: string | null; created: number; updated: number; thread: TicketMsg[]; canReply: boolean;
}

/** Statusen som text ("Åtgärdat i version 1.2.3") och dess färg */
export function statusLabel(k: { status: string; version?: string | null }): [string, Tone] {
  const [label, tone] = STATUS[k.status] || [k.status, 'info'];
  return [k.status === 'fixed' && k.version ? `Åtgärdat i version ${k.version}` : label, tone];
}

// ---------- var man är i appen ----------
// Sidan och vad den gäller efter skärmens namn i navigeringen (nav.ts) och flikarna på startsidan. Konto, Feedback och
// Mina ärenden räknas inte: förvalet ska gälla det man gjorde innan man öppnade Feedback.
const ROUTES: Record<string, [string, string]> = {
  Library: ['Bibliotek', 'film'], Item: ['Titelsidan', 'film'], Player: ['Spelaren', 'uppspelning'], Album: ['Album', 'musik'], Artist: ['Artist', 'musik'],
  Playlist: ['Spellista', 'musik'], Book: ['Ljudbok', 'ljud'], Podcast: ['Podd', 'ljud'], Downloads: ['Nedladdat', 'appen'],
};
const TABS: Record<string, [string, string]> = { home: ['Hem', 'appen'], search: ['Sök', 'appen'], music: ['Musik', 'musik'], list: ['Min lista', 'film'] };
const where = { page: 'Hem', area: 'appen' };
/** Navigeringen bytte skärm (App.tsx). NowPlaying hör till det som spelas (musik eller ljudbok) – inget ändras. */
export function noteRoute(name: string) { const r = ROUTES[name]; if (r) [where.page, where.area] = r; }
/** Startsidan bytte flik (Main.tsx) */
export function noteTab(tab: string) { const r = TABS[tab]; if (r) [where.page, where.area] = r; }
/** Förvalet i "Gäller" */
export const currentArea = () => where.area;

// ---------- den senaste uppspelningen ----------
const ERROR_FRESH = 30 * 60e3; // ett uppspelningsfel räknas i en halvtimme (förval: Något fungerar inte)
const play = { id: 0, error: '', at: 0 };
/** Spelaren startade en titel (error tomt) eller visade ett fel */
export function notePlayback(id: number, error = '') {
  play.id = id;
  if (error) { play.error = error; play.at = Date.now(); }
}
/** Ett uppspelningsfel den senaste halvtimmen? */
export const recentError = () => !!play.error && Date.now() - play.at < ERROR_FRESH;

/** Plattformen som text, t.ex. "android 14", "ios 18.1 · TV" eller "web" */
export function platformText(os = Platform.OS as string, version: string | number | undefined = Platform.Version, tv = !!(Platform as any).isTV): string {
  return [`${os}${version != null && version !== '' && os !== 'web' ? ' ' + version : ''}`, tv ? 'TV' : ''].filter(Boolean).join(' · ');
}
/** Det appen bifogar (servern rensar och lägger till sitt) */
export function clientContext(kind: Kind) {
  const { width, height } = Dimensions.get('window');
  const dpr = Math.round(PixelRatio.get() * 10) / 10;
  const c: Record<string, any> = {
    client: { name: 'Expo', version: appJson.expo.version, platform: platformText() },
    route: where.page, screen: `${Math.round(width)}×${Math.round(height)}${dpr !== 1 ? ` @${dpr}` : ''}`, lang: 'sv',
  };
  if (play.id) c.itemId = play.id;
  if (kind === 'bug' && recentError()) c.errors = [`Uppspelningen: ${play.error}`];
  return c;
}

/** Den tekniska informationen som rader [rubrik, värde] – samma ordning och ord som webben (contextHtml) */
export function contextRows(c: TechContext | null): [string, string][] {
  if (!c) return [];
  const rows: [string, string][] = [];
  const add = (k: string, v?: string | number | null) => { if (v != null && v !== '') rows.push([k, String(v)]); };
  const dur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  add('Serverns version', c.version);
  if (c.app) add('Appen', [c.app.name, c.app.version, c.app.platform].filter(Boolean).join(' · '));
  add('Sida', c.page);
  add('Webbläsare och enhet', c.browser);
  add('Skärmstorlek', c.screen);
  add('Språk', c.lang);
  if (c.title) add('Titel', `#${c.title.id} ${c.title.name}${c.title.year ? ` (${c.title.year})` : ''}${c.title.format ? ` – ${c.title.format}` : ''}`);
  const p = c.lastPlayback;
  if (p) add('Senaste uppspelningen', [`#${p.item} ${p.name}`, p.format, p.mode, p.quality, p.position != null ? `${dur(p.position)}${p.duration ? ' / ' + dur(p.duration) : ''}` : '',
    p.remote ? 'utanför hemmet' : 'hemma', `för ${p.minutesAgo} min sedan`].filter(Boolean).join(' · '));
  for (const e of c.pageErrors || []) add('Fel', e);
  return rows;
}

/** Datum och tid som i webben ("27 nov. 14:05") */
export function fmtDate(s: number): string {
  const d = new Date(s * 1000);
  try { return d.toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

// ---------- anropen ----------
export const previewContext = (kind: Kind) => api<{ context: TechContext }>('/api/support/context', { method: 'POST', body: { kind, context: clientContext(kind) } });
export const sendTicket = (b: { kind: Kind; area: string; text: string; tech: boolean }) =>
  api<{ id: number; status: string; message: string }>('/api/support', { method: 'POST', body: { ...b, context: b.tech ? clientContext(b.kind) : null } });
export const myTickets = () => api<{ tickets: Ticket[] }>('/api/support');
export const replyTicket = (id: number, text: string) => api<Ticket>(`/api/support/${id}/reply`, { method: 'POST', body: { text } });
/** Egna ärenden där teamet väntar på svar */
export const needInfoCount = () => api<{ needinfo?: number }>('/api/support/count').then((r) => r.needinfo || 0);
