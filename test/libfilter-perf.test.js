// Bibliotekets filter på ett syntetiskt bibliotek med 10 000 filmer och 1 000 serier (10 avsnitt var): frågeplanen
// använder indexen (biblioteket via items_lib, versioner/avsnitt via items_version/items_parent_se, framsteg via
// primärnyckeln) och en sida med filter och sortering tar några millisekunder. Gränsen i testet är tilltagen för
// belastade CI-maskiner; uppmätt på utvecklingsmaskinen 10–30 ms per sida via HTTP (mål < 80 ms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-lfperf-'));
process.env.MEDIA_ROOT = path.join(process.env.CONFIG_DIR, 'media');
const { db, all } = await import('../server/db.js');
const lf = await import('../server/libfilter.js');
const { listItems, ageFilter, PROG, FROM, MAIN_ONLY } = await import('../server/http/context.js');

const G = ['Action', 'Drama', 'Komedi', 'Thriller', 'Skräck', 'Science fiction', 'Animerat', 'Dokumentär'];
const L = ['swe', 'eng', 'fre', 'ger', 'jpn'];
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const M = Number(db.prepare(`INSERT INTO libraries(name,type,path) VALUES('Filmer','movie','/x/m')`).run().lastInsertRowid);
const S = Number(db.prepare(`INSERT INTO libraries(name,type,path) VALUES('Serier','show','/x/s')`).run().lastInsertRowid);
const uid = Number(db.prepare(`INSERT INTO users(name,pass,created) VALUES('perf','x',1)`).run().lastInsertRowid);
const ins = db.prepare(`INSERT INTO items(library_id,kind,parent_id,title,sort_title,year,season,episode,duration,rating,age,added,genres,width,height,hdr,streams,path)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const streams = () => JSON.stringify([{ index: 0, type: 'video', codec: 'hevc' }, { index: 1, type: 'audio', codec: 'eac3', lang: pick(L), channels: rnd() < 0.5 ? 6 : 2, ...(rnd() < 0.1 ? { profile: 'Dolby Digital Plus + Dolby Atmos' } : {}) },
  { index: 2, type: 'subtitle', codec: 'subrip', lang: pick(L) }]);
const res = () => pick([[1920, 1080], [3840, 2160], [1280, 720], [720, 576]]);
db.exec('BEGIN');
for (let i = 0; i < 10000; i++) {
  const [w, h] = res();
  ins.run(M, 'movie', null, 'Film ' + i, 'film ' + String(i).padStart(5, '0'), 1950 + Math.floor(rnd() * 75), null, null, 3600 + rnd() * 5000, Math.round(rnd() * 100) / 10,
    pick([0, 7, 11, 15, null]), 1700000000 + i, JSON.stringify([pick(G), pick(G)]), w, h, h >= 2160 && rnd() < 0.5 ? 'dovi' : null, streams(), `/x/m/${i}.mkv`);
}
for (let i = 0; i < 1000; i++) {
  const sid = Number(ins.run(S, 'show', null, 'Serie ' + i, 'serie ' + i, 1990 + (i % 30), null, null, null, 7, 11, 1700000000 + i, JSON.stringify([pick(G)]), null, null, null, null, null).lastInsertRowid);
  for (let e = 0; e < 10; e++) { const [w, h] = res(); ins.run(S, 'episode', sid, 'A' + e, null, null, 1 + (e >> 2), e + 1, 2400, null, null, 1700000000 + i, null, w, h, null, streams(), `/x/s/${i}/${e}.mkv`); }
}
db.exec('COMMIT');
while (lf.refreshFacets(5000));
db.exec('DROP TABLE IF EXISTS sqlite_stat1'); // utan statistik (som direkt efter första skanningen)

const plan = (lib, q) => {
  const qq = lf.query(lib, lf.parse(q, lib.type)), age = ageFilter(uid);
  const sql = `SELECT i.id, ${PROG} ${FROM} LEFT JOIN items s ON s.id=i.parent_id WHERE (${qq.where.join(' AND ')})${MAIN_ONLY}${age.sql} ORDER BY ${qq.order} LIMIT 300`;
  return all('EXPLAIN QUERY PLAN ' + sql, uid, ...qq.params, ...age.params).map(r => r.detail);
};
const ms = (fn) => { const t = []; for (let i = 0; i < 5; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } return t.sort((a, b) => a - b)[2]; };

test('frågeplanen: biblioteket via index, versioner och avsnitt via index, ingen genomsökning av hela items', () => {
  const movies = { id: M, type: 'movie' }, shows = { id: S, type: 'show' };
  const p1 = plan(movies, 'genre=Drama&yearMin=1990&yearMax=1999&res=4k&audio=atmos&alang=sv&sort=rating&order=asc');
  assert.ok(p1.some(d => /SEARCH i USING INDEX items_lib/.test(d)), p1.join('\n'));
  assert.ok(p1.some(d => /SEARCH v USING INDEX items_version/.test(d)), p1.join('\n'));
  assert.ok(!p1.some(d => /^SCAN (i|v|e)\b/.test(d)), p1.join('\n'));
  const p2 = plan(shows, 'res=4k&slang=en&seasonsMin=2&filter=unwatched&sort=lastwatched');
  assert.ok(p2.some(d => /SEARCH i USING INDEX items_lib/.test(d)), p2.join('\n'));
  assert.ok(p2.some(d => /SEARCH e USING (COVERING )?INDEX items_parent_se/.test(d)), p2.join('\n'));
  assert.ok(!p2.some(d => /^SCAN (i|e|q)\b/.test(d)), p2.join('\n'));
});

test('10 000 titlar: en sida med filter och sortering, räkningen och panelens värden går snabbt', () => {
  const movies = { id: M, type: 'movie' }, shows = { id: S, type: 'show' };
  for (const [lib, q] of [[movies, 'genre=Drama,Komedi&yearMin=1980&ratingMin=5&sort=year&order=asc'], [movies, 'res=4k&hdr=dovi&audio=surround&alang=sv,en'],
    [movies, 'sort=random&seed=7'], [movies, 'durMin=90&durMax=130&sort=duration'], [shows, 'res=4k&alang=sv&seasonsMin=2&sort=lastwatched']]) {
    const f = lf.parse(q, lib.type), qq = lf.query(lib, f);
    const t = ms(() => listItems(uid, qq.where.join(' AND '), qq.params, qq.order, 300, 0, { slim: true }));
    const c = ms(() => lf.count(uid, qq.where, qq.params));
    assert.ok(t < 200 && c < 200, `${q}: sida ${t.toFixed(1)} ms, antal ${c.toFixed(1)} ms`);
  }
  lf.clearFacets();
  const t = ms(() => { lf.clearFacets(); lf.facets(uid, movies); });
  assert.ok(t < 400, `facets ${t.toFixed(1)} ms`);
  assert.equal(lf.facets(uid, movies).total, 10000);
});
