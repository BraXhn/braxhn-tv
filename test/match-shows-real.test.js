// Supportärende #3: "The Big Bang Theory" matchades som en koreansk serie och "Top Gear" matchades fel om och om igen.
// Vanliga mappnamn för serier som har samma eller nästan samma titel som andra serier hos TMDB, hela vägen genom
// skanningen mot låtsas-TMDB:n med riktiga TMDB-id (test/fixtures/match/tmdb-real.js). Dessutom: en ny skanning byter
// inte en riktig träff, en manuell matchning ("Fel titel?") rörs aldrig, och en tidigare felmatchning rättas.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeTmdb } from './fixtures/match/tmdb.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-shows-real-'));
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
after(() => { fake.srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const touch = (dir, rel) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
let n = 0;
/** Ett eget seriebibliotek med filerna (så att olika mappnamn för samma serie inte slås ihop) */
async function library(files) {
  const dir = path.join(MEDIA, `lib${++n}`);
  for (const f of files) touch(dir, f);
  const id = Number(D.run('INSERT INTO libraries(name,type,path,anime) VALUES(?,?,?,0)', `Serier ${n}`, 'show', dir).lastInsertRowid);
  await sc.scan(id);
  return { id, dir };
}
const shows = (lib) => D.all(`SELECT * FROM items WHERE library_id=? AND kind='show'`, lib.id);
// Säsonger och avsnitt som en vanlig samling: några avsnitt i några säsonger
const eps = (folder, name, seasons, per = 2) => seasons.flatMap(s => Array.from({ length: per }, (_, i) =>
  `${folder}/Season ${s}/${name}.S${String(s).padStart(2, '0')}E${String(i + 1).padStart(2, '0')}.mkv`));

const BBT = 1418, TG = 45, TG_US = 7038, TG_AU = 7636;
const CASES = [
  ['The Big Bang Theory', eps('The Big Bang Theory', 'The.Big.Bang.Theory', [1, 5, 12]), BBT],
  ['Big Bang Theory', eps('Big Bang Theory', 'Big.Bang.Theory', [2, 3]), BBT],
  ['The Big Bang Theory (2007)', eps('The Big Bang Theory (2007)', 'The Big Bang Theory', [3]), BBT],
  ['bigbang theory', eps('bigbang theory', 'bigbang theory', [1, 2]), BBT],
  ['Bigbang Theory (bara en säsong)', eps('Bigbang Theory', 'Bigbang.Theory', [1]), BBT],
  ['The-Big-Bang-Theory', eps('The-Big-Bang-Theory', 'The-Big-Bang-Theory', [4]), BBT],
  ['Top Gear', eps('Top Gear', 'Top.Gear', [20, 22]), TG],
  ['Top Gear (bara säsong 1)', eps('Top Gear', 'Top.Gear', [1]), TG],
  ['Top Gear (2002)', eps('Top Gear (2002)', 'Top Gear', [5]), TG],
  ['Top Gear (UK)', eps('Top Gear (UK)', 'Top.Gear.UK', [10, 11]), TG],
  ['Top Gear UK', eps('Top Gear UK', 'Top.Gear.UK', [3]), TG],
  ['Top Gear (US)', eps('Top Gear (US)', 'Top.Gear.US', [2]), TG_US],
  ['Top Gear USA', eps('Top Gear USA', 'Top.Gear.USA', [1]), TG_US],
  ['Top Gear Australia', eps('Top Gear Australia', 'Top.Gear.Australia', [1]), TG_AU],
  ['The Office (US)', eps('The Office (US)', 'The.Office.US', [3]), 2316],
  ['The Office (UK)', eps('The Office (UK)', 'The.Office.UK', [1]), 2996],
  ['Doctor Who (2005)', eps('Doctor Who (2005)', 'Doctor.Who.2005', [1, 4]), 57243],
  ['House of Cards (2013)', eps('House of Cards (2013)', 'House.of.Cards.2013', [1]), 1425],
  ['House of Cards (1990)', eps('House of Cards (1990)', 'House of Cards', [1]), 21720],
  ['Shameless (US)', eps('Shameless (US)', 'Shameless.US', [1, 9]), 34307],
  ['Shameless (UK)', eps('Shameless (UK)', 'Shameless.UK', [1]), 1906],
  ['Skam', ['Skam/Säsong 1/Skam S01E01.mkv', 'Skam/Säsong 3/Skam S03E02.mkv'], 65320],
];

test('vanliga mappnamn matchas till rätt serie', { timeout: 120000 }, async () => {
  const miss = [];
  for (const [name, files, want] of CASES) {
    const lib = await library(files);
    const s = shows(lib);
    const got = s.map(x => x.tmdb_id);
    if (s.length !== 1 || got[0] !== want) miss.push(`${name}: ${JSON.stringify(got)} (rätt: ${want})`);
  }
  assert.deepEqual(miss, []);
});

// Som en äldre version: serien matchades fel och fick den felaktiga seriens titel och år från TMDB
const WRONG = [
  ['The Big Bang Theory', eps('The Big Bang Theory', 'The.Big.Bang.Theory', [1, 5, 12]), 287649, 'BIGBANG: The Beginning', 2006, BBT],
  ['Top Gear (som 1978 års)', eps('Top Gear', 'Top.Gear', [20, 22]), 4498, 'Top Gear', 1978, TG],
  ['Top Gear (som den amerikanska)', eps('Top Gear', 'Top.Gear', [1, 9]), TG_US, 'Top Gear', 2010, TG],
  ['Top Gear (som Top Gear Korea)', eps('Top Gear', 'Top.Gear', [1]), 43176, 'Top Gear Korea', 2011, TG],
];
const setWrong = (id, tmdb, title, year) => D.run(`UPDATE items SET tmdb_id=?, title=?, sort_title=?, year=?, meta_done=1, match_score=NULL,
  match_unsure=0, match_locked=0 WHERE id=?`, tmdb, title, title.toLowerCase(), year, id);

test('en tidigare felmatchning rättas när serien matchas igen: TMDB:s titel och år räknas inte som ledtrådar', { timeout: 120000 }, async () => {
  const miss = [];
  for (const [name, files, wrong, title, year, want] of WRONG) {
    const lib = await library(files);
    const [s] = shows(lib);
    setWrong(s.id, wrong, title, year);
    D.run('UPDATE items SET meta_done=0 WHERE id=?', s.id);
    await sc.scan(lib.id);
    const got = D.get('SELECT tmdb_id FROM items WHERE id=?', s.id).tmdb_id;
    if (got !== want) miss.push(`${name}: ${got} (rätt: ${want})`);
  }
  assert.deepEqual(miss, []);
  // Säsong 1–2 finns i både den brittiska och den amerikanska: träffen behålls men visas under Osäkra matchningar med
  // den brittiska som förslag (administratören väljer; ett byte fram och tillbaka vid varje skanning vore värre)
  const lib = await library(eps('Top Gear', 'Top.Gear', [1, 2]));
  const [s] = shows(lib);
  setWrong(s.id, TG_US, 'Top Gear', 2010);
  D.run('UPDATE items SET meta_done=0 WHERE id=?', s.id);
  await sc.scan(lib.id);
  const r = D.get('SELECT tmdb_id, match_unsure, match_cands FROM items WHERE id=?', s.id);
  assert.equal(r.tmdb_id, TG_US); assert.equal(r.match_unsure, 1);
  assert.equal(JSON.parse(r.match_cands)[0].id, TG);
});

test('omskanning byter inte träff; en manuell matchning ändras aldrig, inte ens av en skanning som redan pågick', { timeout: 120000 }, async () => {
  const lib = await library(eps('Top Gear', 'Top.Gear', [1, 2]));
  const [s] = shows(lib);
  assert.equal(s.tmdb_id, TG);
  // Nya avsnitt (serien matchas om) och fler skanningar: samma träff
  for (const sn of [3, 4]) {
    touch(lib.dir, `Top Gear/Season ${sn}/Top.Gear.S0${sn}E01.mkv`);
    await sc.scan(lib.id);
    assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', s.id).tmdb_id, TG, `efter säsong ${sn}`);
  }
  // "Fel titel?": administratören väljer den amerikanska (som routes/library.js: hämta, sedan lås)
  const stale = D.get('SELECT * FROM items WHERE id=?', s.id); // raden som en pågående skanning redan läst
  assert.ok(await sc.refreshItem(D.get('SELECT * FROM items WHERE id=?', s.id), TG_US));
  D.run('UPDATE items SET match_locked=1, match_unsure=0, match_cands=NULL WHERE id=?', s.id);
  // Den pågående skanningen kommer fram till serien med sin gamla rad: valet ska stå kvar
  D.run('UPDATE items SET meta_done=0 WHERE id=?', s.id);
  await sc.refreshItem(stale, stale.match_locked ? stale.tmdb_id : null);
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', s.id).tmdb_id, TG_US, 'gammal rad från en pågående skanning');
  touch(lib.dir, 'Top Gear/Season 5/Top.Gear.S05E01.mkv');
  D.run('UPDATE items SET meta_done=0 WHERE id=?', s.id);
  await sc.scan(lib.id);
  const r = D.get('SELECT tmdb_id, match_locked FROM items WHERE id=?', s.id);
  assert.deepEqual({ ...r }, { tmdb_id: TG_US, match_locked: 1 });
});

test('efter uppdateringen matchas automatiskt matchade serier om en gång – låsta rörs inte', { timeout: 120000 }, async () => {
  const a = await library(eps('The Big Bang Theory', 'The.Big.Bang.Theory', [1, 12]));
  const b = await library(eps('Top Gear', 'Top.Gear', [20]));
  const [sa] = shows(a), [sb] = shows(b);
  setWrong(sa.id, 287649, 'BIGBANG: The Beginning', 2006);
  setWrong(sb.id, 4498, 'Top Gear', 1978);
  D.run('UPDATE items SET match_locked=1 WHERE id=?', sb.id); // valt för hand: står kvar
  const before = fake.calls.length;
  await sc.scan(a.id); await sc.scan(b.id);
  assert.equal(fake.calls.length, before, 'redan matchade: ingen sökning förrän engångsförsöket');
  D.setSetting('match_v5', '0');
  await sc.scan(a.id); await sc.scan(b.id);
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', sa.id).tmdb_id, BBT);
  assert.equal(D.get('SELECT tmdb_id FROM items WHERE id=?', sb.id).tmdb_id, 4498);
  assert.equal(D.getSetting('match_v5'), '1');
});
