// API-nycklar: administratören delar ut skrivskyddad åtkomst till utvalda data åt andra system (en väggskärm,
// Home Assistant, Homepage …). Nyckeln visas en gång och sparas bara som SHA-256. Varje nyckel har behörigheter
// (SCOPES) och gäller som standard bara från hemnätet. Den ger aldrig åtkomst till något annat än /api/v1/*
// (router.js, routealternativet apikey) och kan inte strömma eller ändra något.
import crypto from 'node:crypto';
import { db, all, get, run, now } from './db.js';
import * as act from './activity.js';

db.exec(`CREATE TABLE IF NOT EXISTS api_keys(id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  scopes TEXT NOT NULL, home_only INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_used INTEGER, last_ip TEXT, uses INTEGER NOT NULL DEFAULT 0)`);

/** Behörigheter som en nyckel kan få (namnen visas i Administration) */
export const SCOPES = {
  nowplaying: 'Vad som spelas just nu (titel, vem, enhet och hur långt)',
  library: 'Biblioteket: antal titlar och nyligen tillagt'
};
export const MAX_KEYS = 50;
const PREFIX = 'bxtv_';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const shape = (r) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes.split(',').filter(Boolean), homeOnly: !!r.home_only,
  created: r.created, lastUsed: r.last_used || null, lastIp: r.last_ip || null, uses: r.uses || 0 });
export const list = () => all('SELECT * FROM api_keys ORDER BY created DESC').map(shape);

/** Ny nyckel: { key (visas en gång), ...kortet } */
export function create({ name, scopes, homeOnly = true }, userId) {
  name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('Ge nyckeln ett namn, t.ex. var den ska användas'), { status: 400 });
  const sc = [...new Set((Array.isArray(scopes) ? scopes : []).map(String))].filter(s => s in SCOPES);
  if (!sc.length) throw Object.assign(new Error('Välj minst en sak som nyckeln får läsa'), { status: 400 });
  if (get('SELECT COUNT(*) AS n FROM api_keys').n >= MAX_KEYS) throw Object.assign(new Error(`Högst ${MAX_KEYS} nycklar – ta bort någon du inte använder`), { status: 400 });
  const key = PREFIX + crypto.randomBytes(30).toString('base64url');
  const id = Number(run('INSERT INTO api_keys(name,key_hash,prefix,scopes,home_only,created,created_by) VALUES(?,?,?,?,?,?,?)',
    name, sha(key), key.slice(0, PREFIX.length + 6), sc.join(','), homeOnly === false ? 0 : 1, now(), userId ?? null).lastInsertRowid);
  return { key, ...shape(get('SELECT * FROM api_keys WHERE id=?', id)) };
}
export const remove = (id) => Number(run('DELETE FROM api_keys WHERE id=?', +id).changes) > 0;

/** Nyckeln ur förfrågan: X-Api-Key eller Authorization: Bearer bxtv_… (aldrig i adressen – den hamnar i loggar) */
export function keyFrom(req) {
  const h = String(req.headers['x-api-key'] || '').trim();
  if (h) return h;
  const m = /^Bearer\s+(bxtv_[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || '').trim());
  return m ? m[1] : '';
}

// Högst 120 anrop per minut och nyckel (en väggskärm frågar var 10:e–30:e sekund)
const rate = new Map();
const RATE_MAX = 120;
/**
 * Kontrollerar nyckeln. scope = en behörighet, en lista (någon av dem räcker) eller null (vilken som helst).
 * { key } eller { status, error }. trusted = förfrågan kommer från hemnätet (isTrusted i router.js; via reläet aldrig).
 */
export function check(req, scope, { trusted, ip }) {
  const k = keyFrom(req);
  if (!k.startsWith(PREFIX) || k.length > 100) return { status: 401, error: 'API-nyckel saknas eller är fel (skicka den i rubriken X-Api-Key)' };
  const r = get('SELECT * FROM api_keys WHERE key_hash=?', sha(k));
  if (!r) return { status: 401, error: 'API-nyckeln finns inte (den kan ha tagits bort)' };
  const has = r.scopes.split(','), want = scope == null ? has : [].concat(scope);
  if (!want.some(x => has.includes(x))) return { status: 403, error: 'Nyckeln får inte läsa det här – ändra den under Administration → API-nycklar' };
  if (r.home_only && !trusted) return { status: 403, error: 'Nyckeln gäller bara på hemnätverket' };
  const t = Date.now(), w = rate.get(r.id);
  if (!w || t - w.t > 60e3) rate.set(r.id, { t, n: 1 });
  else if (++w.n > RATE_MAX) return { status: 429, error: 'För många anrop – vänta en minut' };
  // Senast använd: högst en skrivning per minut och nyckel
  if (!r.last_used || now() - r.last_used >= 60 || r.last_ip !== ip) run('UPDATE api_keys SET last_used=?, last_ip=?, uses=uses+1 WHERE id=?', now(), ip || null, r.id);
  else run('UPDATE api_keys SET uses=uses+1 WHERE id=?', r.id);
  return { key: shape(r) };
}

// ---------------- data ----------------
const pad = (n) => String(n).padStart(2, '0');
const AUDIO_WINDOW = 90; // ljudböcker och poddar: framsteg de senaste 90 s = spelas nu (spelarna skickar oftare)

/** Allt som spelas just nu: film och serier (uppspelningssessionerna), musik, ljudböcker och poddar */
export function nowPlaying(at = now()) {
  const out = [];
  for (const s of act.listActive()) {
    const m = act.itemMeta(s.itemId);
    const ep = m?.kind === 'episode';
    out.push({
      kind: m?.kind || 'movie', user: s.user, title: ep ? m.show_title : m?.title || s.title,
      subtitle: ep ? `S${pad(m.season)}E${pad(m.episode)} · ${m.title}` : null, year: ep ? m.show_year ?? null : m?.year ?? null,
      season: ep ? m.season : null, episode: ep ? m.episode : null,
      position: Math.round(s.position || 0), duration: s.duration ? Math.round(s.duration) : null,
      paused: !!s.paused, device: s.device || null, remote: !!s.remote, mode: s.mode || null, quality: s.quality || null,
      started: s.started, image: m ? `v${ep && m.show_id ? m.show_id : m.id}` : null
    });
  }
  // Musik: spåret som startade senast per profil och fortfarande pågår (start + längd)
  for (const r of all(`SELECT p.user_id, u.name AS user, p.ts, t.title, t.duration, t.album_id, a.title AS album, ar.name AS artist
      FROM track_plays p JOIN users u ON u.id=p.user_id JOIN tracks t ON t.id=p.track_id LEFT JOIN albums a ON a.id=t.album_id LEFT JOIN artists ar ON ar.id=t.artist_id
      WHERE p.ts > ? AND p.ts = (SELECT MAX(ts) FROM track_plays q WHERE q.user_id=p.user_id) ORDER BY p.ts DESC`, at - 4 * 3600)) {
    const dur = Math.round(r.duration || 0);
    if (!dur || at > r.ts + dur + 30) continue;
    out.push({ kind: 'music', user: r.user, title: r.title, subtitle: [r.artist, r.album].filter(Boolean).join(' · ') || null, year: null, season: null, episode: null,
      position: Math.min(dur, at - r.ts), duration: dur, paused: false, device: null, remote: null, mode: null, quality: null, started: r.ts, image: r.album_id ? `a${r.album_id}` : null });
  }
  for (const r of all(`SELECT u.name AS user, b.id, b.title, b.author, b.duration, p.position, p.updated FROM book_progress p JOIN users u ON u.id=p.user_id JOIN books b ON b.id=p.book_id
      WHERE p.updated > ? AND p.finished=0 ORDER BY p.updated DESC`, at - AUDIO_WINDOW)) {
    out.push({ kind: 'audiobook', user: r.user, title: r.title, subtitle: r.author || null, year: null, season: null, episode: null,
      position: Math.round(r.position || 0), duration: r.duration ? Math.round(r.duration) : null, paused: false, device: null, remote: null, mode: null, quality: null,
      started: null, image: `b${r.id}` });
  }
  for (const r of all(`SELECT u.name AS user, e.title, e.duration, c.title AS podcast, p.position FROM podcast_progress p JOIN users u ON u.id=p.user_id
      JOIN podcast_episodes e ON e.id=p.episode_id JOIN podcasts c ON c.id=e.podcast_id WHERE p.updated > ? AND p.played=0 ORDER BY p.updated DESC`, at - AUDIO_WINDOW)) {
    out.push({ kind: 'podcast', user: r.user, title: r.title, subtitle: r.podcast || null, year: null, season: null, episode: null,
      position: Math.round(r.position || 0), duration: r.duration ? Math.round(r.duration) : null, paused: false, device: null, remote: null, mode: null, quality: null,
      started: null, image: null });
  }
  return out;
}

/** Biblioteket: antal och de senast tillagda filmerna och avsnitten */
export function library(limit = 12) {
  const n = get(`SELECT (SELECT COUNT(*) FROM items WHERE kind='movie' AND version_of IS NULL) AS movies,
    (SELECT COUNT(*) FROM items WHERE kind='show') AS shows, (SELECT COUNT(*) FROM items WHERE kind='episode') AS episodes,
    (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM albums) AS albums, (SELECT COUNT(*) FROM books) AS audiobooks,
    (SELECT COUNT(*) FROM podcasts) AS podcasts`);
  const recent = all(`SELECT i.id, i.kind, i.title, i.year, i.season, i.episode, i.added, s.id AS show_id, s.title AS show_title
    FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.kind IN ('movie','episode') AND i.version_of IS NULL AND i.path IS NOT NULL
    ORDER BY i.added DESC LIMIT ?`, Math.max(1, Math.min(50, limit))).map(r => {
    const ep = r.kind === 'episode';
    return { kind: r.kind, title: ep ? r.show_title : r.title, subtitle: ep ? `S${pad(r.season)}E${pad(r.episode)} · ${r.title}` : null,
      year: r.year ?? null, added: r.added, image: `v${ep && r.show_id ? r.show_id : r.id}` };
  });
  return { counts: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Number(v)])), recent };
}
