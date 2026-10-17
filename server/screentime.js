// Skärmtid: max minuter per dag och tillåtna klockslag per profil/konto (främst barnprofiler).
// Tittartiden räknas på servern från framstegsrapporter och live-segment. Tiden räknas per användare
// (väggklocka), inte per ström – två samtidiga strömmar ger alltså inte dubbel tid. Pausad uppspelning
// (positionen står still) räknas inte. Dagen och klockslagen följer serverns lokala tid (TZ).
import { db, get, run } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS screen_usage(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, extra INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));`);

/** Längsta glapp (sekunder) mellan två rapporter som räknas som sammanhängande tittande.
 *  Klienterna rapporterar var 10:e sekund; längre glapp betyder paus, stopp eller avbrott. */
export const CAP = 45;
const DAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    const r = get('SELECT seconds, extra FROM screen_usage WHERE user_id=? AND day=?', uid, day);
    u = { day, seconds: r?.seconds || 0, extra: r?.extra || 0 };
    usage.set(uid, u);
    if (usage.size > 2000) usage.delete(usage.keys().next().value);
  }
  return u;
}
function saveUsage(uid, u) {
  run(`INSERT INTO screen_usage(user_id,day,seconds,extra) VALUES(?,?,?,?)
    ON CONFLICT(user_id,day) DO UPDATE SET seconds=excluded.seconds, extra=excluded.extra`, uid, u.day, u.seconds, u.extra);
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
  u.seconds = 0; saveUsage(uid, u);
}

// Senaste räknade ögonblick per användare och senaste position per ström
const beats = new Map(); // uid -> { t (ms), pos: Map(key -> position) }
export let onBlocked = null; // sätts av routes/social.js: stoppar pågående strömmar
export const setOnBlocked = (fn) => { onBlocked = fn; };

/**
 * Registrera att användaren tittar. key identifierar strömmen (t.ex. "i:12", "l:3").
 * position = uppspelningsposition (sekunder) eller null för strömmar utan position (live).
 * Returnerar status efter uppdateringen (eller null om användaren inte har någon skärmtid).
 */
export function heartbeat(uid, key, position = null, { audio = false, at = Date.now() } = {}) {
  const rules = rulesFor(uid);
  if (!rules || (audio && !rules.audio)) return null;
  let b = beats.get(uid);
  if (!b) { b = { t: 0, pos: new Map() }; beats.set(uid, b); if (beats.size > 2000) beats.delete(beats.keys().next().value); }
  let moving = true;
  if (position != null && Number.isFinite(+position)) {
    const prev = b.pos.get(key);
    moving = prev == null || Math.abs(+position - prev) >= 1;
    b.pos.set(key, +position);
    if (b.pos.size > 20) b.pos.delete(b.pos.keys().next().value);
  }
  if (moving) {
    const gap = (at - b.t) / 1000;
    if (b.t && gap > 0 && gap <= CAP) {
      const u = usageOf(uid, localDay(new Date(at)));
      u.seconds += gap;
      saveUsage(uid, u);
    }
    if (at > b.t) b.t = at;
  }
  const s = status(uid, new Date(at));
  if (s && !s.allowed && onBlocked) { try { onBlocked(uid, s); } catch (e) { console.warn('[skärmtid]', e.message); } }
  return s;
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
  if (remaining != null && remaining <= 0) {
    Object.assign(out, { allowed: false, reason: 'limit', left: 0,
      message: `Tiden är slut för idag – du har tittat ${Math.round(u.seconds / 60)} av ${t.daily + u.extra} minuter. Fråga en vuxen om du behöver mer tid.` });
  } else if (!inWindow) {
    const win = from != null && until != null ? `mellan ${hhmm(from)} och ${hhmm(until)}` : from != null ? `från ${hhmm(from)}` : `fram till ${hhmm(until)}`;
    Object.assign(out, { allowed: false, reason: 'window', left: 0, message: `Det går inte att titta just nu. På ${DAYS[d.getDay()]}ar går det att titta ${win}.` });
  }
  return out;
}

/** Får användaren starta/fortsätta uppspelning? Returnerar null (ja) eller status med förklaring (nej). */
export function check(uid, { audio = false, d = new Date() } = {}) {
  const s = status(uid, d);
  if (!s || s.allowed || (audio && !s.audio)) return null;
  return s;
}

// Gamla rader behövs inte (statistik över skärmtid sparas i 60 dagar)
setInterval(() => { try { run('DELETE FROM screen_usage WHERE day < ?', localDay(new Date(Date.now() - 60 * 86400e3))); } catch {} }, 12 * 3600e3).unref();
