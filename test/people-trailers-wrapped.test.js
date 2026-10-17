// Rollista/personer, trailers och årssammanfattning – testas direkt mot modulerna (TMDB mockas)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-ppl-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const { get, all, run, setSetting, IMAGES } = await import('../server/db.js');
await import('../server/activity.js');   // plays
await import('../server/audiobooks.js'); // books, book_progress
const people = await import('../server/people.js');
const trailers = await import('../server/trailers.js');
const wrapped = await import('../server/wrapped.js');
const scanner = await import('../server/scanner.js');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const lib = Number(run(`INSERT INTO libraries(name,type,path) VALUES('Filmer','movie','/x')`).lastInsertRowid);
const showLib = Number(run(`INSERT INTO libraries(name,type,path) VALUES('Serier','show','/y')`).lastInsertRowid);
const item = (kind, title, extra = {}) => {
  const cols = { library_id: kind === 'movie' ? lib : showLib, kind, title, added: 0, ...extra };
  return Number(run(`INSERT INTO items(${Object.keys(cols).join(',')}) VALUES(${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid);
};

// ---- TMDB-mock ----
const realFetch = globalThis.fetch;
let calls = [];
function mockTmdb(handler) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    const r = handler(u);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const restore = () => { globalThis.fetch = realFetch; };

const MOVIE = {
  id: 603, title: 'Matrix', release_date: '1999-03-31', overview: 'Neo', vote_average: 8, genres: [{ name: 'Action' }],
  credits: {
    cast: Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i, name: `Skådis ${i}`, character: `Roll ${i}`, order: 29 - i, profile_path: i === 29 ? '/a.jpg' : null })),
    crew: [{ id: 2000, name: 'Lana', job: 'Director' }, { id: 2001, name: 'Joel', job: 'Producer' }, { id: 2000, name: 'Lana', job: 'Director' }]
  },
  videos: { results: [{ site: 'YouTube', type: 'Teaser', key: 'teaser12345', official: true }, { site: 'Vimeo', type: 'Trailer', key: 'x' },
    { site: 'YouTube', type: 'Trailer', key: 'trailer1234', official: true }, { site: 'YouTube', type: 'Trailer', key: 'bad key!' }] }
};

test('extractCredits: högst 20 i rollistan, sorterat på ordning, regissör utan dubbletter', () => {
  const l = people.extractCredits(MOVIE, 'movie');
  const cast = l.filter(p => p.role === 'cast');
  assert.equal(cast.length, people.MAX_CAST);
  assert.equal(cast[0].name, 'Skådis 29'); // order 0
  assert.equal(cast[0].profile_path, '/a.jpg');
  assert.deepEqual(l.filter(p => p.role === 'director').map(p => p.name), ['Lana']);
  // serie: aggregate_credits med roller, skapare
  const s = people.extractCredits({ created_by: [{ id: 5, name: 'Skaparen' }],
    aggregate_credits: { cast: [{ id: 7, name: 'Ann', order: 0, roles: [{ character: 'Liten roll', episode_count: 1 }, { character: 'Huvudroll', episode_count: 9 }] }] } }, 'show');
  assert.equal(s.find(p => p.role === 'cast').character, 'Huvudroll');
  assert.equal(s.find(p => p.role === 'creator').name, 'Skaparen');
  // ogiltiga poster och bildsökvägar ignoreras
  const bad = people.extractCredits({ credits: { cast: [{ id: 'x', name: 'A' }, { id: 9, name: '' }, { id: 10, name: 'B', profile_path: '../../etc' }] } }, 'movie');
  assert.deepEqual(bad.map(p => [p.id, p.profile_path]), [[10, null]]);
});

test('pickYoutube: officiell trailer före teaser, bara giltiga YouTube-nycklar', () => {
  assert.equal(trailers.pickYoutube(MOVIE.videos), 'trailer1234');
  assert.equal(trailers.pickYoutube({ results: [{ site: 'YouTube', type: 'Featurette', key: 'abcdefgh' }] }), null);
  assert.equal(trailers.pickYoutube(null), null);
  assert.equal(trailers.youtubeOk('abc"><script'), false);
});

test('refreshItem sparar rollista och YouTube-trailer från samma anrop', async () => {
  setSetting('tmdb_key', 'testnyckel');
  const id = item('movie', 'Matrix', { year: 1999 });
  mockTmdb((u) => {
    if (u.hostname === 'image.tmdb.org') return new Response('nej', { status: 404 });
    if (u.pathname === '/3/search/movie') return { results: [{ id: 603, title: 'Matrix', original_title: 'The Matrix', release_date: '1999-03-30' }] };
    if (u.pathname === '/3/movie/603') return MOVIE;
    return new Response('{}', { status: 404 });
  });
  try { assert.equal(await scanner.refreshItem(get('SELECT * FROM items WHERE id=?', id)), true); } finally { restore(); }
  const d = calls.find(c => c.startsWith('/3/movie/603'));
  assert.match(decodeURIComponent(d), /append_to_response=release_dates,credits,videos/);
  assert.match(decodeURIComponent(d), /include_video_language=sv,en,null/);
  const row = get('SELECT credits_done, trailer_yt FROM items WHERE id=?', id);
  assert.deepEqual({ ...row }, { credits_done: 1, trailer_yt: 'trailer1234' });
  const cast = people.castOf(id);
  assert.equal(cast.length, 21);
  assert.equal(cast[0].role, 'director');
  assert.equal(cast[1].name, 'Skådis 29');
  assert.equal(cast[1].character, 'Roll 29');
  assert.equal(cast[1].image, true);
  // ny hämtning ersätter rollistan
  people.saveCredits(id, [{ id: 1000, name: 'Skådis 0', role: 'cast', character: null, ord: 0 }]);
  assert.equal(people.castOf(id).length, 1);
  people.saveCredits(id, people.extractCredits(MOVIE, 'movie'));
});

test('sökning på personer respekterar åldersgränsen', () => {
  const kid = item('movie', 'Barnfilm', { age: 7 });
  const adult = item('movie', 'Vuxenfilm', { age: 15 });
  people.saveCredits(kid, [{ id: 3000, name: 'Greta Glad', role: 'cast', character: 'Pippi', ord: 0 }]);
  people.saveCredits(adult, [{ id: 3001, name: 'Greta Grym', role: 'cast', character: 'Skurk', ord: 0 },
    { id: 3000, name: 'Greta Glad', role: 'cast', character: 'Mamma', ord: 1 }]);
  const none = { sql: '', params: [] }, seven = { sql: ' AND COALESCE(i.age, s.age, ?) <= ?', params: [999, 7] };
  assert.deepEqual(people.searchPeople('greta', none).map(p => [p.name, p.titles]), [['Greta Glad', 2], ['Greta Grym', 1]]);
  assert.deepEqual(people.searchPeople('greta', seven).map(p => [p.name, p.titles]), [['Greta Glad', 1]]);
  // LIKE-tecken i sökningen tolkas bokstavligt
  assert.deepEqual(people.searchPeople('%', none), []);
  const roles = people.rolesOf(3000);
  assert.equal(roles.get(adult)[0].character, 'Mamma');
});

test('personsida: biografi hämtas en gång och cachas, svensk text i första hand', async () => {
  let n = 0;
  mockTmdb((u) => {
    n++;
    if (u.pathname !== '/3/person/3000') return new Response('{}', { status: 404 });
    return u.searchParams.get('language') === 'en-US' ? { biography: 'English bio' } : { biography: '', birthday: '1970-01-02', place_of_birth: 'Vimmerby' };
  });
  try {
    const p = await people.person(3000, scanner.tmdb, true);
    assert.equal(p.bio, 'English bio');
    assert.equal(p.birthday, '1970-01-02');
    assert.equal(p.birthplace, 'Vimmerby');
    const before = n;
    await people.person(3000, scanner.tmdb, true);
    assert.equal(n, before, 'biografin ska cachas');
    assert.equal(await people.person(999999, scanner.tmdb, true), null);
  } finally { restore(); }
});

test('personbild hämtas vid första visningen och sparas bland bilderna', async () => {
  mockTmdb((u) => u.hostname === 'image.tmdb.org' && u.pathname === '/t/p/w185/a.jpg' ? new Response(Buffer.from([0xff, 0xd8, 0xff, 1, 2])) : new Response('', { status: 404 }));
  try {
    const f = await people.personImage(1029);
    assert.equal(f, path.join(IMAGES, 'p1029-profile.jpg'));
    assert.equal(fs.readFileSync(f).length, 5);
    calls = [];
    assert.equal(await people.personImage(1029), f);
    assert.equal(calls.length, 0);
    assert.equal(await people.personImage(1000), null); // ingen bild hos TMDB
  } finally { restore(); }
});

test('bakgrundshämtning av rollistor: begränsat antal och avbryts vid 429', async () => {
  const a = item('movie', 'Gammal A', { tmdb_id: 11, meta_done: 1, added: 3 });
  const b = item('movie', 'Gammal B', { tmdb_id: 12, meta_done: 1, added: 2 });
  const c = item('movie', 'Gammal C', { tmdb_id: 13, meta_done: 1, added: 1 });
  mockTmdb((u) => u.pathname === '/3/movie/11' ? { credits: { cast: [{ id: 4000, name: 'Ny Person', order: 0 }] }, videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abcdefgh123' }] } }
    : new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } }));
  const saved = [];
  try { assert.equal(await people.backfill({ id: lib }, scanner.tmdb, { max: 5, apply: (it) => saved.push(it.id) }), 1); } finally { restore(); }
  assert.equal(get('SELECT credits_done FROM items WHERE id=?', a).credits_done, 1);
  assert.deepEqual(saved, [a]);
  assert.equal(people.castOf(a)[0].name, 'Ny Person');
  // b gav 429 fyra gånger (+ första försöket) – c ska inte ha försökts
  assert.equal(calls.filter(x => x.startsWith('/3/movie/13')).length, 0);
  assert.equal(get('SELECT credits_done FROM items WHERE id=?', b).credits_done, 0);
  // max begränsar antalet
  mockTmdb(() => ({ credits: { cast: [] } }));
  try { assert.equal(await people.backfill({ id: lib }, scanner.tmdb, { max: 1 }), 1); } finally { restore(); }
  assert.equal(get('SELECT credits_done FROM items WHERE id=?', c).credits_done, 0);
  // personer utan titlar städas bort
  run('DELETE FROM items WHERE id=?', a);
  people.cleanupPeople();
  assert.equal(people.personRow(4000), undefined);
});

test('trailerfiler känns igen och kopplas till rätt film', () => {
  for (const f of ['/m/Film (2020)-trailer.mkv', '/m/Film (2020) - trailer.mp4', '/m/Film.2020.trailer.mkv', '/m/Film (2020)-trailer2.mkv',
    '/m/Film/trailers/Officiell.mp4', '/m/Film/Trailers/x.mkv', '/m/Film/trailer/x.mkv']) assert.ok(trailers.isTrailerFile(f), f);
  for (const f of ['/m/Trailer Park Boys (2006).mkv', '/m/Film (2020).mkv', '/m/Film/Film.mkv', '/m/The Trailer Man (2001).mkv']) assert.ok(!trailers.isTrailerFile(f), f);
  assert.equal(trailers.homeDir('/m/Film/trailers/x.mkv'), '/m/Film');
  const movies = [{ id: 1, path: '/m/Film (2020).mkv' }, { id: 2, path: '/m/Film 2 (2022).mkv' }, { id: 3, path: '/m/Annan (2019).mp4' }];
  assert.equal(trailers.pickOwner('/m/Film (2020)-trailer.mkv', movies), 1);
  assert.equal(trailers.pickOwner('/m/Film 2 (2022) - trailer.mp4', movies), 2);
  assert.equal(trailers.pickOwner('/m/Annan.(2019).trailer.mp4', movies), 3);
  assert.equal(trailers.pickOwner('/m/Okänd-trailer.mkv', movies), null);
  assert.equal(trailers.pickOwner('/m/Film/trailers/Officiell trailer.mp4', [{ id: 9, path: '/m/Film/Film (2020).mkv' }]), 9);
  // Flera versioner av samma film i mappen (samma id) – trailern hör till filmen
  const vers = [{ id: 7, path: '/m/F (2020)/F (2020) - 2160p.mkv' }, { id: 7, path: '/m/F (2020)/F (2020) - 1080p.mkv' }];
  assert.equal(trailers.pickOwner('/m/F (2020)/F (2020)-trailer.mkv', vers), 7);
  assert.equal(trailers.pickOwner('/m/F (2020)/trailers/Teaser.mp4', vers), 7);
});

test('skanning: trailers blir inte egna filmer utan kopplas till filmen', { skip: !hasFfmpeg && 'ffmpeg saknas' }, async () => {
  setSetting('tmdb_key', '');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-trl-'));
  const mk = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]); };
  mk(path.join(root, 'Film (2020).mp4'));
  fs.copyFileSync(path.join(root, 'Film (2020).mp4'), path.join(root, 'Film (2020)-trailer.mp4'));
  fs.copyFileSync(path.join(root, 'Film (2020).mp4'), path.join(root, 'Film (2020) - trailer.mp4'));
  fs.mkdirSync(path.join(root, 'Annan (2019)', 'Trailers'), { recursive: true });
  fs.copyFileSync(path.join(root, 'Film (2020).mp4'), path.join(root, 'Annan (2019)', 'Annan (2019).mp4'));
  fs.copyFileSync(path.join(root, 'Film (2020).mp4'), path.join(root, 'Annan (2019)', 'Trailers', 'Teaser.mp4'));
  const L = Number(run(`INSERT INTO libraries(name,type,path) VALUES('Trailertest','movie',?)`, root).lastInsertRowid);
  try {
    await scanner.scan(L);
    const movies = all(`SELECT id, title, path FROM items WHERE library_id=? ORDER BY title`, L);
    assert.deepEqual(movies.map(m => m.title), ['Annan', 'Film']);
    const film = movies.find(m => m.title === 'Film'), annan = movies.find(m => m.title === 'Annan');
    assert.equal(trailers.trailersOf(film.id).length, 2);
    assert.deepEqual(trailers.trailersOf(film.id).map(t => t.name), ['Trailer 1', 'Trailer 2']);
    assert.equal(trailers.trailersOf(annan.id).length, 1);
    // borttagen trailerfil försvinner vid nästa skanning, filmen finns kvar
    fs.rmSync(path.join(root, 'Film (2020)-trailer.mp4'));
    await scanner.scan(L);
    assert.equal(trailers.trailersOf(film.id).length, 1);
    assert.equal(all(`SELECT id FROM items WHERE library_id=?`, L).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('årssammanfattning: timmar, mest sedda, genre, musik och ljudböcker per år', () => {
  const u1 = Number(run(`INSERT INTO users(name,pass,created) VALUES('wrap1','x',0)`).lastInsertRowid);
  const u2 = Number(run(`INSERT INTO users(name,pass,created) VALUES('wrap2','x',0)`).lastInsertRowid);
  const [from] = wrapped.yearRange(2025);
  const day = 86400, ts = (d) => from + d * day + 3600;
  const film = item('movie', 'Årets film', { duration: 7200, genres: JSON.stringify(['Drama', 'Komedi']) });
  const show = item('show', 'Årets serie', { genres: JSON.stringify(['Komedi']) });
  const e1 = item('episode', 'Avsnitt 1', { parent_id: show, duration: 1800 });
  const e2 = item('episode', 'Avsnitt 2', { parent_id: show, duration: 1800 });
  const pl = (u, i, t) => run('INSERT INTO plays(user_id,item_id,ts) VALUES(?,?,?)', u, i, t);
  pl(u1, film, ts(10)); pl(u1, e1, ts(40)); pl(u1, e2, ts(41)); pl(u1, e1, ts(200));
  pl(u1, film, from - day);      // föregående år
  pl(u2, film, ts(5));           // annan användare
  run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)', u1, film, 0, 7200, 1, ts(10));
  run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)', u1, e1, 0, 1800, 1, ts(40));
  run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,?,?,?,?)', u1, e2, 900, 1800, 0, ts(41));
  // musik
  const ar = Number(run(`INSERT INTO artists(library_id,name) VALUES(?, 'ABBA')`, lib).lastInsertRowid);
  const al = Number(run(`INSERT INTO albums(library_id,artist_id,title,added) VALUES(?,?,'Gold',0)`, lib, ar).lastInsertRowid);
  const t1 = Number(run(`INSERT INTO tracks(library_id,album_id,artist_id,title,duration,path,added) VALUES(?,?,?,'Waterloo',180,'/a',0)`, lib, al, ar).lastInsertRowid);
  const t2 = Number(run(`INSERT INTO tracks(library_id,album_id,artist_id,title,duration,path,added) VALUES(?,?,?,'SOS',180,'/b',0)`, lib, al, ar).lastInsertRowid);
  for (let i = 0; i < 3; i++) run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', u1, t1, ts(i));
  run('INSERT INTO track_plays(user_id,track_id,ts) VALUES(?,?,?)', u1, t2, ts(3));
  // ljudbok
  const bl = Number(run(`INSERT INTO libraries(name,type,path) VALUES('Böcker','audiobook','/b')`).lastInsertRowid);
  const bk = Number(run(`INSERT INTO books(library_id,key,title,author,duration,added) VALUES(?,'k','Boken','Författaren',36000,0)`, bl).lastInsertRowid);
  run('INSERT INTO book_progress(user_id,book_id,position,finished,updated) VALUES(?,?,?,?,?)', u1, bk, 36000, 1, ts(100));

  const w = wrapped.wrapped(u1, 2025);
  assert.equal(w.video.plays, 4);
  assert.equal(w.video.movies, 1);
  assert.equal(w.video.episodes, 2);
  assert.equal(w.video.hours, 2.8);            // 7200 + 1800 + 900 s
  assert.deepEqual(w.video.titles.map(t => [t.title, t.plays, t.kind]), [['Årets serie', 3, 'show'], ['Årets film', 1, 'movie']]);
  assert.equal(w.video.titles[0].id, show);
  assert.equal(w.topGenre, 'Komedi');
  assert.equal(w.video.months[0], 1);
  assert.equal(w.music.plays, 4);
  assert.equal(w.music.hours, 0.2);            // 720 s
  assert.deepEqual(w.music.tracks.map(t => [t.title, t.plays]), [['Waterloo', 3], ['SOS', 1]]);
  assert.deepEqual(w.music.artists.map(a => [a.name, a.plays]), [['ABBA', 4]]);
  assert.deepEqual(w.books.list.map(b => [b.title, b.finished]), [['Boken', true]]);
  assert.equal(w.books.hours, 10);
  assert.equal(w.hours, 13);
  assert.deepEqual(wrapped.years(u1), [2025, 2024]);
  // annat år och annan användare blandas inte in
  assert.equal(wrapped.wrapped(u1, 2024).video.plays, 1);
  const o = wrapped.wrapped(u2, 2025);
  assert.equal(o.video.plays, 1);
  assert.equal(o.music.plays, 0);
  assert.equal(o.video.hours, 0);              // ingen position sparad
});

test('avsnitt utan nummer matchas mot TMDB på titel, numrerade på nummer', async () => {
  setSetting('tmdb_key', 'testnyckel');
  const show = item('show', 'Chuggington');
  const ep = (title, season, episode, guess) => item('episode', title, { parent_id: show, season, episode, ep_guess: guess });
  const a = ep('Hjälpsamma Hodge', 1, 1, 1), b = ep('Wilson och raketen', 1, 2, 1), c = ep('Avsnitt 3', 1, 3, 0), d = ep('Okänd titel här', 1, 4, 1);
  const S1 = { episodes: [{ episode_number: 1, name: 'Bråttom Brewster' }, { episode_number: 2, name: 'Avsnitt 2' }, { episode_number: 3, name: 'Tågtvätten', overview: 'Tvätt' }] };
  const S2 = { episodes: [{ episode_number: 5, name: 'Hjälpsamma Hodge', overview: 'Hodge hjälper' }, { episode_number: 6, name: 'Wilson och raketen' }] };
  mockTmdb((u) => {
    if (u.hostname === 'image.tmdb.org') return new Response('nej', { status: 404 });
    if (u.pathname === '/3/search/tv') return { results: [{ id: 77, name: 'Chuggington', original_name: 'Chuggington', first_air_date: '2008-09-22' }] };
    if (u.pathname === '/3/tv/77') return { id: 77, name: 'Chuggington', first_air_date: '2008-09-22', seasons: [{ season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 6 }] };
    if (u.pathname === '/3/tv/77/season/1') return S1;
    if (u.pathname === '/3/tv/77/season/2') return S2;
    return new Response('{}', { status: 404 });
  });
  try { assert.equal(await scanner.refreshItem(get('SELECT * FROM items WHERE id=?', show)), true); } finally { restore(); }
  const row = (id) => ({ ...get('SELECT season, episode, title, ep_guess FROM items WHERE id=?', id) });
  assert.deepEqual(row(a), { season: 2, episode: 5, title: 'Hjälpsamma Hodge', ep_guess: 2 });
  assert.deepEqual(row(b), { season: 2, episode: 6, title: 'Wilson och raketen', ep_guess: 2 });
  // Numrerat avsnitt: på nummer, och TMDB:s titel ersätter "Avsnitt 3"
  assert.deepEqual(row(c), { season: 1, episode: 3, title: 'Tågtvätten', ep_guess: 0 });
  // Ingen träff: gissat nummer och filens titel ligger kvar (får inte "Bråttom Brewster" från S1E1… eller S1E4)
  assert.deepEqual(row(d), { season: 1, episode: 4, title: 'Okänd titel här', ep_guess: 1 });
});
