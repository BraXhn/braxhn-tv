// Matchning mot TMDB (server/match.js) och tolkning av filnamn med kvalitetsord
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-match-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const m = await import('../server/match.js');
const sc = await import('../server/scanner.js');

// En liten låtsas-TMDB: söker som TMDB (alla ord i frågan ska finnas i titeln) och filtrerar på år
const DB = [
  { id: 12444, title: 'Harry Potter och dödsrelikerna – del 1', original_title: 'Harry Potter and the Deathly Hallows: Part 1', release_date: '2010-11-17', popularity: 90 },
  { id: 12445, title: 'Harry Potter och dödsrelikerna – del 2', original_title: 'Harry Potter and the Deathly Hallows: Part 2', release_date: '2011-07-12', popularity: 95 },
  { id: 27205, title: 'Inception', original_title: 'Inception', release_date: '2010-07-15', popularity: 80 },
  { id: 1366, title: 'Rocky', original_title: 'Rocky', release_date: '1976-11-21', popularity: 40 },
  { id: 1367, title: 'Rocky II', original_title: 'Rocky II', release_date: '1979-06-15', popularity: 30 },
  { id: 15472, title: 'Män som hatar kvinnor', original_title: 'Män som hatar kvinnor', release_date: '2009-02-27', popularity: 20 },
  { id: 14160, title: 'Upp', original_title: 'Up', release_date: '2009-05-28', popularity: 70 },
  { id: 22947, title: 'Up in the Air', original_title: 'Up in the Air', release_date: '2009-09-05', popularity: 30 },
];
const calls = [];
const search = async (q, year) => {
  calls.push([q, year]);
  const qt = m.tokens(q).filter(t => !['och', 'and', 'the'].includes(t));
  return DB.filter(r => (!year || r.release_date.startsWith(String(year))) &&
    qt.every(t => [...m.tokens(r.title), ...m.tokens(r.original_title)].includes(t)));
};
const best = async (title, year) => (await m.findBest(search, title, year))?.id ?? null;

test('matchning: titel på två språk, nummer i stället för "del", ord för mycket, kvalitetsord', async () => {
  assert.equal(await best('Harry Potter och Dödsrelikerna 01', 2010), 12444);
  assert.equal(await best('Harry Potter och Dödsrelikerna 02', 2011), 12445);
  assert.equal(await best('Harry Potter och Dödsrelikerna - Harry Potter and the Deathly Hallows Part 1', 2010), 12444);
  assert.equal(await best('Harry Potter och Dödsrelikerna Del 2', null), 12445);
  assert.equal(await best('Inception 1080p BluRay x264', 2010), 27205);
  assert.equal(await best('Inception Directors Cut', 2010), 27205);
  assert.equal(await best('Män som hatar kvinnor (The Girl with the Dragon Tattoo)', 2009), 15472);
  assert.equal(await best('Inception', 2011), 27205, 'årtal som skiljer ett år');
});

test('matchning: väljer hellre ingen än fel film', async () => {
  assert.equal(await best('Rocky II', 1979), 1367);
  assert.equal(await best('Rocky III', 1982), null, 'inte Rocky eller Rocky II');
  assert.equal(await best('Up in the Air', 2009), 22947);
  assert.equal(await best('Helt Okänd Film', 2015), null);
});

test('likhet: nummer avgör delar, romerska siffror och nollor', () => {
  assert.ok(m.similarity('Dödsrelikerna 01', 'Dödsrelikerna del 1') > 0.95);
  assert.ok(m.similarity('Dödsrelikerna 01', 'Dödsrelikerna del 2') < 0.4);
  assert.ok(m.similarity('Rocky 2', 'Rocky II') > 0.95);
  assert.ok(m.similarity('Rocky II', 'Rocky') < m.GOOD);
  assert.ok(m.similarity('Kill Bill Vol 1', 'Kill Bill: Vol. 1') > 0.95);
  assert.equal(m.variants('Film 2160p WEB-DL x265 HDR10')[0], 'Film');
});

test('filnamn: kvalitetsord före årtalet och utan årtal hör inte till titeln', () => {
  assert.deepEqual(sc.parseMovie('/m/Inception.1080p.2010.mkv'), { title: 'Inception', year: 2010 });
  assert.deepEqual(sc.parseMovie('/m/Arrival.2016.1080p.BluRay.x264.mkv'), { title: 'Arrival', year: 2016 });
  assert.deepEqual(sc.parseMovie('/m/Charlottes.Web.2006.mkv'), { title: 'Charlottes Web', year: 2006 });
  assert.deepEqual(sc.parseMovie('/m/Web.of.Lies.1080p.mkv'), { title: 'Web of Lies', year: null });
  assert.deepEqual(sc.parseMovie('/m/Blade Runner 2049 (2017).mkv'), { title: 'Blade Runner 2049', year: 2017 });
});

test('dubbletter: filer som matchats till samma TMDB-film blir versioner av en film', async () => {
  const D = await import('../server/db.js');
  const ver = await import('../server/versions.js');
  const lib = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Dubbletter','movie','/m')").lastInsertRowid);
  const add = (p, tmdb, year) => Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,year,path,tmdb_id,meta_done,added) VALUES(?,?,?,?,?,?,?,1,0)`,
    lib, 'movie', 'x', 'x', year, p, tmdb, ).lastInsertRowid);
  const a = add('/m/Inception (2010)/Inception (2010).mkv', 27205, 2010);
  const b = add('/m/Inception.1080p.mkv', 27205, 2010);              // utan årtal i filnamnet
  const c = add('/m/Inception - Svensk titel (2010).mkv', 27205, 2010); // annan titel i filnamnet
  const wrong = add('/m/Annan film (1999).mkv', 27205, 2010);          // gammal felmatchning: årtalet stämmer inte
  ver.groupVersions({ id: lib, name: 'Dubbletter', type: 'movie' }, sc.parseMovie);
  const vo = (id) => D.get('SELECT version_of FROM items WHERE id=?', id).version_of;
  assert.equal(vo(a), null, 'den äldsta blir huvudrad');
  assert.equal(vo(b), a); assert.equal(vo(c), a);
  assert.equal(vo(wrong), null, 'slås inte ihop när årtalet inte stämmer');
});
