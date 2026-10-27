// Träffsäkerheten för matchningen mäts på en korpus av riktiga namngivningar (test/fixtures/match/corpus.js):
// tolkning av titel/år/säsong/avsnitt (server/parse.js) och rätt TMDB-träff hela vägen genom refreshItem
// mot en låtsas-TMDB som svarar som TMDB (test/fixtures/match/tmdb.js). Gränserna får bara höjas.
// MATCH_VERBOSE=1 skriver ut varje miss.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORPUS } from './fixtures/match/corpus.js';
import { startFakeTmdb } from './fixtures/match/tmdb.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-corpus-'));
const fake = await startFakeTmdb();
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.TMDB_API_URL = fake.url;
process.env.TMDB_API_KEY = 'testnyckel';
process.env.CREDITS_PER_SCAN = '0';
const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const { searchKey } = await import('../server/searchkey.js');
after(() => fake.srv.close());

// Gränser (andel rätt). Utgångsläget före förbättringen: titel 91,2 %, år 98,9 %, säsong 96,8 %, avsnitt 97,9 %, TMDB 88,5 %.
const MIN = { title: 0.97, year: 0.98, season: 0.98, episode: 0.98, tmdb: 0.95 };
const MEDIA = '/media';
const libs = new Map();
const libFor = (name, type) => {
  const k = name + type;
  if (!libs.has(k)) libs.set(k, Number(D.run('INSERT INTO libraries(name,type,path,anime) VALUES(?,?,?,?)', name, type, path.join(MEDIA, name + '-' + type), name === 'Anime' ? 1 : 0).lastInsertRowid));
  return { id: libs.get(k), root: path.join(MEDIA, name + '-' + type) };
};
const key = (s) => searchKey(s || '');
const native = (p) => p.split('/').join(path.sep);

const results = [];
test('korpus: tolkning av filnamn', () => {
  for (const e of CORPUS) {
    if (e.kind === 'movie') {
      const p = sc.parseMovie(path.join(MEDIA, e.lib, native(e.p)));
      results.push({ e, p, title: key(p.title) === key(e.t), year: (p.year ?? null) === e.y, season: true, episode: true });
    } else {
      const p = sc.parseEpisode(native(e.p));
      const season = e.date ? p?.date === e.date : p?.season === e.se;
      results.push({ e, p, title: !!p && key(p.show) === key(e.s), year: !!p && (p.year ?? p.yearHint ?? null) === e.y,
        season, episode: e.date ? season : !!p && (p.episode ?? null) === e.ep });
    }
  }
  const n = results.length;
  const rate = (k) => results.filter(r => r[k]).length / n;
  const miss = (k) => results.filter(r => !r[k]).map(r => `${r.e.p} → ${JSON.stringify(r.p)}`);
  console.log(`[korpus] ${n} filer: titel ${(100 * rate('title')).toFixed(1)} %, år ${(100 * rate('year')).toFixed(1)} %, säsong ${(100 * rate('season')).toFixed(1)} %, avsnitt ${(100 * rate('episode')).toFixed(1)} %`);
  if (process.env.MATCH_VERBOSE) for (const k of ['title', 'year', 'season', 'episode']) for (const m of miss(k)) console.log(`  ${k}: ${m}`);
  assert.ok(n >= 300, 'korpusen ska ha minst 300 filer');
  for (const k of ['title', 'year', 'season', 'episode']) assert.ok(rate(k) >= MIN[k], `${k}: ${(100 * rate(k)).toFixed(1)} % < ${100 * MIN[k]} %\n${miss(k).join('\n')}`);
});

test('korpus: rätt TMDB-träff genom refreshItem', async () => {
  let ok = 0, calls = 0;
  const miss = [];
  for (const r of results) {
    const { e, p } = r;
    const lib = libFor(e.lib, e.kind);
    const file = path.join(lib.root, native(e.p));
    let id;
    if (e.kind === 'movie') {
      id = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,year,path,duration,added) VALUES(?,?,?,?,?,?,?,0)`,
        lib.id, 'movie', p.title, p.title.toLowerCase(), p.year, file, e.dur ? e.dur * 60 : null).lastInsertRowid);
    } else if (p) {
      id = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,year,src_name,added) VALUES(?,?,?,?,?,?,0)`,
        lib.id, 'show', p.show, p.show.toLowerCase(), p.year, sc.showKey(p.show, p.year)).lastInsertRowid);
      D.run(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,season,episode,abs_episode,ep_guess,path,added) VALUES(?,?,?,?,?,?,?,?,?,?,0)`,
        lib.id, 'episode', id, 'x', 'x', p.season, p.episode ?? 1, p.absolute ? p.episode : null, p.episode == null ? 1 : 0, file);
    }
    const before = fake.calls.length;
    if (id) await sc.refreshItem(D.get('SELECT * FROM items WHERE id=?', id));
    calls += fake.calls.length - before;
    const got = id ? D.get('SELECT tmdb_id FROM items WHERE id=?', id).tmdb_id ?? null : null;
    if (got === e.id) ok++; else miss.push(`${e.p} → ${got} (rätt: ${e.id})`);
  }
  const rate = ok / results.length;
  console.log(`[korpus] rätt TMDB-träff ${(100 * rate).toFixed(1)} % (${ok}/${results.length}), ${(calls / results.length).toFixed(1)} TMDB-anrop per titel`);
  if (process.env.MATCH_VERBOSE) for (const m of miss) console.log('  tmdb: ' + m);
  assert.ok(rate >= MIN.tmdb, `TMDB: ${(100 * rate).toFixed(1)} % < ${100 * MIN.tmdb} %\n${miss.join('\n')}`);
});
