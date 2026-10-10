// Live-TV: HDHomeRun (antenn/kabel) och IPTV (M3U), TV-guide (XMLTV eller HDHomeRuns guide) och
// live-strömning som HLS. Flera tittare på samma kanal delar en ström; strömmen stängs när ingen tittar.
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { db, get, all, run, now, getSetting, CONFIG } from './db.js';
import { TRANSCODE, liveEncoder } from './stream.js';
import { send, fail } from './util.js';

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
async function fetchText(url, { timeout = 60000, max = 200 << 20 } = {}) {
  if (/^file:/.test(url) || url.startsWith('/')) {
    const p = url.replace(/^file:\/\//, '');
    if (!path.resolve(p).startsWith(path.resolve(CONFIG))) throw new Error('Lokala filer måste ligga i /config');
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
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dec = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m).trim();
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
export function parseXMLTV(xml) {
  const channels = [];
  for (const m of xml.matchAll(/<channel\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    channels.push({ id: dec(m[1]), names: [...m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map(x => dec(x[1])), icon: /<icon\s+src="([^"]+)"/.exec(m[2])?.[1] || null });
  }
  const programs = [];
  for (const m of xml.matchAll(/<programme\s([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const a = m[1], b = m[2];
    const start = xmltvTime(/start="([^"]+)"/.exec(a)?.[1]), stop = xmltvTime(/stop="([^"]+)"/.exec(a)?.[1]);
    const ch = dec(/channel="([^"]+)"/.exec(a)?.[1]);
    if (!start || !ch) continue;
    const ns = /<episode-num[^>]*system="xmltv_ns"[^>]*>([^<]*)</.exec(b)?.[1];
    let season = null, episode = null;
    if (ns) { const [s, e] = ns.split('.'); season = s?.trim() ? parseInt(s) + 1 : null; episode = e?.trim() ? parseInt(e) + 1 : null; }
    const onscreen = /<episode-num[^>]*system="onscreen"[^>]*>\s*S(\d+)\s*E(\d+)/i.exec(b);
    if (onscreen) { season = +onscreen[1]; episode = +onscreen[2]; }
    programs.push({ channel: ch, start, stop: stop || start + 1800, title: dec(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1]) || 'Program',
      subtitle: dec(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/.exec(b)?.[1]) || null, description: dec(/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(b)?.[1]) || null,
      category: dec(/<category[^>]*>([\s\S]*?)<\/category>/.exec(b)?.[1]) || null, season, episode,
      icon: /<icon\s+src="([^"]+)"/.exec(b)?.[1] || null, isNew: /<new\s*\/>/.test(b) || /<premiere/.test(b) });
  }
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

export async function refreshTuner(id) {
  const t = get('SELECT * FROM tuners WHERE id=?', id); if (!t) return;
  try {
    let list;
    if (t.kind === 'hdhr') {
      const info = await hdhrInfo(t.url);
      run('UPDATE tuners SET tuner_count=?, device_auth=? WHERE id=?', info.tuners, info.auth, id);
      list = info.channels.map(c => ({ ...c, epg: null, logo: null, group: c.hd ? 'HD' : null }));
    } else list = parseM3U(await fetchText(t.url));
    if (!list.length) throw new Error('Inga kanaler hittades');
    const keep = new Set();
    list.slice(0, 5000).forEach((c, i) => {
      run(`INSERT INTO channels(tuner_id,number,name,logo,stream_url,epg_id,group_name,hd,sort) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tuner_id,stream_url) DO UPDATE SET number=excluded.number, name=excluded.name, logo=COALESCE(excluded.logo,logo),
        epg_id=COALESCE(epg_id, excluded.epg_id), group_name=excluded.group_name, hd=excluded.hd, sort=excluded.sort`,
        id, c.number || null, String(c.name).slice(0, 120), c.logo || null, c.url, c.epg || null, c.group || null, c.hd || 0, parseFloat(c.number) || i + 1);
      keep.add(c.url);
    });
    for (const c of all('SELECT id, stream_url FROM channels WHERE tuner_id=?', id)) if (!keep.has(c.stream_url)) run('DELETE FROM channels WHERE id=?', c.id);
    run('UPDATE tuners SET last_refresh=?, error=NULL WHERE id=?', now(), id);
    await refreshGuide(id).catch(e => console.warn('[livetv] guide:', e.message));
    return { channels: list.length };
  } catch (e) { run('UPDATE tuners SET error=? WHERE id=?', e.message, id); throw e; }
}

// ---------- TV-guide ----------
export const guideState = { running: false, last: null, error: null };
export async function refreshGuide(tunerId = null) {
  const tuners = tunerId ? all('SELECT * FROM tuners WHERE id=? AND enabled=1', tunerId) : all('SELECT * FROM tuners WHERE enabled=1');
  guideState.running = true;
  try {
    for (const t of tuners) {
      const chans = all('SELECT * FROM channels WHERE tuner_id=?', t.id);
      const ins = (chId, p) => run('INSERT INTO programs(channel_id,start,stop,title,subtitle,description,category,season,episode,icon,is_new) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        chId, p.start, p.stop, String(p.title).slice(0, 300), p.subtitle?.slice(0, 300) || null, p.description?.slice(0, 3000) || null, p.category?.slice(0, 80) || null,
        p.season ?? null, p.episode ?? null, p.icon || null, p.isNew ? 1 : 0);
      if (t.epg_url) {
        const { channels, programs } = parseXMLTV(await fetchText(t.epg_url));
        // Koppla kanaler: tvg-id, annars namn/nummer
        const byName = new Map();
        for (const c of channels) for (const n of c.names) byName.set(norm(n), c.id);
        for (const ch of chans) {
          if (ch.epg_id && channels.some(c => c.id === ch.epg_id)) continue;
          const id = byName.get(norm(ch.name)) || (ch.number && byName.get(norm(ch.number))) || null;
          if (id) { run('UPDATE channels SET epg_id=? WHERE id=?', id, ch.id); ch.epg_id = id; }
          const icon = channels.find(c => c.id === (ch.epg_id || id))?.icon;
          if (icon && !ch.logo) run('UPDATE channels SET logo=? WHERE id=?', icon, ch.id);
        }
        const map = new Map(all('SELECT id, epg_id FROM channels WHERE tuner_id=? AND epg_id IS NOT NULL', t.id).map(r => [r.epg_id, r.id]));
        const horizon = now() + 14 * 86400;
        db.exec('BEGIN');
        try {
          for (const chId of map.values()) run('DELETE FROM programs WHERE channel_id=? AND start >= ?', chId, now() - 3 * 3600);
          for (const p of programs) { const chId = map.get(p.channel); if (chId && p.stop > now() - 3 * 3600 && p.start < horizon) ins(chId, p); }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      } else if (t.kind === 'hdhr' && t.device_auth) {
        // HDHomeRuns egen guide (gratis för enhetens ägare, ca 24 h framåt per anrop)
        const byNum = new Map(chans.map(c => [String(c.number), c.id]));
        const seen = new Set();
        for (let off = 0; off < 3; off++) {
          const start = now() + off * 86400;
          let data;
          try { data = JSON.parse(await fetchText(`https://api.hdhomerun.com/api/guide.php?DeviceAuth=${encodeURIComponent(t.device_auth)}&Start=${start}`)); } catch { break; }
          db.exec('BEGIN');
          try {
            for (const ch of data || []) {
              const chId = byNum.get(String(ch.GuideNumber)); if (!chId) continue;
              if (ch.ImageURL) run('UPDATE channels SET logo=COALESCE(logo, ?) WHERE id=?', ch.ImageURL, chId);
              if (!seen.has(chId)) { run('DELETE FROM programs WHERE channel_id=? AND start >= ?', chId, now() - 3 * 3600); seen.add(chId); }
              for (const g of ch.Guide || []) {
                const se = /S(\d+)E(\d+)/i.exec(g.EpisodeNumber || '');
                if (get('SELECT 1 FROM programs WHERE channel_id=? AND start=?', chId, g.StartTime)) continue;
                ins(chId, { start: g.StartTime, stop: g.EndTime, title: g.Title, subtitle: g.EpisodeTitle, description: g.Synopsis, category: (g.Filter || [])[0],
                  season: se ? +se[1] : null, episode: se ? +se[2] : null, icon: g.ImageURL, isNew: !!g.First });
              }
            }
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
        }
      }
    }
    run('DELETE FROM programs WHERE stop < ?', now() - 86400);
    guideState.last = now(); guideState.error = null;
  } catch (e) { guideState.error = e.message; throw e; }
  finally { guideState.running = false; }
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
const sessions = new Map(); // channelId → { proc, dir, last, viewers:Set, tunerId, started, error }
export const httpOpts = (u) => /^https?:/i.test(u) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [];
export const SAFE_LIVE = ['-protocol_whitelist', 'http,https,tcp,tls,udp,rtp,crypto,hls,httpproxy'];

function startLive(ch) {
  const key = `live-${ch.id}`;
  if (!acquireTuner(ch.tuner_id, key)) throw Object.assign(new Error('Alla tuners används just nu (live-TV eller inspelningar)'), { status: 409 });
  const dir = path.join(LIVE, String(ch.id));
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const transcode = getSetting('live_transcode', 'auto'); // auto | always
  const enc = liveEncoder({ deinterlace: true, maxHeight: +getSetting('live_max_height', '1080') || null });
  // auto: försök kopiera H.264, annars koda om (MPEG-2 från antenn kräver omkodning för webbläsare)
  const copyV = transcode !== 'always' && /h264|avc/i.test(ch.codec || '');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_LIVE, '-fflags', '+genpts+discardcorrupt', ...httpOpts(ch.stream_url),
    ...(copyV ? [] : enc.pre), '-i', ch.stream_url, '-map', '0:v:0', '-map', '0:a:0?',
    ...(copyV ? ['-c:v', 'copy'] : [...enc.vf, ...enc.enc, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0']),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '8', '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg-%05d.ts'), path.join(dir, 'live.m3u8')];
  const s = { proc: null, dir, last: Date.now(), tunerId: ch.tuner_id, key, started: Date.now(), error: null };
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err = (err + d).slice(-800); });
  proc.on('close', (code) => {
    releaseTuner(ch.tuner_id, key);
    if (sessions.get(ch.id) === s) { s.error = code ? (err.trim().split('\n').pop() || 'Strömmen avbröts') : null; s.proc = null; }
  });
  s.proc = proc;
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
setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.last > 45000) stopLive(id); }, 10000).unref();

/** Probar kanalens codec en gång (för att kunna kopiera H.264 utan omkodning) */
const codecCache = new Map();
async function probeCodec(ch) {
  if (codecCache.has(ch.id)) return codecCache.get(ch.id);
  const c = await new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', ...SAFE_LIVE, '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', '-analyzeduration', '3000000', '-probesize', '3000000', ch.stream_url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', d => out += d);
    const t = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.on('close', () => { clearTimeout(t); resolve(out.trim() || null); });
  });
  codecCache.set(ch.id, c);
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
  let m = fs.readFileSync(f, 'utf8');
  // Appar och Chromecast skickar inte cookies – token följer med till segmenten
  if (token) m = m.replace(/^(seg-\d{5}\.ts)$/gm, `$1?t=${encodeURIComponent(token)}`);
  send(res, 200, m, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
}
export function serveSegment(req, res, chId, name) {
  const s = sessions.get(+chId);
  if (!s || !/^seg-\d{5}\.ts$/.test(name)) return fail(res, 404, 'Finns inte');
  s.last = Date.now();
  const f = path.join(s.dir, name);
  fs.stat(f, (err, st) => {
    if (err) return fail(res, 404, 'Finns inte');
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
}
export const activeLive = () => [...sessions.entries()].map(([id, s]) => ({ channelId: id, since: s.started, error: s.error }));
export const stopChannel = stopLive;

// Uppdatera guiden var 12:e timme och kanallistor en gång per dygn
setInterval(() => { refreshGuide().catch(() => {}); }, 12 * 3600e3).unref();
setInterval(() => { for (const t of all('SELECT id FROM tuners WHERE enabled=1 AND (last_refresh IS NULL OR last_refresh < ?)', now() - 86400)) refreshTuner(t.id).catch(() => {}); }, 3600e3).unref();
