// Stora bibliotek: frågorna som mättes med 5 000 filmer, 60 000 avsnitt och 50 000 låtar (se CHANGELOG, Ej utgiven) ska
// fortsätta använda sina index. Testet kör de riktiga funktionerna, fångar SQL-satserna de kör och kontrollerar
// frågeplanerna – med och utan statistik (sqlite_stat1), som direkt efter första skanningen. Ett mindre syntetiskt
// bibliotek räcker för planerna; tidsgränserna är tilltagna för långsamma CI-maskiner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatementSync } from 'node:sqlite';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-large-'));
process.env.MEDIA_ROOT = path.join(process.env.CONFIG_DIR, 'media');
const { db, all, get } = await import('../server/db.js');
const C = await import('../server/http/context.js');
const lf = await import('../server/libfilter.js');
const music = await import('../server/music.js');
const S = await import('../server/search.js');
const colors = await import('../server/imgcolor.js');
const { relOf } = await import('../server/libpaths.js');

// ---------- syntetiskt bibliotek: 3 000 filmer, 300 serier × 20 avsnitt, 6 000 låtar, två profiler ----------
let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const W = ['röd', 'natt', 'stad', 'hjärta', 'skugga', 'vinter', 'sommar', 'resa', 'flod', 'eld', 'ljus', 'kung', 'krig', 'havet', 'dröm', 'sista', 'tyst', 'vild', 'guld', 'vind'];
const G = ['Action', 'Drama', 'Komedi', 'Thriller', 'Skräck', 'Dokumentär'];
const title = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(W)).join(' ');
const lib = (n, t) => Number(db.prepare('INSERT INTO libraries(name,type,path) VALUES(?,?,?)').run(n, t, '/x/' + n).lastInsertRowid);
const LM = lib('Filmer', 'movie'), LS = lib('Serier', 'show'), LMU = lib('Musik', 'music');
const uid = Number(db.prepare(`INSERT INTO users(name,pass,created) VALUES('stor','x',1)`).run().lastInsertRowid);
const kid = Number(db.prepare(`INSERT INTO users(name,pass,created,parent_id,max_age) VALUES('barnet','x',1,?,11)`).run(uid).lastInsertRowid);
const ins = db.prepare(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,year,season,episode,duration,rating,age,added,genres,path,poster,backdrop,thumb,collection_id,streams)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const st = JSON.stringify([{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', lang: 'swe', channels: 2 }]);
const movies = [], shows = [], eps = [];
db.exec('BEGIN');
const cols = Array.from({ length: 60 }, (_, i) => Number(db.prepare('INSERT INTO collections(name) VALUES(?)').run('Samling ' + i).lastInsertRowid));
for (let i = 0; i < 3000; i++) {
  const t = title() + ' ' + i;
  movies.push(Number(ins.run(LM, 'movie', null, t, t, 1950 + (i % 75), null, null, 5400, Math.round(rnd() * 100) / 10, pick([0, 7, 11, 15, null]), 1700000000 + i,
    JSON.stringify([pick(G), pick(G)]), `/x/Filmer/${i}.mkv`, 1, 1, 0, rnd() < 0.1 ? pick(cols) : null, st).lastInsertRowid));
}
for (let s = 0; s < 300; s++) {
  const sid = Number(ins.run(LS, 'show', null, 'Serie ' + title() + ' ' + s, 'serie ' + s, 2000, null, null, null, 7, 11, 1700000000 + s, JSON.stringify([pick(G)]), null, 1, 1, 0, null, null).lastInsertRowid);
  shows.push(sid);
  for (let e = 0; e < 20; e++) eps.push(Number(ins.run(LS, 'episode', sid, 'Avsnitt ' + title(), null, null, 1 + (e >> 3), 1 + (e % 8), 2400, null, null, 1700000000 + s * 100 + e, null, `/x/Serier/${s}/${e}.mkv`, 0, 0, 1, null, st).lastInsertRowid));
}
const art = [], tracks = [];
for (let i = 0; i < 200; i++) art.push(Number(db.prepare('INSERT INTO artists(library_id,name,sort_name) VALUES(?,?,?)').run(LMU, 'Artist ' + i, 'artist ' + i).lastInsertRowid));
for (let a = 0; a < 500; a++) {
  const al = Number(db.prepare('INSERT INTO albums(library_id,artist_id,title,sort_title,year,cover,added) VALUES(?,?,?,?,?,1,?)').run(LMU, art[a % 200], title() + ' ' + a, 'album ' + a, 1990, 1700000000 + a).lastInsertRowid);
  for (let k = 0; k < 12; k++) tracks.push(Number(db.prepare('INSERT INTO tracks(library_id,album_id,artist_id,title,track_no,disc_no,duration,path,added) VALUES(?,?,?,?,?,1,?,?,?)')
    .run(LMU, al, art[(a + k) % 200], title(), k + 1, 200, `/x/Musik/${a}/${k}.flac`, 1700000000 + a).lastInsertRowid));
}
const pr = db.prepare('INSERT OR IGNORE INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)');
for (let i = 0; i < 800; i++) pr.run(uid, pick(movies), i % 20 ? 0 : 1200, 5400, i % 20 ? 1 : 0, 1700000000 + i);
for (let i = 0; i < 1500; i++) pr.run(uid, pick(eps), 0, 2400, 1, 1700000000 + i);
for (let i = 0; i < 2000; i++) db.prepare('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)').run(uid, pick(tracks), 1700000000 + i);
db.exec('COMMIT');
while (lf.refreshFacets(5000));

// ---------- hjälpare ----------
/** De SQL-satser (med parametrar) som fn kör */
function captured(fn) {
  const out = [], orig = {};
  for (const m of ['all', 'get', 'iterate']) {
    orig[m] = StatementSync.prototype[m];
    StatementSync.prototype[m] = function (...a) { out.push([this.sourceSQL, a]); return orig[m].apply(this, a); };
  }
  try { fn(); } finally { for (const m of Object.keys(orig)) StatementSync.prototype[m] = orig[m]; }
  return out;
}
const planOf = (sql, params) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(r => r.detail);
/** Planerna för de satser fn kör som innehåller needle */
const plans = (fn, needle) => captured(fn).filter(([sql]) => sql.includes(needle)).map(([sql, p]) => planOf(sql, p));
const ms = (fn) => { const t = []; for (let i = 0; i < 5; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } return t.sort((a, b) => a - b)[2]; };
// Med statistik (efter PRAGMA optimize) och utan (som när statistiken togs med ett tomt bibliotek)
const states = [['med statistik', () => db.exec('ANALYZE')], ['utan statistik', () => db.exec('DROP TABLE IF EXISTS sqlite_stat1')]];

test('listorna (listItems) använder bibliotekets index – inte sökningens eller betygets', () => {
  for (const [label, prep] of states) {
    prep();
    const cases = [
      ['Nytt i (tillagda)', () => C.listItems(uid, 'i.library_id=? AND i.kind=?', [LM, 'movie'], 'i.added DESC', 24), /SEARCH i USING (COVERING )?INDEX items_lib_added/],
      ['nya avsnitt per säsong', () => C.listItems(uid, `i.library_id=? AND i.kind='episode'`, [LS], 'i.added DESC, i.season DESC, i.episode DESC', 400, 0, { slim: true }), /SEARCH i USING (COVERING )?INDEX items_lib_added/],
      ['titelordning', () => C.listItems(uid, 'i.library_id=? AND i.kind=?', [LM, 'movie'], 'i.sort_title', 300, 0, { slim: true }), /SEARCH i USING (COVERING )?INDEX items_lib_sort/],
      ['seriens avsnitt', () => C.listItems(uid, 'i.parent_id=?', [shows[3]], 'i.season, i.episode', 5000), /SEARCH i USING (COVERING )?INDEX items_parent/],
    ];
    for (const [name, fn, want] of cases) {
      for (const p of plans(fn, 'FROM items i JOIN (SELECT ? AS uid)')) {
        assert.ok(p.some(d => want.test(d)), `${label}, ${name}:\n${p.join('\n')}`);
        assert.ok(!p.some(d => /items_search|items_kind_rating|items_color_todo/.test(d)), `${label}, ${name}:\n${p.join('\n')}`);
      }
    }
  }
});

test('sökningen läser sitt delindex, liknande titlar betygsindexet', () => {
  for (const [label, prep] of states) {
    prep();
    for (const kinds of [['movie', 'show'], ['episode']]) {
      const p = plans(() => S.searchItemIds(S.parseQuery('natt stad'), kinds, C.ageFilter(uid), 60), 'instr(i.skeyc');
      assert.ok(p.length && p.every(x => x.some(d => /SEARCH i USING INDEX items_search \(kind=\? AND version_of=\?\)/.test(d))), `${label} ${kinds}:\n${p.flat().join('\n')}`);
    }
    // Barnprofilen (åldersgränsen i SQL) likadant
    const pk = plans(() => S.searchItemIds(S.parseQuery('hjärta'), ['movie', 'show'], C.ageFilter(kid), 60), 'instr(i.skeyc');
    assert.ok(pk.every(x => x.some(d => /items_search/.test(d))), pk.flat().join('\n'));
    const it = get('SELECT * FROM items WHERE id=?', movies[5]);
    const ps = plans(() => C.similarTo(uid, it, 12), 'ORDER BY i.rating DESC LIMIT 2000');
    assert.ok(ps.length && ps[0].some(d => /SEARCH i USING (COVERING )?INDEX items_kind_rating/.test(d)) && !ps[0].some(d => /TEMP B-TREE/.test(d)), `${label}:\n${ps.flat().join('\n')}`);
  }
  // Rätt träffar: ordet finns i titeln
  const ids = S.searchItemIds(S.parseQuery('natt'), ['movie', 'show'], C.ageFilter(uid), 60).map(r => r.id);
  assert.ok(ids.length > 10);
  for (const id of ids.slice(0, 10)) assert.match(get('SELECT title FROM items WHERE id=?', id).title, /natt/i);
  assert.ok(ms(() => S.searchItemIds(S.parseQuery('stad'), ['movie', 'show'], C.ageFilter(uid), 60)) < 100);
});

test('musiken: artistens populära låtar och albumlistan via index', () => {
  for (const [label, prep] of states) {
    prep();
    const p = plans(() => music.artist(art[7], uid), 'track_plays p WHERE p.track_id=t.id');
    assert.ok(p.length && !p[0].some(d => /^SCAN t\b/.test(d)), `${label}:\n${p.flat().join('\n')}`);
    const pa = plans(() => music.albums(LMU, 'title'), 'FROM albums al');
    assert.ok(pa.length && pa[0].filter(d => /SEARCH t USING COVERING INDEX tracks_album_dur/.test(d)).length === 2, `${label}:\n${pa.flat().join('\n')}`);
  }
  // Samma låtar som förut: artistens egna och spåren på artistens album, mest spelade först
  const a = art[7], want = new Set(all('SELECT t.id FROM tracks t LEFT JOIN albums al ON al.id=t.album_id WHERE t.artist_id=? OR al.artist_id=?', a, a).map(r => r.id));
  const got = music.artist(a, uid).popular;
  assert.equal(got.length, Math.min(10, want.size));
  for (const t of got) assert.ok(want.has(t.id));
  const n = (id) => get('SELECT COUNT(*) AS n FROM track_plays WHERE track_id=?', id).n;
  for (let i = 1; i < got.length; i++) assert.ok(n(got[i - 1].id) >= n(got[i].id));
  const al = music.albums(LMU, 'title').find(x => x.tracks);
  assert.equal(al.tracks, 12); assert.equal(al.duration, 2400);
});

test('bakgrundsjobben hittar nästa omgång via delindex (inte genom att gå igenom hela items)', () => {
  for (const [label, prep] of states) {
    prep();
    const pc = planOf(colors.TODO_SQL, [40]);
    assert.ok(pc.some(d => /SCAN items USING INDEX items_color_todo/.test(d)) && !pc.some(d => /TEMP B-TREE/.test(d)), `${label}:\n${pc.join('\n')}`);
    db.exec(`UPDATE items SET f_v=NULL WHERE id IN (${eps.slice(-5).join(',')})`);
    const pf = plans(() => lf.refreshFacets(200), 'f_v IS NULL');
    assert.ok(pf.length && pf.every(x => x.some(d => /items_fv_todo/.test(d))), `${label}:\n${pf.flat().join('\n')}`);
    assert.equal(get('SELECT COUNT(*) AS n FROM items WHERE f_v IS NULL AND path IS NOT NULL').n, 0);
  }
  assert.equal(get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='items_facets_todo'").n, 0, 'det gamla indexet tas bort');
  assert.equal(get('PRAGMA user_version').user_version >= 8, true);
});

test('kontrollen efter skanning skriver bara ändrade fil-egenskaper', () => {
  const ch = () => get('SELECT total_changes() AS n').n;
  // Ett felaktigt värde (som om en svensk undertextfil tagits bort) rättas, allt annat lämnas orört
  db.prepare("UPDATE items SET f_alang=',xx,' WHERE id=?").run(movies[9]);
  const before = ch();
  lf.afterScan();
  let n = 0, k; while ((k = lf.recheckFacets(500))) n += k;
  assert.equal(n, get('SELECT COUNT(*) AS n FROM items WHERE path IS NOT NULL').n);
  assert.equal(ch() - before, 1, 'bara den ändrade raden skrivs');
  assert.equal(get('SELECT f_alang FROM items WHERE id=?', movies[9]).f_alang, ',sv,');
  assert.equal(lf.recheckFacets(500), 0);
});

test('relOf: resten av sökvägen under biblioteksmappen, annars som path.relative', () => {
  const r = ['/m/Filmer', '/m/Film2'];
  assert.equal(relOf(r, '/m/Filmer/A (2001)/a.mkv'), path.join('A (2001)', 'a.mkv'));
  assert.equal(relOf(r, '/m/Film2/b.mkv'), 'b.mkv');
  assert.equal(relOf(r, '/m/Filmerna/c.mkv'), path.relative('/m/Filmer', '/m/Filmerna/c.mkv'));
});
