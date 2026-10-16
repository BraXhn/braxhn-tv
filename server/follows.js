// Följda serier: "Nytt för dig" när skannern hittar nya avsnitt, personlig notis (ntfy/webhook)
// och underlaget för appens automatiska offline-synk ("håll de N nästa osedda avsnitten nedladdade").
//
// Beteende: man följer en serie med Följ-knappen. En serie följs också automatiskt när man lägger den
// i Min lista eller ser klart ett avsnitt. Avföljer man en serie följs den inte automatiskt igen.
import { db, get, all, run, tx, now } from './db.js';
import { sendPersonal, PERSONAL_KINDS } from './notify.js';
import { safePost } from './podcasts.js';

db.exec(`CREATE TABLE IF NOT EXISTS follows(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1, auto INTEGER NOT NULL DEFAULT 0,
  sync INTEGER, added INTEGER NOT NULL, PRIMARY KEY(user_id, show_id));
CREATE INDEX IF NOT EXISTS follows_show ON follows(show_id, active);
CREATE TABLE IF NOT EXISTS new_episodes(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, season INTEGER NOT NULL, episode INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, added INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, show_id, season, episode));
CREATE INDEX IF NOT EXISTS new_ep_user ON new_episodes(user_id, seen, added);
CREATE INDEX IF NOT EXISTS new_ep_item ON new_episodes(item_id);`);

// ---------- följa ----------
const showIdOf = (itemId) => { const it = get('SELECT id, kind, parent_id FROM items WHERE id=?', itemId); return !it ? null : it.kind === 'episode' ? it.parent_id : it.kind === 'show' ? it.id : null; };
export function follow(uid, itemId, on = true) {
  const sid = showIdOf(itemId); if (!sid) return null;
  run(`INSERT INTO follows(user_id,show_id,active,auto,added) VALUES(?,?,?,0,?)
    ON CONFLICT(user_id,show_id) DO UPDATE SET active=excluded.active, auto=0`, uid, sid, on ? 1 : 0, now());
  return sid;
}
/** Automatisk följning (Min lista, sett avsnitt) – ändrar aldrig ett aktivt val (t.ex. avföljd) */
export function autoFollow(uid, itemId) {
  const sid = showIdOf(itemId); if (!sid) return;
  run('INSERT OR IGNORE INTO follows(user_id,show_id,active,auto,added) VALUES(?,?,1,1,?)', uid, sid, now());
}
export const isFollowing = (uid, showId) => !!get('SELECT 1 FROM follows WHERE user_id=? AND show_id=? AND active=1', uid, showId);
export const followInfo = (uid, showId) => {
  const r = get('SELECT active, sync FROM follows WHERE user_id=? AND show_id=?', uid, showId);
  return { following: !!r?.active, sync: r?.sync ?? null };
};
/** Antal avsnitt att hålla nedladdade för just den här serien (null = standard, 0 = av) */
export function setShowSync(uid, showId, n) {
  const v = n === null || n === '' || n === undefined ? null : Math.max(0, Math.min(10, parseInt(n) || 0));
  run('UPDATE follows SET sync=? WHERE user_id=? AND show_id=?', v, uid, showId);
  return v;
}
export const followedIds = (uid) => all('SELECT show_id FROM follows WHERE user_id=? AND active=1 ORDER BY added DESC', uid).map(r => r.show_id);

// ---------- "Nytt för dig" ----------
/** SQL-villkor för listItems: nya, olästa och osedda avsnitt för användaren (p_uid.uid) */
export const FOR_YOU_WHERE = `i.id IN (SELECT item_id FROM new_episodes WHERE user_id=p_uid.uid AND seen=0 AND item_id IS NOT NULL) AND COALESCE(p.watched,0)=0`;
export const FOR_YOU_ORDER = `(SELECT added FROM new_episodes n WHERE n.user_id=p_uid.uid AND n.item_id=i.id) DESC, i.season, i.episode`;
export function markSeen(uid, ids = null) {
  if (Array.isArray(ids)) tx(() => { for (const id of ids.slice(0, 1000)) run('UPDATE new_episodes SET seen=1 WHERE user_id=? AND item_id=?', uid, +id); });
  else run('UPDATE new_episodes SET seen=1 WHERE user_id=? AND seen=0', uid);
}

// ---------- nya avsnitt från skannern ----------
const DELAY = Math.max(0, +(process.env.NEW_EPISODE_NOTIFY_DELAY ?? 600)) * 1000; // samla avsnitt i 10 min innan notisen skickas
const MAX_WAIT = 60 * 60e3;
const pending = new Map(); // uid -> { eps: [], first, timer }
export const outbox = []; // senaste personliga notiser (för test och felsökning)

/**
 * Anropas av skannern med id:n för nyskapade avsnitt. allowed(uid, item) = får profilen se titeln (åldersgräns).
 * Varje användare som följer serien får avsnitten i "Nytt för dig" och (samlat) en personlig notis.
 * Samma säsong/avsnitt ger aldrig två notiser (t.ex. när en fil byts mot en bättre version).
 */
export function onNewEpisodes(ids, allowed = () => true) {
  if (!ids?.length) return 0;
  const eps = all(`SELECT e.id, e.parent_id, e.season, e.episode, e.title, e.age, s.title AS show, s.age AS show_age FROM items e JOIN items s ON s.id=e.parent_id
    WHERE e.kind='episode' AND e.id IN (${ids.map(() => '?').join(',')})`, ...ids.map(Number));
  const byShow = new Map();
  for (const e of eps) { if (!byShow.has(e.parent_id)) byShow.set(e.parent_id, []); byShow.get(e.parent_id).push(e); }
  const got = new Map(); // uid -> nya avsnitt
  tx(() => {
    for (const [sid, list] of byShow) {
      for (const f of all('SELECT user_id FROM follows WHERE show_id=? AND active=1', sid)) {
        for (const e of list) {
          if (!allowed(f.user_id, { id: e.id, age: e.age, parent_id: sid })) continue;
          // Redan sett ett avsnitt med samma nummer (t.ex. ersatt fil)? Då är det inte nytt.
          if (get(`SELECT 1 FROM items x JOIN progress q ON q.item_id=x.id AND q.user_id=? AND q.watched=1 WHERE x.parent_id=? AND x.season=? AND x.episode=? LIMIT 1`,
            f.user_id, sid, e.season, e.episode)) continue;
          const r = run('INSERT OR IGNORE INTO new_episodes(user_id,show_id,season,episode,item_id,added) VALUES(?,?,?,?,?,?)', f.user_id, sid, e.season, e.episode, e.id, now());
          if (!r.changes) { run('UPDATE new_episodes SET item_id=? WHERE user_id=? AND show_id=? AND season=? AND episode=? AND item_id IS NULL', e.id, f.user_id, sid, e.season, e.episode); continue; }
          if (!got.has(f.user_id)) got.set(f.user_id, []);
          got.get(f.user_id).push(e);
        }
      }
    }
  });
  let n = 0;
  for (const [uid, list] of got) { n += list.length; queue(uid, list); }
  return n;
}

function queue(uid, list) {
  if (!personalOf(uid)) return;
  let p = pending.get(uid);
  if (!p) { p = { eps: [], first: Date.now(), timer: null }; pending.set(uid, p); }
  p.eps.push(...list);
  clearTimeout(p.timer);
  const wait = Math.max(0, Math.min(DELAY, p.first + MAX_WAIT - Date.now()));
  p.timer = setTimeout(() => { flush(uid).catch(() => {}); }, wait);
  p.timer.unref?.();
}
/** Skicka alla väntande notiser direkt (används vid test) */
export async function flushAll() { for (const uid of [...pending.keys()]) await flush(uid); }

const sxe = (e) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
export function compose(eps) {
  const byShow = new Map();
  for (const e of eps) { if (!byShow.has(e.show)) byShow.set(e.show, []); byShow.get(e.show).push(e); }
  const shows = [...byShow.keys()];
  const title = eps.length === 1 ? `Nytt avsnitt av ${shows[0]}` : shows.length === 1 ? `${eps.length} nya avsnitt av ${shows[0]}` : `${eps.length} nya avsnitt`;
  const lines = [...byShow].slice(0, 8).map(([show, l]) => {
    l.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const parts = l.slice(0, 6).map(e => `${sxe(e)}${e.title && !/^Avsnitt \d+$/.test(e.title) ? ' ' + e.title : ''}`);
    return `${show}: ${parts.join(', ')}${l.length > 6 ? ` och ${l.length - 6} till` : ''}`;
  });
  if (byShow.size > 8) lines.push(`… och ${byShow.size - 8} serier till`);
  return { title, message: lines.join('\n') };
}

let poster = async (url, body, headers) => {
  const r = await safePost(url, body, { headers });
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 200)}`);
};
/** Byt ut POST-funktionen (test) */
export const setPoster = (fn) => { poster = fn; };

async function flush(uid) {
  const p = pending.get(uid); if (!p) return;
  pending.delete(uid); clearTimeout(p.timer);
  // Avsnitt som hunnit ses eller tas bort skickas inte
  const eps = p.eps.filter(e => get('SELECT 1 FROM items WHERE id=?', e.id) && !get('SELECT 1 FROM progress WHERE user_id=? AND item_id=? AND watched=1', uid, e.id));
  const c = personalOf(uid);
  if (!eps.length || !c) return;
  const { title, message } = compose(eps);
  try { await sendPersonal(c, title, message, poster); outbox.push({ uid, title, message, at: Date.now() }); if (outbox.length > 50) outbox.shift(); }
  catch (e) { console.warn(`[notis] kunde inte skicka till användare ${uid}:`, e.message); }
}

// ---------- personlig notisadress ----------
function personalOf(uid) {
  try { const c = JSON.parse(get('SELECT notify_personal FROM users WHERE id=?', uid)?.notify_personal || 'null'); return c && PERSONAL_KINDS.includes(c.kind) && c.url ? c : null; }
  catch { return null; }
}
export function getPersonal(uid) {
  const c = personalOf(uid);
  return { kind: c?.kind || 'none', url: c?.url || '', hasToken: !!c?.token, kinds: PERSONAL_KINDS };
}
/** Spara personlig notisadress. Kastar fel med svensk text vid ogiltig adress. token: undefined = behåll. */
export function setPersonal(uid, { kind, url, token }) {
  if (!kind || kind === 'none') { run('UPDATE users SET notify_personal=NULL WHERE id=?', uid); return getPersonal(uid); }
  if (!PERSONAL_KINDS.includes(kind)) throw Object.assign(new Error('Okänd notistyp'), { status: 400 });
  const u = String(url || '').trim();
  let parsed;
  try { parsed = new URL(u); } catch { throw Object.assign(new Error('Ogiltig adress'), { status: 400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || u.length > 500) throw Object.assign(new Error('Adressen måste börja med https:// (eller http://)'), { status: 400 });
  if (parsed.username || parsed.password) throw Object.assign(new Error('Adresser med inloggning stöds inte – använd fältet för token'), { status: 400 });
  if (kind === 'ntfy' && !parsed.pathname.replace(/\//g, '')) throw Object.assign(new Error('Ange ntfy-adressen med ämne, t.ex. https://ntfy.sh/mitt-hemliga-amne'), { status: 400 });
  const old = personalOf(uid);
  const tok = token === undefined ? old?.token || '' : String(token || '').slice(0, 300);
  run('UPDATE users SET notify_personal=? WHERE id=?', JSON.stringify({ kind, url: u, token: tok }), uid);
  return getPersonal(uid);
}
export async function testPersonal(uid) {
  const c = personalOf(uid);
  if (!c) throw Object.assign(new Error('Ingen notisadress angiven'), { status: 400 });
  await sendPersonal(c, 'Testnotis', 'Så här ser notiser om nya avsnitt ut.', poster);
}

// ---------- automatisk offline-synk ----------
export const SYNC_QUALITIES = ['480', '720', '1080', 'orig'];
export function getSync(uid) {
  let s = null;
  try { s = JSON.parse(get('SELECT offline_sync FROM users WHERE id=?', uid)?.offline_sync || 'null'); } catch {}
  return { count: s?.count || 0, scope: s?.scope === 'continue' ? 'continue' : 'follows', quality: SYNC_QUALITIES.includes(s?.quality) ? s.quality : '720', wifiOnly: s?.wifiOnly !== false };
}
export function setSync(uid, b) {
  const cur = getSync(uid);
  const s = {
    count: b.count != null ? Math.max(0, Math.min(10, parseInt(b.count) || 0)) : cur.count,
    scope: b.scope != null ? (b.scope === 'continue' ? 'continue' : 'follows') : cur.scope,
    quality: b.quality != null ? (SYNC_QUALITIES.includes(String(b.quality)) ? String(b.quality) : '720') : cur.quality,
    wifiOnly: b.wifiOnly != null ? !!b.wifiOnly : cur.wifiOnly
  };
  run('UPDATE users SET offline_sync=? WHERE id=?', JSON.stringify(s), uid);
  return s;
}
const MAX_ITEMS = 60;
/**
 * Vilka avsnitt ska finnas offline? Nästa N osedda avsnitt per serie (efter det senast sedda; specialavsnitt räknas inte).
 * have = avsnitt som appens synk själv har laddat ner; remove = de av dem som är sedda eller borttagna.
 * Returnerar avsnittens id i ordning (åldersgränsen filtreras i app.js).
 */
export function syncPlan(uid, have = []) {
  const s = getSync(uid);
  const shows = new Map(); // show_id -> antal
  for (const f of all('SELECT show_id, sync FROM follows WHERE user_id=? AND active=1 ORDER BY added DESC', uid)) {
    const n = f.sync ?? (s.scope === 'follows' ? s.count : 0);
    if (n > 0) shows.set(f.show_id, n);
  }
  if (s.scope === 'continue' && s.count > 0) {
    // Serier man tittat på senaste 30 dagarna (samma som "Fortsätt titta"); avföljda serier hoppas över
    for (const r of all(`SELECT e.parent_id AS sid, MAX(p.updated) AS t FROM progress p JOIN items e ON e.id=p.item_id
      WHERE p.user_id=? AND e.kind='episode' AND p.updated > ? GROUP BY e.parent_id ORDER BY t DESC LIMIT 20`, uid, now() - 30 * 86400)) {
      const f = get('SELECT active, sync FROM follows WHERE user_id=? AND show_id=?', uid, r.sid);
      if (f && (!f.active || f.sync === 0)) continue;
      if (!shows.has(r.sid)) shows.set(r.sid, f?.sync ?? s.count);
    }
  }
  const ids = [];
  for (const [sid, n] of shows) {
    if (ids.length >= MAX_ITEMS) break;
    const rows = all(`SELECT e.id FROM items e LEFT JOIN progress p ON p.item_id=e.id AND p.user_id=?
      WHERE e.parent_id=? AND e.kind='episode' AND e.season > 0 AND e.path IS NOT NULL AND COALESCE(p.watched,0)=0
        AND (e.season*10000+e.episode) > COALESCE((SELECT MAX(x.season*10000+x.episode) FROM items x JOIN progress q ON q.item_id=x.id AND q.user_id=? AND q.watched=1
          WHERE x.parent_id=e.parent_id AND x.season > 0), -1)
      ORDER BY e.season, e.episode LIMIT ?`, uid, sid, uid, Math.min(n, MAX_ITEMS - ids.length));
    ids.push(...rows.map(r => r.id));
  }
  const want = new Set(ids);
  const remove = [];
  for (const id of [...new Set(have.map(Number).filter(x => Number.isInteger(x) && x > 0))].slice(0, 500)) {
    if (want.has(id)) continue;
    const it = get('SELECT id FROM items WHERE id=?', id);
    if (!it || get('SELECT 1 FROM progress WHERE user_id=? AND item_id=? AND watched=1', uid, id)) remove.push(id);
  }
  return { ...s, enabled: s.count > 0 || [...shows.values()].some(n => n > 0), ids, remove };
}
