// Live-TV: HDHomeRun (antenn/kabel) och IPTV (M3U), TV-guide (XMLTV eller HDHomeRuns guide) och
// live-strömning som HLS. Flera tittare på samma kanal delar en ström; strömmen stängs när ingen tittar.
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { db, get, all, run, now, getSetting, CONFIG } from './db.js';
import { TRANSCODE, liveEncoder } from './stream.js';
import { send, fail, streamFile } from './util.js';
import { listSize, rewritePlaylist, enforceCap, SEG_RE, segNum } from './timeshift.js';

db.exec(`CREATE TABLE IF NOT EXISTS tuners(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('hdhr','m3u')), name TEXT NOT NULL, url TEXT NOT NULL,
  epg_url TEXT, tuner_count INTEGER NOT NULL DEFAULT 2, device_auth TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_refresh INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY, tuner_id INTEGER NOT NULL REFERENCES tuners(id) ON DELETE CASCADE,
  number TEXT, name TEXT NOT NULL, logo TEXT, stream_url TEXT NOT NULL, epg_id TEXT, group_name TEXT, hd INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, sort REAL);
CREATE UNIQUE INDEX IF NOT EXISTS channels_url ON channels(tuner_id, stream_url);
CREATE TABLE IF NOT EXISTS programs(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT, category TEXT,
  season INTEGER, episode INTEGER, icon TEXT, is_new INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS programs_ch ON programs(channel_id, start);
CREATE INDEX IF NOT EXISTS programs_title ON programs(title COLLATE NOCASE, start);`);

// ---------- hjälp ----------
function localPath(url) {
  const p = url.replace(/^file:\/\//, '');
  if (!path.resolve(p).startsWith(path.resolve(CONFIG))) throw new Error('Lokala filer måste ligga i /config');
  return p;
}
async function fetchText(url, { timeout = 60000, max = 200 << 20 } = {}) {
  if (/^file:/.test(url) || url.startsWith('/')) {
    const p = localPath(url);
    const b = fs.readFileSync(p);
    return (/\.gz$/.test(p) ? zlib.gunzipSync(b, { maxOutputLength: 400 << 20 }) : b).toString('utf8');
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'BraXhnTV/1.0' } });
  if (!r.ok) throw new Error(`${new URL(url).host} svarade ${r.status}`);
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error('Filen är för stor'); chunks.push(c); }
  let b = Buffer.concat(chunks);
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b, { maxOutputLength: 400 << 20 });
  return b.toString('utf8');
}
/** Strömmande hämtning som text (för stora TV-guider): hela filen hålls aldrig i minnet. Packar upp gzip automatiskt. */
async function* fetchTextStream(url, { timeout = 180000, max = 200 << 20, maxOut = 1024 << 20 } = {}) {
  let src;
  if (/^file:/.test(url) || url.startsWith('/')) src = fs.createReadStream(localPath(url), { highWaterMark: 256 << 10 });
  else {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'BraXhnTV/1.0' } });
    if (!r.ok) { r.body?.cancel().catch(() => {}); throw new Error(`${new URL(url).host} svarade ${r.status}`); }
    src = Readable.fromWeb(r.body);
  }
  const it = src[Symbol.asyncIterator]();
  try {
    let first = await it.next();
    if (first.done) return;
    const dec = new TextDecoder('utf-8');
    let n = 0, out = 0;
    const raw = async function* () { let c = first; while (!c.done) { n += c.value.length; if (n > max) throw new Error('Filen är för stor'); yield c.value; c = await it.next(); } };
    if (first.value[0] === 0x1f && first.value[1] === 0x8b) {
      const gz = zlib.createGunzip();
      const feeder = Readable.from(raw());
      feeder.on('error', (e) => gz.destroy(e));
      feeder.pipe(gz);
      try {
        for await (const c of gz) { out += c.length; if (out > maxOut) throw new Error('Filen är för stor'); yield dec.decode(c, { stream: true }); }
      } finally { feeder.destroy(); gz.destroy(); }
    } else for await (const c of raw()) yield dec.decode(c, { stream: true });
    const tail = dec.decode();
    if (tail) yield tail;
  } finally { src.destroy?.(); it.return?.().catch?.(() => {}); }
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dec = (s) => { s = String(s ?? ''); return s.includes('&') || s.includes('<![') ? decFull(s) : s.trim(); };
const decFull = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => { try { return e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m; } catch { return m; } }).trim();
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(hd|sd|fhd|uhd|4k|se|sverige)\b/g, '').replace(/[^a-z0-9]/g, '');

// ---------- M3U ----------
export function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      const name = line.slice(line.lastIndexOf(',') + 1).trim();
      cur = { name: name || attrs['tvg-name'] || 'Kanal', epg: attrs['tvg-id'] || null, logo: attrs['tvg-logo'] || null, group: attrs['group-title'] || null, number: attrs['tvg-chno'] || attrs['channel-number'] || null };
    } else if (line && !line.startsWith('#') && cur) {
      if (/^(https?|rtp|udp|rtsp):\/\//i.test(line)) out.push({ ...cur, url: line });
      cur = null;
    }
  }
  return out;
}

// ---------- XMLTV ----------
/** "20261010180000 +0200" → unix-sekunder */
export function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s || '').trim());
  if (!m) return null;
  const tz = m[7] ? (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(3)) : 0;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000) - tz * 60;
}
function parseChannel(a, b) {
  const id = /\bid="([^"]+)"/.exec(a)?.[1];
  if (!id) return null;
  return { id: dec(id), names: [...b.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map(x => dec(x[1])), icon: /<icon\s+src="([^"]+)"/.exec(b)?.[1] || null };
}
function parseProgramme(a, b) {
  const start = xmltvTime(/start="([^"]+)"/.exec(a)?.[1]), stop = xmltvTime(/stop="([^"]+)"/.exec(a)?.[1]);
  const ch = dec(/channel="([^"]+)"/.exec(a)?.[1]);
  if (!start || !ch) return null;
  const ns = /<episode-num[^>]*system="xmltv_ns"[^>]*>([^<]*)</.exec(b)?.[1];
  let season = null, episode = null;
  if (ns) { const [s, e] = ns.split('.'); season = s?.trim() ? parseInt(s) + 1 : null; episode = e?.trim() ? parseInt(e) + 1 : null; }
  const onscreen = /<episode-num[^>]*system="onscreen"[^>]*>\s*S(\d+)\s*E(\d+)/i.exec(b);
  if (onscreen) { season = +onscreen[1]; episode = +onscreen[2]; }
  return { channel: ch, start, stop: stop || start + 1800, title: dec(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1]) || 'Program',
    subtitle: dec(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/.exec(b)?.[1]) || null, description: dec(/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(b)?.[1]) || null,
    category: dec(/<category[^>]*>([\s\S]*?)<\/category>/.exec(b)?.[1]) || null, season: Number.isFinite(season) ? season : null, episode: Number.isFinite(episode) ? episode : null,
    icon: /<icon\s+src="([^"]+)"/.exec(b)?.[1] || null, isNew: /<new\s*\/>/.test(b) || /<premiere/.test(b) };
}
/** Stegvis XMLTV-tolk: matas med textbitar och anropar onChannel/onProgram för varje komplett element (linjär tid, litet minne). */
export class XmltvParser {
  constructor({ onChannel, onProgram }) { this.onChannel = onChannel; this.onProgram = onProgram; this.buf = ''; }
  feed(s) {
    const b = this.buf ? this.buf + s : s;
    const re = /<(channel|programme)[\s>]/g;
    let pos = 0, m;
    while ((m = re.exec(b))) {
      const isCh = m[1] === 'channel';
      const close = b.indexOf(isCh ? '</channel>' : '</programme>', m.index);
      if (close < 0) { pos = m.index; break; } // ofullständigt element: vänta på mer data
      const gt = b.indexOf('>', m.index);
      if (gt > 0 && gt < close) {
        const attrs = b.slice(m.index + m[0].length - 1, gt), body = b.slice(gt + 1, close);
        if (isCh) { const c = parseChannel(attrs, body); if (c) this.onChannel(c); }
        else { const p = parseProgramme(attrs, body); if (p) this.onProgram(p); }
      }
      pos = close + (isCh ? 10 : 12);
      re.lastIndex = pos;
    }
    if (!m) { const lt = b.lastIndexOf('<'); pos = Math.max(pos, lt >= pos ? lt : b.length); }
    this.buf = b.slice(pos);
    if (this.buf.length > 64 << 20) throw new Error('Ogiltig XMLTV (för stort element)');
  }
}
export function parseXMLTV(xml) {
  const channels = [], programs = [];
  new XmltvParser({ onChannel: c => channels.push(c), onProgram: p => programs.push(p) }).feed(xml);
  return { channels, programs };
}

// ---------- HDHomeRun ----------
/** Leta efter HDHomeRun-enheter på nätverket (UDP-broadcast). Fungerar bara om containern kör med host- eller macvlan-nätverk. */
export function discoverHdhr(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (_m, rinfo) => found.add(rinfo.address));
    sock.on('error', () => { try { sock.close(); } catch {} resolve([]); });
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        // HDHomeRun discover-paket: typ 0x0002, taggar för enhetstyp (tuner) och wildcard-id, CRC32 (LE)
        const body = Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x04, 0xff, 0xff, 0xff, 0xff]);
        const pkt = Buffer.concat([Buffer.from([0x00, 0x02, 0x00, body.length]), body]);
        const crc = Buffer.alloc(4); crc.writeUInt32LE(crc32(pkt));
        sock.send(Buffer.concat([pkt, crc]), 65001, '255.255.255.255');
      } catch {}
      setTimeout(() => { try { sock.close(); } catch {} resolve([...found]); }, timeoutMs);
    });
  });
}
function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }

async function hdhrInfo(base) {
  base = base.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) base = 'http://' + base;
  const d = JSON.parse(await fetchText(base + '/discover.json', { timeout: 10000 }));
  const lineup = JSON.parse(await fetchText(d.LineupURL || base + '/lineup.json', { timeout: 15000 }));
  return { base, name: d.FriendlyName || d.ModelNumber || 'HDHomeRun', tuners: d.TunerCount || 2, auth: d.DeviceAuth || null,
    channels: lineup.filter(c => !c.DRM).map(c => ({ number: c.GuideNumber, name: c.GuideName, url: c.URL, hd: c.HD ? 1 : 0 })) };
}

// ---------- källor ----------
export async function addTuner({ kind, url, name, epgUrl, tuners }) {
  if (kind === 'hdhr') {
    const info = await hdhrInfo(url);
    const id = Number(run('INSERT INTO tuners(kind,name,url,epg_url,tuner_count,device_auth) VALUES(?,?,?,?,?,?)', 'hdhr', name || info.name, info.base, epgUrl || null, info.tuners, info.auth).lastInsertRowid);
    await refreshTuner(id);
    return id;
  }
  if (kind === 'm3u') {
    if (!/^(https?:\/\/|\/config\/)/.test(url)) throw new Error('Ange en http(s)-adress eller en fil under /config');
    const id = Number(run('INSERT INTO tuners(kind,name,url,epg_url,tuner_count) VALUES(?,?,?,?,?)', 'm3u', name || 'IPTV', url, epgUrl || null, Math.max(1, Math.min(20, +tuners || 2))).lastInsertRowid);
    try { await refreshTuner(id); } catch (e) { run('DELETE FROM tuners WHERE id=?', id); throw e; }
    return id;
  }
  throw new Error('Okänd källa');
}

/** Kanalerna matchas mot befintliga rader i första hand på adress, sedan namn+nummer och sist tvg-id. IPTV-leverantörer byter ofta
 *  token i adresserna – då uppdateras adressen på samma rad så att favoriter, dolda kanaler, guidekoppling och serieinspelningar finns kvar. */
function syncChannels(tunerId, list) {
  const existing = all('SELECT id, number, name, stream_url, epg_id FROM channels WHERE tuner_id=?', tunerId);
  const byUrl = new Map(existing.map(c => [c.stream_url, c]));
  const nameKey = (name, number) => `${norm(name)}|${number ?? ''}`;
  const byName = new Map(), byEpg = new Map();
  for (const c of existing) {
    const k = nameKey(c.name, c.number); if (!byName.has(k)) byName.set(k, c);
    if (c.epg_id && !byEpg.has(c.epg_id)) byEpg.set(c.epg_id, c);
  }
  const claimed = new Set(), seenUrl = new Set();
  const rows = [];
  list.slice(0, 5000).forEach((c, i) => { if (!seenUrl.has(c.url)) { seenUrl.add(c.url); rows.push({ c, i, match: null }); } });
  const take = (r, ex) => { if (ex && !claimed.has(ex.id)) { claimed.add(ex.id); r.match = ex; } };
  const keyOf = (c) => nameKey(String(c.name).slice(0, 120), c.number || null);
  // 1) samma adress och samma kanal, 2) samma namn+nummer (adressen har bytts), 3) samma adress (kanalen har bytt namn), 4) samma tvg-id
  for (const r of rows) { const ex = byUrl.get(r.c.url); if (ex && (nameKey(ex.name, ex.number) === keyOf(r.c) || (r.c.epg && ex.epg_id === r.c.epg))) take(r, ex); }
  for (const r of rows) if (!r.match) take(r, byName.get(keyOf(r.c)));
  for (const r of rows) if (!r.match) take(r, byUrl.get(r.c.url));
  for (const r of rows) if (!r.match && r.c.epg) take(r, byEpg.get(r.c.epg));
  const upd = db.prepare(`UPDATE channels SET number=?, name=?, logo=COALESCE(?, logo), stream_url=?, epg_id=COALESCE(epg_id, ?), group_name=?, hd=?, sort=? WHERE id=?`);
  const tmpUrl = db.prepare('UPDATE channels SET stream_url=? WHERE id=?');
  const ins = db.prepare('INSERT INTO channels(tuner_id,number,name,logo,stream_url,epg_id,group_name,hd,sort) VALUES(?,?,?,?,?,?,?,?,?)');
  const del = db.prepare('DELETE FROM channels WHERE id=?');
  db.exec('BEGIN');
  try {
    // Borttagna kanaler först (deras adresser kan återanvändas), sedan tillfälliga adresser så att byten mellan kanaler inte krockar med UNIQUE-indexet
    for (const c of existing) if (!claimed.has(c.id)) del.run(c.id);
    for (const r of rows) if (r.match && r.match.stream_url !== r.c.url) tmpUrl.run(`\u0000byts:${r.match.id}`, r.match.id);
    for (const { c, i, match } of rows) {
      const v = [c.number || null, String(c.name).slice(0, 120), c.logo || null, c.url];
      if (match) upd.run(...v, c.epg || null, c.group || null, c.hd || 0, parseFloat(c.number) || i + 1, match.id);
      else ins.run(tunerId, v[0], v[1], v[2], v[3], c.epg || null, c.group || null, c.hd || 0, parseFloat(c.number) || i + 1);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function refreshTuner(id, { guide = true } = {}) {
  const t = get('SELECT * FROM tuners WHERE id=?', id); if (!t) return;
  try {
    let list;
    if (t.kind === 'hdhr') {
      const info = await hdhrInfo(t.url);
      run('UPDATE tuners SET tuner_count=?, device_auth=? WHERE id=?', info.tuners, info.auth, id);
      list = info.channels.map(c => ({ ...c, epg: null, logo: null, group: c.hd ? 'HD' : null }));
    } else list = parseM3U(await fetchText(t.url));
    if (!list.length) throw new Error('Inga kanaler hittades');
    syncChannels(id, list);
    run('UPDATE tuners SET last_refresh=?, error=NULL WHERE id=?', now(), id);
    if (guide) await refreshGuide(id).catch(e => console.warn('[livetv] guide:', e.message));
    return { channels: list.length };
  } catch (e) { run('UPDATE tuners SET error=? WHERE id=?', e.message, id); throw e; }
}

// ---------- TV-guide ----------
export const guideState = { running: false, last: null, error: null };
const KEEP_BACK = 3 * 3600; // så här långt bakåt behålls/ersätts program (pågående långa program räknas med)
const CHUNK = 5000;
let insertStmt = null;
const insertProgram = () => insertStmt ||= db.prepare('INSERT INTO programs(channel_id,start,stop,title,subtitle,description,category,season,episode,icon,is_new) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
const insRow = (chId, p) => insertProgram().run(chId, p.start, p.stop, String(p.title).slice(0, 300), p.subtitle?.slice(0, 300) || null, p.description?.slice(0, 3000) || null,
  p.category?.slice(0, 80) || null, p.season ?? null, p.episode ?? null, p.icon || null, p.isNew ? 1 : 0);
const yieldLoop = () => new Promise(setImmediate);
function inTx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** XMLTV för en källa: tolkas strömmande och skrivs i omgångar. Oförändrade program behålls (samma id), nya läggs in och
 *  gamla tas bort först när allt lyckats – avbryts hämtningen finns den gamla guiden kvar. */
const progSig = (p) => crypto.createHash('sha1').update(JSON.stringify([p.stop, String(p.title).slice(0, 300), p.subtitle?.slice(0, 300) || null, p.description?.slice(0, 3000) || null,
  p.category?.slice(0, 80) || null, p.season ?? null, p.episode ?? null, p.icon || null, p.isNew ? 1 : 0])).digest('base64');
async function guideFromXmltv(t) {
  const chans = all('SELECT id, name, number, logo, epg_id FROM channels WHERE tuner_id=?', t.id);
  const channels = new Map(); // xmltv-id → kanal
  const byName = new Map();
  let map = null; // xmltv-id → [kanal-id]
  const mapChannels = () => {
    const setEpg = db.prepare('UPDATE channels SET epg_id=? WHERE id=?'), setLogo = db.prepare('UPDATE channels SET logo=? WHERE id=?');
    inTx(() => {
      for (const ch of chans) {
        if (!(ch.epg_id && channels.has(ch.epg_id))) {
          // Koppla kanaler: tvg-id, annars namn/nummer
          const id = byName.get(norm(ch.name)) || (ch.number && byName.get(norm(ch.number))) || null;
          if (id && id !== ch.epg_id) { setEpg.run(id, ch.id); ch.epg_id = id; }
        }
        const icon = channels.get(ch.epg_id)?.icon;
        if (icon && !ch.logo) setLogo.run(icon, ch.id);
      }
    });
    map = new Map();
    for (const ch of chans) if (ch.epg_id) { if (!map.has(ch.epg_id)) map.set(ch.epg_id, []); map.get(ch.epg_id).push(ch.id); }
  };
  const boundary = get('SELECT COALESCE(MAX(id), 0) AS m FROM programs').m;
  const cutoff = now() - KEEP_BACK, horizon = now() + 14 * 86400;
  // Befintliga program per kanal (laddas när kanalen dyker upp): start → [{ id, sig, kept }]
  const oldStmt = db.prepare('SELECT id, start, stop, title, subtitle, description, category, season, episode, icon, is_new FROM programs WHERE channel_id=? AND stop > ? AND id <= ?');
  const old = new Map();
  const oldOf = (chId) => {
    let m = old.get(chId);
    if (!m) {
      m = new Map();
      for (const r of oldStmt.all(chId, cutoff, boundary)) {
        const e = { id: r.id, sig: progSig({ ...r, isNew: r.is_new }), kept: false };
        const l = m.get(r.start); l ? l.push(e) : m.set(r.start, [e]);
      }
      old.set(chId, m);
    }
    return m;
  };
  let batch = [], total = 0, inserted = 0;
  const flush = () => { if (!batch.length) return; const b = batch; batch = []; inTx(() => { for (const [chId, p] of b) insRow(chId, p); }); inserted += b.length; };
  const parser = new XmltvParser({
    onChannel: (c) => { if (map) return; channels.set(c.id, c); for (const n of c.names) byName.set(norm(n), c.id); },
    onProgram: (p) => {
      if (!map) mapChannels();
      if (!(p.stop > cutoff && p.start < horizon)) return;
      const ids = map.get(p.channel); if (!ids) return;
      let sig = null;
      for (const chId of ids) {
        total++;
        const same = oldOf(chId).get(p.start);
        if (same) {
          sig ||= progSig(p);
          const hit = same.find(e => !e.kept && e.sig === sig);
          if (hit) { hit.kept = true; continue; }
        }
        batch.push([chId, p]);
      }
    }
  });
  const chIds = () => [...new Set([...(map?.values() || [])].flat())];
  try {
    for await (const text of fetchTextStream(t.epg_url)) {
      parser.feed(text);
      if (batch.length >= CHUNK) { flush(); await yieldLoop(); }
    }
    if (!map) mapChannels();
    flush();
  } catch (e) {
    // Ta bort det som hann läggas in – den gamla guiden gäller
    const ids = chIds(), st = db.prepare('DELETE FROM programs WHERE channel_id=? AND id > ?');
    for (let i = 0; i < ids.length; i += 200) inTx(() => { for (const id of ids.slice(i, i + 200)) st.run(id, boundary); });
    throw e;
  }
  // Ta bort ersatta program. Samma villkor som vid inläggningen (stop > cutoff), annars dubbletter av långa program.
  const delId = db.prepare('DELETE FROM programs WHERE id=?');
  const delCh = db.prepare('DELETE FROM programs WHERE channel_id=? AND id <= ? AND stop > ?');
  const gone = [];
  for (const chId of chIds()) {
    const m = old.get(chId);
    if (!m) gone.push(() => delCh.run(chId, boundary, cutoff)); // kanalen saknar program i den nya guiden
    else for (const l of m.values()) for (const e of l) if (!e.kept) gone.push(() => delId.run(e.id));
  }
  for (let i = 0; i < gone.length; i += CHUNK) { inTx(() => { for (const f of gone.slice(i, i + CHUNK)) f(); }); await yieldLoop(); }
  return { total, inserted, removed: gone.length };
}

async function guideFromHdhr(t) {
  // HDHomeRuns egen guide (gratis för enhetens ägare, ca 24 h framåt per anrop)
  const chans = all('SELECT id, number FROM channels WHERE tuner_id=?', t.id);
  const byNum = new Map(chans.map(c => [String(c.number), c.id]));
  const seen = new Set();
  const cutoff = now() - KEEP_BACK;
  const del = db.prepare('DELETE FROM programs WHERE channel_id=? AND stop > ?');
  const exists = db.prepare('SELECT 1 FROM programs WHERE channel_id=? AND start=?');
  const logo = db.prepare('UPDATE channels SET logo=COALESCE(logo, ?) WHERE id=?');
  for (let off = 0; off < 3; off++) {
    const start = now() + off * 86400;
    let data;
    try { data = JSON.parse(await fetchText(`https://api.hdhomerun.com/api/guide.php?DeviceAuth=${encodeURIComponent(t.device_auth)}&Start=${start}`)); } catch { break; }
    inTx(() => {
      for (const ch of data || []) {
        const chId = byNum.get(String(ch.GuideNumber)); if (!chId) continue;
        if (ch.ImageURL) logo.run(ch.ImageURL, chId);
        if (!seen.has(chId)) { del.run(chId, cutoff); seen.add(chId); }
        for (const g of ch.Guide || []) {
          if (!(g.EndTime > cutoff) || exists.get(chId, g.StartTime)) continue;
          const se = /S(\d+)E(\d+)/i.exec(g.EpisodeNumber || '');
          insRow(chId, { start: g.StartTime, stop: g.EndTime, title: g.Title || 'Program', subtitle: g.EpisodeTitle, description: g.Synopsis, category: (g.Filter || [])[0],
            season: se ? +se[1] : null, episode: se ? +se[2] : null, icon: g.ImageURL, isNew: !!g.First });
        }
      }
    });
    await yieldLoop();
  }
}

let guideRun = null; // { tunerId, promise } – bara en uppdatering åt gången
export function refreshGuide(tunerId = null) {
  if (guideRun) {
    if (guideRun.tunerId == null || guideRun.tunerId === tunerId) return guideRun.promise;
    return guideRun.promise.catch(() => {}).then(() => refreshGuide(tunerId));
  }
  const promise = (async () => {
    const tuners = tunerId ? all('SELECT * FROM tuners WHERE id=? AND enabled=1', tunerId) : all('SELECT * FROM tuners WHERE enabled=1');
    guideState.running = true;
    const errors = [];
    try {
      for (const t of tuners) {
        // En källa som inte svarar ska inte stoppa de andra
        try {
          if (t.epg_url) await guideFromXmltv(t);
          else if (t.kind === 'hdhr' && t.device_auth) await guideFromHdhr(t);
        } catch (e) { errors.push(`${t.name}: ${e.message}`); console.warn('[livetv] guide', t.name, e.message); }
      }
      run('DELETE FROM programs WHERE stop < ?', now() - 86400);
      guideState.last = now(); guideState.error = errors.length ? errors.join('; ') : null;
      if (errors.length && errors.length === tuners.length) throw new Error(guideState.error);
    } finally { guideState.running = false; }
  })().finally(() => { guideRun = null; });
  guideRun = { tunerId, promise };
  return promise;
}

// ---------- API-hjälp ----------
export function channelList(includeHidden = false) {
  const t = now();
  return all(`SELECT c.*, t.name AS tuner_name FROM channels c JOIN tuners t ON t.id=c.tuner_id WHERE t.enabled=1 ${includeHidden ? '' : 'AND c.hidden=0'}
    ORDER BY c.favorite DESC, c.sort, c.name`).map(c => {
    const progs = all('SELECT id, start, stop, title, subtitle, category FROM programs WHERE channel_id=? AND stop > ? ORDER BY start LIMIT 2', c.id, t);
    return { id: c.id, number: c.number, name: c.name, logo: c.logo, group: c.group_name, hd: !!c.hd, hidden: !!c.hidden, favorite: !!c.favorite, tuner: c.tuner_name,
      epgId: c.epg_id, now: progs[0] && progs[0].start <= t ? progs[0] : null, next: progs[0] && progs[0].start > t ? progs[0] : progs[1] || null };
  });
}
export function guide(from, to) {
  const chans = all(`SELECT c.id, c.number, c.name, c.logo FROM channels c JOIN tuners t ON t.id=c.tuner_id WHERE t.enabled=1 AND c.hidden=0 ORDER BY c.favorite DESC, c.sort, c.name`);
  const progs = all('SELECT id, channel_id, start, stop, title, subtitle, category, season, episode, is_new FROM programs WHERE stop > ? AND start < ? ORDER BY start', from, to);
  const by = new Map(chans.map(c => [c.id, []]));
  for (const p of progs) by.get(p.channel_id)?.push({ id: p.id, start: p.start, stop: p.stop, title: p.title, subtitle: p.subtitle, category: p.category, season: p.season, episode: p.episode, isNew: !!p.is_new });
  return chans.map(c => ({ ...c, programs: by.get(c.id) }));
}
export const program = (id) => get('SELECT p.*, c.name AS channel_name, c.number AS channel_number FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.id=?', id);
export const searchPrograms = (q) => all(`SELECT p.id, p.channel_id, p.start, p.stop, p.title, p.subtitle, p.season, p.episode, c.name AS channel FROM programs p JOIN channels c ON c.id=p.channel_id
  WHERE p.title LIKE ? AND p.stop > ? ORDER BY p.start LIMIT 100`, '%' + q.replace(/[%_]/g, '') + '%', now());

// ---------- tuner-hantering ----------
/** Antal använda tuners per källa (live + inspelningar) */
const inUse = new Map(); // tunerId → Set(nyckel)
export function acquireTuner(tunerId, key) {
  const t = get('SELECT tuner_count FROM tuners WHERE id=?', tunerId);
  const set = inUse.get(tunerId) || new Set();
  if (set.has(key)) return true;
  if (set.size >= (t?.tuner_count || 2)) return false;
  set.add(key); inUse.set(tunerId, set); return true;
}
export function releaseTuner(tunerId, key) { inUse.get(tunerId)?.delete(key); }
export const tunersInUse = () => Object.fromEntries([...inUse].map(([k, v]) => [k, v.size]));

// ---------- live-HLS ----------
const LIVE = path.join(TRANSCODE, 'live');
const starting = new Map(); // channelId → Promise (pågående start)
const sessions = new Map(); // channelId → { proc, dir, last, tunerId, key, started, error, minSeg }
export const httpOpts = (u) => /^https?:/i.test(u) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [];
export const SAFE_LIVE = ['-protocol_whitelist', 'http,https,tcp,tls,udp,rtp,crypto,hls,httpproxy'];

function startLive(ch) {
  // Unik nyckel och mapp per session: en gammal session som stängs (asynkront) får aldrig röra en ny för samma kanal
  const started = Date.now();
  const key = `live-${ch.id}-${started}`;
  if (!acquireTuner(ch.tuner_id, key)) throw Object.assign(new Error('Alla tuners används just nu (live-TV eller inspelningar)'), { status: 409 });
  const s = { proc: null, dir: path.join(LIVE, `${ch.id}-${started}`), last: started, tunerId: ch.tuner_id, key, started, error: null, minSeg: 0 };
  try {
    fs.rmSync(s.dir, { recursive: true, force: true }); fs.mkdirSync(s.dir, { recursive: true });
    const transcode = getSetting('live_transcode', 'auto'); // auto | always
    const enc = liveEncoder({ deinterlace: true, maxHeight: +getSetting('live_max_height', '1080') || null });
    // auto: försök kopiera H.264, annars koda om (MPEG-2 från antenn kräver omkodning för webbläsare)
    const copyV = transcode !== 'always' && /h264|avc/i.test(ch.codec || '');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_LIVE, '-fflags', '+genpts+discardcorrupt', ...httpOpts(ch.stream_url),
      ...(copyV ? [] : enc.pre), '-i', ch.stream_url, '-map', '0:v:0?', '-map', '0:a:0?',
      ...(copyV ? ['-c:v', 'copy'] : [...enc.vf, ...enc.enc, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0']),
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'hls', '-hls_time', '4',
      // Timeshift: ffmpeg håller hela fönstret bakåt i spellistan och tar själv bort äldre segment (disktaket i timeshift.js)
      '-hls_list_size', String(listSize()), '-hls_delete_threshold', '3', '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
      '-hls_segment_filename', path.join(s.dir, 'seg-%05d.ts'), path.join(s.dir, 'live.m3u8')];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', ended = false;
    proc.stderr.on('data', d => { err = (err + d).slice(-800); });
    const end = (code, msg) => {
      if (ended) return; ended = true;
      releaseTuner(ch.tuner_id, key); // nyckeln är unik för sessionen
      if (sessions.get(ch.id) === s) { s.error = msg || (code ? (err.trim().split('\n').pop() || 'Strömmen avbröts') : null); s.proc = null; }
    };
    proc.on('error', (e) => end(1, 'ffmpeg kunde inte startas: ' + e.message));
    proc.on('close', (code) => end(code));
    s.proc = proc;
  } catch (e) { releaseTuner(ch.tuner_id, key); fs.rm(s.dir, { recursive: true, force: true }, () => {}); throw e; }
  sessions.set(ch.id, s);
  return s;
}
function stopLive(chId) {
  const s = sessions.get(chId); if (!s) return;
  sessions.delete(chId);
  try { s.proc?.kill('SIGKILL'); } catch {}
  releaseTuner(s.tunerId, s.key);
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}
/** Idle-städning: strömmar som ingen hämtat något från på maxIdleMs stängs och tunern släpps (även med timeshift) */
export function sweepIdle(maxIdleMs = 45000) {
  for (const [id, s] of [...sessions]) if (Date.now() - s.last > maxIdleMs) stopLive(id);
}
/** Disktak för timeshift-segmenten (se timeshift.js) */
export const enforceTimeshiftCap = (opts) => enforceCap([...sessions.values()], opts);
setInterval(() => {
  sweepIdle();
  try { enforceTimeshiftCap(); } catch (e) { console.warn('[livetv] timeshift:', e.message); }
}, 10000).unref();
// Rester från tidigare körningar
try { fs.rmSync(LIVE, { recursive: true, force: true }); } catch {}

/** Stäng alla live-strömmar (vid avstängning av servern) */
export function shutdown() {
  for (const [id, s] of [...sessions]) { stopLive(id); try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {} }
}

/** Probar kanalens codec (för att kunna kopiera H.264 utan omkodning). Misslyckade prober cachas inte. */
const codecCache = new Map();
async function probeCodec(ch) {
  if (codecCache.has(ch.id)) return codecCache.get(ch.id);
  const c = await new Promise((resolve) => {
    let p;
    try { p = spawn('ffprobe', ['-v', 'error', ...SAFE_LIVE, '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', '-analyzeduration', '3000000', '-probesize', '3000000', ch.stream_url], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    let out = ''; p.stdout.on('data', d => out += d);
    const t = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => { clearTimeout(t); resolve(out.trim() || null); });
  });
  if (c) { codecCache.set(ch.id, c); if (codecCache.size > 5000) codecCache.delete(codecCache.keys().next().value); }
  return c;
}

export async function servePlaylist(res, chId, token = null) {
  const ch = get('SELECT * FROM channels WHERE id=?', chId);
  if (!ch) return fail(res, 404, 'Kanalen finns inte');
  let s = sessions.get(ch.id);
  if (s && !s.proc) { stopLive(ch.id); s = null; }
  if (!s) {
    // Flera samtidiga förfrågningar väntar på samma start (annars startas ffmpeg två gånger)
    if (!starting.has(ch.id)) starting.set(ch.id, (async () => {
      // HDHomeRun: probe tar en tuner en kort stund – kopiera bara för IPTV, koda om antenn-TV (oftast MPEG-2/flätad)
      const t = get('SELECT kind FROM tuners WHERE id=?', ch.tuner_id);
      ch.codec = t?.kind === 'm3u' ? await probeCodec(ch) : null;
      return startLive(ch);
    })().finally(() => starting.delete(ch.id)));
    try { s = await starting.get(ch.id); } catch (e) { return fail(res, e.status || 500, e.message); }
  }
  s.last = Date.now();
  const f = path.join(s.dir, 'live.m3u8');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) { if (s.error || !s.proc) break; await new Promise(r => setTimeout(r, 200)); }
  if (!fs.existsSync(f)) { const e = s.error; stopLive(ch.id); return fail(res, 502, 'Kanalen kunde inte startas' + (e ? ': ' + e : '')); }
  // Appar och Chromecast skickar inte cookies – token följer med till segmenten
  const m = rewritePlaylist(fs.readFileSync(f, 'utf8'), { minSeg: s.minSeg, token });
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
}
export function serveSegment(req, res, chId, name) {
  const s = sessions.get(+chId);
  if (!s || !SEG_RE.test(name) || segNum(name) < s.minSeg) return fail(res, 404, 'Finns inte');
  s.last = Date.now();
  const f = path.join(s.dir, name);
  fs.stat(f, (err, st) => {
    if (err) return fail(res, 404, 'Finns inte');
    // streamFile använder pipeline: ett segment som hinner raderas (delete_segments/disktaket) eller en avbruten
    // hämtning får inte krascha servern eller lämna filen öppen
    streamFile(req, res, f, st.size, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' }, { ranges: false });
  });
}
export const activeLive = () => [...sessions.entries()].map(([id, s]) => ({ channelId: id, since: s.started, error: s.error }));
export const stopChannel = stopLive;

// Uppdatera guiden var 12:e timme och kanallistor en gång per dygn (en källa i taget, guiden en gång efteråt)
setInterval(() => { refreshGuide().catch(() => {}); }, 12 * 3600e3).unref();
let dailyRunning = false;
async function dailyRefresh() {
  if (dailyRunning) return;
  dailyRunning = true;
  try {
    const due = all('SELECT id FROM tuners WHERE enabled=1 AND (last_refresh IS NULL OR last_refresh < ?)', now() - 86400);
    if (!due.length) return;
    for (const t of due) await refreshTuner(t.id, { guide: false }).catch(e => console.warn('[livetv] kanallista:', e.message));
    await refreshGuide().catch(() => {});
  } finally { dailyRunning = false; }
}
setInterval(() => { dailyRefresh().catch(() => {}); }, 3600e3).unref();
