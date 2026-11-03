// Import av tittarhistorik (sett/framsteg) från Plex och Jellyfin/Emby – en eller flera profiler.
// Plex: via servern (X-Plex-Token: ägarens historik, hemanvändare via plex.tv-växling, delade vänner via
// uppspelningshistoriken) eller direkt ur Plex databasfil (server/plexdb.js, alla konton).
// Matchning: 1) exakt filsökväg (med valfri sökvägsmappning), 2) TMDB/IMDb/TVDB-id (Plex guid, NFO, {tmdb-…} i namnet),
// 3) unikt filnamn, 4) mappnamnet tolkat som skannern gör (server/parse.js) eller titel + år. Avsnitt matchas på
// filens säsong/avsnitt först (samma tolkning som biblioteket) och sedan på Plex numrering (som kan följa TVDB eller TMDB).
// Förhandsvisningen hämtar och matchar; importen skriver in resultatet på kopplade/nya profiler. Kopplingarna sparas
// (import_links) och används av den valfria löpande synken (envägs, bara ändringar sedan förra gången).
import crypto from 'node:crypto';
import path from 'node:path';
import { get, all, run, tx, now, getSetting, setSetting } from './db.js';
import { tmdb, hasTmdb, showKey } from './scanner.js';
import { parseMovie, parseEpisode, idsIn } from './parse.js';
import { searchKey, compactKey } from './searchkey.js';
import { hashPw } from './auth.js';
import { plexIds, readPlexDb } from './plexdb.js';
export { plexIds } from './plexdb.js';

const TIMEOUT = 30000;          // per anrop
const MAX_BYTES = 200 * 1024 * 1024;
const PAGE = 1000;
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---------- hämtning ----------
async function readCapped(r) {
  const len = +r.headers.get('content-length') || 0;
  if (len > MAX_BYTES) throw new Error('Svaret är för stort');
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > MAX_BYTES) throw new Error('Svaret är för stort'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
// Felen nämner aldrig adressen (där kan PIN stå) eller token. upstream = tjänstens statuskod (inte vårt svar).
async function getJson(name, url, headers, { method = 'GET' } = {}) {
  let r;
  try { r = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`${name} svarade inte i tid`);
    throw new Error(`Kunde inte nå ${name} – kontrollera adress och port (${e.cause?.code || 'nätverksfel'})`);
  }
  if (r.status === 401 || r.status === 403) { r.body?.cancel().catch(() => {}); throw Object.assign(new Error(`${name} nekade åtkomst – kontrollera token/API-nyckel`), { upstream: r.status }); }
  if (!r.ok) { r.body?.cancel().catch(() => {}); throw Object.assign(new Error(`${name} svarade ${r.status}`), { upstream: r.status }); }
  const text = await readCapped(r);
  try { return JSON.parse(text); } catch { throw new Error(`${name} skickade inget giltigt JSON-svar – är adressen rätt?`); }
}
export function checkUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(s)) throw err400('Ange adressen som t.ex. http://192.168.1.10:32400');
  return s;
}
const int = (v) => { const n = parseInt(v); return Number.isFinite(n) ? n : null; };
const enc = encodeURIComponent;

// ---------- Plex ----------
// plex.tv (hemanvändare, växling, resurser). PLEX_TV_URL bara för tester mot en låtsasserver.
const plexTv = () => (process.env.PLEX_TV_URL || 'https://plex.tv').replace(/\/+$/, '');
const plexHeaders = (token) => ({ 'X-Plex-Token': String(token).trim(), 'X-Plex-Client-Identifier': 'braxhn-tv-import', 'X-Plex-Product': 'BraXhn TV' });
const plexFiles = (m) => [...new Set((m.Media || []).flatMap(x => (x.Part || []).map(p => p.file)).filter(Boolean))];
const plexAlt = (m) => [m.originalTitle].filter(x => x && x !== m.title);

/** Alla sidor av en Plex-lista. Plex kan ge färre poster per sida än vi ber om: totalSize avgör, inte sidans längd. */
async function plexPages(base, p, H) {
  const out = [];
  let start = 0;
  for (let i = 0; i < 100000; i++) {
    const mc = (await getJson('Plex', `${base}${p}${p.includes('?') ? '&' : '?'}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`, H)).MediaContainer || {};
    const md = mc.Metadata || [];
    out.push(...md); start += md.length;
    const total = mc.totalSize != null ? +mc.totalSize : null;
    if (!md.length || (total != null && Number.isFinite(total) ? start >= total : md.length < PAGE)) break;
  }
  return out;
}
/** Titeln utan tittarläge (film eller avsnitt), null för annat */
function plexItem(m, shows) {
  const paths = plexFiles(m), duration = (+m.duration || 0) / 1000;
  if (m.type === 'movie' || (!m.type && !m.grandparentRatingKey)) return { kind: 'movie', title: m.title || '', alt: plexAlt(m), year: int(m.year), ids: plexIds(m), paths, path: paths[0] || null, duration };
  if (m.type && m.type !== 'episode') return null;
  const show = shows?.get(String(m.grandparentRatingKey)) || { title: m.grandparentTitle || '', alt: [], year: null, ids: plexIds({ guid: m.grandparentGuid }) };
  return { kind: 'episode', title: m.title || '', year: int(m.year), ids: {}, paths, path: paths[0] || null, duration, show, season: int(m.parentIndex), episode: int(m.index) };
}
const plexSeen = (m) => (+m.viewCount || 0) > 0 || (+m.viewOffset || 0) > 0;
// viewCount = 0 med viewOffset > 0 är påbörjad; lastViewedAt bevaras som tidpunkt
const plexState = (m) => ({ watched: (+m.viewCount || 0) > 0, position: (+m.viewOffset || 0) / 1000, updated: int(m.lastViewedAt) || null });

/** Biblioteket som token ser: sedda/påbörjade poster och (valfritt) alla titlar per ratingKey för historikuppslag */
async function plexLibrary(base, token, wantCatalog = false) {
  const H = plexHeaders(token);
  const sections = (await getJson('Plex', `${base}/library/sections`, H)).MediaContainer?.Directory || [];
  const records = [], catalog = wantCatalog ? new Map() : null;
  const take = (m, shows) => {
    const r = plexItem(m, shows); if (!r) return;
    if (catalog && m.ratingKey != null) catalog.set(String(m.ratingKey), r);
    if (plexSeen(m)) records.push({ ...r, ...plexState(m) });
  };
  for (const s of sections) {
    const k = enc(s.key);
    if (s.type === 'movie') {
      for (const m of await plexPages(base, `/library/sections/${k}/all?type=1&includeGuids=1`, H)) take({ type: 'movie', ...m });
    } else if (s.type === 'show') {
      const shows = new Map((await plexPages(base, `/library/sections/${k}/all?type=2&includeGuids=1`, H))
        .map(x => [String(x.ratingKey), { title: x.title || '', alt: plexAlt(x), year: int(x.year), ids: plexIds(x) }]));
      for (const m of await plexPages(base, `/library/sections/${k}/all?type=4&includeGuids=1`, H)) take({ type: 'episode', ...m }, shows);
    }
  }
  return { records, catalog };
}

/** Uppspelningshistoriken för ett konto på servern (delade vänner, hemanvändare utan PIN): bara sedda, ingen position */
async function plexHistory(base, H, accountId, catalog) {
  const list = await plexPages(base, `/status/sessions/history/all?sort=viewedAt:desc&accountID=${enc(accountId)}`, H);
  const by = new Map();
  for (const h of list) {
    if (String(h.accountID ?? accountId) !== String(accountId)) continue;
    const at = int(h.viewedAt);
    const key = h.ratingKey != null ? String(h.ratingKey) : `${h.type}\u0000${h.grandparentTitle}\u0000${h.parentIndex}\u0000${h.index}\u0000${h.title}`;
    const prev = by.get(key);
    if (prev) { if ((at || 0) > (prev.updated || 0)) prev.updated = at; continue; }
    const base = (h.ratingKey != null && catalog?.get(String(h.ratingKey))) || plexItem({ ...h, year: h.year ?? String(h.originallyAvailableAt || '').slice(0, 4) }, null);
    if (base) by.set(key, { ...base, watched: true, position: 0, updated: at });
  }
  return [...by.values()];
}

const RESTRICT_AGE = { little_kid: 7, older_kid: 11, teen: 15 };
const homeUsers = (r) => (Array.isArray(r) ? r : Array.isArray(r?.users) ? r.users : r?.MediaContainer?.User || []).filter(u => u && (u.uuid || u.id));
/** Hemanvändarens token på servern: växla via plex.tv (PIN vid behov), sedan serverns åtkomsttoken ur resources */
async function homeToken(adminTok, u, pin, machine) {
  let r;
  try { r = await getJson('plex.tv', `${plexTv()}/api/v2/home/users/${enc(u.uuid || u.id)}/switch${pin ? `?pin=${enc(pin)}` : ''}`, plexHeaders(adminTok), { method: 'POST' }); }
  catch (e) { if (e.upstream === 401 || e.upstream === 403 || e.upstream === 422) throw Object.assign(new Error(pin ? 'Fel PIN' : 'PIN krävs'), { pin: true }); throw e; }
  const userTok = r?.authToken || r?.authenticationToken || r?.user?.authToken;
  if (!userTok) throw new Error('plex.tv gav ingen token för användaren');
  try {
    const id = await machine();
    const res = await getJson('plex.tv', `${plexTv()}/api/v2/resources?includeHttps=1`, plexHeaders(userTok));
    const hit = (Array.isArray(res) ? res : res?.MediaContainer?.Device || []).find(d => d && id && d.clientIdentifier === id && d.accessToken);
    if (hit) return hit.accessToken;
  } catch {}
  return userTok;
}

/**
 * Plex-profiler via servern: ägaren (token), hemanvändarna (plex.tv, växling med PIN) och delade vänner
 * (uppspelningshistoriken). pins/tokens: per profilnyckel ('plex:<konto-id>'). Returnerar { profiles, notes }.
 * Profilernas secret (hemanvändarens servertoken) lämnas aldrig ut i API-svar.
 */
export async function fetchPlexProfiles({ url, token, pins = {}, tokens = {} }) {
  const base = checkUrl(url);
  if (!token) throw err400('Ange X-Plex-Token');
  const tok = String(token).trim(), H = plexHeaders(tok);
  const own = await plexLibrary(base, tok, true); // fel token/adress ska synas direkt
  const notes = [];
  let home = [], accounts = [];
  try { home = homeUsers(await getJson('plex.tv', `${plexTv()}/api/v2/home/users`, H)); }
  catch (e) { notes.push(`Hemanvändarna kunde inte hämtas från plex.tv (${e.message}).`); }
  try { accounts = (await getJson('Plex', `${base}/accounts`, H)).MediaContainer?.Account || []; }
  catch (e) { notes.push(`Servern listade inga konton (${e.message}).`); }
  let mid;
  const machine = async () => mid !== undefined ? mid : (mid = await getJson('Plex', `${base}/identity`, {}).then(r => r.MediaContainer?.machineIdentifier || null).catch(() => null));
  const admin = home.find(u => u.admin);
  const profiles = [{ key: 'plex:1', name: String(admin?.title || admin?.username || accounts.find(a => +a.id === 1)?.name || 'Plex'), kind: 'owner', records: own.records }];
  const accIds = new Set(accounts.map(a => String(a.id)));
  for (const u of home) {
    if (u.admin) continue;
    const key = `plex:${u.id}`;
    const p = { key, name: String(u.title || u.username || `Plex ${u.id}`), kind: 'home', kid: !!u.restricted,
      maxAge: u.restricted ? RESTRICT_AGE[u.restrictionProfile] ?? 11 : null, protected: !!u.protected, records: [] };
    // En sparad token (löpande synk) först, sedan växling (PIN om profilen är skyddad)
    if (tokens[key]) { try { p.records = (await plexLibrary(base, tokens[key])).records; p.secret = tokens[key]; } catch {} }
    if (!p.secret) {
      const pin = pins[key] != null && String(pins[key]).trim() ? String(pins[key]).trim() : null;
      if (u.protected && !pin) p.needPin = true;
      else {
        try { const t = await homeToken(tok, u, pin, machine); p.records = (await plexLibrary(base, t)).records; p.secret = t; }
        catch (e) { if (e.pin) { p.needPin = true; p.pinError = !!pin; } else p.error = e.message; }
      }
    }
    // Utan egen token: bara sedda titlar ur serverns uppspelningshistorik
    if (!p.secret) { p.partial = true; p.records = accIds.has(String(u.id)) ? await plexHistory(base, H, u.id, own.catalog).catch(() => []) : []; }
    profiles.push(p);
  }
  const homeIds = new Set(home.map(u => String(u.id)));
  for (const a of accounts) {
    if (!(+a.id > 1) || homeIds.has(String(a.id))) continue;
    const records = await plexHistory(base, H, a.id, own.catalog).catch(() => []);
    if (records.length) profiles.push({ key: `plex:${a.id}`, name: String(a.name || `Plex ${a.id}`), kind: 'friend', partial: true, records });
  }
  return { profiles, notes };
}
/** Bara ägarens historik (bakåtkompatibelt) */
export async function fetchPlex({ url, token }) {
  const base = checkUrl(url);
  if (!token) throw err400('Ange X-Plex-Token');
  return (await plexLibrary(base, String(token).trim())).records;
}

// ---------- Jellyfin / Emby ----------
const jfHeaders = (key) => ({ 'X-Emby-Token': key, Authorization: `MediaBrowser Client="BraXhn TV", Device="import", DeviceId="braxhn-tv-import", Version="1", Token="${key}"` });
export async function jellyfinUsers({ url, apiKey }) {
  const base = checkUrl(url);
  if (!apiKey) throw err400('Ange API-nyckel');
  const users = await getJson('Jellyfin', `${base}/Users`, jfHeaders(String(apiKey).trim()));
  return (Array.isArray(users) ? users : []).map(u => ({ id: String(u.Id), name: String(u.Name || '') }));
}
const jfIds = (p = {}) => {
  const ids = {};
  for (const [k, v] of Object.entries(p || {})) { const kk = k.toLowerCase(); if (['tmdb', 'imdb', 'tvdb'].includes(kk) && v) ids[kk] = String(v); }
  return ids;
};
async function jellyfinProfile({ url, apiKey, user }) {
  const base = checkUrl(url);
  const users = await jellyfinUsers({ url: base, apiKey });
  const want = String(user || '').trim().toLowerCase();
  if (!want) throw Object.assign(new Error('Välj vilken Jellyfin-användares historik som ska importeras'), { status: 400, users });
  const u = users.find(x => x.name.toLowerCase() === want || x.id.toLowerCase() === want);
  if (!u) throw Object.assign(new Error('Användaren finns inte i Jellyfin'), { status: 400, users });
  const H = jfHeaders(String(apiKey).trim());
  const items = async (q) => {
    const out = [];
    for (let start = 0; start < 1e6;) {
      const r = await getJson('Jellyfin', `${base}/Users/${enc(u.id)}/Items?Recursive=true&${q}&EnableUserData=true&StartIndex=${start}&Limit=${PAGE}`, H);
      const list = r.Items || [];
      out.push(...list); start += list.length;
      if (!list.length || (r.TotalRecordCount != null ? start >= r.TotalRecordCount : list.length < PAGE)) break;
    }
    return out;
  };
  const F = 'Fields=ProviderIds,Path,ProductionYear,MediaSources';
  const played = await items(`IncludeItemTypes=Movie,Episode&Filters=IsPlayed&${F}`);
  const resumable = await items(`IncludeItemTypes=Movie,Episode&Filters=IsResumable&${F}`);
  const byId = new Map([...played, ...resumable].map(x => [String(x.Id), x]));
  const needShows = [...new Set([...byId.values()].filter(x => x.Type === 'Episode' && x.SeriesId).map(x => String(x.SeriesId)))];
  const shows = new Map();
  for (let i = 0; i < needShows.length; i += 100) {
    for (const s of await items(`IncludeItemTypes=Series&Ids=${needShows.slice(i, i + 100).map(enc).join(',')}&${F}`))
      shows.set(String(s.Id), { title: s.Name, alt: [s.OriginalTitle].filter(x => x && x !== s.Name), year: int(s.ProductionYear), ids: jfIds(s.ProviderIds) });
  }
  const records = [];
  for (const x of byId.values()) {
    const ud = x.UserData || {};
    const paths = [...new Set([x.Path, ...(x.MediaSources || []).map(m => m.Path)].filter(Boolean))];
    const c = { watched: !!ud.Played, position: (+ud.PlaybackPositionTicks || 0) / 1e7, duration: (+x.RunTimeTicks || 0) / 1e7, paths, path: paths[0] || null,
      updated: ud.LastPlayedDate ? Math.floor(Date.parse(ud.LastPlayedDate) / 1000) || null : null };
    if (x.Type === 'Movie') records.push({ kind: 'movie', title: x.Name, alt: [x.OriginalTitle].filter(t => t && t !== x.Name), year: int(x.ProductionYear), ids: jfIds(x.ProviderIds), ...c });
    else if (x.Type === 'Episode') {
      const show = shows.get(String(x.SeriesId)) || { title: x.SeriesName, alt: [], year: null, ids: {} };
      records.push({ kind: 'episode', title: x.Name, year: int(x.ProductionYear), ids: jfIds(x.ProviderIds), show, season: int(x.ParentIndexNumber), episode: int(x.IndexNumber), ...c });
    }
  }
  return { key: `jellyfin:${u.id}`, name: u.name, kind: 'user', records };
}
export async function fetchJellyfin(o) { return (await jellyfinProfile(o)).records; }

// ---------- matchning ----------
/** "från=till" per rad eller kommaseparerat, t.ex. /data/movies=/media/Filmer. Längsta prefixet vinner. */
export function parsePathMap(s) {
  return String(s || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return i > 0 ? { from: x.slice(0, i).trim().replace(/\\/g, '/').replace(/\/+$/, ''), to: x.slice(i + 1).trim().replace(/\/+$/, '') } : null;
  }).filter(m => m && m.from).sort((a, b) => b.from.length - a.from.length);
}
export function mapPath(p, map) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, '/');
  for (const m of map) if (s === m.from || s.startsWith(m.from + '/')) return m.to + s.slice(m.from.length);
  return s;
}
export const normTitle = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
/** Jämförelsenyckel för titlar: diakritik bort (å = a, ø = o, ß = ss), & = and, "II" = "2", "01" = "1"; fungerar även för andra skriftsystem */
export function titleKey(t) {
  const w = searchKey(String(t || '').replace(/&/g, ' and ')).split(' ').filter(Boolean);
  return w.map((x, i) => /^\d+$/.test(x) ? String(+x) : i > 0 && ROMAN[x] ? String(ROMAN[x]) : x).join('');
}
const nkey = (k) => compactKey(searchKey(k)); // samma nyckel som skannern använder för seriemappar
const nfc = (p) => p ? String(p).normalize('NFC') : null; // macOS/SMB kan ge sökvägar i NFD ("Så" som S + a + ring)

/** IMDb/TVDB → TMDB via TMDB:s /find (bara med TMDB-nyckel, begränsat antal uppslag) */
async function resolveExternal(records, limit = 400) {
  if (!hasTmdb()) return;
  const cache = new Map();
  let n = 0;
  for (const r of records) {
    const o = r.kind === 'movie' ? r.ids : r.show?.ids;
    if (!o || o.tmdb) continue;
    const [src, id] = o.imdb ? ['imdb_id', o.imdb] : o.tvdb ? ['tvdb_id', o.tvdb] : [];
    if (!src) continue;
    const field = r.kind === 'movie' ? 'movie_results' : 'tv_results', k = `${src}:${id}:${field}`;
    if (!cache.has(k)) {
      if (n++ >= limit) break;
      try { cache.set(k, (await tmdb(`/find/${enc(id)}`, { external_source: src }))[field]?.[0]?.id || null); } catch { cache.set(k, null); }
    }
    if (cache.get(k)) o.tmdb = String(cache.get(k));
  }
}

function indexes() {
  // Flera versioner av samma film: historiken hamnar alltid på filmen (huvudraden)
  const rows = all(`SELECT id, COALESCE(version_of, id) AS main, kind, title, original_title, year, tmdb_id, imdb_id, nfo, path, parent_id, season, episode,
    abs_episode, src_name, src_alias FROM items WHERE kind IN ('movie','show','episode')`);
  const ix = { movieId: new Map(), showId: new Map(), path: new Map(), base: new Map(), movieTitle: new Map(), showTitle: new Map(), showKey: new Map(), ep: new Map(), abs: new Map() };
  const once = (m, k, v) => { if (k && v && !m.has(k)) m.set(k, v); };
  const push = (m, k, v) => { if (!k) return; const a = m.get(k); if (!a) m.set(k, [v]); else if (!a.some(x => (x.id ?? x) === (v.id ?? v))) a.push(v); };
  const idKeys = (o) => o ? [o.tmdb && `tmdb:${o.tmdb}`, o.imdb && `imdb:${o.imdb}`, o.tvdb && `tvdb:${o.tvdb}`].filter(Boolean) : [];
  const nfoIds = (r) => { try { return JSON.parse(r.nfo || 'null')?.ids || null; } catch { return null; } };
  const aliases = (r) => { try { const a = JSON.parse(r.src_alias || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const noYear = (k) => String(k || '').replace(/\s*\((?:19|20)\d\d\)$/, '');
  for (const r of rows) {
    if (r.kind === 'movie') {
      const c = { id: r.main, year: r.year };
      for (const k of [...idKeys({ tmdb: r.tmdb_id, imdb: r.imdb_id }), ...idKeys(nfoIds(r)), ...idKeys(idsIn(r.path))]) once(ix.movieId, k, r.main);
      for (const t of [r.title, r.original_title, r.path && parseMovie(r.path)?.title]) push(ix.movieTitle, titleKey(t), c);
    } else if (r.kind === 'show') {
      const c = { id: r.id, year: r.year };
      for (const k of [...idKeys({ tmdb: r.tmdb_id }), ...idKeys(nfoIds(r)), ...idKeys(idsIn(r.src_name))]) once(ix.showId, k, r.id);
      for (const t of [r.title, r.original_title, noYear(r.src_name), ...aliases(r).map(noYear)]) push(ix.showTitle, titleKey(t), c);
      for (const k of [r.src_name, ...aliases(r)]) once(ix.showKey, k && nkey(k), r.id);
    } else {
      once(ix.ep, r.parent_id && r.season != null && r.episode != null ? `${r.parent_id}:${r.season}:${r.episode}` : null, r.main);
      once(ix.abs, r.parent_id && r.abs_episode != null ? `${r.parent_id}:${r.abs_episode}` : null, r.main);
      for (const k of idKeys(idsIn(r.path))) once(ix.showId, k, r.parent_id); // "Serie {tvdb-123}/…"
    }
    if (r.path && r.kind !== 'show') { once(ix.path, nfc(r.path), r.main); push(ix.base, path.basename(nfc(r.path)).toLowerCase(), r.main); }
  }
  return ix;
}
const byYear = (cands, year) => {
  if (!cands?.length) return null;
  if (year) {
    const exact = cands.filter(c => c.year === year);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const near = cands.filter(c => c.year && Math.abs(c.year - year) <= 1);
    if (near.length === 1) return near[0];
    return cands.length === 1 && !cands[0].year ? cands[0] : null;
  }
  return cands.length === 1 ? cands[0] : null;
};

/** Matchare mot biblioteket (indexen byggs en gång). Sätter r.itemId och r.method ('path' | 'id' | 'title' | null). */
function matcher(pathMap) {
  const map = parsePathMap(pathMap), ix = indexes();
  const mp = (p) => nfc(mapPath(p, map));
  const pathsOf = (r) => [...new Set((r.paths?.length ? r.paths : [r.path]).filter(Boolean))].map(mp).filter(Boolean);
  const exact = (ps) => { for (const p of ps) { const id = ix.path.get(p); if (id) return id; } return null; };
  const unique = (ps) => { for (const p of ps) { const b = ix.base.get(path.basename(p).toLowerCase()); if (b?.length === 1) return b[0]; } return null; };
  const byIds = (m, ids) => { for (const k of ['tmdb', 'imdb', 'tvdb']) if (ids?.[k]) { const id = m.get(`${k}:${ids[k]}`); if (id) return id; } return null; };
  const byTitle = (m, titles, year) => { for (const t of titles) { const c = byYear(m.get(titleKey(t)), year); if (c) return c.id; } return null; };
  // Seriemapp/säsong/fil som skannern ser dem (biblioteket tolkar sökvägen relativt biblioteksmappen)
  const tail = (p) => p.split('/').filter(Boolean).slice(-3).join(path.sep);
  return (r) => {
    const ps = pathsOf(r);
    let id = null, method = null;
    const hit = (x, how) => { if (x && !id) { id = x; method = how; } return !!id; };
    if (r.kind === 'movie') {
      if (!hit(exact(ps), 'path') && !hit(byIds(ix.movieId, r.ids), 'id')) {
        const parsed = ps.map(p => parseMovie(p));
        for (const f of parsed) if (hit(byIds(ix.movieId, f?.ids), 'id')) break;
        hit(unique(ps), 'path') || hit(byTitle(ix.movieTitle, [r.title, ...(r.alt || [])].filter(Boolean), r.year), 'title');
        for (const f of parsed) if (f?.title && hit(byTitle(ix.movieTitle, [f.title], f.year || r.year), 'title')) break;
      }
    } else if (r.kind === 'episode' && !hit(exact(ps), 'path')) {
      const parsed = ps.map(p => parseEpisode(tail(p))).filter(Boolean);
      // Filens numrering först (samma som bibliotekets), sedan Plex/Jellyfins (kan följa en annan ordning)
      const nums = [...parsed.filter(x => x.episode != null && x.season != null && !x.absolute).map(x => [x.season, x.episode]), [r.season, r.episode]]
        .filter(([s, e]) => s != null && e != null);
      const ep = (sid) => {
        if (!sid) return null;
        for (const [s, e] of nums) { const x = ix.ep.get(`${sid}:${s}:${e}`); if (x) return x; }
        return r.episode != null && (r.season == null || r.season === 1) ? ix.abs.get(`${sid}:${r.episode}`) || null : null; // absolut numrering (anime)
      };
      let sid = byIds(ix.showId, r.show?.ids);
      for (const p of parsed) sid ||= byIds(ix.showId, p.ids);
      if (!hit(ep(sid), 'id') && !hit(unique(ps), 'path')) {
        for (const p of parsed) if (hit(ep(ix.showKey.get(nkey(showKey(p.show, p.year)))), 'title')) break;
        hit(ep(byTitle(ix.showTitle, [r.show?.title, ...(r.show?.alt || [])].filter(Boolean), r.show?.year)), 'title');
      }
    }
    r.itemId = id; r.method = method;
    return r;
  };
}
async function matchAll(lists, pathMap) {
  let m = matcher(pathMap);
  const flat = lists.flat();
  for (const r of flat) m(r);
  // TMDB-id via /find bara för de som inte hittades (sparar uppslag), sedan en gång till
  const miss = flat.filter(r => !r.itemId);
  if (miss.length && hasTmdb()) { await resolveExternal(miss); m = matcher(pathMap); for (const r of miss) m(r); }
}
/** Matchar poster mot biblioteket. Returnerar posterna med itemId och method ('id' | 'path' | 'title' | null). */
export async function matchRecords(records, { pathMap = '' } = {}) {
  await matchAll([records], pathMap);
  return records;
}

// ---------- förhandsvisning ----------
const previews = new Map(); // id → { at, source, mode, profiles, cfg }
const TTL = 30 * 60e3;
function prune() {
  for (const [k, v] of previews) if (Date.now() - v.at > TTL) previews.delete(k);
  while (previews.size > 3) previews.delete(previews.keys().next().value);
}
const label = (r) => r.kind === 'episode' ? `${r.show?.title || '?'} S${String(r.season ?? '?').padStart(2, '0')}E${String(r.episode ?? '?').padStart(2, '0')}` : `${r.title}${r.year ? ` (${r.year})` : ''}`;
export function summarize(records) {
  const by = { id: 0, path: 0, title: 0 };
  for (const r of records) if (r.method) by[r.method]++;
  const matched = records.filter(r => r.itemId);
  return {
    total: records.length, matched: matched.length, unmatched: records.length - matched.length, byMethod: by,
    watched: matched.filter(r => r.watched).length, inProgress: matched.filter(r => !r.watched && r.position > 0).length,
    unmatchedSample: records.filter(r => !r.itemId).slice(0, 50).map(r => ({ kind: r.kind, title: String(label(r)).slice(0, 200), path: r.path ? String(r.path).slice(0, 300) : null }))
  };
}
const nameKey = (s) => compactKey(searchKey(s));
/** Kopplingar som sparats vid tidigare importer: profilnyckel → rad (user_id NULL = hoppa över) */
export const links = (source) => new Map(all(`SELECT l.ext_key, l.ext_name, l.user_id, l.secret, l.synced_at, u.name AS user_name FROM import_links l
  LEFT JOIN users u ON u.id = l.user_id WHERE l.source=?`, source).map(r => [r.ext_key, r]));
/** Förslag: sparad koppling → profil med samma namn (helst i det egna hushållet) → ägaren = huvudkontot */
function suggestFor(p, users, rootId) {
  const k = nameKey(p.name);
  const same = users.filter(u => k && nameKey(u.name) === k);
  const hit = same.find(u => (u.parent_id || u.id) === rootId) || same[0];
  if (hit) return hit;
  return p.kind === 'owner' ? users.find(u => u.id === rootId) || null : null;
}
const profileOut = (p, link, users, rootId) => {
  const s = summarize(p.records);
  const sug = suggestFor(p, users, rootId);
  return { key: p.key, name: p.name, kind: p.kind, kid: !!p.kid, maxAge: p.maxAge ?? null, protected: !!p.protected, needPin: !!p.needPin, pinError: !!p.pinError,
    partial: !!p.partial, error: p.error || null, total: s.total, matched: s.matched, unmatched: s.unmatched, watched: s.watched, inProgress: s.inProgress, byMethod: s.byMethod,
    link: link ? (link.user_id ? { id: link.user_id, name: link.user_name } : { skip: true }) : null, suggest: sug ? { id: sug.id, name: sug.name } : null };
};

export async function preview({ source, mode, url, token, apiKey, user, pathMap, dbPath, pins, rootId = null }) {
  let profiles, notes = [], cfg;
  if (source === 'plex' && mode === 'db') { profiles = (await readPlexDb(dbPath)).profiles; cfg = { mode: 'db', dbPath: String(dbPath).trim() }; }
  else if (source === 'plex') { ({ profiles, notes } = await fetchPlexProfiles({ url, token, pins: pins && typeof pins === 'object' ? pins : {} })); cfg = { mode: 'api', url: checkUrl(url), token: String(token).trim() }; }
  else if (source === 'jellyfin') { profiles = [await jellyfinProfile({ url, apiKey, user })]; cfg = null; }
  else throw err400('Välj Plex eller Jellyfin/Emby');
  await matchAll(profiles.map(p => p.records), pathMap);
  prune();
  const id = crypto.randomBytes(12).toString('hex');
  previews.set(id, { at: Date.now(), source, profiles, cfg: cfg && { ...cfg, pathMap: String(pathMap || '') } });
  const L = links(source), users = all('SELECT id, name, parent_id FROM users ORDER BY COALESCE(parent_id, id), id');
  // Sammanfattningen överst gäller ägaren/den första profilen (som tidigare)
  return { id, source, mode: cfg?.mode || null, notes, ...summarize(profiles[0]?.records || []), profiles: profiles.map(p => profileOut(p, L.get(p.key), users, rootId)) };
}

// ---------- import ----------
/** En rad per titel här: flera poster kan gå till samma titel (flera versioner i Plex, dubbelavsnitt i en fil) */
function collapse(records, since) {
  const by = new Map();
  for (const r of records) {
    if (!r.itemId || (since != null && !((r.updated || 0) > since))) continue;
    let c = by.get(r.itemId);
    if (!c) by.set(r.itemId, (c = { itemId: r.itemId, watched: false, position: 0, posAt: -1, duration: 0, updated: null }));
    if (r.watched) c.watched = true;
    else if (+r.position > 0 && (r.updated || 0) >= c.posAt) { c.position = +r.position; c.posAt = r.updated || 0; }
    c.duration = Math.max(c.duration, +r.duration || 0);
    if ((r.updated || 0) > (c.updated || 0)) c.updated = r.updated;
  }
  return [...by.values()];
}
/**
 * Skriv in matchad historik på användarna. Sedda titlar markeras som sedda (en sedd titel avmarkeras aldrig);
 * påbörjade får sin position. Är det som finns här nyare (påbörjad efter tiden i Plex) ändras inget utan overwrite.
 * since: bara poster som ändrats efter den tiden (löpande synk). Returnerar även latest = senaste tiden bland posterna.
 */
export function applyRecords(records, userIds, { overwrite = false, since = null } = {}) {
  const res = { watched: 0, progress: 0, skipped: 0, users: 0, latest: null };
  const t = now();
  const rows = collapse(records, since);
  for (const r of rows) if (r.updated && r.updated <= t && r.updated > (res.latest || 0)) res.latest = r.updated;
  tx(() => {
    for (const uid of userIds) {
      if (!get('SELECT 1 FROM users WHERE id=?', uid)) continue;
      res.users++;
      for (const r of rows) {
        const it = get('SELECT id, duration FROM items WHERE id=?', r.itemId);
        if (!it) { res.skipped++; continue; }
        const dur = it.duration || r.duration || null;
        const when = Math.min(t, r.updated || t);
        const prev = get('SELECT watched, position, updated FROM progress WHERE user_id=? AND item_id=?', uid, it.id);
        const newerHere = prev && !overwrite && prev.position > 0 && (prev.updated || 0) >= when;
        if (r.watched) {
          if (prev?.watched || (newerHere && (prev.updated || 0) > when)) { res.skipped++; continue; }
          run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,?,1,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET position=0, watched=1, duration=COALESCE(excluded.duration, duration), updated=excluded.updated`, uid, it.id, dur, when);
          res.watched++;
        } else if (r.position >= 30) {
          if (prev?.watched || newerHere) { res.skipped++; continue; }
          run(`INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,0,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET position=excluded.position, duration=COALESCE(excluded.duration, duration), updated=excluded.updated`, uid, it.id, r.position, dur, when);
          res.progress++;
        } else res.skipped++;
      }
    }
  });
  return res;
}
const takePreview = (id) => {
  const p = previews.get(String(id || ''));
  if (!p || Date.now() - p.at > TTL) throw Object.assign(new Error('Förhandsvisningen har gått ut – gör om den'), { status: 410 });
  return p;
};
/** Bakåtkompatibelt: ägarens/den första profilens historik på valda användare */
export function runImport(id, userIds, opts = {}) {
  const p = takePreview(id);
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw err400('Välj minst en användare');
  const { latest, ...r } = applyRecords(p.profiles[0]?.records || [], ids, opts);
  previews.delete(String(id));
  return { ...r, source: p.source };
}

/** Ny profil under huvudkontot (barnprofil med åldersgräns om maxAge anges). Namnet görs unikt vid krock. */
export async function createProfile(rootId, name, maxAge = null) {
  const root = get('SELECT id, parent_id, remote_allowed FROM users WHERE id=?', rootId);
  if (!root || root.parent_id != null) throw new Error('Huvudkontot finns inte');
  if (all('SELECT id FROM users WHERE parent_id=?', root.id).length >= 10) throw new Error('Max 10 profiler per hushåll');
  const base = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Plex';
  const age = maxAge === '' || maxAge == null ? null : Math.max(0, Math.min(18, parseInt(maxAge) || 0));
  const pass = await hashPw(crypto.randomBytes(24).toString('hex')); // profiler loggar aldrig in med lösenord
  for (const nm of [base, `${base.slice(0, 33)} (Plex)`, ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => `${base.slice(0, 37)} ${n}`)]) {
    if (get('SELECT 1 FROM users WHERE name=? COLLATE NOCASE', nm)) continue;
    const uid = Number(run('INSERT INTO users(name,pass,is_admin,created,parent_id,max_age,remote_allowed) VALUES(?,?,0,?,?,?,?)', nm, pass, now(), root.id, age, root.remote_allowed).lastInsertRowid);
    return { id: uid, name: nm, maxAge: age };
  }
  throw new Error('Namnet är upptaget');
}
function saveLink(source, key, name, userId, secret, syncedAt) {
  run(`INSERT INTO import_links(source,ext_key,ext_name,user_id,secret,synced_at,updated) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(source,ext_key) DO UPDATE SET ext_name=excluded.ext_name, user_id=excluded.user_id, secret=excluded.secret,
      synced_at=CASE WHEN user_id IS excluded.user_id THEN MAX(COALESCE(synced_at,0), COALESCE(excluded.synced_at,0)) ELSE excluded.synced_at END, updated=excluded.updated`,
  source, key, String(name || '').slice(0, 100), userId ?? null, secret || null, syncedAt ?? null, now());
}

/**
 * Importera per profil. choices: [{ key, action: 'link' | 'create' | 'skip', userId?, name?, maxAge? }] ('skip' sparas; saknas = inget ändras).
 * rootId = huvudkontot som nya profiler skapas under. sync: { on, hours } sparar inställningen för löpande synk (bara Plex).
 */
export async function runProfiles(id, choices, { overwrite = false, rootId, sync = null } = {}) {
  const p = takePreview(id);
  const want = new Map((Array.isArray(choices) ? choices : []).filter(c => c && c.key).map(c => [String(c.key), c]));
  const syncOn = !!(sync?.on && p.source === 'plex' && p.cfg);
  const out = { source: p.source, profiles: [], created: [], watched: 0, progress: 0, skipped: 0 };
  // Kontrollera valen innan något skrivs
  for (const pr of p.profiles) {
    const c = want.get(pr.key);
    if (c?.action === 'link' && !get('SELECT 1 FROM users WHERE id=?', +c.userId)) throw err400(`Välj en befintlig profil för ${pr.name}`);
  }
  if (p.profiles.some(pr => want.get(pr.key)?.action === 'link' || want.get(pr.key)?.action === 'create')) previews.delete(String(id));
  else throw err400('Välj minst en profil att importera till');
  for (const pr of p.profiles) {
    const c = want.get(pr.key);
    if (!c) continue; // inget val: kopplingen lämnas som den är
    const row = { key: pr.key, name: pr.name, action: c.action === 'link' || c.action === 'create' ? c.action : 'skip', userId: null, userName: null, watched: 0, progress: 0, skipped: 0, error: null };
    try {
      if (row.action === 'create') {
        const kid = c.maxAge !== undefined ? c.maxAge : pr.kid ? pr.maxAge : null;
        const u = await createProfile(rootId, c.name || pr.name, kid);
        row.userId = u.id; row.userName = u.name; out.created.push(u);
      } else if (row.action === 'link') {
        const u = get('SELECT id, name FROM users WHERE id=?', +c.userId);
        row.userId = u.id; row.userName = u.name;
      }
      if (row.userId) {
        const r = applyRecords(pr.records, [row.userId], { overwrite });
        Object.assign(row, { watched: r.watched, progress: r.progress, skipped: r.skipped });
        out.watched += r.watched; out.progress += r.progress; out.skipped += r.skipped;
        saveLink(p.source, pr.key, pr.name, row.userId, syncOn ? pr.secret : null, r.latest || now());
      } else saveLink(p.source, pr.key, pr.name, null, null, null);
    } catch (e) { row.error = e.message; row.userId = null; }
    out.profiles.push(row);
  }
  if (p.source === 'plex' && p.cfg && sync) setSync({ on: syncOn, hours: sync.hours, cfg: p.cfg });
  out.users = out.profiles.filter(r => r.userId).length;
  return out;
}

// ---------- löpande synk (Plex, envägs) ----------
// Inställningen (utan hemligheter) i settings.import_sync; Plex-token för sig (import_sync_token), hemanvändarnas
// servertoken i import_links.secret. Inget av det lämnas ut i API-svar.
const readSync = () => { try { return JSON.parse(getSetting('import_sync', '') || '{}') || {}; } catch { return {}; } };
const clampHours = (h) => Math.max(1, Math.min(168, parseInt(h) || 24));
function setSync({ on, hours, cfg }) {
  const s = readSync();
  const next = { ...s, on: !!on, hours: clampHours(hours ?? s.hours) };
  if (cfg) {
    Object.assign(next, { mode: cfg.mode, url: cfg.url || null, dbPath: cfg.dbPath || null, pathMap: cfg.pathMap || '' });
    setSetting('import_sync_token', cfg.mode === 'api' ? cfg.token : '');
  }
  // Avstängd synk behöver inga token: de sparas bara så länge synken är på
  if (!next.on) { next.error = null; setSetting('import_sync_token', ''); run("UPDATE import_links SET secret=NULL WHERE source='plex'"); }
  setSetting('import_sync', JSON.stringify(next));
}
export function syncInfo() {
  const s = readSync();
  const L = [...links('plex').values()];
  return { on: !!s.on, hours: clampHours(s.hours), mode: s.mode || null, url: s.url || null, dbPath: s.dbPath || null, configured: !!s.mode,
    tokenSet: !!getSetting('import_sync_token', ''), last: s.last || null, result: s.result || null, error: s.error || null, running: syncing,
    links: L.map(l => ({ key: l.ext_key, name: l.ext_name, userId: l.user_id, userName: l.user_name, syncedAt: l.synced_at })) };
}
export function updateSync({ on, hours }) {
  const s = readSync();
  if (on && (!s.mode || (s.mode === 'api' && !getSetting('import_sync_token', ''))))
    throw err400('Gör en import från Plex med löpande synk ikryssad – synken använder samma källa och kopplingar');
  setSync({ on: on ?? s.on, hours: hours ?? s.hours });
  return syncInfo();
}
let syncing = false;
/** Hämta på nytt och för in det som ändrats sedan förra synken på de kopplade profilerna (aldrig något skrivs över). */
export async function syncNow() {
  if (syncing) return { busy: true };
  const s = readSync();
  if (!s.mode) throw err400('Ingen Plex-källa är sparad');
  syncing = true;
  const result = { at: now(), watched: 0, progress: 0, profiles: 0, newProfiles: 0 };
  try {
    const L = links('plex');
    const tokens = Object.fromEntries([...L.values()].filter(l => l.secret).map(l => [l.ext_key, l.secret]));
    const { profiles } = s.mode === 'db' ? await readPlexDb(s.dbPath) : await fetchPlexProfiles({ url: s.url, token: getSetting('import_sync_token', ''), tokens });
    const linked = profiles.filter(p => L.get(p.key)?.user_id);
    result.newProfiles = profiles.filter(p => !L.has(p.key)).length;
    await matchAll(linked.map(p => p.records), s.pathMap);
    for (const p of linked) {
      const l = L.get(p.key);
      const r = applyRecords(p.records, [l.user_id], { since: l.synced_at || 0 });
      result.watched += r.watched; result.progress += r.progress; result.profiles++;
      run('UPDATE import_links SET synced_at=MAX(COALESCE(synced_at,0), ?), secret=COALESCE(?, secret), updated=? WHERE source=? AND ext_key=?',
        r.latest || 0, p.secret || null, now(), 'plex', p.key);
    }
    setSetting('import_sync', JSON.stringify({ ...readSync(), last: result.at, result, error: null }));
    try { onSynced?.(linked.map(p => L.get(p.key).user_id)); } catch {}
    return result;
  } catch (e) {
    setSetting('import_sync', JSON.stringify({ ...readSync(), last: now(), error: e.message }));
    throw e;
  } finally { syncing = false; }
}
/** Körs av tidtagaren: synkar när det gått N timmar sedan förra gången (och synken är på) */
export async function syncTick(at = now()) {
  const s = readSync();
  if (!s.on || !s.mode || syncing) return null;
  if (s.last && at - s.last < clampHours(s.hours) * 3600) return null;
  try { return await syncNow(); } catch (e) { console.warn('[import] synk från Plex:', e.message); return null; }
}
let timer = null, onSynced = null;
/** Startar tidtagaren. done(userIds) körs efter varje lyckad synk (routerna tömmer profilernas cache). */
export function startSync(done = null) {
  onSynced = done;
  if (timer) return;
  timer = setInterval(() => { syncTick().catch(() => {}); }, 10 * 60e3);
  timer.unref?.();
}
