// TV-guide för IPTV-källor från flera XMLTV-guider (vanlig eller gzip-komprimerad, lokal fil under /config eller http).
// Anropas av livetv.js refreshGuide för alla M3U/Xtream-källor (HDHomeRun har kvar sin egen väg).
//
// Guiderna för en kanal, i prioritetsordning: källans egen guide (tuners.epg_url), källans fler guider (epg_urls),
// Xtream-serverns xmltv.php, listans url-tvg och sist de gemensamma guiderna (iptv_guides). En kanal tar sina program
// från den första guiden som har program för den ("gör anspråk") – två guider ger aldrig dubbla program.
// Kopplingen: kanalens tvg-id om guiden har det id:t, annars namnet (eller numret) mot guidens display-name.
//
// Som tidigare (livetv.js): tolkas strömmande, skrivs i omgångar, oförändrade program behåller sitt id (inspelningar och
// påminnelser pekar på dem), gamla tas bort först när guiden lästs klart – och misslyckas en guide finns kanalens
// gamla program kvar. Catch-up-kanaler sparar program bakåt så långt som arkivet räcker (channel_ext.catchup_days).
import crypto from 'node:crypto';
import { db, get, all, run, now } from '../db.js';
import { searchKey, compactKey } from '../searchkey.js';
import { textStream, policyOf, isLocal, maskUrl } from './net.js';
import { sourceRow, ctxOf } from './sources.js';
import * as xt from './xtream.js';
import { DEFAULT_DAYS } from './catchup.js';

const KEEP_BACK = 3 * 3600, HORIZON = 14 * 86400, CHUNK = 5000, MAX_BACK = 30 * 86400;
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(hd|sd|fhd|uhd|4k|se|sverige)\b/g, '').replace(/[^a-z0-9]/g, '');
const yieldLoop = () => new Promise(setImmediate);
function inTx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
const progSig = (p) => crypto.createHash('sha1').update(JSON.stringify([p.stop, String(p.title).slice(0, 300), p.subtitle?.slice(0, 300) || null, p.description?.slice(0, 3000) || null,
  p.category?.slice(0, 80) || null, p.season ?? null, p.episode ?? null, p.icon || null, p.isNew ? 1 : 0])).digest('base64');

/** Jobben (en per guideadress) för källorna, i prioritetsordning. tuners: rader ur tuners (kind 'm3u'). */
export function jobsFor(tuners, { globals = true } = {}) {
  const jobs = new Map(); // url → { url, label, rank, pol, headers, shift, guideId, chans: Map(id → kanal) }
  const chanRows = (tid) => all(`SELECT c.id, c.name, c.number, c.logo, c.epg_id, e.shift, e.catchup, e.catchup_days, e.orig_name
    FROM channels c LEFT JOIN channel_ext e ON e.channel_id=c.id WHERE c.tuner_id=?`, tid);
  const add = (url, label, rank, ctx, chans, extra = {}) => {
    if (!url) return;
    let j = jobs.get(url);
    if (!j) { j = { url, label, rank, pol: ctx.pol, headers: ctx.headers, shift: 0, chans: new Map(), ...extra }; jobs.set(url, j); }
    j.rank = Math.min(j.rank, rank);
    for (const c of chans) j.chans.set(c.id, c);
  };
  const all_ = [];
  for (const t of tuners) {
    const r = sourceRow(t.id); if (!r) continue;
    const ctx = ctxOf(r), chans = chanRows(t.id);
    all_.push(...chans.map(c => ({ c, ctx })));
    const list = [t.epg_url, ...json(r.s.epg_urls, [])];
    if (r.s.type === 'xtream') list.push(xt.xmltvUrl(ctx));
    // url-tvg i listan är leverantörens innehåll: dess värd är inte betrodd (policyn gäller som för strömmarna)
    const fromList = json(r.s.m3u_epg, []);
    list.forEach((u, i) => add(u, i === 0 && u === t.epg_url ? t.name : `${t.name} (guide ${i + 1})`, i, ctx, chans));
    fromList.forEach((u, i) => add(u, `${t.name} (listans guide${fromList.length > 1 ? ' ' + (i + 1) : ''})`, list.length + i, ctx, chans));
  }
  if (globals && all_.length) {
    for (const g of all('SELECT * FROM iptv_guides WHERE enabled=1 ORDER BY COALESCE(sort, id), id')) {
      add(g.url, g.name, 1000 + (g.sort ?? g.id), { pol: policyOf([g.url], true), headers: {} }, all_.map(x => x.c), { guideId: g.id, shift: g.shift || 0 });
    }
  }
  return [...jobs.values()].sort((a, b) => a.rank - b.rank);
}

/** Kör guiderna. Returnerar { errors: ['namn: fel'], jobs: n }. */
export async function importGuides(tuners, opts = {}) {
  const live = await import('../livetv.js');
  const jobs = jobsFor(tuners, opts);
  const errors = [];
  if (!jobs.length) return { errors, jobs: 0 };
  const T = now();
  const claimed = new Map(); // kanal-id → jobb
  const failed = new Set();  // kanaler vars guide misslyckades (gamla program behålls)
  const mapped = new Set();  // kanaler som någon guide som lyckades kände till
  const boundary = get('SELECT COALESCE(MAX(id), 0) AS m FROM programs').m;
  const ins = db.prepare('INSERT INTO programs(channel_id,start,stop,title,subtitle,description,category,season,episode,icon,is_new,skey,skeyc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insRow = (chId, p) => { const k = searchKey(String(p.title).slice(0, 300));
    ins.run(chId, p.start, p.stop, String(p.title).slice(0, 300), p.subtitle?.slice(0, 300) || null, p.description?.slice(0, 3000) || null, p.category?.slice(0, 80) || null,
      p.season ?? null, p.episode ?? null, p.icon || null, p.isNew ? 1 : 0, k, compactKey(k)); };
  const cutoffOf = (c) => c.catchup ? T - Math.min(MAX_BACK, (c.catchup_days || DEFAULT_DAYS) * 86400) : T - KEEP_BACK;
  const oldStmt = db.prepare('SELECT id, start, stop, title, subtitle, description, category, season, episode, icon, is_new FROM programs WHERE channel_id=? AND stop > ? AND id <= ?');
  const old = new Map();
  const chanById = new Map();
  for (const j of jobs) for (const c of j.chans.values()) chanById.set(c.id, c);
  const oldOf = (c) => {
    let m = old.get(c.id);
    if (!m) {
      m = new Map();
      for (const r of oldStmt.all(c.id, cutoffOf(c), boundary)) {
        const e = { id: r.id, sig: progSig({ ...r, isNew: r.is_new }), kept: false };
        const l = m.get(r.start); l ? l.push(e) : m.set(r.start, [e]);
      }
      old.set(c.id, m);
    }
    return m;
  };
  for (const job of jobs) {
    const declared = new Map(), byName = new Map();
    let map = null;
    const mine = new Set(); // kanaler som jobbet gjort anspråk på
    const mapChannels = () => {
      map = new Map();
      const setEpg = db.prepare('UPDATE channels SET epg_id=? WHERE id=? AND epg_id IS NULL'), setLogo = db.prepare('UPDATE channels SET logo=? WHERE id=? AND logo IS NULL');
      inTx(() => {
        for (const c of job.chans.values()) {
          let key = c.epg_id && declared.has(c.epg_id) ? c.epg_id : null;
          if (!key) key = byName.get(norm(c.orig_name || c.name)) || byName.get(norm(c.name)) || (c.number && byName.get(norm(c.number))) || null;
          if (key && !c.epg_id) { setEpg.run(key, c.id); c.epg_id = key; }
          key ||= c.epg_id;
          if (!key) continue;
          const icon = declared.get(key)?.icon;
          if (icon && !c.logo && /^https?:\/\//.test(icon)) { setLogo.run(icon, c.id); c.logo = icon; }
          (map.get(key) || map.set(key, []).get(key)).push(c);
        }
      });
    };
    let batch = [], total = 0, inserted = 0;
    const flush = () => { if (!batch.length) return; const b = batch; batch = []; inTx(() => { for (const [id, p] of b) insRow(id, p); }); inserted += b.length; };
    const parser = new live.XmltvParser({
      onChannel: (c) => { if (map || declared.size > 100000) return; declared.set(c.id, c); for (const n of c.names.slice(0, 5)) { const k = norm(n); if (k && !byName.has(k)) byName.set(k, c.id); } },
      onProgram: (p) => {
        if (!map) mapChannels();
        const list = map.get(p.channel); if (!list) return;
        for (const c of list) {
          const owner = claimed.get(c.id);
          if (owner && owner !== job) continue;
          const sh = ((c.shift || 0) + (job.shift || 0)) * 3600;
          const q = sh ? { ...p, start: p.start + sh, stop: p.stop + sh } : p;
          if (!(q.stop > cutoffOf(c) && q.start < T + HORIZON && q.stop > q.start)) continue;
          if (!owner) { claimed.set(c.id, job); mine.add(c.id); }
          total++;
          const same = oldOf(c).get(q.start);
          if (same) { const sig = progSig(q); const hit = same.find(e => !e.kept && e.sig === sig); if (hit) { hit.kept = true; continue; } }
          batch.push([c.id, q]);
        }
      }
    });
    try {
      for await (const text of textStream(job.url, { pol: job.pol, headers: job.headers })) {
        parser.feed(text);
        if (batch.length >= CHUNK) { flush(); await yieldLoop(); }
      }
      if (!map) mapChannels();
      flush();
      for (const list of map.values()) for (const c of list) mapped.add(c.id);
      if (job.guideId) run('UPDATE iptv_guides SET last_refresh=?, error=NULL, channels=?, programs=? WHERE id=?', now(), mine.size, total, job.guideId);
    } catch (e) {
      // Det som hann läggas in tas bort – kanalens gamla guide gäller
      const st = db.prepare('DELETE FROM programs WHERE channel_id=? AND id > ?');
      const ids = [...mine];
      for (let i = 0; i < ids.length; i += 200) inTx(() => { for (const id of ids.slice(i, i + 200)) st.run(id, boundary); });
      for (const id of ids) failed.add(id);
      // Kanaler som guiden skulle ha täckt men inte hann göra anspråk på: deras gamla program tas inte heller bort
      for (const c of job.chans.values()) if (!claimed.has(c.id)) failed.add(c.id);
      const msg = String(e.message || e).replace(/\s+/g, ' ').slice(0, 200);
      errors.push(`${job.label}: ${msg}`);
      if (job.guideId) run('UPDATE iptv_guides SET last_refresh=?, error=? WHERE id=?', now(), msg, job.guideId);
      console.warn('[iptv] guide', job.label, isLocal(job.url) ? job.url : maskUrl(job.url), msg);
    }
    await yieldLoop();
  }
  // Ersatta program tas bort: för kanaler med ny guide det som inte fanns kvar, för kanaler som en lyckad guide
  // kände till men som inte fick några program allt framåt (samma villkor som vid inläggningen: stop > gränsen)
  const delId = db.prepare('DELETE FROM programs WHERE id=?');
  const delCh = db.prepare('DELETE FROM programs WHERE channel_id=? AND id <= ? AND stop > ?');
  const gone = [];
  for (const [id] of claimed) {
    if (failed.has(id)) continue;
    const m = old.get(id); if (!m) continue;
    for (const l of m.values()) for (const e of l) if (!e.kept) gone.push(() => delId.run(e.id));
  }
  for (const id of mapped) if (!claimed.has(id) && !failed.has(id)) { const c = chanById.get(id); gone.push(() => delCh.run(id, boundary, cutoffOf(c))); }
  for (let i = 0; i < gone.length; i += CHUNK) { inTx(() => { for (const f of gone.slice(i, i + CHUNK)) f(); }); await yieldLoop(); }
  return { errors, jobs: jobs.length, channels: claimed.size, removed: gone.length };
}

/** Gamla program tas bort: ett dygn bakåt, men catch-up-kanaler behåller så långt som arkivet räcker */
export function pruneOld(t = now()) {
  run(`DELETE FROM programs WHERE stop < ? AND channel_id NOT IN (SELECT channel_id FROM channel_ext WHERE catchup IS NOT NULL)`, t - 86400);
  run(`DELETE FROM programs WHERE stop < ? - 86400 * COALESCE((SELECT MIN(30, COALESCE(e.catchup_days, ${DEFAULT_DAYS})) FROM channel_ext e WHERE e.channel_id=programs.channel_id AND e.catchup IS NOT NULL), 1)`, t);
}
