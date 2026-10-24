// Skådespelare och personer: rollista och regissör/skapare från TMDB, personsidor och personbilder.
// people.id är TMDB:s person-id. Rollistan sparas per titel (filmer och serier) i item_people.
import fs from 'node:fs';
import path from 'node:path';
import { db, get, all, run, tx, now, getSetting, IMAGES, searchKeys } from './db.js';
import { ranked, parseQuery } from './search.js';

db.exec(`CREATE TABLE IF NOT EXISTS people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, profile_path TEXT, bio TEXT,
  birthday TEXT, deathday TEXT, birthplace TEXT, bio_fetched INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS people_name ON people(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS item_people(item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, role TEXT NOT NULL, character TEXT, ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(item_id, role, person_id));
CREATE INDEX IF NOT EXISTS item_people_person ON item_people(person_id);`);
searchKeys('people', ['name']);

export const MAX_CAST = 20;
const BIO_TTL = 30 * 86400;
const str = (v, max = 200) => v == null || v === '' ? null : String(v).slice(0, max);
const pathOk = (p) => typeof p === 'string' && /^\/[A-Za-z0-9._-]{1,100}$/.test(p) ? p : null;

/** Plocka ut rollista (högst MAX_CAST), regissörer (film) och skapare (serie) ur ett TMDB-svar */
export function extractCredits(d, kind) {
  const out = [], seen = new Set();
  const add = (p, role, character, ord) => {
    const id = parseInt(p?.id);
    if (!(id > 0) || !p.name || seen.has(role + id)) return;
    seen.add(role + id);
    out.push({ id, name: str(p.name), profile_path: pathOk(p.profile_path), role, character: str(character), ord });
  };
  const cast = (kind === 'show' ? (d.aggregate_credits?.cast || d.credits?.cast) : d.credits?.cast) || [];
  [...cast].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)).slice(0, MAX_CAST).forEach((c, i) => {
    // aggregate_credits har en lista med roller – ta den med flest avsnitt
    const ch = c.character ?? [...(c.roles || [])].sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0))[0]?.character;
    add(c, 'cast', ch, i);
  });
  if (kind === 'show') (d.created_by || []).slice(0, 4).forEach((c, i) => add(c, 'creator', null, i));
  else (d.credits?.crew || []).filter(c => c.job === 'Director').slice(0, 4).forEach((c, i) => add(c, 'director', null, i));
  return out;
}

/** Ersätt titelns rollista */
export function saveCredits(itemId, list) {
  tx(() => {
    run('DELETE FROM item_people WHERE item_id=?', itemId);
    for (const p of list) {
      run(`INSERT INTO people(id,name,profile_path) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        profile_path=COALESCE(excluded.profile_path, profile_path)`, p.id, p.name, p.profile_path ?? null);
      run('INSERT OR IGNORE INTO item_people(item_id,person_id,role,character,ord) VALUES(?,?,?,?,?)', itemId, p.id, p.role, p.character ?? null, p.ord ?? 0);
    }
    run('UPDATE items SET credits_done=1 WHERE id=?', itemId);
  });
}

/** Rollistan för en titel (avsnitt visar seriens) */
export function castOf(itemId) {
  return all(`SELECT p.id, p.name, p.profile_path, ip.role, ip.character FROM item_people ip JOIN people p ON p.id=ip.person_id
    WHERE ip.item_id=? ORDER BY CASE ip.role WHEN 'cast' THEN 1 ELSE 0 END, ip.ord`, itemId)
    .map(r => ({ id: r.id, name: r.name, role: r.role, character: r.character || null, image: !!r.profile_path }));
}

/** Personer vars namn matchar – bara de som finns i titlar profilen får se. age = ageFilter(uid) från http/context.js */
export function searchPeople(q, age, limit = 20) {
  // Rankad matchning (search.js): exakt namn först, sedan början av namnet/ord, vid lika poäng flest titlar
  const visible = `(SELECT COUNT(DISTINCT i.id) FROM item_people ip JOIN items i ON i.id=ip.item_id LEFT JOIN items s ON s.id=i.parent_id
    WHERE ip.person_id=p.id AND i.version_of IS NULL${age.sql})`;
  return ranked({ from: 'FROM people p', cols: 'p.id, p.name, p.name AS _t, p.profile_path', key: 'p.skey', pop: visible, colParams: age.params,
    where: `EXISTS (SELECT 1 FROM item_people ip JOIN items i ON i.id=ip.item_id LEFT JOIN items s ON s.id=i.parent_id
      WHERE ip.person_id=p.id AND i.version_of IS NULL${age.sql})`, params: age.params }, typeof q === 'string' ? parseQuery(q) : q, limit)
    .map(r => ({ id: r.id, name: r.name, image: !!r.profile_path, titles: r._n }));
}

/** Personens roller per titel: Map(item_id → [{role, character}]) */
export function rolesOf(personId) {
  const m = new Map();
  for (const r of all('SELECT item_id, role, character FROM item_people WHERE person_id=? ORDER BY role', personId)) {
    if (!m.has(r.item_id)) m.set(r.item_id, []);
    m.get(r.item_id).push({ role: r.role, character: r.character || null });
  }
  return m;
}

export const personRow = (id) => get('SELECT * FROM people WHERE id=?', id);
const shapePerson = (p) => ({ id: p.id, name: p.name, image: !!p.profile_path, bio: p.bio || null,
  birthday: p.birthday || null, deathday: p.deathday || null, birthplace: p.birthplace || null });

// Biografi hämtas vid behov (när personsidan öppnas) och cachas i 30 dagar
const bioPending = new Map();
export async function person(id, tmdb, hasTmdb = true) {
  const p = personRow(id);
  if (!p) return null;
  if (!hasTmdb || now() - p.bio_fetched < BIO_TTL) return shapePerson(p);
  if (!bioPending.has(id)) bioPending.set(id, (async () => {
    try {
      let d = await tmdb(`/person/${id}`);
      let bio = d.biography;
      if (!bio) { try { bio = (await tmdb(`/person/${id}`, { language: 'en-US' })).biography; } catch {} }
      run(`UPDATE people SET bio=?, birthday=?, deathday=?, birthplace=?, profile_path=COALESCE(?, profile_path), bio_fetched=? WHERE id=?`,
        str(bio, 4000), str(d.birthday, 20), str(d.deathday, 20), str(d.place_of_birth), pathOk(d.profile_path), now(), id);
    } catch (e) {
      // Försök igen om ett dygn (t.ex. ingen kontakt med TMDB)
      run('UPDATE people SET bio_fetched=? WHERE id=?', now() - BIO_TTL + 86400, id);
      console.warn('[people] biografi:', e.message);
    } finally { bioPending.delete(id); }
  })());
  await bioPending.get(id);
  return shapePerson(personRow(id));
}

// ---------- personbilder: hämtas från TMDB första gången de visas och sparas bland övriga bilder ----------
export const imageFile = (id) => path.join(IMAGES, `p${+id}-profile.jpg`);
const imgPending = new Map(), imgFailed = new Map();
export async function personImage(id) {
  const f = imageFile(id);
  if (fs.existsSync(f)) return f;
  const p = personRow(id);
  if (!p?.profile_path || (imgFailed.get(id) || 0) > Date.now() - 3600e3) return null;
  if (!imgPending.has(id)) imgPending.set(id, (async () => {
    try {
      const r = await fetch(`https://image.tmdb.org/t/p/w185${p.profile_path}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 5 << 20) throw new Error('för stor bild');
      fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
    } catch { imgFailed.set(id, Date.now()); if (imgFailed.size > 5000) imgFailed.clear(); }
    finally { imgPending.delete(id); }
  })());
  await imgPending.get(id);
  return fs.existsSync(f) ? f : null;
}

/** Ta bort personer som inte längre finns i någon titel (och deras bilder) */
export function cleanupPeople() {
  const gone = all('SELECT id FROM people WHERE NOT EXISTS(SELECT 1 FROM item_people ip WHERE ip.person_id=people.id)');
  if (!gone.length) return 0;
  tx(() => { for (const p of gone) run('DELETE FROM people WHERE id=?', p.id); });
  for (const p of gone) fs.rm(imageFile(p.id), { force: true }, () => {});
  return gone.length;
}

/**
 * Hämta rollistor i bakgrunden för titlar som saknar dem (titlar från äldre versioner). Begränsat antal per
 * skanning; om TMDB fortsätter svara 429 avbryts det och fortsätter vid nästa skanning.
 * apply(item, d) sparar övrigt ur svaret (t.ex. trailer).
 */
export async function backfill(lib, tmdb, { max = 40, status = null, apply = null } = {}) {
  const todo = all(`SELECT id, kind, tmdb_id FROM items WHERE library_id=? AND kind IN('movie','show') AND tmdb_id IS NOT NULL AND version_of IS NULL
    AND meta_done=1 AND credits_done=0 ORDER BY added DESC LIMIT ?`, lib.id, Math.max(0, max));
  if (!todo.length) { cleanupPeople(); return 0; }
  if (status) { status.phase = 'Hämtar rollistor'; status.done = 0; status.total = todo.length; }
  let n = 0;
  for (const it of todo) {
    if (status) status.done++;
    const tv = it.kind === 'show';
    try {
      const d = await tmdb(tv ? `/tv/${it.tmdb_id}` : `/movie/${it.tmdb_id}`, { append_to_response: tv ? 'aggregate_credits,videos' : 'credits,videos', ...videoLangs() });
      saveCredits(it.id, extractCredits(d, it.kind));
      apply?.(it, d);
      n++;
    } catch (e) {
      if (/429/.test(e.message)) { console.warn('[people] TMDB begränsar anropen – fortsätter vid nästa skanning'); break; }
      if (/404/.test(e.message)) run('UPDATE items SET credits_done=2 WHERE id=?', it.id);
      else console.warn('[people]', e.message);
    }
  }
  cleanupPeople();
  return n;
}
// Trailers på svenska, engelska eller utan språk (annars ger språkinställningen sv-SE oftast inga videor)
export const videoLangs = () => ({ include_video_language: [...new Set([String(getSetting('language', 'sv-SE') || 'sv').split('-')[0].toLowerCase(), 'en'])].join(',') + ',null' });
