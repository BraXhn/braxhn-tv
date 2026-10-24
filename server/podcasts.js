// Poddar: prenumerera på RSS-flöden, hämta nya avsnitt automatiskt och lyssna med sparad position.
// Skydd: flöden och avsnitt hämtas bara från publika adresser (inte hemnätet), med storleks- och tidsgränser.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { db, get, all, run, now, getSetting, CONFIG, IMAGES } from './db.js';
import { streamFile } from './util.js';
import * as jobs from './jobs.js';

// RFC 822-datum med tidszonsförkortningar (CEST, BST …) som Date.parse inte förstår
const TZ = { CET: '+0100', CEST: '+0200', BST: '+0100', EET: '+0200', EEST: '+0300', WET: '+0000', WEST: '+0100', IST: '+0530', AEST: '+1000', AEDT: '+1100' };
export function parseDate(v) {
  if (!v) return NaN;
  const t = Date.parse(v);
  if (!isNaN(t)) return t;
  return Date.parse(String(v).trim().replace(/\b([A-Z]{3,4})$/, (m) => TZ[m] || m));
}
export const DIR = process.env.PODCAST_DIR || path.join(CONFIG, 'podcasts');
fs.mkdirSync(DIR, { recursive: true });
db.exec(`CREATE TABLE IF NOT EXISTS podcasts(id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT, author TEXT, description TEXT, link TEXT,
  image INTEGER NOT NULL DEFAULT 0, added_by INTEGER, keep INTEGER NOT NULL DEFAULT 3, last_fetch INTEGER, error TEXT, added INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS podcast_episodes(id INTEGER PRIMARY KEY, podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid TEXT NOT NULL, title TEXT, description TEXT, published INTEGER, duration REAL, url TEXT NOT NULL, mime TEXT, size INTEGER,
  file TEXT, downloading INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS pe_guid ON podcast_episodes(podcast_id, guid);
CREATE INDEX IF NOT EXISTS pe_pub ON podcast_episodes(podcast_id, published DESC);
CREATE TABLE IF NOT EXISTS podcast_progress(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, played INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, PRIMARY KEY(user_id, episode_id));`);
// Nedladdningar som avbröts av en omstart: nollställ flaggan (annars laddas avsnittet aldrig ner) och ta bort halvfärdiga filer
run('UPDATE podcast_episodes SET downloading=0 WHERE downloading!=0');
try { for (const f of fs.readdirSync(DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(DIR, f), { force: true }); } catch {}

// ---------- säker hämtning ----------
// Adressen kontrolleras i samma uppslag som anslutningen görs (skydd mot DNS-rebinding), och alla
// interna, lokala och "inbäddade" IPv4-i-IPv6-adresser spärras.
const MAX_FEED = 10 * 1024 ** 2, MAX_EP = 2 * 1024 ** 3;
const BLOCK4 = new net.BlockList(), BLOCK6 = new net.BlockList(); // separata: IPv6-regler som ::ffff:0:0/96 matchar annars alla IPv4
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCK4.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCK6.addSubnet(a, n, 'ipv6');
export const blockedIp = (ip) => { const v = net.isIP(ip); return !v || (v === 4 ? BLOCK4.check(ip, 'ipv4') : BLOCK6.check(ip, 'ipv6')); };
const allowPrivate = () => process.env.PODCAST_ALLOW_PRIVATE === '1';
function checkedLookup(host, opts, cb) {
  dns.lookup(host, { all: true }).then(addrs => {
    const bad = !allowPrivate() && addrs.find(a => blockedIp(a.address));
    if (bad || !addrs.length) return cb(Object.assign(new Error('Adressen pekar på ett lokalt nätverk och tillåts inte'), { code: 'EBLOCKED' }));
    if (opts?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  }, cb);
}
function request(url, headers, timeout, signal, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Tidsgränsen överskreds'));
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Bara http/https stöds'));
    if (u.username || u.password) return reject(new Error('Adresser med inloggning stöds inte'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && blockedIp(host) && !allowPrivate()) return reject(new Error('Adressen pekar på ett lokalt nätverk och tillåts inte'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: { 'User-Agent': 'BraXhnTV/1.0 (podcast)', ...headers }, lookup: checkedLookup, timeout, signal }, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } }, body: res });
    });
    req.on('timeout', () => req.destroy(new Error('Tidsgränsen överskreds')));
    req.on('error', (e) => reject(e.code === 'EBLOCKED' ? new Error(e.message) : e.name === 'AbortError' ? new Error('Tidsgränsen överskreds') : e));
    req.end(body ?? undefined);
  });
}
/** Hämtning som följer omdirigeringar själv och kontrollerar varje steg. Svaret har status/ok/headers.get/body (ström). */
/** timeout gäller tystnad på anslutningen; signal (t.ex. AbortSignal.timeout) avbryter hela hämtningen inklusive läsningen av svaret. */
export async function safeFetch(u, { headers = {}, timeout = 30000, signal } = {}) {
  let url = String(u);
  for (let i = 0; i < 6; i++) {
    const r = await request(url, headers, timeout, signal);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) { r.body.resume(); url = new URL(r.headers.get('location'), url).href; continue; }
    return { r, url };
  }
  throw new Error('För många omdirigeringar');
}
/** POST till en användarangiven adress (t.ex. personlig ntfy/webhook) med samma skydd – följer inga omdirigeringar. */
export async function safePost(u, body, { headers = {}, timeout = 15000 } = {}) {
  const r = await request(String(u), { 'Content-Length': String(Buffer.byteLength(body)), ...headers }, timeout, AbortSignal.timeout(timeout + 5000), 'POST', body);
  const text = (await readLimited(r, 64 << 10).catch(() => Buffer.alloc(0))).toString('utf8');
  return { status: r.status, ok: r.ok, text };
}
export async function readLimited(r, max) {
  const chunks = []; let n = 0;
  try {
    for await (const c of r.body) { n += c.length; if (n > max) { r.body.destroy(); throw new Error('Svaret är för stort'); } chunks.push(c); }
  } catch (e) { throw e.name === 'AbortError' ? new Error('Tidsgränsen överskreds') : e; }
  return Buffer.concat(chunks);
}

// ---------- Sök efter poddar (Apples poddkatalog, ingen nyckel krävs) ----------
// Som Audiobookshelf: sökningen ger RSS-adressen, så att man slipper leta upp den själv. Svaren cachas en stund.
const searchCache = new Map();
export async function search(term, country = 'se') {
  term = String(term || '').normalize('NFC').trim().slice(0, 100);
  if (term.length < 2) return [];
  const k = country + '|' + term.toLowerCase();
  const hit = searchCache.get(k);
  if (hit && hit.at > Date.now() - 10 * 60e3) return hit.list;
  const q = new URLSearchParams({ media: 'podcast', entity: 'podcast', term, country, limit: '25' });
  let r;
  try { ({ r } = await safeFetch('https://itunes.apple.com/search?' + q, { timeout: 10000, signal: AbortSignal.timeout(15000) })); }
  catch (e) { console.warn('[poddar] sökningen:', e.message); throw new Error('Kunde inte nå Apples poddkatalog – kontrollera att servern har internetanslutning, eller klistra in RSS-adressen'); }
  if (!r.ok) { r.body.resume?.(); throw new Error(`Sökningen svarar inte just nu (${r.status})`); }
  let d; try { d = JSON.parse((await readLimited(r, 2 << 20)).toString('utf8')); } catch { throw new Error('Oväntat svar från sökningen'); }
  const list = (d.results || []).filter(x => /^https?:\/\//i.test(x.feedUrl || '')).map(x => ({
    title: String(x.collectionName || x.trackName || '').slice(0, 200), author: String(x.artistName || '').slice(0, 200),
    feed: String(x.feedUrl).slice(0, 2000), genre: String(x.primaryGenreName || '').slice(0, 80), episodes: +x.trackCount || 0,
    art: artOk(x.artworkUrl600 || x.artworkUrl100) ? String(x.artworkUrl600 || x.artworkUrl100) : null }));
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(k, { at: Date.now(), list });
  return list;
}
// Omslagen i sökresultatet hämtas via servern (CSP tillåter inga bilder från andra webbplatser) – bara Apples bildservrar
export const artOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)mzstatic\.com$/.test(x.hostname); } catch { return false; } };

// ---------- RSS-tolkning ----------
// Tolkas med indexOf och begränsade mönster (inga regex som kan ta exponentiell/kvadratisk tid på skadliga flöden)
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|\w{1,10});/gi, (m, e) => { try { return e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m; } catch { return m; } });
const stripHtml = (s) => decode(s).replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^<>]{0,2000}>/g, '').replace(/&(#x?[0-9a-f]{1,7}|\w{1,10});/gi, (m) => decode(m)).replace(/\n{3,}/g, '\n\n').trim();
/** Hitta öppningstaggen <name ...> (inte <namex>) och returnera { start, end (efter >), attrs } */
function openTag(x, name, from = 0) {
  const lx = x.toLowerCase(), ln = '<' + name.toLowerCase();
  let i = from;
  for (;;) {
    i = lx.indexOf(ln, i);
    if (i < 0) return null;
    const ch = lx[i + ln.length];
    if (ch === '>' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '/') {
      const e = x.indexOf('>', i);
      if (e < 0 || e - i > 4000) { i += ln.length; continue; }
      return { start: i, end: e + 1, attrs: x.slice(i + ln.length, e), selfClosing: x[e - 1] === '/' };
    }
    i += ln.length;
  }
}
const tag = (x, name) => {
  const o = openTag(x, name); if (!o || o.selfClosing) return null;
  const c = x.toLowerCase().indexOf(`</${name.toLowerCase()}>`, o.end);
  return c < 0 ? null : decode(x.slice(o.end, c)).trim();
};
const attr = (x, name, a) => {
  const o = openTag(x, name); if (!o) return null;
  const m = new RegExp(`(?:^|\\s)${a}\\s*=\\s*(?:"([^"]{0,4000})"|'([^']{0,4000})')`, 'i').exec(o.attrs);
  return m ? decode(m[1] ?? m[2]) : null;
};
const dur = (s) => { if (!s) return null; const p = String(s).trim().split(':').map(Number); if (p.some(isNaN)) return null; return p.reduce((a, v) => a * 60 + v, 0); };

export function parseFeed(xml) {
  const first = openTag(xml, 'item');
  const head = first ? xml.slice(0, first.start) : xml;
  const feed = { title: tag(head, 'title'), author: tag(head, 'itunes:author') || tag(head, 'managingEditor'), link: tag(head, 'link'),
    description: stripHtml(tag(head, 'itunes:summary') || tag(head, 'description') || '').slice(0, 3000),
    image: attr(head, 'itunes:image', 'href') || tag(tag(head, 'image') || '', 'url') };
  const items = [];
  const lx = xml.toLowerCase();
  for (let o = first; o && items.length < 3000; o = openTag(xml, 'item', o.end)) {
    const close = lx.indexOf('</item>', o.end);
    if (close < 0) break;
    if (close - o.end > 300000) continue; // orimligt stora avsnitt hoppas över
    const x = xml.slice(o.start, close + 7);
    const url = attr(x, 'enclosure', 'url');
    if (!url) continue;
    items.push({ guid: tag(x, 'guid') || url, title: tag(x, 'title') || 'Avsnitt', url,
      mime: attr(x, 'enclosure', 'type'), size: parseInt(attr(x, 'enclosure', 'length')) || null,
      // Odaterade avsnitt behåller flödets ordning (inte alla samma tid)
      published: Math.floor((parseDate(tag(x, 'pubDate')) || Date.now() - items.length * 1000) / 1000),
      duration: dur(tag(x, 'itunes:duration')),
      description: stripHtml(tag(x, 'content:encoded') || tag(x, 'description') || tag(x, 'itunes:summary') || '').slice(0, 5000) });
  }
  return { feed, items };
}

// ---------- prenumerationer ----------
const imgFile = (id) => path.join(IMAGES, `pod${id}.jpg`);
export const imagePath = (id) => { const f = imgFile(id); return fs.existsSync(f) ? f : null; };

export async function subscribe(url, user) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Ange adressen till poddens RSS-flöde (börjar med https://)');
  const ex = get('SELECT id FROM podcasts WHERE url=?', url);
  if (ex) return ex.id;
  if (get('SELECT COUNT(*) AS n FROM podcasts').n >= 300) throw new Error('Max 300 poddar');
  const id = Number(run('INSERT INTO podcasts(url,added_by,added,keep) VALUES(?,?,?,?)', url, user?.id || null, now(), +getSetting('podcast_keep', '3')).lastInsertRowid);
  try { await refresh(id, true); } catch (e) { run('DELETE FROM podcasts WHERE id=?', id); throw e; }
  return id;
}

const FEED_DEADLINE = 60e3; // hela flödet (anslutning + nedladdning) måste vara klart inom en minut
let upsertStmt = null, sameStmt = null;
export async function refresh(id, first = false) {
  const p = get('SELECT * FROM podcasts WHERE id=?', id); if (!p) return;
  try {
    const signal = AbortSignal.timeout(FEED_DEADLINE);
    const { r } = await safeFetch(p.url, { signal });
    if (!r.ok) { r.body.resume(); throw new Error(`Flödet svarade ${r.status}`); }
    const xml = (await readLimited(r, MAX_FEED)).toString('utf8');
    if (!/<rss|<feed|<channel/i.test(xml)) throw new Error('Adressen är inte ett RSS-flöde');
    const { feed, items } = parseFeed(xml);
    run('UPDATE podcasts SET title=?, author=?, description=?, link=?, last_fetch=?, error=NULL WHERE id=?',
      (feed.title || p.url).slice(0, 300), feed.author?.slice(0, 200) || null, feed.description || null, feed.link?.slice(0, 500) || null, now(), id);
    if (feed.image && (!p.image || first)) {
      try {
        const { r: ir } = await safeFetch(feed.image, { timeout: 20000, signal: AbortSignal.timeout(30000) });
        if (ir.ok && /^image\//.test(ir.headers.get('content-type') || 'image/')) { fs.writeFileSync(imgFile(id), await readLimited(ir, 5 << 20)); run('UPDATE podcasts SET image=1 WHERE id=?', id); }
        else ir.body.resume();
      } catch {}
    }
    // En transaktion per flöde; oförändrade avsnitt skrivs inte om
    upsertStmt ||= db.prepare(`INSERT INTO podcast_episodes(podcast_id,guid,title,description,published,duration,url,mime,size,added) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(podcast_id,guid) DO UPDATE SET title=excluded.title, description=excluded.description, duration=COALESCE(excluded.duration,duration), url=excluded.url`);
    sameStmt ||= db.prepare(`SELECT 1 FROM podcast_episodes WHERE podcast_id=? AND guid=? AND title IS ? AND description IS ? AND url=? AND (duration IS ? OR ? IS NULL)`);
    db.exec('BEGIN');
    try {
      for (const it of items.slice(0, 1000)) {
        const guid = String(it.guid).slice(0, 500), title = it.title.slice(0, 300);
        if (sameStmt.get(id, guid, title, it.description, it.url, it.duration, it.duration)) continue;
        upsertStmt.run(id, guid, title, it.description, it.published, it.duration, it.url, it.mime, it.size, now());
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    autoDownload(id);
    return { episodes: items.length };
  } catch (e) {
    run('UPDATE podcasts SET error=?, last_fetch=? WHERE id=?', e.message, now(), id);
    throw e;
  }
}

// ---------- nedladdning ----------
let active = 0; const queue = [];
const epFile = (ep) => path.join(DIR, `${ep.podcast_id}-${ep.id}${({ 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/opus': '.opus' })[ep.mime] || '.mp3'}`);
export function download(epId) {
  const ep = get('SELECT * FROM podcast_episodes WHERE id=?', epId);
  if (!ep || ep.file || ep.downloading) return;
  run('UPDATE podcast_episodes SET downloading=1 WHERE id=?', epId);
  queue.push(async () => {
    const out = epFile(ep), tmp = out + '.part';
    const jb = jobs.track('download', `Laddar ner: ${ep.title}`, { detail: 'podd' });
    try {
      // Total tidsgräns: en server som droppar en byte i taget får inte hålla en nedladdningsplats i dagar
      const { r } = await safeFetch(ep.url, { timeout: 30 * 60e3, signal: AbortSignal.timeout(3 * 3600e3) });
      if (!r.ok) throw new Error(`Avsnittet svarade ${r.status}`);
      let n = 0;
      const limit = new Transform({ transform(c, _e, cb) { n += c.length; cb(n > MAX_EP ? new Error('Filen är för stor') : null, c); } });
      await pipeline(r.body, limit, fs.createWriteStream(tmp));
      fs.renameSync(tmp, out);
      run('UPDATE podcast_episodes SET file=?, downloading=0, size=? WHERE id=?', path.basename(out), fs.statSync(out).size, epId);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      run('UPDATE podcast_episodes SET downloading=0 WHERE id=?', epId);
      console.warn('[podd] nedladdning misslyckades:', ep.title, e.message);
    } finally { jb.end(); }
  });
  pump();
}
function pump() { while (active < 2 && queue.length) { active++; queue.shift()().finally(() => { active--; pump(); }); } }
function autoDownload(podId) {
  const p = get('SELECT keep FROM podcasts WHERE id=?', podId);
  if (!p?.keep) return;
  for (const e of all('SELECT id FROM podcast_episodes WHERE podcast_id=? ORDER BY published DESC LIMIT ?', podId, p.keep)) download(e.id);
}
/** Ta bort nedladdade avsnitt som är äldre än de N senaste och som alla har lyssnat klart på eller som är äldre än 30 dagar */
export function cleanup() {
  for (const p of all('SELECT id, keep FROM podcasts')) {
    const keepIds = new Set(all('SELECT id FROM podcast_episodes WHERE podcast_id=? ORDER BY published DESC LIMIT ?', p.id, p.keep).map(r => r.id));
    for (const e of all('SELECT id, file, added FROM podcast_episodes WHERE podcast_id=? AND file IS NOT NULL', p.id)) {
      if (keepIds.has(e.id)) continue;
      const inProgress = get('SELECT 1 FROM podcast_progress WHERE episode_id=? AND played=0 AND position>0 AND updated > ?', e.id, now() - 30 * 86400);
      if (inProgress) continue;
      // Ett avsnitt som laddats ner nyligen (t.ex. för att lyssna offline) och som ingen lyssnat klart på får vara kvar i 30 dagar
      const f = path.join(DIR, path.basename(e.file));
      let age = Infinity; try { age = Date.now() - fs.statSync(f).mtimeMs; } catch {}
      const played = get('SELECT 1 FROM podcast_progress WHERE episode_id=? AND played=1', e.id);
      if (!played && age < 30 * 86400e3) continue;
      fs.rmSync(path.join(DIR, path.basename(e.file)), { force: true });
      run('UPDATE podcast_episodes SET file=NULL WHERE id=?', e.id);
    }
  }
}
export function unsubscribe(id) {
  for (const e of all('SELECT file FROM podcast_episodes WHERE podcast_id=? AND file IS NOT NULL', id)) fs.rmSync(path.join(DIR, path.basename(e.file)), { force: true });
  fs.rmSync(imgFile(id), { force: true });
  run('DELETE FROM podcasts WHERE id=?', id);
}

// ---------- uppspelning ----------
export async function stream(req, res, ep) {
  if (ep.file) {
    const f = path.join(DIR, path.basename(ep.file));
    let st; try { st = fs.statSync(f); } catch { run('UPDATE podcast_episodes SET file=NULL WHERE id=?', ep.id); return stream(req, res, { ...ep, file: null }); }
    // streamFile: korrekt Range-hantering och pipeline (stänger filen när spelaren avbryter vid spolning)
    return streamFile(req, res, f, st.size, { 'Content-Type': ep.mime && /^audio\//.test(ep.mime) ? ep.mime : 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
  }
  // Inte nedladdat: vidarebefordra från poddens server (med Range) och ladda ner i bakgrunden
  download(ep.id);
  const { r } = await safeFetch(ep.url, { headers: req.headers.range ? { Range: req.headers.range } : {}, timeout: 30 * 60e3 });
  const h = { 'Content-Type': /^audio\//.test(r.headers.get('content-type') || '') ? r.headers.get('content-type') : (ep.mime || 'audio/mpeg'), 'Cache-Control': 'no-store' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) h[k] = r.headers.get(k);
  res.writeHead(r.status === 206 ? 206 : r.ok ? 200 : 502, h);
  if (req.method === 'HEAD' || !r.ok) { r.body.destroy(); return res.end(); }
  req.on('close', () => r.body.destroy());
  r.body.pipe(res);
}

// ---------- API-hjälp ----------
export const list = (uid) => all(`SELECT p.*, (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id=p.id) AS episodes,
  (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id=p.id AND NOT EXISTS (SELECT 1 FROM podcast_progress q WHERE q.episode_id=e.id AND q.user_id=? AND q.played=1)
    AND e.published > ?) AS unplayed, (SELECT MAX(published) FROM podcast_episodes e WHERE e.podcast_id=p.id) AS latest
  FROM podcasts p ORDER BY latest DESC`, uid, now() - 60 * 86400)
  .map(p => ({ id: p.id, title: p.title, author: p.author, image: !!p.image, episodes: p.episodes, unplayed: p.unplayed, latest: p.latest, error: p.error }));
const epShape = (e) => ({ id: e.id, podcast: e.podcast_id, podcastTitle: e.ptitle, title: e.title, description: e.description, published: e.published, duration: e.duration,
  downloaded: !!e.file, downloading: !!e.downloading, position: e.position || 0, played: !!e.played });
export function podcast(id, uid) {
  const p = get('SELECT * FROM podcasts WHERE id=?', id); if (!p) return null;
  return { id: p.id, title: p.title, author: p.author, description: p.description, link: p.link, url: p.url, image: !!p.image, keep: p.keep, error: p.error, lastFetch: p.last_fetch,
    episodes: all(`SELECT e.*, q.position, q.played FROM podcast_episodes e LEFT JOIN podcast_progress q ON q.episode_id=e.id AND q.user_id=? WHERE e.podcast_id=? ORDER BY e.published DESC LIMIT 300`, uid, id).map(epShape) };
}
export const latest = (uid, limit = 30) => all(`SELECT e.*, p.title AS ptitle, q.position, q.played FROM podcast_episodes e JOIN podcasts p ON p.id=e.podcast_id
  LEFT JOIN podcast_progress q ON q.episode_id=e.id AND q.user_id=? WHERE COALESCE(q.played,0)=0 ORDER BY e.published DESC LIMIT ?`, uid, limit).map(epShape);
export function saveProgress(uid, epId, position, played) {
  const e = get('SELECT duration FROM podcast_episodes WHERE id=?', epId); if (!e) return null;
  const pos = Math.max(0, +position || 0);
  const done = played != null ? (played ? 1 : 0) : (e.duration && e.duration - pos < 45 ? 1 : 0);
  run(`INSERT INTO podcast_progress(user_id,episode_id,position,played,updated) VALUES(?,?,?,?,?) ON CONFLICT(user_id,episode_id) DO UPDATE SET
    position=excluded.position, played=${played != null ? 'excluded.played' : 'MAX(played, excluded.played)'}, updated=excluded.updated`, uid, epId, done ? 0 : pos, done, now());
  return { played: !!done };
}
export const episodeRow = (id) => get('SELECT * FROM podcast_episodes WHERE id=?', id);

// Uppdatera alla flöden varje timme och städa nedladdningar (en körning åt gången, högst 4 flöden samtidigt)
let refreshing = false;
export async function refreshAll(concurrency = 4) {
  if (refreshing) return;
  refreshing = true;
  try {
    const due = all('SELECT id FROM podcasts WHERE last_fetch IS NULL OR last_fetch < ?', now() - 3600).map(p => p.id);
    const worker = async () => { while (due.length) { const id = due.shift(); try { await refresh(id); } catch (e) { void e; } } };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    try { cleanup(); } catch (e) { console.warn('[podd] städning:', e.message); }
  } finally { refreshing = false; }
}
setInterval(() => { refreshAll().catch(e => console.warn('[podd] uppdatering:', e.message)); }, 15 * 60e3).unref();
