// Kvällsvalet: sessioner (kod, hushåll, gräns för felaktiga koder), åldersgränsen = lägsta bland deltagarna (även
// för den som går med senare), "osedda" utan att avslöja vem som sett vad, ordningen (smak, variation, samma för
// alla), match-logiken (alla/majoritet, ångra, topplistan, fler förslag, värdens val), realtid över SSE, Titta
// tillsammans och städning/utgång. Körs i samma process (servern startas på en slumpad port); kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-tonight-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
fs.mkdirSync(MEDIA, { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const tn = await import('../server/tonight.js');
const app = await import('../server/app.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
const open = new Set();
after(() => { tn._setClock(null); for (const c of open) c.close(); srv.closeAllConnections?.(); srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const user = (name, parent = null, maxAge = null) =>
  Number(D.run('INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES(?,?,0,0,?,?)', name, 'x', parent, maxAge).lastInsertRowid);
const MAMMA = user('mamma'), PAPPA = user('pappa', MAMMA), LISA = user('lisa', MAMMA, 7), GRANNE = user('granne'), BUS = user('bus');
const tok = Object.fromEntries([MAMMA, PAPPA, LISA, GRANNE, BUS].map(u => [u, auth.createSession(u, 'app')]));
async function req(uid, p, { method = 'GET', body } = {}) {
  const h = { Authorization: `Bearer ${tok[uid]}` };
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + '/api' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text() };
}
/** SSE-klient: next(ev, pred) väntar på nästa händelse som matchar */
function sse(uid, id) {
  return new Promise((ok, no) => {
    const r = http.get(`${B}/api/tonight/${id}/events`, { headers: { Authorization: `Bearer ${tok[uid]}` } }, (res) => {
      const c = { status: res.statusCode, events: [], waiters: [], close: () => r.destroy() };
      open.add(c);
      c.next = (ev, pred = () => true, ms = 3000) => {
        const hit = c.events.find(e => !e.used && e.ev === ev && pred(e.data));
        if (hit) { hit.used = true; return Promise.resolve(hit.data); }
        return new Promise((y, n) => {
          const w = { m: (e) => e.ev === ev && pred(e.data), y: (e) => { e.used = true; clearTimeout(w.t); y(e.data); } };
          w.t = setTimeout(() => { c.waiters = c.waiters.filter(x => x !== w); n(new Error(`ingen ${ev}-händelse`)); }, ms);
          c.waiters.push(w);
        });
      };
      if (res.statusCode !== 200) { res.resume(); return ok(c); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(blk)?.[1]; if (!ev) continue;
          const e = { ev, data: JSON.parse(/^data: (.*)$/m.exec(blk)?.[1] || 'null') };
          c.events.push(e);
          const w = c.waiters.find(x => x.m(e));
          if (w) { c.waiters = c.waiters.filter(x => x !== w); w.y(e); }
        }
      });
      c.next('state').then(() => ok(c), no);
    });
    r.on('error', no);
  });
}

// Biblioteket: filmer med olika åldersgränser, genrer och längder, och en barnserie med två avsnitt
const MOV = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(MEDIA, 'Filmer')).lastInsertRowid);
const TV = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Serier','show',?)", path.join(MEDIA, 'Serier')).lastInsertRowid);
const film = (title, age, genres, mins = 100, rating = 7) => Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,age,genres,duration,rating,added) VALUES(?,'movie',?,?,?,?,?,?,1)`,
  MOV, title, title.toLowerCase(), age, JSON.stringify(genres), mins * 60, rating).lastInsertRowid);
const F = {
  bamse: film('Bamse', 0, ['Animerat', 'Familj'], 70),
  pippi: film('Pippi', 7, ['Äventyr', 'Familj'], 90),
  emil: film('Emil', 7, ['Komedi', 'Familj'], 95, 8),
  lang: film('Långfilmen', 7, ['Drama'], 190),
  skrack: film('Skräck', 15, ['Skräck'], 100),
  action: film('Action', 15, ['Action'], 110),
  okand: film('Okänd ålder', null, ['Komedi'], 90)
};
const SHOW = Number(D.run(`INSERT INTO items(library_id,kind,title,sort_title,age,genres,added) VALUES(?,'show','Babblarna','babblarna',0,'["Animerat"]',1)`, TV).lastInsertRowid);
const EP1 = Number(D.run(`INSERT INTO items(library_id,kind,parent_id,title,season,episode,duration,added) VALUES(?,'episode',?,'Ett',1,1,600,1)`, TV, SHOW).lastInsertRowid);
const EP2 = Number(D.run(`INSERT INTO items(library_id,kind,parent_id,title,season,episode,duration,added) VALUES(?,'episode',?,'Två',1,2,600,1)`, TV, SHOW).lastInsertRowid);
// Pappa har sett Emil
D.run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,5700,1,1)', PAPPA, F.emil);

const create = async (uid, filters = {}) => (await req(uid, '/tonight', { method: 'POST', body: { filters } })).data;
const state = async (uid, id) => (await req(uid, '/tonight/' + id)).data;
const vote = (uid, id, item, like) => req(uid, `/tonight/${id}/vote`, { method: 'POST', body: { item, like } });

test('filtren tvättas och ordningen är densamma med samma frö, varierad och följer smaken', () => {
  const f = tn.parseFilters({ kinds: ['movie', 'x'], libs: [1, '2', -3, 'a'], genres: ['  Drama ', 'Drama', ''], maxMinutes: 5, minRating: 7.25, unseen: false, rule: 'majority', size: 99, extra: 1 });
  assert.deepEqual(f, { kinds: ['movie'], libs: [1, 2], genres: ['Drama'], maxMinutes: 30, minRating: 7.3, unseen: false, rule: 'majority', size: 20 });
  assert.deepEqual(tn.parseFilters(null).kinds, ['movie', 'show']);
  assert.equal(tn.parseFilters({}).unseen, true);
  const G = ['Drama', 'Komedi', 'Action', 'Skräck', 'Familj'];
  const cands = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, g: [G[i % 5]], rating: 6 + (i % 3), col: null }));
  const lover = { g: { Komedi: 1 }, own: new Map(), cols: new Map() };
  const a = tn.rank(cands, { tastes: [lover], seed: 42, max: 20 }), b = tn.rank(cands, { tastes: [lover], seed: 42, max: 20 });
  assert.deepEqual(a, b, 'samma frö → samma ordning för alla');
  assert.notDeepEqual(a, tn.rank(cands, { tastes: [lover], seed: 7, max: 20 }), 'annat frö → annan ordning');
  assert.equal(new Set(a).size, 20);
  const genreOf = (id) => G[(id - 1) % 5];
  assert.equal(genreOf(a[0]), 'Komedi', 'den gillade genren först');
  assert.ok(new Set(a.slice(0, 5).map(genreOf)).size >= 2, 'variation bland de första förslagen');
  assert.ok(a.filter(id => genreOf(id) === 'Komedi').length >= 6, 'den gillade genren dominerar');
  // Två deltagare: något båda gillar går före det en älskar och den andra ogillar
  const c2 = [{ id: 1, g: ['Skräck'], rating: 7 }, { id: 2, g: ['Komedi'], rating: 7 }];
  const t1 = { g: { Skräck: 1, Komedi: 0.5 }, own: new Map(), cols: new Map() }, t2 = { g: { Skräck: -0.5, Komedi: 0.5 }, own: new Map(), cols: new Map() };
  const many = Array.from({ length: 30 }, (_, i) => tn.rank(c2, { tastes: [t1, t2], seed: i + 1 })[0]);
  assert.ok(many.filter(x => x === 2).length > 20, 'det gemensamma vinner oftast');
  // Egna betyg och samlingar räknas
  const c3 = [{ id: 1, g: ['Drama'], rating: 6, col: null }, { id: 2, g: ['Drama'], rating: 6, col: 9 }];
  assert.equal(tn.rank(c3, { tastes: [{ g: {}, own: new Map(), cols: new Map([[9, 1]]) }], seed: 3 })[0], 2);
});

test('kod, hushåll och behörighet', async () => {
  const s = await create(MAMMA);
  assert.match(s.code, /^\d{6}$/);
  // Hushållet ser kvällsvalet utan kod, grannen inte
  assert.ok((await req(PAPPA, '/tonight')).data.sessions.some(x => x.id === s.id && x.host === 'mamma'));
  assert.ok(!(await req(GRANNE, '/tonight')).data.sessions.some(x => x.id === s.id));
  assert.equal((await req(GRANNE, `/tonight/${s.id}/join`, { method: 'POST' })).status, 404, 'utan kod bara inom hushållet');
  assert.equal((await req(GRANNE, '/tonight/' + s.id)).status, 404, 'den som inte är med ser ingenting');
  assert.equal((await req(GRANNE, `/tonight/${s.id}/events`)).status, 404);
  assert.equal((await req(PAPPA, `/tonight/${s.id}/join`, { method: 'POST' })).status, 200);
  // Med koden går även andra konton att bjuda in (som Titta tillsammans)
  assert.equal((await req(GRANNE, '/tonight/join', { method: 'POST', body: { code: s.code.slice(0, 3) + ' ' + s.code.slice(3) } })).data.id, s.id);
  const st = await state(GRANNE, s.id);
  assert.deepEqual(st.members.map(m => m.name), ['mamma', 'pappa', 'granne']);
  assert.equal(st.isHost, false);
  // Bara värden ändrar filter och börjar
  assert.equal((await req(PAPPA, `/tonight/${s.id}/filters`, { method: 'PUT', body: { kinds: ['show'] } })).status, 403);
  assert.equal((await req(PAPPA, `/tonight/${s.id}/start`, { method: 'POST' })).status, 403);
  assert.equal((await req(PAPPA, `/tonight/${s.id}`, { method: 'DELETE' })).status, 403);
  // Felaktiga koder: 404 och sedan spärr
  for (let i = 0; i < 10; i++) assert.equal((await req(BUS, '/tonight/join', { method: 'POST', body: { code: String(100000 + i) === s.code ? '999999' : String(100000 + i) } })).status, 404);
  assert.equal((await req(BUS, '/tonight/join', { method: 'POST', body: { code: s.code } })).status, 429, 'gissning spärras');
  // Värden lämnar: värdskapet går vidare till den som varit med längst
  assert.equal((await req(MAMMA, `/tonight/${s.id}/me`, { method: 'DELETE' })).status, 200);
  assert.equal((await state(PAPPA, s.id)).isHost, true);
  assert.equal((await req(PAPPA, `/tonight/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(GRANNE, '/tonight/' + s.id)).status, 404);
});

test('åldersgränsen är den lägsta bland deltagarna – även för den som går med under röstningen', async () => {
  const s = await create(MAMMA, { unseen: false });
  const all = (await state(MAMMA, s.id)).fits;
  assert.equal(all, 8, 'alla filmer och serien för en vuxen');
  await req(LISA, `/tonight/${s.id}/join`, { method: 'POST' });
  let st = await state(LISA, s.id);
  assert.equal(st.maxAge, 7);
  assert.equal(st.fits, 5, 'bara titlar till och med 7 år (okänd ålder döljs)');
  assert.equal((await req(MAMMA, `/tonight/${s.id}/start`, { method: 'POST' })).status, 200);
  st = await state(LISA, s.id);
  const ids = st.deck.map(i => i.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [F.bamse, F.pippi, F.emil, F.lang, SHOW].sort((a, b) => a - b));
  assert.deepEqual((await state(MAMMA, s.id)).deck.map(i => i.id), st.deck.map(i => i.id), 'samma ordning för alla');

  // En vuxen startar, barnet går med när röstningen redan börjat: det otillåtna försvinner för alla
  const v = await create(PAPPA, { unseen: false, kinds: ['movie'] });
  await req(MAMMA, `/tonight/${v.id}/join`, { method: 'POST' });
  await req(PAPPA, `/tonight/${v.id}/start`, { method: 'POST' });
  const before = (await state(PAPPA, v.id)).deck.map(i => i.id);
  assert.ok(before.includes(F.skrack));
  await vote(PAPPA, v.id, F.skrack, true);
  const ps = await sse(PAPPA, v.id);
  const lj = await req(LISA, `/tonight/${v.id}/join`, { method: 'POST' });
  assert.equal(lj.status, 200, JSON.stringify(lj.data));
  await ps.next('deck');
  const after = (await state(PAPPA, v.id)).deck.map(i => i.id);
  assert.ok(!after.includes(F.skrack) && !after.includes(F.action) && !after.includes(F.okand));
  assert.deepEqual(after, before.filter(id => after.includes(id)), 'ordningen behålls');
  assert.equal((await vote(LISA, v.id, F.skrack, true)).status, 404, 'barnet kan inte rösta på det borttagna');
  assert.ok(!JSON.stringify(await state(LISA, v.id)).includes('Skräck'));
  ps.close();
});

test('osedda: det någon sett tas bort, men ingen får veta vem', async () => {
  const s = await create(MAMMA, { kinds: ['movie'] });
  assert.equal((await state(MAMMA, s.id)).fits, 7);
  await req(PAPPA, `/tonight/${s.id}/join`, { method: 'POST' });
  const st = await state(MAMMA, s.id);
  assert.equal(st.fits, 6, 'Emil (som pappa sett) räknas inte');
  await req(MAMMA, `/tonight/${s.id}/start`, { method: 'POST' });
  const deck = await state(MAMMA, s.id);
  assert.ok(!deck.deck.some(i => i.id === F.emil));
  // Inget i svaret pekar ut pappas historik: bara mammas egna framsteg finns i titlarna
  assert.ok(deck.members.every(m => Object.keys(m).sort().join() === 'host,kid,name,online,self,voted'));
  assert.ok(!JSON.stringify(deck).includes('Emil'));
  // Filtren: längd, genre och betyg
  const g = await create(MAMMA, { kinds: ['movie'], genres: ['Familj'], maxMinutes: 92, unseen: false });
  assert.equal((await state(MAMMA, g.id)).fits, 2, 'Bamse och Pippi (Emil är för lång)');
  await req(MAMMA, `/tonight/${g.id}/filters`, { method: 'PUT', body: { kinds: ['movie'], genres: ['Familj'], minRating: 8, unseen: false } });
  assert.equal((await state(MAMMA, g.id)).fits, 1, 'bara Emil har betyget 8');
  await req(MAMMA, `/tonight/${g.id}/filters`, { method: 'PUT', body: { kinds: ['movie'], genres: ['Finns inte'] } });
  assert.equal((await req(MAMMA, `/tonight/${g.id}/start`, { method: 'POST' })).data.error, 'Inga titlar passar filtren för alla som är med – ändra filtren');
});

test('match: alla måste gilla, ångra, realtid och Titta tillsammans', async () => {
  const s = await create(MAMMA, { unseen: false, size: 10 });
  await req(PAPPA, `/tonight/${s.id}/join`, { method: 'POST' });
  const ms = await sse(MAMMA, s.id), ps = await sse(PAPPA, s.id);
  await req(MAMMA, `/tonight/${s.id}/start`, { method: 'POST' });
  await ms.next('state', d => d.phase === 'voting');
  assert.equal((await vote(MAMMA, s.id, 999999, true)).status, 404);
  await vote(MAMMA, s.id, SHOW, true);
  // Pappa ser hur långt mamma kommit, men inte vad hon röstat
  const ph = await ps.next('state', d => d.members.some(m => m.name === 'mamma' && m.voted === 1));
  assert.deepEqual(ph.votes, {});
  assert.equal(ph.phase, 'voting');
  // Ångra: rösten tas bort
  await vote(MAMMA, s.id, SHOW, null);
  assert.equal((await state(MAMMA, s.id)).members.find(m => m.self).voted, 0);
  await vote(MAMMA, s.id, SHOW, true);
  await vote(PAPPA, s.id, F.bamse, true);
  assert.equal((await state(MAMMA, s.id)).phase, 'voting');
  await vote(PAPPA, s.id, SHOW, true);
  const [m1, m2] = await Promise.all([ms.next('state', d => d.phase === 'matched'), ps.next('state', d => d.phase === 'matched')]);
  assert.equal(m1.match.id, SHOW); assert.equal(m2.match.likes, 2); assert.equal(m2.match.of, 2);
  // En serie: spela första avsnittet (eller det påbörjade)
  assert.deepEqual(m1.match.play, { id: EP1, position: 0 });
  D.run('INSERT INTO progress(user_id,item_id,position,duration,watched,updated) VALUES(?,?,0,600,1,1)', PAPPA, EP1);
  assert.equal((await state(PAPPA, s.id)).match.play.id, EP2, 'pappa fortsätter med nästa avsnitt');
  assert.equal((await vote(MAMMA, s.id, F.bamse, true)).status, 409, 'avgjort');
  assert.equal((await req(LISA, `/tonight/${s.id}/join`, { method: 'POST' })).status, 409);
  // Titta tillsammans: alla får rummet
  const r = await req(PAPPA, `/tonight/${s.id}/party`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await ms.next('state', d => !!d.party)).party, r.data.id);
  assert.equal((await req(MAMMA, `/tonight/${s.id}/party`, { method: 'POST' })).data.id, r.data.id, 'samma rum');
  assert.equal((await req(MAMMA, '/party/' + r.data.id)).data.itemId, EP2);
  ms.close(); ps.close();
});

test('majoritet, ingen match, topplistan, fler förslag och värdens val', async () => {
  const s = await create(MAMMA, { unseen: false, rule: 'majority', size: 10, kinds: ['movie'] });
  for (const u of [PAPPA, LISA]) await req(u, `/tonight/${s.id}/join`, { method: 'POST' });
  await req(MAMMA, `/tonight/${s.id}/start`, { method: 'POST' });
  let st = await state(MAMMA, s.id);
  assert.equal(st.need, 2);
  const deck = st.deck.map(i => i.id);
  assert.equal(deck.length, 4, 'tre deltagare med ett barn: fyra filmer');
  // Mamma och Lisa gillar Pippi → 2 av 3 = majoritet
  await vote(MAMMA, s.id, F.pippi, true);
  await vote(PAPPA, s.id, F.pippi, false);
  assert.equal((await state(MAMMA, s.id)).phase, 'voting');
  await vote(LISA, s.id, F.pippi, true);
  st = await state(LISA, s.id);
  assert.equal(st.phase, 'matched'); assert.equal(st.match.id, F.pippi); assert.equal(st.match.likes, 2); assert.equal(st.match.of, 3);

  // Alla krävs, ingen match: topplistan med antal (inte vem) och värdens val
  const n = await create(MAMMA, { unseen: false, size: 10, kinds: ['movie'], genres: ['Familj'] });
  await req(PAPPA, `/tonight/${n.id}/join`, { method: 'POST' });
  await req(MAMMA, `/tonight/${n.id}/start`, { method: 'POST' });
  const d2 = (await state(MAMMA, n.id)).deck.map(i => i.id);
  for (const id of d2) { await vote(MAMMA, n.id, id, id === F.bamse); await vote(PAPPA, n.id, id, false); }
  st = await state(PAPPA, n.id);
  assert.equal(st.done, true); assert.equal(st.phase, 'voting');
  assert.deepEqual(st.top, [{ id: F.bamse, likes: 1 }]);
  assert.equal(st.more, false);
  assert.equal((await req(MAMMA, `/tonight/${n.id}/more`, { method: 'POST' })).status, 409, 'inga fler förslag finns');
  assert.equal((await req(PAPPA, `/tonight/${n.id}/pick`, { method: 'POST', body: { item: F.bamse } })).status, 403);
  assert.equal((await req(MAMMA, `/tonight/${n.id}/pick`, { method: 'POST', body: { item: F.bamse } })).status, 200);
  st = await state(PAPPA, n.id);
  assert.equal(st.match.id, F.bamse); assert.equal(st.match.picked, true); assert.equal(st.match.by, 'mamma');

  // Fler förslag läggs till sist i listan
  const m = await create(MAMMA, { unseen: false, size: 10 });
  await req(MAMMA, `/tonight/${m.id}/start`, { method: 'POST' });
  const one = (await state(MAMMA, m.id)).deck.map(i => i.id);
  assert.equal(one.length, 8);
  assert.equal((await state(MAMMA, m.id)).more, false);
});

test('utgång och städning', async () => {
  let t = Date.now();
  tn._setClock(() => t);
  const s = await create(MAMMA);
  const idle = await create(PAPPA);
  const c = await sse(MAMMA, s.id);
  // Utan anslutning i 30 minuter: stängs. Med anslutning: lever kvar
  t += tn.LIMITS.IDLE + 1000;
  tn.sweep();
  assert.equal((await req(PAPPA, '/tonight/' + idle.id)).status, 404);
  assert.equal((await req(MAMMA, '/tonight/' + s.id)).status, 200);
  // Efter fyra timmar stängs det oavsett – anslutna får closed
  t += tn.LIMITS.TTL;
  tn.sweep();
  await c.next('closed');
  assert.equal((await req(MAMMA, '/tonight/' + s.id)).status, 404);
  assert.equal((await req(MAMMA, '/tonight/join', { method: 'POST', body: { code: s.code } })).status, 404, 'koden gäller inte längre');
  // Avgjort: stängs efter en halvtimme
  const d = await create(MAMMA, { unseen: false });
  await req(MAMMA, `/tonight/${d.id}/start`, { method: 'POST' });
  const first = (await state(MAMMA, d.id)).deck[0].id;
  await vote(MAMMA, d.id, first, true);
  assert.equal((await state(MAMMA, d.id)).phase, 'matched');
  const live = await sse(MAMMA, d.id);
  t += tn.LIMITS.DONE + 1000;
  tn.sweep();
  assert.equal((await req(MAMMA, '/tonight/' + d.id)).status, 404);
  live.close(); c.close();
  // Högst två öppna per värd: det äldsta stängs
  const a = await create(LISA), b = await create(LISA), e = await create(LISA);
  assert.equal((await req(LISA, '/tonight/' + a.id)).status, 404);
  assert.equal((await req(LISA, '/tonight/' + b.id)).status, 200);
  assert.equal((await req(LISA, '/tonight/' + e.id)).status, 200);
  tn._setClock(null);
});
