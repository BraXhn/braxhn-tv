// Personuppgifter (GDPR): export av en användares uppgifter, radering utan kvarlämnade spår och gallring.
// Tabellerna hittas genom databasens egen struktur (främmande nycklar till users och kolumner som user_id),
// så att nya tabeller kommer med i exporten och raderingen utan att någon behöver komma ihåg att lägga till dem.
import { all, get, run, getSetting, now } from './db.js';
import { keepDays } from './playstats.js';
import { hasTmdb } from './scanner.js';

/** Kolumner som pekar på en användare utan att vara en främmande nyckel */
const REF_COLS = ['user_id', 'owner_id', 'created_by', 'used_by'];
/** Hemligheter som aldrig lämnar servern, inte ens till kontots ägare (lösenord, nycklar, token) */
const SECRET = /^(pass|pin|token|token_hash|secret|enc|key_hash|totp_secret|totp_pending|totp_last|recovery|xt_pass)$/;

/** Säkerhetsloggen sparas så här många dagar (standard 180, minst 30) */
export const AUDIT_DAYS_DEFAULT = 180;
export const auditDays = () => { const n = parseInt(getSetting('audit_days', process.env.AUDIT_DAYS || String(AUDIT_DAYS_DEFAULT))); return Number.isFinite(n) ? Math.max(30, Math.min(3650, n)) : AUDIT_DAYS_DEFAULT; };
/** IP-adresser i tittarhistoriken tas bort efter så här många dagar (resten av raden finns kvar för statistiken) */
export const IP_DAYS = 90;
/** Kontaktuppgift till den som ansvarar för servern (visas på sidan Integritet) */
export const contact = () => getSetting('privacy_contact', process.env.PRIVACY_CONTACT || '');

const q = (n) => `"${String(n).replace(/"/g, '""')}"`;

/** Alla kopplingar till users: { table, col, onDelete ('CASCADE', 'SET NULL', … eller null utan nyckel), notnull, cols } */
export function userRefs() {
  const out = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    if (name === 'users') continue;
    const info = all(`PRAGMA table_info(${q(name)})`), cols = info.map(c => c.name);
    const fks = all(`PRAGMA foreign_key_list(${q(name)})`).filter(f => f.table === 'users');
    const seen = new Set();
    for (const f of fks) { seen.add(f.from); out.push({ table: name, col: f.from, onDelete: f.on_delete, notnull: !!info.find(c => c.name === f.from)?.notnull, cols }); }
    for (const c of REF_COLS) if (cols.includes(c) && !seen.has(c)) out.push({ table: name, col: c, onDelete: null, notnull: !!info.find(x => x.name === c)?.notnull, cols });
  }
  return out;
}

/** Kontot och, för ett huvudkonto, dess profiler */
export function householdIds(userId) {
  const u = get('SELECT id, parent_id FROM users WHERE id=?', userId);
  if (!u) return [];
  return u.parent_id ? [u.id] : [u.id, ...all('SELECT id FROM users WHERE parent_id=?', u.id).map(r => r.id)];
}

const strip = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) if (!SECRET.test(k)) o[k] = typeof v === 'bigint' ? Number(v) : v; return o; };
const inList = (ids) => ids.map(() => '?').join(',');

/** Allt servern har sparat om kontot (och dess profiler) som ett JSON-objekt – utan lösenord, nycklar och token */
export function exportUser(userId) {
  const ids = householdIds(userId);
  if (!ids.length) return null;
  const users = all(`SELECT * FROM users WHERE id IN (${inList(ids)})`, ...ids).map(strip);
  const tables = {}, itemIds = new Set();
  for (const r of userRefs()) {
    const rows = all(`SELECT * FROM ${q(r.table)} WHERE ${q(r.col)} IN (${inList(ids)})`, ...ids).map(strip);
    if (!rows.length) continue;
    (tables[r.table] ||= []).push(...rows);
    if (r.cols.includes('item_id')) for (const x of rows) if (x.item_id != null) itemIds.add(x.item_id);
  }
  // Samma rad kan nås via två kolumner (t.ex. inbjudningar: skapad av och använd av) – bara en gång
  for (const k of Object.keys(tables)) { const s = new Set(); tables[k] = tables[k].filter(x => { const j = JSON.stringify(x); return !s.has(j) && s.add(j); }); }
  // Titlarna som raderna pekar på, så att exporten går att läsa utan databasen
  const items = {};
  const list = [...itemIds];
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    for (const it of all(`SELECT id, kind, title, year, season, episode FROM items WHERE id IN (${inList(part)})`, ...part)) items[it.id] = strip(it);
  }
  return {
    format: 'braxhn-tv-personuppgifter/1', exported: new Date().toISOString(),
    note: 'Allt den här BraXhn TV-servern har sparat om kontot och dess profiler. Lösenord, PIN-koder, nycklar och inloggningstoken tas aldrig med.',
    users, tables, items
  };
}

/**
 * Tar bort det som inte försvinner av sig självt när kontona raderas (anropas före DELETE FROM users, i samma transaktion):
 * tittarhistorik utan främmande nyckel tas bort, och i rader som ska finnas kvar (säkerhetsloggen, önskemål,
 * inspelningsregler) nollställs kopplingen, namnet och IP-adressen.
 */
export function eraseTraces(ids) {
  if (!ids.length) return;
  const names = all(`SELECT name FROM users WHERE id IN (${inList(ids)})`, ...ids).map(r => r.name);
  for (const r of userRefs()) {
    if (r.onDelete === 'CASCADE') continue;
    if (r.notnull) { run(`DELETE FROM ${q(r.table)} WHERE ${q(r.col)} IN (${inList(ids)})`, ...ids); continue; }
    const extra = ['user_name', 'ip'].filter(c => r.cols.includes(c)).map(c => `, ${q(c)}=NULL`).join('');
    run(`UPDATE ${q(r.table)} SET ${q(r.col)}=NULL${extra} WHERE ${q(r.col)} IN (${inList(ids)})`, ...ids);
  }
  // Andras loggrader om kontot (t.ex. "profilen ändrad: Anna") behåller händelsen men inte namnet
  for (const n of names) run('UPDATE audit SET detail=NULL WHERE detail=?', n);
}

/** Gallring: säkerhetsloggen efter auditDays(), IP-adresser i historiken efter IP_DAYS och utgångna sessioner */
export function prune(at = now()) {
  const a = Number(run('DELETE FROM audit WHERE ts < ?', at - auditDays() * 86400).changes);
  const i = Number(run('UPDATE plays SET ip=NULL WHERE ip IS NOT NULL AND ts < ?', at - IP_DAYS * 86400).changes);
  return { audit: a, ips: i };
}
setTimeout(() => { try { prune(); } catch {} }, 90e3).unref();
setInterval(() => { try { const r = prune(); if (r.audit || r.ips) console.log(`[integritet] gallrade ${r.audit} loggrader och ${r.ips} IP-adresser`); } catch (e) { console.warn('[integritet]', e.message); } }, 86400e3).unref();

/** Vad sidan Integritet visar: hur länge saker sparas, vem som ansvarar och vilka externa tjänster som är på */
export function summary(viewer) {
  const on = (k, d) => getSetting(k, d) === '1';
  const notify = getSetting('notify_kind', process.env.NOTIFY_KIND || 'none');
  return {
    contact: contact() || null,
    retention: { historyDays: keepDays(), auditDays: auditDays(), ipDays: IP_DAYS },
    services: {
      tmdb: hasTmdb(),
      fanart: !!getSetting('fanart_api_key', ''),
      musicMeta: on('music_meta', process.env.MUSIC_METADATA || '1'),
      bookMeta: on('book_meta', process.env.BOOK_METADATA || '1'),
      updateCheck: on('update_check', process.env.UPDATE_CHECK || '1'),
      notify: notify && notify !== 'none' ? notify : null,
      relay: !!getSetting('relay_server', ''),
      acme: !!getSetting('acme_domain', process.env.ACME_DOMAIN || ''),
      scrobble: !!get('SELECT 1 FROM scrobble_accounts WHERE user_id=? LIMIT 1', viewer.id)
    }
  };
}
