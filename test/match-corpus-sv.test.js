// Den svenska korpusen (test/fixtures/match/corpus-sv.js) hela vägen genom skanningen: tomma filer i riktiga mappar,
// scan() per bibliotek och matchning mot låtsas-TMDB:n (test/fixtures/match/tmdb.js + tmdb-sv.js). En fil räknas som rätt
// när filmen/serien fått rätt TMDB-id, avsnittet rätt säsong/avsnitt (och avsnittsnamn när korpusen anger et) och en
// omatchad titel ett snyggt namn i stället för filnamnet. Gränserna får bara höjas. MATCH_VERBOSE=1 skriver ut varje miss.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORPUS_SV } from './fixtures/match/corpus-sv.js';
import { startFakeTmdb } from './fixtures/match/tmdb.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-corpus-sv-'));
const MEDIA = path.join(ROOT, 'media');
const fake = await startFakeTmdb();
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
process.env.CREDITS_PER_SCAN = '0';
process.env.TMDB_API_URL = fake.url;
process.env.TMDB_API_KEY = 'testnyckel';
const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const { searchKey } = await import('../server/searchkey.js');
after(() => { fake.srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// Utgångsläget före förbättringen (samma korpus, samma låtsas-TMDB): 91,0 % rätt (egna fall 41,9 %).
const MIN = 0.97;
const key = (s) => searchKey(s || '');

test('svensk korpus: rätt titel, säsong och avsnitt efter skanningen', { timeout: 600000 }, async () => {
  assert.ok(CORPUS_SV.length >= 300, `korpusen ska ha minst 300 filer (${CORPUS_SV.length})`);
  const libs = new Map();
  for (const e of CORPUS_SV) {
    const k = e.lib + '|' + e.kind;
    if (!libs.has(k)) {
      const dir = path.join(MEDIA, `${e.lib}-${e.kind}`);
      fs.mkdirSync(dir, { recursive: true });
      libs.set(k, { dir, id: Number(D.run('INSERT INTO libraries(name,type,path,anime) VALUES(?,?,?,0)', e.lib, e.kind === 'movie' ? 'movie' : 'show', dir).lastInsertRowid) });
    }
    const f = path.join(libs.get(k).dir, ...e.p.split('/'));
    assert.ok(!fs.existsSync(f), 'samma fil två gånger i korpusen: ' + e.p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    e.file = f;
  }
  for (const l of libs.values()) await sc.scan(l.id);
  const cats = new Map(), miss = [];
  let ok = 0;
  for (const e of CORPUS_SV) {
    const row = D.get('SELECT * FROM items WHERE path=?', e.file);
    let good = false, got = '';
    if (!row) got = 'ingen rad';
    else if (e.kind === 'movie') {
      const main = row.version_of ? D.get('SELECT * FROM items WHERE id=?', row.version_of) : row;
      good = (main.tmdb_id ?? null) === e.id && (e.id != null || key(main.title) === key(e.t));
      got = `tmdb ${main.tmdb_id} "${main.title}"`;
    } else {
      const show = D.get('SELECT * FROM items WHERE id=?', row.parent_id);
      good = (show.tmdb_id ?? null) === e.id && row.season === e.se && row.episode === e.ep && (e.id != null || key(show.title) === key(e.s))
        && (!e.et || row.title === e.et);
      got = `tmdb ${show.tmdb_id} "${show.title}" S${row.season}E${row.episode} "${row.title}"`;
    }
    const c = cats.get(e.cat) || { n: 0, ok: 0 };
    c.n++; if (good) { c.ok++; ok++; } else miss.push(`[${e.cat}] ${e.p} → ${got} (rätt: ${e.id} ${e.kind === 'movie' ? e.t : `${e.s} S${e.se}E${e.ep}${e.et ? ` "${e.et}"` : ''}`})`);
    cats.set(e.cat, c);
  }
  const rate = ok / CORPUS_SV.length;
  console.log(`[svensk korpus] ${CORPUS_SV.length} filer: ${(100 * rate).toFixed(1)} % rätt (${ok}), ${(fake.calls.length / CORPUS_SV.length).toFixed(1)} TMDB-anrop per fil`);
  for (const [c, v] of cats) console.log(`  ${c}: ${(100 * v.ok / v.n).toFixed(1)} % (${v.ok}/${v.n})`);
  if (process.env.MATCH_VERBOSE) for (const m of miss) console.log('  miss: ' + m);
  assert.ok(rate >= MIN, `${(100 * rate).toFixed(1)} % < ${100 * MIN} %\n${miss.join('\n')}`);
});
