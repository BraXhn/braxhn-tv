// Skärmtid: max minuter per dag och tillåtna klockslag per profil/konto (främst barnprofiler).
// Tittartiden räknas på servern från framstegsrapporter och live-segment. Tiden räknas per användare
// (väggklocka), inte per ström – två samtidiga strömmar ger alltså inte dubbel tid. Pausad uppspelning
// (positionen står still) räknas inte. Dagen och klockslagen följer serverns lokala tid (TZ).
// Tid som spelats utan nät lämnar apparna in i efterhand (addOffline, POST /api/screentime/offline).
import { db, get, all, run } from './db.js';
import { tr } from './i18n.js';
import { localDate } from './util.js';

db.exec(`CREATE TABLE IF NOT EXISTS screen_usage(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, extra INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
  CREATE TABLE IF NOT EXISTS screen_offline(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT NOT NULL, entry TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, PRIMARY KEY(user_id, device, entry));
  CREATE INDEX IF NOT EXISTS screen_offline_span ON screen_offline(user_id, start);`);
// offline = sekunder av dagens tid som kommit från addOffline (för taket per dag). Äldre databaser saknar kolumnen.
if (!all('PRAGMA table_info(screen_usage)').some(c => c.name === 'offline')) db.exec('ALTER TABLE screen_usage ADD COLUMN offline REAL NOT NULL DEFAULT 0');

/** Längsta glapp (sekunder) mellan två livstecken från samma ström som räknas som sammanhängande tittande.
 *  Spelarna rapporterar var 10:e sekund och en lång ström (originalfilen) ger ett livstecken var 20:e – 45 s tål att
 *  ett livstecken uteblir. Längre glapp betyder paus, stopp eller avbrott. Glappet gäller bara inom samma ström: tiden
 *  mellan två titlar räknas aldrig (heartbeat). */
export const CAP = 45;
/** Millisekunder efter en rapport som strömmens sista data får komma utan att pausen räknas som tittande */
const PAUSE_SLACK = 5000;
/** Millisekunder efter att spelaren stängts (stopped) som ett nytt livstecken för samma titel räknas som en ny start.
 *  Kortare än så är samma uppspelning (t.ex. en ny ström efter ett byte av version) – och den som hämtar strömmen
 *  själv kan inte dela upp den i delar som inte räknas utan att stå helt utan data i minst så här länge åt gången. */
const STOP_GAP = 15000;
const DAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
// "På måndagar går det att titta …" – nycklar i web/i18n/en.js (server/i18n.js)
const DAYS_PL = ['söndagar', 'måndagar', 'tisdagar', 'onsdagar', 'torsdagar', 'fredagar', 'lördagar'];

export const localDay = localDate; // samma lokala dag (TZ) som util.localDate
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '')); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (v) => { if (v === '' || v == null) return null; const n = parseInt(v); return Number.isFinite(n) ? Math.max(0, Math.min(1440, n)) : null; };

/** Tvätta regler från klienten. Tomma fält = ingen gräns. days: per veckodag (0 = söndag) som ersätter standardvärdena. */
export function normalize(r) {
  if (!r || typeof r !== 'object') return null;
  const one = (x) => {
    const o = {};
    const d = minutes(x?.daily); if (d != null) o.daily = d;
    const f = toMin(x?.from); if (f != null) o.from = hhmm(f);
    const u = toMin(x?.until); if (u != null) o.until = hhmm(u);
    return o;
  };
  const out = { ...one(r), audio: !!r.audio, days: {} };
  for (let i = 0; i < 7; i++) { const d = one(r.days?.[i] ?? r.days?.[String(i)]); if (Object.keys(d).length) out.days[i] = d; }
  if (!Object.keys(out.days).length) delete out.days;
  const any = out.daily != null || out.from || out.until || out.days;
  return any ? out : null;
}

// Regler cachas (läses vid varje segment); ändras bara via setRules
const rulesCache = new Map();
export function rulesFor(uid) {
  if (rulesCache.has(uid)) return rulesCache.get(uid);
  let r = null;
  try { r = JSON.parse(get('SELECT screen_time FROM users WHERE id=?', uid)?.screen_time || 'null'); } catch {}
  rulesCache.set(uid, r);
  if (rulesCache.size > 2000) rulesCache.delete(rulesCache.keys().next().value);
  return r;
}
export function setRules(uid, rules) {
  const r = normalize(rules);
  run('UPDATE users SET screen_time=? WHERE id=?', r ? JSON.stringify(r) : null, uid);
  rulesCache.delete(uid);
  return r;
}

/** Dagens regler: veckodagens värden ersätter standardvärdena */
export function rulesToday(rules, d = new Date()) {
  if (!rules) return null;
  const o = rules.days?.[d.getDay()] || {};
  return { daily: o.daily ?? rules.daily ?? null, from: o.from ?? rules.from ?? null, until: o.until ?? rules.until ?? null, audio: !!rules.audio };
}

// ---------- förbrukad tid ----------
const usage = new Map(); // uid -> { day, seconds, extra }
function usageOf(uid, day) {
  let u = usage.get(uid);
  if (!u || u.day !== day) {
    const r = get('SELECT seconds, extra, offline FROM screen_usage WHERE user_id=? AND day=?', uid, day);
    u = { day, seconds: r?.seconds || 0, extra: r?.extra || 0, offline: r?.offline || 0 };
    usage.set(uid, u);
    if (usage.size > 2000) usage.delete(usage.keys().next().value);
  }
  return u;
}
function saveUsage(uid, u) {
  run(`INSERT INTO screen_usage(user_id,day,seconds,extra,offline) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,day) DO UPDATE SET seconds=excluded.seconds, extra=excluded.extra, offline=excluded.offline`, uid, u.day, u.seconds, u.extra, u.offline);
}
/** Ge extra tid för idag (minuter, kan vara negativt). Extra tid förlänger även dagens sluttid. */
export function addExtra(uid, min, d = new Date()) {
  const u = usageOf(uid, localDay(d));
  u.extra = Math.max(0, Math.min(1440, u.extra + Math.round(+min || 0)));
  saveUsage(uid, u);
  return u.extra;
}
/** Nollställ dagens förbrukning (t.ex. om något räknats fel) */
export function resetToday(uid, d = new Date()) {
  const u = usageOf(uid, localDay(d));
  u.seconds = 0; u.offline = 0; saveUsage(uid, u);
}

// Per användare: hur långt tiden är räknad (t), när data senast skickades (flow) och per ström senaste position och
// positionsrapport (pos, last), senaste livstecken av alla slag (seen) och när spelaren stängdes (stop)
const beats = new Map(); // uid -> { t (ms), flow (ms), pos, last, seen, stop: Map(key -> …) }
function beatsOf(uid) {
  let b = beats.get(uid);
  if (!b) { b = { t: 0, pos: new Map(), last: new Map(), seen: new Map(), stop: new Map(), flow: 0 }; beats.set(uid, b); if (beats.size > 2000) beats.delete(beats.keys().next().value); }
  return b;
}
const trim = (m) => { if (m.size > 20) m.delete(m.keys().next().value); };
/** Spelaren stängdes (POST /api/stream/:id/stop) – nästa start av samma titel är en ny uppspelning (heartbeat) */
export function stopped(uid, key, at = Date.now()) {
  if (!rulesFor(uid)) return;
  const b = beatsOf(uid);
  b.stop.delete(key); b.stop.set(key, at); trim(b.stop);
}
/** Strömmen skickade data just nu (http/context.js countStream, varje gång något skickats) – räknas inte, men visar
 *  att uppspelningen inte står pausad (heartbeat) */
export function streamFlow(uid, at = Date.now()) {
  if (!rulesFor(uid)) return;
  const b = beatsOf(uid);
  if (at > b.flow) b.flow = at;
}
export let onBlocked = null; // sätts av routes/social.js: stoppar pågående strömmar
export const setOnBlocked = (fn) => { onBlocked = fn; };

/**
 * Registrera att användaren tittar. key identifierar strömmen (t.ex. "i:12", "l:3").
 * position = uppspelningsposition (sekunder) eller null för strömmar utan position (live).
 * Tiden räknas per ström: från förra livstecknet för samma ström (högst CAP sekunder bakåt) fram till det här, och
 * aldrig det som redan räknats för en annan ström (väggklockan, b.t). Första livstecknet för en ström räknas inte –
 * tiden mellan två titlar (förra stängd, nästa startar inom CAP) räknades förut som tittande. Samma titel igen efter att
 * spelaren stängts (stopped) är också en ny start, om ingen data skickats sedan dess och det gått minst STOP_GAP.
 * Returnerar status efter uppdateringen (eller null om användaren inte har någon skärmtid).
 */
export function heartbeat(uid, key, position = null, { audio = false, at = Date.now() } = {}) {
  const rules = rulesFor(uid);
  if (!rules || (audio && !rules.audio)) return null;
  const b = beatsOf(uid);
  const flow0 = b.flow; // data som skickats före det här livstecknet
  if (position == null && at > b.flow) b.flow = at; // segment eller data från strömmen (live, HLS, originalfilen)
  let moving = true, prev = null;
  if (position != null && Number.isFinite(+position)) {
    prev = b.pos.get(key);
    moving = prev == null || Math.abs(+position - prev) >= 1;
    // Positionen står still, och sedan förra rapporten för strömmen har inget annat livstecken kommit och ingen data
    // skickats (utom strax efter, PAUSE_SLACK): den var pausad – webbspelaren rapporterar när den pausas och när den
    // startar igen. Klockan börjar om här; annars räknades en paus kortare än CAP som tittande när nästa livstecken kom.
    // Skickas data under tiden (en klient som spelar men säger att den står still) gäller den vanliga räkningen.
    const since = b.last.get(key);
    if (!moving && b.t && at > b.t && since != null && b.t - since <= PAUSE_SLACK && b.flow - since <= PAUSE_SLACK) b.t = at;
    b.pos.delete(key); b.pos.set(key, +position); b.last.delete(key); b.last.set(key, at);
    if (b.pos.size > 20) { const k = b.pos.keys().next().value; b.pos.delete(k); b.last.delete(k); }
  }
  // Förra livstecknet för strömmen – inget (ny ström), för länge sedan eller före ett stopp: ny start, inget räknas
  const last = b.seen.get(key);
  let from = last?.t ?? null;
  const stop = b.stop.get(key);
  if (stop != null && at - stop >= STOP_GAP) {
    b.stop.delete(key);
    if (flow0 <= stop) from = null; // ingen data sedan stoppet: spelaren var stängd
  }
  if (from != null && at - from > CAP * 1000) from = null;
  // En rapport där positionen står still (t.ex. när uppspelningen startar igen efter en lång paus) blir bara en ny
  // startpunkt när strömmen ändå inte hänger ihop – annars kunde en klient som säger att den står still mellan
  // strömmens livstecken bryta räkningen. Nästa rapport räknas då bara så länge som positionen rört sig sedan dess.
  if (from != null && last.still && prev != null) from = Math.max(from, at - Math.abs(+position - prev) * 1000);
  if ((moving || from == null) && (!last || at > last.t)) { b.seen.delete(key); b.seen.set(key, { t: at, still: !moving }); trim(b.seen); }
  if (moving && from != null) {
    const gap = (at - Math.max(from, b.t)) / 1000;
    if (gap > 0) {
      const u = usageOf(uid, localDay(new Date(at)));
      u.seconds += gap;
      saveUsage(uid, u);
      b.t = at;
    }
  }
  const s = status(uid, new Date(at));
  if (s && !s.allowed && onBlocked) { try { onBlocked(uid, s); } catch (e) { console.warn('[skärmtid]', e.message); } }
  return s;
}

// ---------- tid som spelats utan nät ----------
/** Längsta tid (sekunder) som en post räknas för – appen börjar en ny post för varje uppspelning (och minst varje timme) */
export const OFFLINE_ENTRY = 4 * 3600;
/** Mest tid utan nät som räknas per dag (sekunder) – en app som räknat fel ska inte kunna låsa barnet i flera dagar */
export const OFFLINE_DAY = 12 * 3600;
/** Poster per anrop, och hur gamla de får vara (dagar, som statistiken i screen_usage) */
export const OFFLINE_MAX = 200;
const OFFLINE_DAYS = 60;

/** Lägg [a, b) (Unix-sekunder) på de dagar (lokal tid) som spannet täcker, inom taket per dag. Returnerar räknade sekunder. */
function addSpan(uid, a, b) {
  let total = 0;
  while (a < b) {
    const d = new Date(a * 1000);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000; // midnatt, även vid sommartid
    const e = Math.min(b, next);
    const u = usageOf(uid, localDay(d));
    const s = Math.min(e - a, Math.max(0, OFFLINE_DAY - u.offline));
    if (s > 0) { u.seconds += s; u.offline += s; saveUsage(uid, u); total += s; }
    a = e;
  }
  return total;
}

/**
 * Tid som spelats utan nät (nedladdningar), inlämnad i efterhand: entries = [{ id, at, seconds, audio }], där at är när
 * uppspelningen började (Unix-sekunder) och seconds hur länge den pågick. Tiden räknas på dagen den spelades, högst fram
 * till nu och högst OFFLINE_ENTRY per post och OFFLINE_DAY per dag. Varje verklig sekund räknas en gång per användare
 * (väggklocka, som heartbeat): det som redan lämnats in – samma post igen, en annan enhet eller ett annat id – räknas
 * inte igen. Samma id från samma enhet får växa (appen fortsatte räkna), men en post som inte hänger ihop med den
 * sparade räknas inte. Kan bara öka den räknade tiden. Tid som räknats medan appen var ansluten känner servern inte
 * till här: appen lämnar bara in tid den inte fått svar för.
 * Returnerar { added (sekunder), done (id:n appen kan ta bort ur sin kö), status } – status null utan skärmtid.
 */
export function addOffline(uid, entries, { device = '', now = Date.now() } = {}) {
  const rules = rulesFor(uid), done = [];
  let added = 0;
  if (!Array.isArray(entries)) return { added, done, status: rules ? status(uid, new Date(now)) : null };
  const nowS = now / 1000, dev = String(device ?? '').slice(0, 64);
  const d0 = new Date(now - OFFLINE_DAYS * 86400e3), oldest = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime() / 1000;
  for (const e of entries.slice(0, OFFLINE_MAX)) {
    const id = typeof e?.id === 'string' && e.id ? e.id.slice(0, 64) : Number.isFinite(e?.id) ? String(e.id) : null;
    if (id == null) continue;
    done.push(id);
    if (!rules || (e.audio && !rules.audio)) continue;
    const at = Number(e.at), secs = Number(e.seconds);
    if (!Number.isFinite(at) || !Number.isFinite(secs) || secs <= 0 || at >= nowS || at < oldest) continue;
    let start = at, end = Math.min(at + Math.min(secs, OFFLINE_ENTRY), nowS);
    const prev = get('SELECT start, end FROM screen_offline WHERE user_id=? AND device=? AND entry=?', uid, dev, id);
    if (prev) {
      if (start > prev.end || end < prev.start) continue; // samma id men en annan tid: första vinner
      start = Math.min(start, prev.start); end = Math.max(end, prev.end);
      if (end - start > OFFLINE_ENTRY) end = start + OFFLINE_ENTRY;
    }
    // Bara det som ingen sparad post (från någon enhet) redan täcker
    let cur = start;
    for (const s of all('SELECT start, end FROM screen_offline WHERE user_id=? AND end>? AND start<? ORDER BY start', uid, start, end)) {
      if (s.start > cur) added += addSpan(uid, cur, Math.min(s.start, end));
      cur = Math.max(cur, s.end);
      if (cur >= end) break;
    }
    if (cur < end) added += addSpan(uid, cur, end);
    run(`INSERT INTO screen_offline(user_id,device,entry,start,end) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,device,entry) DO UPDATE SET start=excluded.start, end=excluded.end`, uid, dev, id, start, end);
  }
  if (!rules) return { added, done, status: null };
  const s = status(uid, new Date(now));
  if (added > 0 && !s.allowed && onBlocked) { try { onBlocked(uid, s); } catch (err) { console.warn('[skärmtid]', err.message); } }
  return { added, done, status: s };
}

/**
 * Livstecken från en ström som skickar data (http/context.js countStream). Mätaren anropas med jämna mellanrum med
 * antalet skickade byte och ger tidpunkten (ms) som tiden ska räknas fram till – den senaste stunden data faktiskt
 * skickades – högst en gång per tick, annars null. Förut räknades tiden fram till anropet om något skickats sedan förra
 * livstecknet: en paus räknades då som tittande i upp till en hel period (20 s) efter att data slutat skickas.
 */
export function streamMeter(tick, now = Date.now(), bytes = 0) {
  let sent = bytes, moved = now, beat = now;
  return (t, n) => {
    if (n !== sent) { sent = n; moved = t; }
    if (moved > beat && t - beat >= tick) { beat = moved; return moved; }
    return null;
  };
}

/**
 * Status för användaren just nu. null = ingen skärmtid inställd.
 * allowed: får titta nu; remaining: sekunder kvar (null = ingen daglig gräns); reason: 'limit' | 'window'.
 */
export function status(uid, d = new Date()) {
  const rules = rulesFor(uid);
  if (!rules) return null;
  const t = rulesToday(rules, d);
  const u = usageOf(uid, localDay(d));
  const nowMin = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const limit = t.daily != null ? (t.daily + u.extra) * 60 : null;
  let remaining = limit != null ? Math.max(0, Math.round(limit - u.seconds)) : null;
  const from = toMin(t.from), until0 = toMin(t.until);
  const until = until0 != null ? Math.min(1440, until0 + u.extra) : null;
  let inWindow = true, windowLeft = null;
  if (from != null || until != null) {
    const f = from ?? 0, e = until ?? 1440;
    if (f <= e) { inWindow = nowMin >= f && nowMin < e; if (inWindow && until != null) windowLeft = Math.round((e - nowMin) * 60); }
    else { inWindow = nowMin >= f || nowMin < e; if (inWindow && until != null) windowLeft = Math.round(((nowMin >= f ? e + 1440 : e) - nowMin) * 60); }
  }
  const out = { limited: true, day: localDay(d), weekday: DAYS[d.getDay()], daily: t.daily, used: Math.round(u.seconds), extra: u.extra,
    remaining, from: t.from, until: until != null ? hhmm(until) : null, audio: t.audio, allowed: true, reason: null, message: null, left: null };
  out.left = remaining == null ? windowLeft : windowLeft == null ? remaining : Math.min(remaining, windowLeft);
  if (remaining != null && remaining <= 0) Object.assign(out, { allowed: false, reason: 'limit', left: 0 });
  else if (!inWindow) Object.assign(out, { allowed: false, reason: 'window', left: 0 });
  out.message = messageOf(out, 'sv');
  return out;
}
/** Beskedet när det inte går att titta, på språket ('sv' | 'en') – byggt ur statusens fält */
function messageOf(s, lang) {
  if (s.reason === 'limit') return tr(lang, 'Tiden är slut för idag – du har tittat {used} av {total} minuter. Fråga en vuxen om du behöver mer tid.',
    { used: Math.round(s.used / 60), total: (s.daily ?? 0) + s.extra });
  if (s.reason !== 'window') return null;
  const win = s.from && s.until ? tr(lang, 'mellan {from} och {until}', { from: s.from, until: s.until })
    : s.from ? tr(lang, 'från {from}', { from: s.from }) : tr(lang, 'fram till {until}', { until: s.until });
  const [y, m, d] = s.day.split('-').map(Number);
  return tr(lang, 'Det går inte att titta just nu. På {days} går det att titta {win}.', { days: tr(lang, DAYS_PL[new Date(y, m - 1, d).getDay()]), win });
}
/** Statusen med beskedet på språket (server/i18n.js reqLang) – null/inget besked lämnas som det är */
export const inLang = (s, lang) => s && s.message && lang && lang !== 'sv' ? { ...s, message: messageOf(s, lang) } : s;

/** Får användaren starta/fortsätta uppspelning? Returnerar null (ja) eller status med förklaring (nej). */
export function check(uid, { audio = false, d = new Date() } = {}) {
  const s = status(uid, d);
  if (!s || s.allowed || (audio && !s.audio)) return null;
  return s;
}

// Gamla rader behövs inte (statistik över skärmtid sparas i 60 dagar)
setInterval(() => {
  try {
    run('DELETE FROM screen_usage WHERE day < ?', localDay(new Date(Date.now() - 60 * 86400e3)));
    run('DELETE FROM screen_offline WHERE end < ?', Date.now() / 1000 - (OFFLINE_DAYS + 1) * 86400);
  } catch {}
}, 12 * 3600e3).unref();
