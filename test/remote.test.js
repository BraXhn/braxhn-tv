// "Spela på…": register över enheter, behörighet (hushåll, barnprofiler, PIN, andra konton, CSRF),
// kommandon och statusflöde över SSE samt städning av döda anslutningar.
// Körs i samma process (servern startas på en slumpad port); kräver inte ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-remote-'));
const MEDIA = path.join(ROOT, 'media');
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = MEDIA;
process.env.WATCH_FILES = '0';
fs.mkdirSync(MEDIA, { recursive: true });
const D = await import('../server/db.js');
const sc = await import('../server/scanner.js');
const auth = await import('../server/auth.js');
const remote = await import('../server/remote.js');
const app = await import('../server/app.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
const open = new Set();
after(() => { for (const c of open) c.close(); srv.closeAllConnections?.(); srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const user = (name, parent = null, maxAge = null, pin = null) =>
  Number(D.run('INSERT INTO users(name,pass,is_admin,created,parent_id,max_age,pin) VALUES(?,?,0,0,?,?,?)', name, 'x', parent, maxAge, pin).lastInsertRowid);
const MAMMA = user('mamma');
const PAPPA = user('pappa', MAMMA);
const LISA = user('lisa', MAMMA, 7);
const PRIVAT = user('privat', MAMMA, null, 'pinhash');
const GRANNE = user('granne');
const SPAM = user('spam');
const tok = Object.fromEntries([MAMMA, PAPPA, LISA, PRIVAT, GRANNE, SPAM].map(u => [u, auth.createSession(u, 'app')]));

async function req(uid, p, { method = 'GET', body, headers = {} } = {}) {
  const h = { Authorization: `Bearer ${tok[uid]}`, ...headers };
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
let keyN = 0;
const newKey = () => `testnyckel-${String(++keyN).padStart(6, '0')}`;
/** SSE-klient: samlar händelser; next(ev, pred) väntar på nästa obesvarade händelse som matchar */
function sse(uid, name, { key = newKey(), hidden = false, token = tok[uid] } = {}) {
  return new Promise((ok, no) => {
    const q = new URLSearchParams({ key, name }); if (hidden) q.set('hidden', '1');
    const r = http.get(`${B}/api/remote/events?${q}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const c = { res, key, status: res.statusCode, events: [], waiters: [], close: () => r.destroy() };
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
      c.next('hello').then(h => { c.id = h.id; ok(c); }, no);
    });
    r.on('error', no);
  });
}
const cmd = (uid, dev, body) => req(uid, `/api/remote/devices/${dev}/command`, { method: 'POST', body });
const list = async (uid, me = '') => (await req(uid, '/api/remote/devices?me=' + me)).data.devices;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Bibliotek: en barntillåten och en vuxenserie (avsnitt utan riktiga videodata räcker här)
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
const SHOWDIR = path.join(MEDIA, 'Serier');
touch(path.join(SHOWDIR, 'Bamse', 'Season 1', 'Bamse S01E01.mkv'));
touch(path.join(SHOWDIR, 'Bamse', 'Season 1', 'Bamse S01E02.mkv'));
touch(path.join(SHOWDIR, 'Vuxenserie', 'Season 1', 'Vuxenserie S01E01.mkv'));
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('TV','show',?)", SHOWDIR).lastInsertRowid);
await sc.scan(LIB);
const show = (t) => D.get("SELECT id FROM items WHERE kind='show' AND title=?", t).id;
D.run('UPDATE items SET age=0 WHERE id=?', show('Bamse'));
D.run('UPDATE items SET age=15 WHERE id=?', show('Vuxenserie'));
const KIDS_EP = D.get('SELECT id FROM items WHERE parent_id=? AND episode=1', show('Bamse')).id;
const ADULT_EP = D.get('SELECT id FROM items WHERE parent_id=?', show('Vuxenserie')).id;

test('registrering: enheten listas med namn, och bara för hushållet', async () => {
  const tv = await sse(MAMMA, 'Vardagsrums-TV');
  const phone = await sse(MAMMA, 'Mammas telefon');
  assert.match(tv.id, /^[\w-]{16}$/);
  const l = await list(MAMMA, phone.id);
  const me = l.find(d => d.id === phone.id), t = l.find(d => d.id === tv.id);
  assert.ok(me.self && !t.self, 'den egna enheten markeras');
  assert.equal(t.name, 'Vardagsrums-TV');
  assert.equal(t.mine, true);
  // Annan profil i samma hushåll (vuxen, utan PIN) ser TV:n; grannen ser ingenting
  assert.ok((await list(PAPPA)).some(d => d.id === tv.id));
  assert.deepEqual(await list(GRANNE), []);
  // Byt namn (bara den egna profilen) – mottagaren får det nya namnet
  assert.equal((await req(PAPPA, `/api/remote/devices/${tv.id}`, { method: 'PUT', body: { name: 'Hack' } })).status, 404);
  const r = await req(MAMMA, `/api/remote/devices/${tv.id}`, { method: 'PUT', body: { name: '  TV i\u0000 vardagsrummet ' } });
  assert.equal(r.data.name, 'TV i vardagsrummet');
  assert.equal((await tv.next('hello', h => h.name === 'TV i vardagsrummet')).id, tv.id);
  // Samma nyckel ger samma id efter omladdning, och den gamla anslutningen ersätts
  const again = await sse(MAMMA, 'TV igen', { key: tv.key });
  assert.equal(again.id, tv.id);
  await tv.next('replaced');
  // Dold enhet syns inte för andra men för sig själv
  const hid = await sse(MAMMA, 'Dold', { hidden: true });
  assert.ok(!(await list(MAMMA, phone.id)).some(d => d.id === hid.id));
  assert.ok((await list(MAMMA, hid.id)).some(d => d.id === hid.id && d.self));
  assert.equal((await cmd(MAMMA, hid.id, { pause: true })).status, 404, 'en dold enhet går inte att styra');
  // Ogiltig nyckel
  const bad = await new Promise(y => http.get(`${B}/api/remote/events?key=kort`, { headers: { Authorization: `Bearer ${tok[MAMMA]}` } }, (res) => { res.resume(); y(res.statusCode); }));
  assert.equal(bad, 400);
  for (const c of [phone, again, hid]) c.close();
});

test('behörighet: grannar, barnprofiler och PIN-profiler', async () => {
  const tv = await sse(MAMMA, 'TV');
  const kidTv = await sse(LISA, 'Lisas surfplatta');
  const priv = await sse(PRIVAT, 'Privat dator');
  // Grannen kan varken se eller styra
  assert.equal((await cmd(GRANNE, tv.id, { pause: true })).status, 404);
  // Barnprofilen ser bara sina egna enheter och kan inte styra andras
  const kl = await list(LISA);
  assert.ok(kl.every(d => d.mine), 'barnet ser bara egna enheter');
  assert.ok(kl.some(d => d.id === kidTv.id));
  assert.equal((await cmd(LISA, tv.id, { pause: true })).status, 404);
  // PIN-profilens enheter: syns för huvudkontot men inte för en annan vuxen profil
  assert.ok((await list(MAMMA)).some(d => d.id === priv.id));
  assert.ok(!(await list(PAPPA)).some(d => d.id === priv.id));
  assert.equal((await cmd(PAPPA, priv.id, { pause: true })).status, 404);
  // Föräldern kan starta en barntillåten titel på barnets enhet – men aldrig en över mottagarens åldersgräns
  assert.equal((await cmd(MAMMA, kidTv.id, { play: { item: ADULT_EP } })).status, 403);
  assert.equal((await cmd(MAMMA, kidTv.id, { play: { item: KIDS_EP, position: 12 } })).status, 200);
  const got = await kidTv.next('command', c => c.cmd === 'play');
  assert.deepEqual([got.item, got.position, got.from.user], [KIDS_EP, 12, 'mamma']);
  // Barnet kan inte starta en vuxentitel ens på sin egen enhet
  assert.equal((await cmd(LISA, kidTv.id, { play: { item: ADULT_EP } })).status, 404);
  assert.ok(!kidTv.events.some(e => e.ev === 'command' && e.data.item === ADULT_EP));
  // Okänd titel och serie (inte spelbar)
  assert.equal((await cmd(MAMMA, tv.id, { play: { item: 999999 } })).status, 404);
  assert.equal((await cmd(MAMMA, tv.id, { play: { item: show('Bamse') } })).status, 404);
  // Lägesrapport för någon annans enhet nekas
  assert.equal((await req(PAPPA, '/api/remote/state', { method: 'POST', body: { device: tv.id, state: null } })).status, 404);
  for (const c of [tv, kidTv, priv]) c.close();
});

test('CSRF: kommando med kaka från annan webbplats nekas', async () => {
  const tv = await sse(MAMMA, 'TV');
  const web = auth.createSession(MAMMA, 'web');
  const post = (origin) => fetch(`${B}/api/remote/devices/${tv.id}/command`, { method: 'POST',
    headers: { Cookie: `kt=${web}`, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ pause: true }) });
  assert.equal((await post('http://elak.example')).status, 403);
  assert.ok(!tv.events.some(e => e.ev === 'command'));
  assert.equal((await post(B)).status, 200);
  await tv.next('command', c => c.cmd === 'pause');
  // Mediatoken (kortlivad, för strömmar) släpps inte in på fjärrstyrningen
  const media = auth.createSession(MAMMA, 'media');
  assert.equal((await fetch(`${B}/api/remote/devices?t=${media}`)).status, 401);
  tv.close();
});

test('kommandon valideras', async () => {
  const tv = await sse(MAMMA, 'TV');
  for (const body of [{}, { pause: true, stop: true }, { seek: 'x' }, { seek: -5 }, { volume: 2 }, { play: { item: 'abc' } }, { play: 5 },
    { audio: '<script>' }, { audio: '' }, { sub: 'a b' }, { pause: 'ja' }, { seek: { delta: 99999 } }]) {
    assert.equal((await cmd(MAMMA, tv.id, body)).status, 400, JSON.stringify(body));
  }
  const ok = [[{ pause: true }, { cmd: 'pause' }], [{ resume: true }, { cmd: 'resume' }], [{ seek: 90.5 }, { cmd: 'seek', position: 90.5 }],
    [{ seek: { delta: -10 } }, { cmd: 'seek', delta: -10 }], [{ volume: 0.4 }, { cmd: 'volume', level: 0.4 }], [{ volume: { muted: true } }, { cmd: 'volume', muted: true }],
    [{ audio: '2' }, { cmd: 'audio', id: '2' }], [{ sub: '' }, { cmd: 'sub', id: '' }], [{ sub: 'ext:0' }, { cmd: 'sub', id: 'ext:0' }],
    [{ next: true }, { cmd: 'next' }], [{ stop: true }, { cmd: 'stop' }]];
  for (const [body, want] of ok) {
    assert.equal((await cmd(MAMMA, tv.id, body)).status, 200, JSON.stringify(body));
    const got = await tv.next('command');
    delete got.from;
    assert.deepEqual(got, want);
  }
  // Uppspelning med valda spår; utelämnade spår skickas inte vidare (mottagarens egna val gäller)
  await cmd(MAMMA, tv.id, { play: { item: KIDS_EP, position: 5, audio: '1', sub: '' } });
  assert.deepEqual(await tv.next('command').then(({ from, ...c }) => c), { cmd: 'play', item: KIDS_EP, position: 5, audio: '1', sub: '' });
  await cmd(MAMMA, tv.id, { play: { item: KIDS_EP } });
  assert.deepEqual(await tv.next('command').then(({ from, ...c }) => c), { cmd: 'play', item: KIDS_EP, position: 0 });
  tv.close();
});

test('hastighetsbegränsning för kommandon', async () => {
  const tv = await sse(SPAM, 'TV');
  const codes = [];
  for (let i = 0; i < 45; i++) codes.push((await cmd(SPAM, tv.id, { pause: true })).status);
  assert.ok(codes.slice(0, 40).every(c => c === 200));
  assert.equal(codes.at(-1), 429);
  tv.close();
});

test('statusflöde: mottagarens läge når den styrande över SSE', async () => {
  const tv = await sse(MAMMA, 'TV');
  const phone = await sse(PAPPA, 'Pappas telefon');
  // Kommando med from = den egna enheten → telefonen bevakar TV:n och får läget direkt
  assert.equal((await cmd(PAPPA, tv.id, { from: phone.id, play: { item: KIDS_EP, position: 30 } })).status, 200);
  const first = await phone.next('status', s => s.id === tv.id);
  assert.equal(first.online, true);
  assert.equal(first.state, null);
  await tv.next('command');
  assert.ok((await tv.next('watched')).n >= 1, 'mottagaren får veta att någon bevakar');
  // Mottagaren rapporterar; titeln slås upp av servern (klientens egen titel används inte för video)
  const st = { media: 'video', itemId: KIDS_EP, title: '<b>falsk</b>', position: 31, duration: 1300, paused: false, volume: 0.8, muted: false,
    audio: '1', sub: '', audios: [{ id: '1', label: 'Svenska · aac' }, { id: 'x y', label: 'fel' }], subs: [{ id: 'ext:0', label: 'Engelska' }], hasNext: true, extra: 'bort' };
  const r = await req(MAMMA, '/api/remote/state', { method: 'POST', body: { device: tv.id, state: st } });
  assert.equal(r.status, 400, 'ogiltigt spår-id i listan nekas');
  st.audios = [{ id: '1', label: 'Svenska · aac' }];
  const r2 = await req(MAMMA, '/api/remote/state', { method: 'POST', body: { device: tv.id, state: st } });
  assert.deepEqual(r2.data, { watched: true });
  const s = await phone.next('status', x => x.state);
  assert.equal(s.state.title, 'Bamse – S01E01 ' + D.get('SELECT title FROM items WHERE id=?', KIDS_EP).title);
  assert.equal(s.state.itemId, KIDS_EP);
  assert.ok(s.state.position >= 31 && s.state.position < 33);
  assert.equal(s.state.extra, undefined);
  assert.deepEqual(s.state.subs, [{ id: 'ext:0', label: 'Engelska' }]);
  // Enhetslistan visar vad som spelas
  assert.equal((await list(PAPPA)).find(d => d.id === tv.id).playing.paused, false);
  // Paus → nytt läge; mottagaren kopplar ner → bevakaren får online:false
  await req(MAMMA, '/api/remote/state', { method: 'POST', body: { device: tv.id, state: { ...st, paused: true } } });
  assert.equal((await phone.next('status', x => x.state?.paused)).state.paused, true);
  tv.close();
  assert.equal((await phone.next('status', x => !x.online)).online, false);
  // Sluta bevaka
  const tv2 = await sse(MAMMA, 'TV 2');
  assert.equal((await req(PAPPA, `/api/remote/devices/${tv2.id}/watch`, { method: 'POST', body: { from: phone.id } })).status, 200);
  await phone.next('status', x => x.id === tv2.id);
  assert.equal((await req(PAPPA, `/api/remote/devices/${tv2.id}/watch?from=${phone.id}`, { method: 'DELETE' })).status, 200);
  await req(MAMMA, '/api/remote/state', { method: 'POST', body: { device: tv2.id, state: st } });
  await wait(150);
  assert.ok(!phone.events.some(e => e.ev === 'status' && e.data.id === tv2.id && e.data.state), 'ingen status efter avslutad bevakning');
  // En barnprofil kan inte rapportera en vuxentitel (läget töms)
  const kid = await sse(LISA, 'Lisas');
  await req(LISA, '/api/remote/state', { method: 'POST', body: { device: kid.id, state: { ...st, itemId: ADULT_EP } } });
  assert.equal(remote._devices.get(kid.id).state, null);
  for (const c of [phone, tv2, kid]) c.close();
});

test('städning: stängda, döda och utloggade anslutningar', async () => {
  // Stängd anslutning: försvinner ur listan direkt
  const a = await sse(MAMMA, 'Stängs');
  a.close();
  await wait(100);
  assert.ok(!(await list(MAMMA)).some(d => d.id === a.id));
  // Kommando till frånkopplad enhet
  assert.equal((await cmd(MAMMA, a.id, { pause: true })).status, 409);
  // Död anslutning utan close-händelse (halvöppen): städningen kastar ut den och glömmer enheten efter en minut
  const b = await sse(MAMMA, 'Halvöppen');
  const d = remote._devices.get(b.id);
  d.conn = { res: { destroyed: true, writableEnded: false, writableLength: 0, destroy() {}, write() { throw new Error('död'); }, end() {} }, hb: null };
  remote.sweep();
  assert.equal(d.conn, null);
  assert.ok(remote._devices.has(b.id), 'finns kvar en stund (omladdning)');
  d.offline = Date.now() - 61e3;
  remote.sweep();
  assert.ok(!remote._devices.has(b.id));
  b.close();
  // Utloggad (sessionen borttagen): stängs med "closed" vid städningen
  const t = auth.createSession(MAMMA, 'app');
  const c = await sse(MAMMA, 'Loggas ut', { token: t });
  D.run('DELETE FROM sessions WHERE token=?', remote._devices.get(c.id).tokenHash);
  remote.sweep();
  await c.next('closed');
  assert.ok(!(await list(MAMMA)).some(x => x.id === c.id));
  c.close();
});
