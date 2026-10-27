// IPTV-källor: M3U-listor och Xtream Codes-konton (raden i tuners, kind 'm3u', plus iptv_sources). Kopplas in i
// livetv.js refreshTuner: loadChannels() ger kanallistan, beforeSync/afterSync runt syncChannels sparar det som
// livetv.js inte känner till (rubriker, catch-up, tidsförskjutning) och lägger tillbaka administratörens ändringar
// (namn, nummer, grupp, logotyp, ordning) – syncChannels matchar på listans egna värden, så de återställs först.
// Schemalagd uppdatering per källa (refresh_hours) och av VOD-listorna. Importerar inte livetv.js statiskt
// (livetv.js importerar den här kedjan) – där den behövs laddas den när funktionen körs.
import { all, get, run, tx, now, getSetting } from '../db.js';
import { readText, policyOf, cleanHeaders, maskUrl, isLocal } from './net.js';
import { parseM3U, isAdultName } from './m3u.js';
import * as xt from './xtream.js';

const live = () => import('../livetv.js');
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(hd|sd|fhd|uhd|4k|se|sverige|hevc|h265)\b/g, '').replace(/[^a-z0-9]/g, '');
export const altKey = (epg, name) => epg ? 'e:' + String(epg).toLowerCase() : norm(name) ? 'n:' + norm(name) : null;

/** Källans rad (tuners + iptv_sources). null om den inte finns eller inte är IPTV. */
export function sourceRow(tunerId) {
  const t = get('SELECT * FROM tuners WHERE id=?', tunerId);
  if (!t || t.kind !== 'm3u') return null;
  const s = get('SELECT * FROM iptv_sources WHERE tuner_id=?', tunerId) || { tuner_id: tunerId, type: 'm3u', allow_lan: 1, refresh_hours: 24, vod: 1, priority: 0 };
  return { t, s };
}
/** Det som behövs för att hämta från källan: policy (betrodda värdar), rubriker, Xtream-inloggning */
export function ctxOf({ t, s }) {
  const headers = cleanHeaders(json(s.headers, {}));
  const typed = [t.url, t.epg_url, ...json(s.epg_urls, [])].filter(u => u && !isLocal(u));
  const c = { type: s.type, headers, lan: !!s.allow_lan, pol: policyOf(typed, s.allow_lan) };
  if (s.type === 'xtream') Object.assign(c, { base: t.url, user: s.xt_user || '', pass: s.xt_pass || '', tz: json(s.account, {}).tz || null });
  return c;
}
export const sourceCtx = (tunerId) => { const r = sourceRow(tunerId); return r ? ctxOf(r) : null; };

/** Kanallistan för en IPTV-källa (anropas av livetv.js refreshTuner) */
export async function loadChannels(t) {
  const r = sourceRow(t.id); if (!r) return [];
  const c = ctxOf(r);
  if (!get('SELECT 1 FROM iptv_sources WHERE tuner_id=?', t.id)) run('INSERT OR IGNORE INTO iptv_sources(tuner_id) VALUES(?)', t.id);
  if (c.type === 'xtream') {
    const acct = await xt.account(c);
    run('UPDATE iptv_sources SET account=? WHERE tuner_id=?', JSON.stringify(acct), t.id);
    c.tz = acct.tz;
    return xt.liveEntries(c, acct);
  }
  const text = await readText(t.url, { pol: c.pol, headers: c.headers });
  if (!/#EXTINF/i.test(text.slice(0, 1 << 20))) throw new Error(/^\s*</.test(text) ? 'Adressen ger en webbsida, inte en M3U-lista' : 'Ingen M3U-lista (#EXTINF saknas)');
  const { header, entries, skipped } = parseM3U(text);
  run('UPDATE iptv_sources SET m3u_epg=? WHERE tuner_id=?', header.epg.length ? JSON.stringify(header.epg) : null, t.id);
  if (skipped) console.log(`[iptv] ${t.name}: ${skipped} rader i listan hoppades över (DRM, okänt protokoll eller för långa)`);
  return entries;
}

const OVR = 'name_o IS NOT NULL OR number_o IS NOT NULL OR group_o IS NOT NULL OR logo_o IS NOT NULL';
/** Före syncChannels: kanalerna får tillbaka listans egna värden, så att matchningen (namn+nummer) fungerar */
export function beforeSync(tunerId) {
  run(`UPDATE channels SET name=COALESCE((SELECT e.orig_name FROM channel_ext e WHERE e.channel_id=channels.id AND e.name_o IS NOT NULL), name),
    number=CASE WHEN (SELECT e.number_o FROM channel_ext e WHERE e.channel_id=channels.id) IS NOT NULL THEN (SELECT e.orig_number FROM channel_ext e WHERE e.channel_id=channels.id) ELSE number END,
    group_name=CASE WHEN (SELECT e.group_o FROM channel_ext e WHERE e.channel_id=channels.id) IS NOT NULL THEN (SELECT e.orig_group FROM channel_ext e WHERE e.channel_id=channels.id) ELSE group_name END
    WHERE tuner_id=? AND id IN (SELECT channel_id FROM channel_ext WHERE ${OVR})`, tunerId);
}
/** Efter syncChannels: tilläggsuppgifter per kanal, administratörens ändringar och dolda grupper */
export function afterSync(tunerId, list) {
  const byUrl = new Map();
  for (const e of list) if (!byUrl.has(e.url)) byUrl.set(e.url, e);
  const rows = all('SELECT id, stream_url, name, number, group_name, logo, epg_id FROM channels WHERE tuner_id=?', tunerId);
  tx(() => {
    for (const r of rows) {
      const e = byUrl.get(r.stream_url) || {};
      const h = e.headers && Object.keys(e.headers).length ? JSON.stringify(e.headers) : null;
      run(`INSERT INTO channel_ext(channel_id, headers, catchup, catchup_days, catchup_source, shift, xc_id, radio, adult, alt_key, orig_name, orig_number, orig_group, orig_logo)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET headers=excluded.headers, catchup=excluded.catchup, catchup_days=excluded.catchup_days,
        catchup_source=excluded.catchup_source, shift=excluded.shift, xc_id=excluded.xc_id, radio=excluded.radio, adult=excluded.adult, alt_key=excluded.alt_key,
        orig_name=excluded.orig_name, orig_number=excluded.orig_number, orig_group=excluded.orig_group, orig_logo=excluded.orig_logo`,
      r.id, h, e.catchup || null, e.catchupDays || null, e.catchupSource || null, Number.isFinite(e.shift) ? e.shift : null, e.xcId ?? null, e.radio ? 1 : 0, e.adult ? 1 : 0,
      altKey(r.epg_id || e.epg, r.name), r.name, r.number, r.group_name, r.logo);
    }
    applyOverrides(tunerId);
    // Grupper med vuxeninnehåll får åldersgränsen 18 automatiskt (administratören kan ändra)
    for (const g of all("SELECT DISTINCT group_name AS g FROM channels WHERE tuner_id=? AND group_name IS NOT NULL", tunerId)) {
      if (isAdultName(g.g)) run("INSERT OR IGNORE INTO iptv_groups(kind, name, age, auto) VALUES('live', ?, 18, 1)", g.g);
    }
  });
  applyGroupHidden();
}
/** Administratörens ändringar på kanalerna (namn, nummer, grupp, logotyp, ordning) */
export function applyOverrides(tunerId = null) {
  const w = tunerId == null ? '' : ' AND c.tuner_id=?', p = tunerId == null ? [] : [tunerId];
  run(`UPDATE channels AS c SET name=COALESCE(e.name_o, c.name), number=CASE WHEN e.number_o IS NOT NULL THEN NULLIF(e.number_o, '') ELSE c.number END,
    group_name=CASE WHEN e.group_o IS NOT NULL THEN NULLIF(e.group_o, '') ELSE c.group_name END, logo=COALESCE(e.logo_o, c.logo), sort=COALESCE(e.sort_o, c.sort)
    FROM channel_ext e WHERE e.channel_id=c.id AND (${OVR.replace(/(\w+_o)/g, 'e.$1')} OR e.sort_o IS NOT NULL)${w}`, ...p);
}
/** Dolda grupper döljer kanalerna (channels.hidden, så att även apparna och de äldre vyerna slipper dem). ghidden =
 *  dold av gruppen – visas igen när gruppen visas, men en kanal som administratören dolt själv förblir dold. */
export function applyGroupHidden() {
  tx(() => {
    const hide = all(`SELECT c.id FROM channels c JOIN iptv_groups g ON g.kind='live' AND g.name=c.group_name AND g.hidden=1 WHERE c.hidden=0`);
    for (const { id } of hide) {
      run('INSERT OR IGNORE INTO channel_ext(channel_id) VALUES(?)', id);
      run('UPDATE channels SET hidden=1 WHERE id=?', id); run('UPDATE channel_ext SET ghidden=1 WHERE channel_id=?', id);
    }
    const show = all(`SELECT e.channel_id AS id FROM channel_ext e JOIN channels c ON c.id=e.channel_id WHERE e.ghidden=1
      AND NOT EXISTS (SELECT 1 FROM iptv_groups g WHERE g.kind='live' AND g.name=c.group_name AND g.hidden=1)`);
    for (const { id } of show) { run('UPDATE channels SET hidden=0 WHERE id=?', id); run('UPDATE channel_ext SET ghidden=0 WHERE channel_id=?', id); }
  });
}

// ---------- administration ----------
const bool = (v, d) => v == null ? d : v ? 1 : 0;
const clampInt = (v, lo, hi, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
const urlOk = (u) => /^(https?:\/\/|\/config\/)/.test(u);
function epgList(v) {
  const l = (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map(s => String(s).trim()).filter(Boolean);
  for (const u of l) if (!urlOk(u)) throw new Error('TV-guiden ska vara en http(s)-adress eller en fil under /config');
  return l.slice(0, 8);
}
function headersOf(b) {
  const h = cleanHeaders({ 'User-Agent': b.userAgent, Referer: b.referer });
  return Object.keys(h).length ? JSON.stringify(h) : null;
}

/** Ny källa: { type: 'm3u'|'xtream', name, url | server+username+password, epgUrl, epgUrls, userAgent, referer,
 *  connections, refreshHours, allowLan, vod }. Xtream-inloggningen prövas innan något sparas. */
export async function addSource(b) {
  const type = b.type === 'xtream' ? 'xtream' : 'm3u';
  const headers = headersOf(b), lan = bool(b.allowLan, 1), extra = epgList(b.epgUrls);
  const epgUrl = String(b.epgUrl || '').trim() || null;
  if (epgUrl && !urlOk(epgUrl)) throw new Error('TV-guiden ska vara en http(s)-adress eller en fil under /config');
  let url, name = String(b.name || '').trim().slice(0, 60), conns = clampInt(b.connections, 1, 20, null), acct = null, user = null, pass = null;
  if (type === 'xtream') {
    url = xt.xtBase(b.server || b.url);
    user = String(b.username || '').trim(); pass = String(b.password || '');
    if (!user || !pass) throw new Error('Ange användarnamn och lösenord för Xtream-kontot');
    acct = await xt.account({ base: url, user, pass, headers: cleanHeaders(json(headers, {})), lan: !!lan });
    name ||= new URL(url).hostname;
    conns ??= Math.max(1, Math.min(20, acct.maxConnections || 1));
  } else {
    url = String(b.url || '').trim();
    if (!urlOk(url)) throw new Error('Ange en http(s)-adress eller en fil under /config');
    name ||= 'IPTV';
    conns ??= 2;
  }
  const id = Number(run('INSERT INTO tuners(kind,name,url,epg_url,tuner_count) VALUES(?,?,?,?,?)', 'm3u', name, url, epgUrl, conns).lastInsertRowid);
  run(`INSERT INTO iptv_sources(tuner_id,type,xt_user,xt_pass,headers,epg_urls,refresh_hours,allow_lan,vod,priority,account) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, type, user, pass, headers, extra.length ? JSON.stringify(extra) : null, clampInt(b.refreshHours, 1, 168, 24), lan, bool(b.vod, 1), clampInt(b.priority, -100, 100, 0), acct ? JSON.stringify(acct) : null);
  try { await (await live()).refreshTuner(id); }
  catch (e) { run('DELETE FROM tuners WHERE id=?', id); throw e; }
  if (type === 'xtream' && bool(b.vod, 1)) vodSync(id).catch(() => {});
  return id;
}
export function updateSource(id, b) {
  const r = sourceRow(id); if (!r) throw Object.assign(new Error('Källan finns inte'), { status: 404 });
  const { t, s } = r;
  if (!get('SELECT 1 FROM iptv_sources WHERE tuner_id=?', id)) run('INSERT INTO iptv_sources(tuner_id) VALUES(?)', id);
  if (typeof b.name === 'string' && b.name.trim()) run('UPDATE tuners SET name=? WHERE id=?', b.name.trim().slice(0, 60), id);
  if (typeof b.url === 'string' && b.url.trim()) {
    const u = s.type === 'xtream' ? xt.xtBase(b.url) : b.url.trim();
    if (s.type !== 'xtream' && !urlOk(u)) throw new Error('Ange en http(s)-adress eller en fil under /config');
    run('UPDATE tuners SET url=? WHERE id=?', u, id);
  }
  if (typeof b.epgUrl === 'string') { const u = b.epgUrl.trim(); if (u && !urlOk(u)) throw new Error('Ogiltig adress till TV-guiden'); run('UPDATE tuners SET epg_url=? WHERE id=?', u || null, id); }
  if (b.epgUrls != null) { const l = epgList(b.epgUrls); run('UPDATE iptv_sources SET epg_urls=? WHERE tuner_id=?', l.length ? JSON.stringify(l) : null, id); }
  if (b.userAgent != null || b.referer != null) {
    const cur = json(s.headers, {});
    run('UPDATE iptv_sources SET headers=? WHERE tuner_id=?', headersOf({ userAgent: b.userAgent ?? cur['User-Agent'], referer: b.referer ?? cur.Referer }), id);
  }
  if (b.connections != null) run('UPDATE tuners SET tuner_count=? WHERE id=?', clampInt(b.connections, 1, 20, t.tuner_count), id);
  if (b.enabled != null) run('UPDATE tuners SET enabled=? WHERE id=?', b.enabled ? 1 : 0, id);
  if (b.refreshHours != null) run('UPDATE iptv_sources SET refresh_hours=? WHERE tuner_id=?', clampInt(b.refreshHours, 1, 168, 24), id);
  if (b.allowLan != null) run('UPDATE iptv_sources SET allow_lan=? WHERE tuner_id=?', b.allowLan ? 1 : 0, id);
  if (b.vod != null) run('UPDATE iptv_sources SET vod=? WHERE tuner_id=?', b.vod ? 1 : 0, id);
  if (b.priority != null) run('UPDATE iptv_sources SET priority=? WHERE tuner_id=?', clampInt(b.priority, -100, 100, 0), id);
  if (s.type === 'xtream') {
    if (typeof b.username === 'string' && b.username.trim()) run('UPDATE iptv_sources SET xt_user=? WHERE tuner_id=?', b.username.trim(), id);
    if (typeof b.password === 'string' && b.password) run('UPDATE iptv_sources SET xt_pass=? WHERE tuner_id=?', b.password, id);
  }
}
/** Källorna för administrationen – utan lösenord, adresser maskerade */
export function adminSources() {
  return all(`SELECT t.id, t.name, t.url, t.epg_url, t.tuner_count, t.enabled, t.last_refresh, t.error, s.type, s.headers, s.epg_urls, s.m3u_epg, s.refresh_hours,
      s.allow_lan, s.vod, s.priority, s.account, s.vod_refresh, s.vod_error, s.xt_user,
      (SELECT COUNT(*) FROM channels WHERE tuner_id=t.id) AS channels, (SELECT COUNT(*) FROM channels WHERE tuner_id=t.id AND hidden=1) AS hidden,
      (SELECT COUNT(*) FROM channels c JOIN channel_ext e ON e.channel_id=c.id WHERE c.tuner_id=t.id AND e.catchup IS NOT NULL) AS catchup,
      (SELECT COUNT(*) FROM iptv_vod WHERE tuner_id=t.id AND kind='movie') AS movies, (SELECT COUNT(*) FROM iptv_vod WHERE tuner_id=t.id AND kind='series') AS series
    FROM tuners t LEFT JOIN iptv_sources s ON s.tuner_id=t.id WHERE t.kind='m3u' ORDER BY COALESCE(s.priority,0) DESC, t.id`).map(r => {
    const h = json(r.headers, {}), a = json(r.account, null);
    return { id: r.id, name: r.name, type: r.type || 'm3u', url: maskUrl(r.url), epgUrl: maskUrl(r.epg_url), epgUrls: json(r.epg_urls, []).map(maskUrl), m3uEpg: json(r.m3u_epg, []).map(maskUrl),
      connections: r.tuner_count, enabled: !!r.enabled, lastRefresh: r.last_refresh, error: r.error, userAgent: h['User-Agent'] || '', referer: h.Referer || '',
      refreshHours: r.refresh_hours ?? 24, allowLan: r.allow_lan == null ? true : !!r.allow_lan, vod: r.vod == null ? true : !!r.vod, priority: r.priority || 0,
      username: r.type === 'xtream' ? r.xt_user : undefined, hasPassword: r.type === 'xtream' ? true : undefined,
      account: a ? { status: a.status, exp: a.exp, maxConnections: a.maxConnections, activeCons: a.activeCons, trial: a.trial, tz: a.tz } : null,
      channels: r.channels, hidden: r.hidden, catchup: r.catchup, movies: r.movies, series: r.series, vodRefresh: r.vod_refresh, vodError: r.vod_error };
  });
}

// ---------- VOD ----------
const vodRunning = new Map();
/** Hämtar om filmer och serier från en Xtream-källa (en körning åt gången per källa) */
export function vodSync(tunerId) {
  if (vodRunning.has(tunerId)) return vodRunning.get(tunerId);
  const p = (async () => {
    const r = sourceRow(tunerId);
    if (!r || r.s.type !== 'xtream') throw new Error('Filmer och serier finns bara för Xtream-källor');
    try {
      const res = await xt.syncVod(tunerId, ctxOf(r));
      run('UPDATE iptv_sources SET vod_refresh=?, vod_error=NULL WHERE tuner_id=?', now(), tunerId);
      for (const k of ['movie', 'series']) for (const g of all('SELECT DISTINCT category AS c FROM iptv_vod WHERE tuner_id=? AND kind=? AND category IS NOT NULL', tunerId, k))
        if (isAdultName(g.c)) run('INSERT OR IGNORE INTO iptv_groups(kind, name, age, auto) VALUES(?, ?, 18, 1)', k, g.c);
      return res;
    } catch (e) { run('UPDATE iptv_sources SET vod_refresh=?, vod_error=? WHERE tuner_id=?', now(), String(e.message).slice(0, 300), tunerId); throw e; }
  })().finally(() => vodRunning.delete(tunerId));
  vodRunning.set(tunerId, p);
  return p;
}

// ---------- schema ----------
let ticking = false;
/** Källor vars lista är äldre än refresh_hours uppdateras (en i taget, guiden en gång efteråt); VOD en gång per dygn;
 *  TV-guiden enligt inställningen iptv_guide_hours (standard 12). */
export async function tick() {
  if (ticking) return; ticking = true;
  try {
    const L = await live();
    const due = all(`SELECT t.id FROM tuners t LEFT JOIN iptv_sources s ON s.tuner_id=t.id WHERE t.kind='m3u' AND t.enabled=1
      AND (t.last_refresh IS NULL OR t.last_refresh < ? - COALESCE(s.refresh_hours, 24) * 3600)`, now());
    for (const t of due) await L.refreshTuner(t.id, { guide: false }).catch(e => console.warn('[iptv] lista:', e.message));
    const gh = Math.max(1, Math.min(168, parseInt(getSetting('iptv_guide_hours', '12'), 10) || 12));
    if (due.length || !L.guideState.last || L.guideState.last < now() - gh * 3600) await L.refreshGuide().catch(() => {});
    if (due.length) (await import('../dvr.js')).applyRules?.();
    for (const s of all(`SELECT s.tuner_id FROM iptv_sources s JOIN tuners t ON t.id=s.tuner_id WHERE s.type='xtream' AND s.vod=1 AND t.enabled=1
      AND (s.vod_refresh IS NULL OR s.vod_refresh < ?)`, now() - 86400)) await vodSync(s.tuner_id).catch(e => console.warn('[iptv] vod:', e.message));
  } finally { ticking = false; }
}
if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
  setTimeout(() => { tick().catch(() => {}); setInterval(() => tick().catch(() => {}), 10 * 60e3).unref(); }, 120e3).unref();
}
