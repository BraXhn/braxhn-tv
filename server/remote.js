// "Spela på…": fjärrstyrning mellan inloggade webbläsare (telefonen styr TV-webbläsaren eller datorn).
//
// Varje inloggad webbklient håller en SSE-anslutning (GET /api/remote/events) och blir då en enhet i registret
// nedan (bara i minnet, som Titta tillsammans i party.js). Samma anslutning används åt båda hållen:
//   mottagare  – får `command` (spela, paus, spola, spår, volym, nästa, stopp) och rapporterar sitt läge
//                med POST /api/remote/state
//   styrande   – får `status` för de enheter den bevakar (efter ett kommando eller "watch")
//
// Vem får se och styra vilka enheter (canControl):
//   - samma profil: alltid (t.ex. telefonen och TV:n inloggade som samma person)
//   - andra profiler i samma hushåll (huvudkontot + dess profiler): ja för vuxna profiler – en förälder kan
//     styra TV:n där barnprofilen är inloggad. En PIN-skyddad profils enheter syns dock bara för profilen
//     själv och huvudkontot (PIN betyder "privat").
//   - barnprofiler (max_age) styr bara sina egna enheter, aldrig andras
//   - andra konton (även administratörer): aldrig
// Titlar som startas kontrolleras mot åldersgränsen för BÅDE mottagarens och den styrandes profil.
import crypto from 'node:crypto';
import { get } from './db.js';

// Åldersgränsen (allowedFor i http/context.js) kopplas in av routes/remote.js – serverns moduler importerar inte
// från http/. Tills den är inkopplad nekas alla titlar.
let allowedFor = () => false;
export const setAllowed = (fn) => { allowedFor = fn; };

const devices = new Map(); // id -> enhet
const now = () => Date.now();
const GRACE = 60e3;        // frånkopplad enhet behåller sina bevakare så här länge (sidomladdning, nätbyte)
const MAX_PER_USER = 12;
const MAX_BUFFER = 256 * 1024; // en klient som inte läser (halvöppen anslutning) kastas ut vid städningen
export const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const userRow = (uid) => get('SELECT id, name, parent_id, max_age, pin FROM users WHERE id=?', uid);
const err = (status, message) => Object.assign(new Error(message), { status });

/** Får användaren u se och styra enheten d? (se reglerna överst) */
export function canControl(u, d) {
  if (!u || !d) return false;
  if (d.userId === u.id) return true;
  const me = userRow(u.id), owner = userRow(d.userId);
  if (!me || !owner || me.max_age != null) return false;
  const root = me.parent_id || me.id;
  if ((owner.parent_id || owner.id) !== root) return false;
  return !owner.pin || me.id === root;
}

function write(d, event, data) {
  if (!d.conn) return false;
  try { d.conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; } catch { return false; }
}
function drop(d, reason) {
  const c = d.conn; if (!c) return;
  d.conn = null; d.offline = now();
  clearInterval(c.hb);
  if (reason) { try { c.res.write(`event: ${reason}\ndata: {}\n\n`); } catch {} }
  try { c.res.end(); } catch {}
  notify(d);
}

/** Ansluter en webbklient (SSE). key = slumpad nyckel som webbläsaren sparar, så att enheten behåller id vid omladdning. */
export function connect(user, { key, name, hidden }, req, res) {
  if (!KEY_RE.test(String(key || ''))) throw err(400, 'Ogiltig enhetsnyckel');
  const id = crypto.createHash('sha256').update(`${user.id}:${key}`).digest('base64url').slice(0, 16);
  let d = devices.get(id);
  if (d?.conn) drop(d, 'replaced'); // samma webbläsare i en ny flik tar över
  if (!d) {
    const mine = [...devices.values()].filter(x => x.userId === user.id).sort((a, b) => (a.conn ? 1 : 0) - (b.conn ? 1 : 0) || a.connected - b.connected);
    while (mine.length >= MAX_PER_USER) { const old = mine.shift(); drop(old); devices.delete(old.id); }
    d = { id, userId: user.id, watchers: new Set(), state: null, stateAt: 0, rate: [] };
    devices.set(id, d);
  }
  Object.assign(d, { userName: user.name, name: clean(name, 40) || 'Webbläsare', hidden: !!hidden, tokenHash: user.tokenHash, connected: now(), offline: 0 });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const conn = d.conn = { res, hb: setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000) };
  write(d, 'hello', { id, name: d.name, hidden: d.hidden });
  if (d.watchers.size) write(d, 'watched', { n: d.watchers.size });
  req.on('close', () => { clearInterval(conn.hb); if (d.conn === conn) { d.conn = null; d.offline = now(); notify(d); } });
  return d;
}

/** Enheten om den finns och användaren får styra den (annars null). En dold enhet går inte att styra. */
export function deviceFor(user, id) {
  const d = devices.get(String(id));
  return d && !d.hidden && canControl(user, d) ? d : null;
}
/** Användarens egen anslutna enhet (för "from" i kommandon och bevakning) */
export function ownDevice(user, id) {
  const d = id && devices.get(String(id));
  return d && d.userId === user.id && d.conn ? d : null;
}
const sessionValid = (d) => !!get('SELECT 1 FROM sessions WHERE token=? AND expires > ?', d.tokenHash, Math.floor(now() / 1000));

// Titel för läget: slås upp i databasen (klientens egen text används bara för musik)
function itemInfo(id) {
  const it = get(`SELECT i.id, i.kind, i.title, i.season, i.episode, i.duration, i.parent_id, i.age, i.version_of, s.title AS show
    FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.id=? AND i.kind != 'show'`, id);
  return it || null;
}
const titleOf = (it) => it.kind === 'episode' ? `${it.show || ''} – S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')} ${it.title}` : it.title;

/** Läget som skickas till en bevakare (titeln döljs om bevakarens profil inte får se den) */
function view(d, watcherUid) {
  const s = d.state;
  let st = null;
  if (s) {
    st = { ...s };
    delete st.itemId;
    if (s.media === 'video' && s.itemId) {
      const it = itemInfo(s.itemId);
      if (it && allowedFor(watcherUid, it)) Object.assign(st, { itemId: it.id, title: titleOf(it) });
      else Object.assign(st, { title: 'Något spelas', audios: [], subs: [] });
    }
    // Positionen räknas fram till nu (rapporteras bara med några sekunders mellanrum)
    if (!s.paused && s.position != null && !s.blocked) st.position = Math.min(s.duration || Infinity, s.position + (now() - d.stateAt) / 1000);
  }
  return { id: d.id, name: d.name, user: d.userName, online: !!d.conn, state: st };
}
function notify(d) {
  for (const wid of [...d.watchers]) {
    const w = devices.get(wid);
    if (!w || !w.conn) { if (!w || now() - w.offline > GRACE) d.watchers.delete(wid); continue; }
    const u = userRow(w.userId);
    if (!u || !canControl(u, d)) { d.watchers.delete(wid); continue; }
    write(w, 'status', view(d, w.userId));
  }
}

/** Enheterna användaren kan styra (anslutna, inte dolda). me = den egna enhetens id (markeras med self) */
export function listFor(user, me) {
  const out = [];
  for (const d of devices.values()) {
    if (!d.conn || !canControl(user, d)) continue;
    if (d.hidden && d.id !== me) continue;
    const v = view(d, user.id);
    out.push({ id: d.id, name: d.name, user: d.userName, self: d.id === me, mine: d.userId === user.id,
      playing: v.state && v.state.media ? { title: v.state.title || '', paused: !!v.state.paused, media: v.state.media } : null });
  }
  return out.sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name, 'sv'));
}

/** Byt namn eller dölj den egna enheten */
export function update(user, id, { name, hidden }) {
  const d = devices.get(String(id));
  if (!d || d.userId !== user.id) throw err(404, 'Enheten finns inte');
  if (name !== undefined) { const n = clean(name, 40); if (!n) throw err(400, 'Ange ett namn'); d.name = n; }
  if (hidden !== undefined) d.hidden = !!hidden;
  write(d, 'hello', { id: d.id, name: d.name, hidden: d.hidden });
  notify(d);
  return { id: d.id, name: d.name, hidden: d.hidden };
}

// ---------- kommandon ----------
const CMDS = ['play', 'pause', 'resume', 'seek', 'volume', 'audio', 'sub', 'next', 'stop'];
const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw err(400, 'Ogiltigt värde'); return n; };
const trackId = (v) => { const s = String(v ?? ''); if (s && !/^[\w:.\-]{1,80}$/.test(s)) throw err(400, 'Ogiltigt spår'); return s; };
/** Tvättar ett kommando { play: {...} } / { pause: true } … till { cmd, ... }. Kastar 400 vid fel. */
export function parseCommand(body) {
  const keys = Object.keys(body || {}).filter(k => CMDS.includes(k));
  if (keys.length !== 1) throw err(400, 'Ange exakt ett kommando');
  const cmd = keys[0], v = body[cmd];
  switch (cmd) {
    case 'play': {
      if (!v || typeof v !== 'object') throw err(400, 'Ogiltigt kommando');
      const item = Number(v.item);
      if (!Number.isInteger(item) || item <= 0) throw err(400, 'Ogiltig titel');
      // audio/sub utelämnade = mottagarens egna standardval; sub '' = inga undertexter
      const o = { cmd, item, position: v.position == null ? 0 : num(v.position, 0, 1e6) };
      if (v.audio != null && v.audio !== '') o.audio = trackId(v.audio);
      if (v.sub != null) o.sub = trackId(v.sub);
      return o;
    }
    case 'seek':
      if (v && typeof v === 'object' && v.delta != null) return { cmd, delta: num(v.delta, -3600, 3600) };
      return { cmd, position: num(v && typeof v === 'object' ? v.position : v, 0, 1e6) };
    case 'volume':
      if (v && typeof v === 'object') return { cmd, ...(v.level != null ? { level: num(v.level, 0, 1) } : {}), ...(v.muted != null ? { muted: !!v.muted } : {}) };
      return { cmd, level: num(v, 0, 1) };
    case 'audio': return { cmd, id: trackId(v) || (() => { throw err(400, 'Ogiltigt spår'); })() };
    case 'sub': return { cmd, id: trackId(v) };
    default: if (v !== true && v !== 1 && v !== undefined && !(v && typeof v === 'object')) throw err(400, 'Ogiltigt kommando');
      return { cmd };
  }
}

// Hastighetsbegränsning per användare (styrande) och per enhet (lägesrapporter)
const limits = new Map();
function limited(key, n, ms) {
  const t = now(), a = (limits.get(key) || []).filter(x => t - x < ms);
  if (a.length >= n) { limits.set(key, a); return true; }
  a.push(t); limits.set(key, a); return false;
}

/** Skickar ett kommando till enheten d från användaren user (from = den styrandes egen enhet, valfri) */
export function command(user, d, cmd, from) {
  if (limited('c' + user.id, 40, 10e3)) throw err(429, 'För många kommandon – vänta en stund');
  if (!d.conn) throw err(409, 'Enheten är inte ansluten');
  if (!sessionValid(d)) { drop(d, 'closed'); throw err(409, 'Enheten är inte längre inloggad'); }
  if (cmd.cmd === 'play') {
    const it = get(`SELECT * FROM items WHERE id=? AND kind != 'show'`, cmd.item);
    if (!it || !allowedFor(user.id, it)) throw err(404, 'Finns inte');
    if (!allowedFor(d.userId, it)) throw err(403, `Titeln är inte tillåten för profilen ${d.userName} på ${d.name}`);
  }
  const f = ownDevice(user, from);
  const fresh = f && f.id !== d.id && !d.watchers.has(f.id);
  if (fresh) d.watchers.add(f.id);
  if (!write(d, 'command', { ...cmd, from: { id: f?.id || null, name: f?.name || user.name, user: user.name } })) throw err(409, 'Enheten är inte ansluten');
  if (fresh) write(d, 'watched', { n: d.watchers.size });
  // Stoppad: töm läget direkt (mottagaren bekräftar med sin nästa rapport) – annars syns "Spelar" en stund till
  if (cmd.cmd === 'stop') { d.state = null; d.stateAt = now(); notify(d); }
  else if (f) write(f, 'status', view(d, user.id));
  return { ok: true };
}

/** Börja/sluta bevaka en enhets läge (styrpanelen) */
export function watch(user, d, from, on = true) {
  const f = ownDevice(user, from);
  if (!f) throw err(400, 'Den här webbläsaren är inte ansluten');
  if (on) { d.watchers.add(f.id); write(d, 'watched', { n: d.watchers.size }); write(f, 'status', view(d, user.id)); }
  else d.watchers.delete(f.id);
  return { ok: true };
}

/** Mottagarens lägesrapport. Returnerar om någon bevakar (då rapporterar klienten oftare). */
export function report(user, id, s) {
  const d = devices.get(String(id));
  if (!d || d.userId !== user.id) throw err(404, 'Enheten finns inte');
  if (limited('s' + d.id, 8, 2e3)) throw err(429, 'För många rapporter');
  d.state = sanitizeState(s, d.userId);
  d.stateAt = now();
  notify(d);
  return { watched: d.watchers.size > 0 };
}
const list = (a) => Array.isArray(a) ? a.slice(0, 40).map(x => ({ id: trackId(x?.id), label: clean(x?.label, 100) })) : [];
const fin = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
export function sanitizeState(s, uid) {
  if (!s || typeof s !== 'object' || !['video', 'audio'].includes(s.media)) return null;
  const o = { media: s.media, position: fin(s.position, 1e6), duration: fin(s.duration, 1e6), paused: !!s.paused, blocked: !!s.blocked,
    volume: fin(s.volume, 1), muted: !!s.muted, hasNext: !!s.hasNext };
  if (s.media === 'video') {
    const id = Number(s.itemId), it = Number.isInteger(id) && id > 0 ? itemInfo(id) : null;
    if (!it || !allowedFor(uid, it)) return null;
    Object.assign(o, { itemId: it.id, audio: trackId(s.audio), sub: trackId(s.sub), audios: list(s.audios), subs: list(s.subs) });
  } else Object.assign(o, { title: clean(s.title, 200), artist: clean(s.artist, 200) });
  return o;
}

/** Städning: döda och utloggade anslutningar stängs, frånkopplade enheter glöms efter en minut */
export function sweep() {
  for (const d of [...devices.values()]) {
    const c = d.conn;
    if (c && (c.res.destroyed || c.res.writableEnded || c.res.writableLength > MAX_BUFFER)) { clearInterval(c.hb); d.conn = null; d.offline = now(); try { c.res.destroy(); } catch {} notify(d); }
    else if (c && !sessionValid(d)) drop(d, 'closed');
    if (!d.conn && now() - d.offline > GRACE) { devices.delete(d.id); limits.delete('s' + d.id); }
  }
  for (const [k, a] of limits) if (!a.length || now() - a[a.length - 1] > 60e3) limits.delete(k);
}
setInterval(sweep, 30e3).unref();

// För tester
export const _devices = devices;
