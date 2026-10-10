// Poddar: prenumerera på RSS-flöden, hämta nya avsnitt automatiskt och lyssna med sparad position.
// Skydd: flöden och avsnitt hämtas bara från publika adresser (inte hemnätet), med storleks- och tidsgränser.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { db, get, all, run, now, getSetting, CONFIG, IMAGES } from './db.js';
import { isPrivate } from './util.js';

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

// ---------- säker hämtning ----------
const MAX_FEED = 15 * 1024 ** 2, MAX_EP = 2 * 1024 ** 3;
async function assertPublic(u) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bara http/https stöds');
  if (url.username || url.password) throw new Error('Adresser med inloggning stöds inte');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (process.env.PODCAST_ALLOW_PRIVATE !== '1' && addrs.some(a => isPrivate(a.address) || /^(0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::$|fe80:|::ffff:(127|10|192\.168)\.)/i.test(a.address)))
    throw new Error('Adressen pekar på ett lokalt nätverk och tillåts inte');
  return url;
}
/** fetch som följer omdirigeringar själv och kontrollerar varje steg */
export async function safeFetch(u, { headers = {}, timeout = 30000 } = {}) {
  let url = String(u);
  for (let i = 0; i < 6; i++) {
    await assertPublic(url);
    const r = await fetch(url, { headers: { 'User-Agent': 'BraXhnTV/1.0 (podcast)', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; continue; }
    return { r, url };
  }
  throw new Error('För många omdirigeringar');
}
async function readLimited(r, max) {
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error('Svaret är för stort'); chunks.push(c); }
  return Buffer.concat(chunks);
}

// ---------- RSS-tolkning ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const stripHtml = (s) => decode(s).replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m) => decode(m)).replace(/\n{3,}/g, '\n\n').trim();
const tag = (x, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(x); return m ? decode(m[1]).trim() : null; };
const attr = (x, name, a) => { const m = new RegExp(`<${name}\\s[^>]*?${a}\\s*=\\s*["']([^"']+)["']`, 'i').exec(x); return m ? decode(m[1]) : null; };
const dur = (s) => { if (!s) return null; const p = String(s).trim().split(':').map(Number); if (p.some(isNaN)) return null; return p.reduce((a, v) => a * 60 + v, 0); };

export function parseFeed(xml) {
  const chEnd = xml.search(/<item[\s>]/i);
  const head = chEnd > 0 ? xml.slice(0, chEnd) : xml;
  const feed = { title: tag(head, 'title'), author: tag(head, 'itunes:author') || tag(head, 'managingEditor'), link: tag(head, 'link'),
    description: stripHtml(tag(head, 'itunes:summary') || tag(head, 'description') || '').slice(0, 3000),
    image: attr(head, 'itunes:image', 'href') || tag(tag(head, 'image') || '', 'url') };
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const x = m[0];
    const url = attr(x, 'enclosure', 'url');
    if (!url) continue;
    items.push({ guid: tag(x, 'guid') || url, title: tag(x, 'title') || 'Avsnitt', url,
      mime: attr(x, 'enclosure', 'type'), size: parseInt(attr(x, 'enclosure', 'length')) || null,
      published: Math.floor((Date.parse(tag(x, 'pubDate') || '') || Date.now()) / 1000),
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

export async function refresh(id, first = false) {
  const p = get('SELECT * FROM podcasts WHERE id=?', id); if (!p) return;
  try {
    const { r } = await safeFetch(p.url);
    if (!r.ok) throw new Error(`Flödet svarade ${r.status}`);
    const xml = (await readLimited(r, MAX_FEED)).toString('utf8');
    if (!/<rss|<feed|<channel/i.test(xml)) throw new Error('Adressen är inte ett RSS-flöde');
    const { feed, items } = parseFeed(xml);
    run('UPDATE podcasts SET title=?, author=?, description=?, link=?, last_fetch=?, error=NULL WHERE id=?',
      (feed.title || p.url).slice(0, 300), feed.author?.slice(0, 200) || null, feed.description || null, feed.link?.slice(0, 500) || null, now(), id);
    if (feed.image && (!p.image || first)) {
      try {
        const { r: ir } = await safeFetch(feed.image, { timeout: 20000 });
        if (ir.ok && /^image\//.test(ir.headers.get('content-type') || 'image/')) { fs.writeFileSync(imgFile(id), await readLimited(ir, 5 << 20)); run('UPDATE podcasts SET image=1 WHERE id=?', id); }
      } catch {}
    }
    for (const it of items.slice(0, 1000)) {
      run(`INSERT INTO podcast_episodes(podcast_id,guid,title,description,published,duration,url,mime,size,added) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(podcast_id,guid) DO UPDATE SET title=excluded.title, description=excluded.description, duration=COALESCE(excluded.duration,duration), url=excluded.url`,
        id, String(it.guid).slice(0, 500), it.title.slice(0, 300), it.description, it.published, it.duration, it.url, it.mime, it.size, now());
    }
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
    try {
      const { r } = await safeFetch(ep.url, { timeout: 30 * 60e3 });
      if (!r.ok) throw new Error(`Avsnittet svarade ${r.status}`);
      let n = 0;
      const limit = new Transform({ transform(c, _e, cb) { n += c.length; cb(n > MAX_EP ? new Error('Filen är för stor') : null, c); } });
      await pipeline(Readable.fromWeb(r.body), limit, fs.createWriteStream(tmp));
      fs.renameSync(tmp, out);
      run('UPDATE podcast_episodes SET file=?, downloading=0, size=? WHERE id=?', path.basename(out), fs.statSync(out).size, epId);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      run('UPDATE podcast_episodes SET downloading=0 WHERE id=?', epId);
      console.warn('[podd] nedladdning misslyckades:', ep.title, e.message);
    }
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
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m) { start = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1]; if (m[1] !== '' && m[2] !== '') end = Math.min(+m[2], end); code = 206; }
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    const h = { 'Content-Type': ep.mime && /^audio\//.test(ep.mime) ? ep.mime : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600' };
    if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(f, { start, end }).pipe(res);
  }
  // Inte nedladdat: vidarebefordra från poddens server (med Range) och ladda ner i bakgrunden
  download(ep.id);
  const { r } = await safeFetch(ep.url, { headers: req.headers.range ? { Range: req.headers.range } : {}, timeout: 30 * 60e3 });
  const h = { 'Content-Type': /^audio\//.test(r.headers.get('content-type') || '') ? r.headers.get('content-type') : (ep.mime || 'audio/mpeg'), 'Cache-Control': 'no-store' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) h[k] = r.headers.get(k);
  res.writeHead(r.status === 206 ? 206 : r.ok ? 200 : 502, h);
  if (req.method === 'HEAD' || !r.ok) return res.end();
  const src = Readable.fromWeb(r.body);
  req.on('close', () => src.destroy());
  src.pipe(res);
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

// Uppdatera alla flöden varje timme och städa nedladdningar
setInterval(async () => {
  for (const p of all('SELECT id FROM podcasts WHERE last_fetch IS NULL OR last_fetch < ?', now() - 3600)) await refresh(p.id).catch(() => {});
  cleanup();
}, 15 * 60e3).unref();
