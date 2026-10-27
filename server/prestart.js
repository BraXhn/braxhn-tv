// Snabbstart (startcache): på Unraid sover arraydiskarna, och en film tar 5–15 s att starta medan disken
// snurrar upp. För titlar som troligen spelas härnäst (Fortsätt titta, nästa avsnitt i serier som hushållet
// tittar på, nyligen tillagt) kopieras början av filen (PRESTART_SECONDS räknat på filens bithastighet),
// platsen där man slutade titta och filens index (moov i MP4 som ligger sist, slutet av MKV med Cues) till
// snabb lagring (PRESTART_DIR, t.ex. en mapp på cache-poolen).
//
// Vid uppspelning serveras de cachade byte-intervallen direkt (direktuppspelning med Range) eller matas till
// ffmpeg som en sammansatt indata (remux/omkodning från början), medan originalfilen öppnas parallellt. När
// cachen tar slut fortsätter läsningen från originalfilen – byte för byte samma innehåll.
//
// Kopieringen görs bara när disken ändå är vaken: I/O-räknarna i /sys/block (och hdparm -C om det finns) när
// filens disk går att hitta, annars när servern själv nyss läst något i samma mapp (skanning, uppspelning,
// väckning). Den går med begränsad hastighet, en titel åt gången, och cachen håller sig under storleksgränsen.
// Cachens filer har titelns id som namn (<id>.p0, <id>.p1 …, <id>.json) – inget annat i mappen rörs.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { execFile } from 'node:child_process';
import { all, get, getSetting, setSetting } from './db.js';
import { librariesWithRoots, rootOf } from './libpaths.js';

const GB = 1e9, MB = 1 << 20;
const OWN = /^(\d+)\.(json|p\d+|p\d+\.part|json\.part)$/;
const TAIL_MAX = 64 * MB; // MP4 med moov sist: större index än så cachas inte (sällsynt)
const TAIL_GENERIC = 2 * MB; // MKV (Cues), AVI, TS: slutet av filen
const REFILL_QUIET = 120e3; // en post som nyss använts byts inte ut (kan strömmas just nu)

// Filåtkomst mot originalfilerna går via io – testerna byter ut open mot en långsam variant (sovande disk)
export const io = { open: (p, flags = 'r') => fs.promises.open(p, flags), diskOf: (root) => diskOfRoot(root) };
// Kopplas in av app.js: nyckelbildsindexet tas fram när disken ändå är vaken
export const hooks = { keyframes: null };

const over = {}; // tester: { maxBytes, seconds, rate, awakeMs }
export function __setConfig(o) { const { forget, ...rest } = o; Object.assign(over, rest); if (forget) { touched.clear(); woke.clear(); } }

/** Gällande inställningar. Mappen kommer från PRESTART_DIR eller Docker-mallens /prestart – aldrig från webben. */
export function config() {
  // Docker-mallens valfria mapp /prestart används när den är monterad (mappen finns inte i imagen annars)
  const dir = String(over.dir ?? process.env.PRESTART_DIR ?? (hasMount() ? '/prestart' : '')).trim();
  const gb = parseFloat(getSetting('prestart_max_gb', process.env.PRESTART_MAX_GB || '20'));
  return {
    on: getSetting('prestart_on', '1') === '1',
    dir: dir && path.isAbsolute(dir) ? path.resolve(dir) : '',
    maxBytes: over.maxBytes ?? Math.round((Number.isFinite(gb) ? Math.max(0.1, Math.min(10000, gb)) : 20) * GB),
    seconds: over.seconds ?? Math.max(10, Math.min(600, parseInt(process.env.PRESTART_SECONDS) || 90)),
    rate: over.rate ?? Math.max(1, parseFloat(process.env.PRESTART_MBPS) || 40) * MB,
    awakeMs: over.awakeMs ?? Math.max(1, parseFloat(process.env.PRESTART_AWAKE_MIN) || 10) * 60e3
  };
}
let mountSeen = null;
const hasMount = () => (mountSeen ??= (() => { try { return fs.statSync('/prestart').isDirectory(); } catch { return false; } })());
const cacheOn = () => { const c = config(); return c.on && c.dir ? c : null; };

// ---------------- index över cachade titlar ----------------
// id → { id, path, size, mtime, parts: [{ from, to }] (to inklusive), pipe, key, at, used, bytes }
const index = new Map();
let loadedDir = null;
const partFile = (dir, id, i) => path.join(dir, `${id}.p${i}`);
const metaFile = (dir, id) => path.join(dir, `${id}.json`);

function load(c) {
  if (loadedDir === c.dir) return;
  index.clear(); loadedDir = c.dir;
  let files = [];
  try { fs.mkdirSync(c.dir, { recursive: true }); files = fs.readdirSync(c.dir); } catch (e) { console.warn('[snabbstart] mappen går inte att använda:', c.dir, e.message); return; }
  const keep = new Set();
  for (const f of files) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(c.dir, f), 'utf8'));
      const ok = e && +e.id === +m[1] && Array.isArray(e.parts) && e.parts.every((p, i) => {
        try { return fs.statSync(partFile(c.dir, e.id, i)).size === p.to - p.from + 1; } catch { return false; }
      });
      if (!ok) continue;
      e.bytes = e.parts.reduce((s, p) => s + p.to - p.from + 1, 0);
      index.set(e.id, e);
      keep.add(f); e.parts.forEach((_, i) => keep.add(`${e.id}.p${i}`));
    } catch {}
  }
  // Rester av avbrutna kopieringar och poster som inte gick att läsa
  for (const f of files) if (OWN.test(f) && !keep.has(f)) { try { fs.rmSync(path.join(c.dir, f), { force: true }); } catch {} }
}
const usedBytes = () => { let s = 0; for (const e of index.values()) s += e.bytes; return s; };

function drop(e, dir = loadedDir) {
  index.delete(e.id);
  if (!dir) return;
  try { fs.rmSync(metaFile(dir, e.id), { force: true }); } catch {}
  e.parts.forEach((_, i) => { try { fs.rmSync(partFile(dir, e.id, i), { force: true }); } catch {} });
}

/** Posten för titeln om den stämmer med databasens fil (sökväg, storlek, ändringstid) – annars tas den bort */
function usable(it) {
  const e = index.get(it.id);
  if (!e) return null;
  if (e.path !== it.path || e.size !== it.size || e.mtime !== it.mtime) { drop(e); return null; }
  return e;
}

// ---------------- statistik ----------------
let stats = null;
function S() {
  if (!stats) { try { stats = { hits: 0, misses: 0, wakes: 0, served: 0, fills: 0, ...JSON.parse(getSetting('prestart_stats', '{}')) }; } catch { stats = { hits: 0, misses: 0, wakes: 0, served: 0, fills: 0 }; } }
  return stats;
}
let saveT = null;
function saveStats() { if (saveT) return; saveT = setTimeout(() => { saveT = null; try { setSetting('prestart_stats', JSON.stringify(S())); } catch {} }, 5000); saveT.unref?.(); }

// ---------------- vaken disk? ----------------
const diskState = new Map(); // namn i /sys/block → { sig, changed }
/** Läser I/O-räknarna för alla blockenheter; en disk vars räknare ändrats sedan förra provet räknas som vaken */
export function sampleDisks(sys = '/sys/block', nowMs = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(sys); } catch { return diskState; }
  for (const n of names) {
    if (/^(loop|ram|zram|sr|fd)/.test(n)) continue;
    let txt; try { txt = fs.readFileSync(path.join(sys, n, 'stat'), 'utf8'); } catch { continue; }
    const f = txt.trim().split(/\s+/).map(Number);
    if (f.length < 8) continue;
    const sig = `${f[0]},${f[4]}`; // lästa och skrivna förfrågningar
    const prev = diskState.get(n);
    if (!prev) diskState.set(n, { sig, changed: 0 });
    else if (prev.sig !== sig) { prev.sig = sig; prev.changed = nowMs; }
  }
  return diskState;
}

// Bibliotekets mapp → disk (major:minor i /sys/dev/block). Unraids användarresurser (shfs/FUSE) och overlay ger ingen disk.
const rootDisk = new Map();
function diskOfRoot(root) {
  const hit = rootDisk.get(root);
  if (hit && Date.now() - hit.at < 3600e3) return hit.disk;
  let disk = null;
  try {
    const dev = fs.statSync(root, { bigint: true }).dev;
    const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)), minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn));
    const p = fs.realpathSync(`/sys/dev/block/${major}:${minor}`);
    disk = fs.existsSync(path.join(p, 'partition')) ? path.basename(path.dirname(p)) : path.basename(p);
    if (!fs.existsSync(path.join('/sys/block', disk, 'stat'))) disk = null;
  } catch {}
  rootDisk.set(root, { disk, at: Date.now() });
  return disk;
}

// hdparm -C väcker inte disken: "active/idle" = snurrar, "standby" = sover. Bara om verktyget och enheten finns.
const hdparm = new Map();
let hdparmOk = null;
function hdparmActive(disk) {
  if (hdparmOk == null) hdparmOk = String(process.env.PATH || '').split(path.delimiter).some(d => { try { return fs.statSync(path.join(d, 'hdparm')).isFile(); } catch { return false; } });
  if (!hdparmOk || !fs.existsSync('/dev/' + disk)) return false;
  const h = hdparm.get(disk);
  if (!h || Date.now() - h.at > 60e3) {
    const e = { at: Date.now(), active: h?.active || false };
    hdparm.set(disk, e);
    execFile('hdparm', ['-C', '/dev/' + disk], { timeout: 3000 }, (err, out) => { if (!err) e.active = /active|idle/i.test(out) && !/standby|sleeping/i.test(out); });
  }
  return hdparm.get(disk).active;
}

// Mappar som servern själv nyss läst ur (skanning, uppspelning, väckning, kopiering): disken är vaken
const touched = new Map();
const SEASON_DIR = /^(season|säsong|sasong|series|s)\s*\d+$|^specials$/i;
function dirsOf(file) {
  const d = path.dirname(file);
  // Avsnitt: seriens mapp ligger oftast på samma disk (Unraids split level) – säsongsmappen räknas till serien
  return SEASON_DIR.test(path.basename(d)) ? [d, path.dirname(d)] : [d];
}
/** Markerar att titelns disk är vaken just nu */
export function touch(it, nowMs = Date.now()) {
  if (!it?.path) return;
  for (const d of dirsOf(it.path)) touched.set(d, nowMs);
  if (touched.size > 2000) for (const [k, t] of touched) if (nowMs - t > 3600e3) touched.delete(k);
}

/** Nya titlar från skanningen (filerna har just lästs): markera mapparna och kopiera snart */
export function touchIds(ids) {
  if (!ids?.length || !cacheOn()) return;
  for (const id of ids.slice(0, 5000)) touch(get('SELECT path FROM items WHERE id=?', id));
  kick(60e3);
}

function libRoot(it) {
  try { const l = librariesWithRoots('id=?', it.library_id)[0]; return l ? rootOf(l.roots, it.path) : null; } catch { return null; }
}
/** Är disken som titeln ligger på vaken? (för kopieringen – väcker aldrig själv) */
export function awakeFor(it, c = config(), nowMs = Date.now()) {
  const root = libRoot(it);
  const disk = root && io.diskOf(root);
  if (disk) {
    const s = diskState.get(disk);
    if (s?.changed && nowMs - s.changed < 150e3) return true;
    if (hdparmActive(disk)) return true;
  }
  return dirsOf(it.path).some(d => nowMs - (touched.get(d) || 0) < c.awakeMs);
}

// ---------------- vad spelas troligen härnäst? ----------------
const PLAYABLE = `i.kind IN ('movie','episode') AND i.path IS NOT NULL AND i.size > 0`;
/** Kandidater i prioritetsordning: [{ it, score, positions, why }] */
export function candidates(nowS = Math.floor(Date.now() / 1000)) {
  const by = new Map();
  const add = (it, score, why, pos = null) => {
    let c = by.get(it.id);
    if (!c) by.set(it.id, c = { it, score, why, positions: [] });
    else if (score > c.score) { c.score = score; c.why = why; }
    if (pos != null && c.positions.length < 3 && !c.positions.some(p => Math.abs(p - pos) < 30)) c.positions.push(pos);
  };
  // Fortsätt titta: platsen där man slutade (senaste 60 dagarna)
  for (const r of all(`SELECT i.*, p.position AS _pos, p.updated AS _upd FROM progress p JOIN items i ON i.id=p.item_id
      WHERE ${PLAYABLE} AND p.watched=0 AND p.position>5 AND (i.duration IS NULL OR p.position < i.duration*0.95) AND p.updated>?
      ORDER BY p.updated DESC LIMIT 200`, nowS - 60 * 86400)) {
    add(r, 100 - Math.min(30, (nowS - r._upd) / 86400), 'Fortsätt titta', r._pos);
  }
  // Nästa avsnitt i serier som hushållet tittar på (fler sedda avsnitt senaste månaden = högre)
  for (const s of all(`SELECT e.parent_id AS show, MAX(e.season*10000+e.episode) AS last, COUNT(*) AS n, MAX(p.updated) AS upd
      FROM progress p JOIN items e ON e.id=p.item_id WHERE e.kind='episode' AND p.watched=1 AND p.updated>? AND e.parent_id IS NOT NULL
      GROUP BY p.user_id, e.parent_id ORDER BY upd DESC LIMIT 100`, nowS - 30 * 86400)) {
    const next = all(`SELECT i.* FROM items i WHERE i.parent_id=? AND ${PLAYABLE} AND i.version_of IS NULL AND (i.season*10000+i.episode)>?
      ORDER BY i.season, i.episode LIMIT 2`, s.show, s.last);
    const base = 80 + Math.min(15, s.n) - Math.min(20, (nowS - s.upd) / 86400);
    next.forEach((it, k) => add(it, base - k * 25, k ? 'Avsnittet efter nästa' : 'Nästa avsnitt'));
  }
  // Nyligen tillagt (två veckor)
  for (const it of all(`SELECT i.* FROM items i WHERE ${PLAYABLE} AND i.version_of IS NULL AND i.added>? ORDER BY i.added DESC LIMIT 60`, nowS - 14 * 86400)) {
    add(it, 40 - Math.min(14, (nowS - it.added) / 86400), 'Nyligen tillagt');
  }
  return [...by.values()].sort((a, b) => b.score - a.score);
}

const mergeRanges = (rs) => {
  const out = [];
  for (const r of rs.filter(r => r.to >= r.from).sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to); else out.push({ ...r });
  }
  return out;
};
/** Byte-intervall att cacha för en kandidat (slutet läggs till vid kopieringen, när filens upplägg är känt) */
export function windowsFor(cand, c) {
  const it = cand.it, size = it.size;
  const rate = it.duration > 0 ? size / it.duration : 1 * MB; // byte per sekund
  const perTitle = Math.max(4 * MB, Math.min(1.5 * GB, c.maxBytes / 6));
  let secs = c.seconds;
  const plan = (s) => {
    const head = Math.min(size, Math.max(2 * MB, Math.ceil(rate * s)));
    const rs = [{ from: 0, to: head - 1 }];
    // Fortsätt titta: uppskattad byteposition (filens snitt) – 20 s före och s sekunder efter
    for (const p of cand.positions) {
      const off = Math.floor(size * Math.min(1, p / (it.duration || p)));
      rs.push({ from: Math.max(0, off - Math.ceil(rate * 20)), to: Math.min(size - 1, off + Math.ceil(rate * s)) });
    }
    return mergeRanges(rs);
  };
  let rs = plan(secs);
  while (secs > 15 && rs.reduce((t, r) => t + r.to - r.from + 1, 0) > perTitle) rs = plan(secs = Math.floor(secs * 0.7));
  return rs;
}
const keyOf = (rs) => rs.map(r => `${Math.round(r.from / MB)}-${Math.round(r.to / MB)}`).join(',');
const bytesOf = (rs) => rs.reduce((t, r) => t + r.to - r.from + 1, 0);

/** Var ligger filens index? MP4 med moov efter mdat behöver slutet (och kan inte matas till ffmpeg som ström). */
async function layout(fh, size) {
  const b = Buffer.alloc(16);
  await fh.read(b, 0, 16, 0);
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    let off = 0, moov = null, mdat = null;
    for (let n = 0; n < 4096 && off + 8 <= size; n++) {
      const { bytesRead } = await fh.read(b, 0, 16, off);
      if (bytesRead < 8) break;
      let sz = b.readUInt32BE(0);
      const type = b.toString('latin1', 4, 8);
      if (sz === 1) sz = Number(b.readBigUInt64BE(8)); else if (sz === 0) sz = size - off;
      if (sz < 8) break;
      if (type === 'moov') moov = off;
      if (type === 'mdat' && mdat == null) mdat = off;
      off += sz;
    }
    if (moov != null && mdat != null && moov > mdat) return { tailFrom: size - moov <= TAIL_MAX ? moov : null, pipe: false };
    return { tailFrom: null, pipe: moov != null };
  }
  const mkv = b.readUInt32BE(0) === 0x1a45dfa3;
  const ts = b[0] === 0x47;
  return { tailFrom: Math.max(0, size - TAIL_GENERIC), pipe: mkv || ts };
}

// ---------------- kopiering ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function copyRange(fh, from, to, dest, rate) {
  const out = await fs.promises.open(dest, 'w');
  try {
    const buf = Buffer.allocUnsafe(4 * MB);
    for (let pos = from; pos <= to;) {
      const t0 = Date.now();
      const n = Math.min(buf.length, to - pos + 1);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      if (!bytesRead) throw new Error('filen tog slut');
      await out.write(buf, 0, bytesRead);
      pos += bytesRead;
      // Låg prioritet: högst rate byte/s, så att uppspelning och skanning går före
      const wait = bytesRead / rate * 1000 - (Date.now() - t0);
      if (wait > 1) await sleep(wait);
    }
  } finally { await out.close(); }
}

/** Gör plats för need byte. Offras i tur och ordning: poster utanför planen (äldst använda), sedan de lägst prioriterade. */
function makeRoom(c, need, rank) {
  if (need > c.maxBytes) return false;
  while (usedBytes() + need > c.maxBytes) {
    const list = [...index.values()];
    const victim = list.filter(e => !rank.has(e.id)).sort((a, b) => (a.used || a.at) - (b.used || b.at))[0]
      || list.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))[0];
    if (!victim) return false;
    drop(victim, c.dir);
  }
  return true;
}

async function fill(c, cand, rank, windows) {
  const it = cand.it;
  const fh = await io.open(it.path, 'r');
  const tmp = [];
  try {
    const st = await fh.stat();
    // Skannern har inte sett ändringen än: kopiera inte (databasens storlek/tid måste stämma)
    if (st.size !== it.size || Math.floor(st.mtimeMs / 1000) !== it.mtime) return false;
    const lay = await layout(fh, st.size);
    const parts = mergeRanges([...windows, ...(lay.tailFrom != null ? [{ from: lay.tailFrom, to: st.size - 1 }] : [])]);
    const need = bytesOf(parts);
    const old = index.get(it.id);
    if (old) drop(old, c.dir);
    if (!makeRoom(c, need, rank)) return false;
    // Lämna alltid minst 1 GB ledigt på cache-poolen
    try { const f = await fs.promises.statfs(c.dir); if (f.bavail * f.bsize < need + GB) { console.warn('[snabbstart] för lite ledigt i', c.dir); return false; } } catch {}
    for (let i = 0; i < parts.length; i++) {
      const t = partFile(c.dir, it.id, i) + '.part';
      tmp.push(t);
      await copyRange(fh, parts[i].from, parts[i].to, t, c.rate);
    }
    // Ändrades filen medan vi kopierade? Då kastas kopian.
    const st2 = await fh.stat();
    if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs) return false;
    for (let i = 0; i < parts.length; i++) fs.renameSync(tmp[i], partFile(c.dir, it.id, i));
    tmp.length = 0;
    const e = { id: it.id, path: it.path, size: it.size, mtime: it.mtime, parts, pipe: lay.pipe, tail: lay.tailFrom != null ? st.size - lay.tailFrom : 0, key: keyOf(windows), why: cand.why, at: Date.now(), used: 0 };
    fs.writeFileSync(metaFile(c.dir, it.id) + '.part', JSON.stringify(e));
    fs.renameSync(metaFile(c.dir, it.id) + '.part', metaFile(c.dir, it.id));
    e.bytes = need;
    index.set(it.id, e);
    S().fills++; saveStats();
    touch(it);
    return true;
  } finally {
    for (const t of tmp) { try { fs.rmSync(t, { force: true }); } catch {} }
    await fh.close().catch(() => {});
  }
}

const state = { running: false, last: 0, lastFill: null, planned: 0, error: null };
/** Ett varv: ta bort inaktuella poster, håll storleksgränsen, kopiera kandidater vars disk är vaken (force = väck) */
export async function tick({ force = false } = {}) {
  sampleDisks();
  const c = cacheOn();
  if (!c || state.running) return { filled: 0 };
  state.running = true; state.last = Date.now();
  let filled = 0;
  try {
    load(c);
    // Titlar som tagits bort eller ändrats sedan de cachades
    for (const e of [...index.values()]) {
      const row = get('SELECT id,path,size,mtime FROM items WHERE id=?', e.id);
      if (!row || row.path !== e.path || row.size !== e.size || row.mtime !== e.mtime) drop(e, c.dir);
    }
    // Planen: kandidater i ordning så länge de ryms
    const rank = new Map(), todo = [];
    let budget = c.maxBytes;
    for (const cand of candidates()) {
      const w = windowsFor(cand, c);
      const known = index.get(cand.it.id);
      const est = bytesOf(w) + (known && known.size === cand.it.size ? known.tail ?? TAIL_GENERIC : TAIL_GENERIC);
      if (est > budget) continue;
      budget -= est;
      rank.set(cand.it.id, cand.score);
      todo.push({ cand, w });
    }
    state.planned = todo.length;
    makeRoom(c, 0, rank); // gränsen kan ha sänkts
    for (const { cand, w } of todo) {
      const e = usable(cand.it);
      if (e && (e.key === keyOf(w) || Date.now() - (e.used || 0) < (over.quietMs ?? REFILL_QUIET))) continue;
      if (!force && !awakeFor(cand.it, c)) continue;
      try { if (await fill(c, cand, rank, w)) { filled++; state.lastFill = { id: cand.it.id, title: cand.it.title, at: Date.now() }; } }
      catch (er) { console.warn('[snabbstart] kunde inte kopiera', cand.it.path, er.message); }
      // Nyckelbildsindexet (remux) tas fram nu när disken ändå är vaken
      try { await hooks.keyframes?.(cand.it); } catch {}
      if (!config().on) break;
    }
    state.error = null;
  } catch (e) { state.error = e.message; console.warn('[snabbstart]', e.message); }
  finally { state.running = false; }
  return { filled };
}

let kickT = null;
/** Kör ett varv snart (efter skanning, väckning, uppspelning) */
export function kick(delay = 5000) {
  clearTimeout(kickT);
  kickT = setTimeout(() => tick().catch(() => {}), delay);
  kickT.unref?.();
}
let timer = null;
export function start() {
  if (timer) return;
  sampleDisks();
  timer = setInterval(() => tick().catch(() => {}), 60e3); timer.unref();
  setTimeout(() => tick().catch(() => {}), 30e3).unref();
}

// ---------------- uppspelning ----------------
/** Öppnar originalfilen och kontrollerar att den är samma som i cachen. Läser direkt efter skarven (väcker disken). */
async function openChecked(e, seam) {
  const fh = await io.open(e.path, 'r');
  try {
    const st = await fh.stat();
    if (st.size !== e.size || Math.floor(st.mtimeMs / 1000) !== e.mtime) throw Object.assign(new Error('Filen har ändrats sedan den cachades'), { changed: true });
    if (seam < e.size) fh.read(Buffer.alloc(64 * 1024), 0, Math.min(64 * 1024, e.size - seam), seam).catch(() => {});
    return fh;
  } catch (er) { await fh.close().catch(() => {}); throw er; }
}

/** Byte start..end (inklusive): cachade delar ur cachen, resten ur originalfilen (som öppnas parallellt) */
async function* compose(c, e, start, end, origP) {
  let pos = start;
  while (pos <= end) {
    const i = e.parts.findIndex(p => p.from <= pos && pos <= p.to);
    if (i >= 0) {
      const p = e.parts[i], to = Math.min(p.to, end);
      for await (const ch of fs.createReadStream(partFile(c.dir, e.id, i), { start: pos - p.from, end: to - p.from })) { S().served += ch.length; yield ch; }
      pos = to + 1;
      continue;
    }
    const next = e.parts.filter(p => p.from > pos).reduce((m, p) => Math.min(m, p.from), Infinity);
    const to = Math.min(end, next - 1);
    let fh;
    try { fh = await origP(); }
    catch (er) { if (er.changed) { console.warn('[snabbstart]', e.path, er.message); drop(e, c.dir); } throw er; }
    for (; pos <= to;) {
      const buf = Buffer.allocUnsafe(Math.min(MB, to - pos + 1));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) throw new Error('Filen är kortare än väntat');
      pos += bytesRead;
      yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
    }
  }
}
function origOpener(e, seam) {
  let p = null;
  const get = () => (p ||= openChecked(e, seam));
  return { get, start() { get().catch(() => {}); }, async close() { if (p) { try { await (await p).close(); } catch {} } } };
}
function composed(c, e, start, end) {
  const covered = e.parts.find(p => p.from <= start && start <= p.to);
  const seam = covered ? covered.to + 1 : start;
  const orig = origOpener(e, seam);
  // Disken behövs om intervallet går utanför cachen: väck den direkt, parallellt med att cachen skickas
  if (bytesOf(mergeRanges(e.parts.map(p => ({ from: Math.max(p.from, start), to: Math.min(p.to, end) })))) < end - start + 1) orig.start();
  const body = Readable.from(compose(c, e, start, end, orig.get), { objectMode: false });
  body.on('close', () => { orig.close(); });
  return body;
}

/**
 * Direktuppspelning ur cachen. Returnerar false (anroparen serverar filen som vanligt) när cachen är av,
 * titeln saknas eller förfrågans början inte ligger i en cachad del.
 */
export function serveDirect(req, res, it, type) {
  const c = cacheOn(); if (!c) return false;
  load(c);
  const e = usable(it); if (!e) return false;
  const size = e.size;
  let start = 0, end = size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - +m[2]);
    else { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], size - 1); }
    if (start > end || start >= size) return false; // 416 svaras som vanligt
    code = 206;
  }
  if (!e.parts.some(p => p.from <= start && start <= p.to)) { wake(it); return false; }
  e.used = Date.now();
  touch(it);
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, h);
  if (req.method === 'HEAD') { res.end(); return true; }
  pipeline(composed(c, e, start, end), res, (er) => { if (er && er.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[snabbstart] direkt:', er.message); saveStats(); });
  return true;
}

/** Sammansatt indata till ffmpeg (från början av filen) – null när titeln inte kan matas som ström ur cachen */
export function inputFor(it) {
  const c = cacheOn(); if (!c) return null;
  load(c);
  const e = usable(it);
  if (!e || !e.pipe || e.parts[0]?.from !== 0) return null;
  e.used = Date.now();
  touch(it);
  return composed(c, e, 0, e.size - 1);
}

/** Uppspelning begärs (/playback): väck disken och räkna träff/miss för träffgraden */
export function notePlay(it, startAt = 0, mode = 'direct') {
  if (!it?.path || !config().on) return;
  wake(it);
  const c = cacheOn(); if (!c) return;
  load(c);
  const e = usable(it);
  let hit = false;
  if (e) {
    if (mode === 'direct') {
      const off = it.duration > 0 ? Math.floor(e.size * Math.min(1, startAt / it.duration)) : 0;
      hit = e.parts.some(p => p.from <= off && off <= p.to);
    } else hit = startAt < 1 && e.pipe && e.parts[0]?.from === 0;
  }
  if (hit) S().hits++; else S().misses++;
  saveStats();
  // Nästa avsnitt ligger troligen på samma disk, som nu är vaken
  kick(30e3);
}

// ---------------- väckning i förväg ----------------
const woke = new Map();
/** Läser lite av filen i bakgrunden så att disken börjar snurra upp (titelsidan öppnas, pekaren på Spela) */
export function wake(it) {
  if (!it?.path || !config().on) return false;
  const t = Date.now();
  if (t - (woke.get(it.id) || 0) < 60e3) return false;
  woke.set(it.id, t);
  if (woke.size > 1000) for (const [k, v] of woke) if (t - v > 300e3) woke.delete(k);
  (async () => {
    const fh = await io.open(it.path, 'r');
    try {
      const size = it.size || (await fh.stat()).size;
      const e = index.get(it.id);
      // Läs där uppspelningen fortsätter efter cachen (troligen inte i sidcachen, så disken måste läsas)
      const off = e?.parts[0]?.from === 0 ? Math.min(size - 1, e.parts[0].to + 1) : Math.floor(size / 2);
      await fh.read(Buffer.alloc(4096), 0, 4096, Math.max(0, off));
    } finally { await fh.close(); }
    S().wakes++; saveStats();
    touch(it);
    kick(20e3);
  })().catch(() => {});
  return true;
}

// ---------------- administration ----------------
export function info() {
  const c = config();
  const on = cacheOn();
  if (on) load(on);
  const s = S(), total = s.hits + s.misses;
  let free = null;
  try { if (on) { const f = fs.statfsSync(on.dir); free = f.bavail * f.bsize; } } catch {}
  const disks = [...diskState.entries()].filter(([n]) => /^(sd|nvme|hd|vd|md|xvd)/.test(n))
    .map(([name, d]) => ({ name, awake: !!d.changed && Date.now() - d.changed < 150e3 }));
  return {
    on: c.on, dir: c.dir || null, active: !!on, maxGb: Math.round(c.maxBytes / GB * 10) / 10, seconds: c.seconds,
    used: on ? usedBytes() : 0, entries: on ? index.size : 0, free,
    hits: s.hits, misses: s.misses, hitRate: total ? Math.round(s.hits / total * 1000) / 10 : null,
    wakes: s.wakes, served: s.served, fills: s.fills, planned: state.planned, running: state.running, lastFill: state.lastFill, error: state.error,
    disks,
    items: on ? [...index.values()].sort((a, b) => b.at - a.at).slice(0, 50).map(e => {
      const r = get('SELECT title, kind, season, episode FROM items WHERE id=?', e.id);
      return { id: e.id, title: r ? (r.kind === 'episode' ? `${r.title} (S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')})` : r.title) : String(e.id), why: e.why || '', bytes: e.bytes, at: e.at, used: e.used || null };
    }) : []
  };
}
export function setOptions(b) {
  if (b.on != null) setSetting('prestart_on', b.on ? '1' : '0');
  if (b.maxGb != null) {
    const v = parseFloat(b.maxGb);
    if (!Number.isFinite(v) || v < 0.1 || v > 10000) throw new Error('Storleken ska vara mellan 0,1 och 10 000 GB');
    setSetting('prestart_max_gb', String(v));
  }
  kick(1000);
}
export function clear() {
  const c = cacheOn(); if (!c) return;
  load(c);
  for (const e of [...index.values()]) drop(e, c.dir);
  stats = { hits: 0, misses: 0, wakes: 0, served: 0, fills: 0 }; saveStats();
}
