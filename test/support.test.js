// Feedback och felrapporter (server/support.js, routes/support.js): en vanlig användares ärende väntar på granskning
// och syns aldrig för teamet (/api/v1/support) förrän en administratör godkänt det; administratörens eget syns direkt;
// avslagna syns aldrig; nyckeln behöver behörigheten support och kan bara svara på godkända ärenden; man ser bara sina
// egna ärenden; storleks- och antalsgränser; export och radering av kontot tar med ärendena; notisen till
// administratören (utan text och namn, högst en per timme); öppna ett avslutat ärende igen; gallring av avslutade ärenden.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-support-'));
process.env.CONFIG_DIR = path.join(ROOT, 'config');
process.env.TRANSCODE_DIR = path.join(ROOT, 'tc');
process.env.MEDIA_ROOT = path.join(ROOT, 'media');
process.env.WATCH_FILES = '0';
fs.mkdirSync(path.join(ROOT, 'media'), { recursive: true });
const D = await import('../server/db.js');
const auth = await import('../server/auth.js');
const app = await import('../server/app.js');
const keys = await import('../server/apikeys.js');
const S = await import('../server/support.js');
const privacy = await import('../server/privacy.js');
const { VERSION } = await import('../server/updates.js');

const srv = http.createServer(app.handle);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const PW = 'Support-test-2026!';
const mk = async (name, o = {}) => Number(D.run('INSERT INTO users(name,pass,is_admin,created,parent_id,max_age) VALUES(?,?,?,0,?,?)', name, await auth.hashPw(PW), o.admin ? 1 : 0, o.parent ?? null, o.maxAge ?? null).lastInsertRowid);
const ADMIN = await mk('Ägaren Hemlig', { admin: true });
const BO = await mk('Bo Hemligsson');
const EVA = await mk('Eva Annansdotter');
const BARN = await mk('Lillan', { parent: BO, maxAge: 7 });
const SPAM = await mk('Spam');
const GONE = await mk('Flyttar');
const hdr = (id) => ({ authorization: 'Bearer ' + auth.createSession(id, 'app') });
const H = { admin: hdr(ADMIN), bo: hdr(BO), eva: hdr(EVA), barn: hdr(BARN), spam: hdr(SPAM), gone: hdr(GONE) };
const req = async (p, { method = 'GET', body, headers = {}, raw } = {}) => {
  const h = { ...headers }; if (body || raw) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
};
const post = (p, headers, body) => req(p, { method: 'POST', headers, body: body || {} });
const KEY = { 'x-api-key': keys.create({ name: 'Teamet', scopes: ['support'] }, ADMIN).key };
const OTHER = { 'x-api-key': keys.create({ name: 'Väggskärmen', scopes: ['nowplaying', 'library'] }, ADMIN).key };
const team = async () => (await req('/api/v1/support', { headers: KEY })).data.tickets;
const inTeam = async (id) => (await team()).some(t => t.id === id);

// ---------- notis till administratören, öppna igen och gallring ----------
const notify = await import('../server/notify.js');
// En notistjänst "utanför servern" (webhook): allt som tas emot sparas här
const hooks = [];
const hookSrv = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { hooks.push(b); s.end('ok'); }); });
await new Promise(r => hookSrv.listen(0, '127.0.0.1', r));
after(() => hookSrv.close());
const waitHooks = async (n) => { for (let i = 0; i < 100 && hooks.length < n; i++) await new Promise(r => setTimeout(r, 20)); return hooks.length; };
const quiet = () => new Promise(r => setTimeout(r, 150));
// Gränsen per timme gäller vanliga användare – testerna nedan skapar många ärenden
const hourPassed = () => D.run('UPDATE support_tickets SET created=created-3700 WHERE by_admin=0');

// En film som alla får se och en som barnprofilen inte får se (åldersgräns)
const LIB = Number(D.run("INSERT INTO libraries(name,type,path) VALUES('Filmer','movie',?)", path.join(ROOT, 'media')).lastInsertRowid);
const item = (title, age) => Number(D.run("INSERT INTO items(library_id,kind,title,year,path,added,container,vcodec,acodec,height,age) VALUES(?,'movie',?,2020,?,0,'mkv','hevc','eac3',1080,?)",
  LIB, title, `/m/${title}.mkv`, age).lastInsertRowid);
const FILM = item('Barnfilmen', 0), VUXEN = item('Vuxenfilmen', 15);
const CTX = { route: '#/item/' + FILM + '?t=abcdef0123456789abcdef0123456789', ua: 'Mozilla/5.0 (Test) från 192.168.1.20', screen: '390×844 @3', lang: 'sv', itemId: FILM,
  errors: ['TypeError: x is undefined (/m/js/views/item.js:12) token=hemlig123hemlig', 'Bearer bxtv_abcdefghijklmnopqrstuvwxyz0123456789ABCD'] };

test('vanlig användare: ärendet väntar på granskning och syns inte för teamet förrän administratören godkänt det', async () => {
  const r = await post('/api/support', H.bo, { kind: 'bug', area: 'uppspelning', title: 'Bilden fryser', text: 'Tryckte på Spela.\nBilden frös efter en minut.', tech: true, context: CTX });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.status, 'pending');
  assert.equal(r.data.message, 'Ärendet är mottaget och väntar på granskning.');
  const id = r.data.id;
  assert.equal(await inTeam(id), false, 'väntande ärende syns aldrig i API:t');
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'working' })).status, 404, 'teamet kan inte svara på ett ärende som inte är godkänt');
  // Användaren ser sitt ärende och vad som bifogades
  const mine = (await req('/api/support', { headers: H.bo })).data.tickets;
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'pending'); assert.equal(mine[0].kind, 'bug'); assert.equal(mine[0].area, 'uppspelning');
  const c = mine[0].context;
  assert.equal(c.version, VERSION);
  assert.equal(c.page, '#/item/' + FILM, 'frågedelen (token) tas bort ur sidan');
  assert.equal(c.screen, '390×844 @3');
  assert.equal(c.browser, 'Mozilla/5.0 (Test) från <ip>');
  assert.equal(S.buildContext({ id: BO }, { ua: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36' }, 'idea', () => true).browser, 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36', 'versionsnumret är kvar');
  assert.deepEqual(c.title, { id: FILM, kind: 'movie', name: 'Barnfilmen', year: 2020, format: 'mkv / hevc / eac3 / 1080p' });
  const flat = JSON.stringify(c);
  assert.ok(!/192\.168|hemlig123|bxtv_abc/.test(flat), 'IP-adresser, token och nycklar maskeras: ' + flat);
  assert.ok(!/"ip"/i.test(JSON.stringify(D.get('SELECT * FROM support_tickets WHERE id=?', id))), 'ingen IP-adress sparas på ärendet');
  // Administratören ser det först i listan, med det som skulle lämna servern
  const L = (await req('/api/admin/support', { headers: H.admin })).data;
  assert.equal(L.review, 1); assert.equal(L.tickets[0].id, id); assert.equal(L.tickets[0].user, 'Bo Hemligsson');
  assert.equal(L.tickets[0].outgoing.from, 'användare'); assert.ok(!JSON.stringify(L.tickets[0].outgoing).includes('Hemligsson'));
  assert.equal((await req('/api/support/count', { headers: H.admin })).data.review, 1);
  assert.equal((await req('/api/support/count', { headers: H.bo })).data.review, undefined, 'bara administratörer får siffran för granskning');
  assert.equal((await req('/api/admin/support', { headers: H.bo })).status, 403);
  assert.equal((await post(`/api/admin/support/${id}/approve`, H.bo)).status, 403, 'bara administratörer godkänner');
  // Administratören ändrar texten och godkänner: exakt den texten lämnar servern
  const ap = await post(`/api/admin/support/${id}/approve`, H.admin, { title: 'Bilden fryser efter en minut', text: 'Spelade en film. Bilden frös efter en minut.' });
  assert.equal(ap.status, 200, ap.text); assert.equal(ap.data.status, 'approved');
  const t = (await team()).find(x => x.id === id);
  assert.ok(t, 'godkänt ärende syns för teamet');
  assert.deepEqual(Object.keys(t).sort(), ['area', 'context', 'created', 'from', 'id', 'kind', 'status', 'text', 'thread', 'title', 'updated', 'version']);
  assert.equal(t.text, 'Spelade en film. Bilden frös efter en minut.'); assert.equal(t.title, 'Bilden fryser efter en minut');
  assert.equal(t.kind, 'bug'); assert.equal(t.area, 'Uppspelning'); assert.equal(t.from, 'användare'); assert.equal(t.status, 'approved');
  const all = JSON.stringify(await req('/api/v1/support', { headers: KEY }));
  assert.ok(!/Hemlig|Annansdotter|Lillan|user_id|"user"/.test(all), 'inga namn på användare i API:t');
  // Användaren ser sin egen text och vad som skickades
  const own = (await req('/api/support/' + id, { headers: H.bo })).data;
  assert.equal(own.status, 'approved'); assert.equal(own.text, 'Tryckte på Spela.\nBilden frös efter en minut.'); assert.equal(own.sentText, 'Spelade en film. Bilden frös efter en minut.');
  assert.equal((await post(`/api/admin/support/${id}/approve`, H.admin)).status, 409, 'redan granskat');
  assert.equal((await req(`/api/admin/support/${id}`, { method: 'PUT', headers: H.admin, body: { text: 'x' } })).status, 409, 'texten kan inte ändras efter godkännandet');
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='support_approved'"));
});

test('administratörens eget ärende är godkänt direkt och syns för teamet', async () => {
  const r = await post('/api/support', H.admin, { kind: 'idea', area: 'musik', text: 'Visa låttexter i miniatyrspelaren.', tech: false });
  assert.equal(r.status, 200, r.text); assert.equal(r.data.status, 'approved'); assert.equal(r.data.message, 'Ärendet är skickat till teamet.');
  const t = (await team()).find(x => x.id === r.data.id);
  assert.ok(t); assert.equal(t.from, 'admin'); assert.equal(t.kind, 'idea'); assert.equal(t.area, 'Musik');
  assert.equal(t.context, null, 'utan krysset för teknisk information bifogas inget');
});

test('avslaget ärende syns aldrig för teamet, och administratören kan låta bli att skicka tekniken', async () => {
  const a = (await post('/api/support', H.eva, { text: 'Det här ska inte vidare.', context: CTX })).data.id;
  const rj = await post(`/api/admin/support/${a}/reject`, H.admin, { note: 'Det här är ett fel i din webbläsare.' });
  assert.equal(rj.status, 200, rj.text); assert.equal(rj.data.status, 'rejected');
  assert.equal(await inTeam(a), false);
  assert.equal((await post('/api/v1/support/' + a, KEY, { status: 'fixed' })).status, 404);
  const own = (await req('/api/support/' + a, { headers: H.eva })).data;
  assert.equal(own.status, 'rejected'); assert.equal(own.thread[0].text, 'Det här är ett fel i din webbläsare.', 'förklaringen syns för användaren');
  assert.equal((await post(`/api/admin/support/${a}/approve`, H.admin)).status, 409, 'ett avslaget ärende kan inte godkännas i efterhand');
  const b = (await post('/api/support', H.eva, { text: 'Utan teknik, tack.', context: CTX })).data.id;
  assert.ok((await req('/api/support/' + b, { headers: H.eva })).data.context);
  assert.equal((await post(`/api/admin/support/${b}/approve`, H.admin, { withContext: false })).status, 200);
  assert.equal((await team()).find(x => x.id === b).context, null);
  // Ta bort: borta för alla
  assert.equal((await req('/api/admin/support/' + b, { method: 'DELETE', headers: H.bo })).status, 403);
  assert.equal((await req('/api/admin/support/' + b, { method: 'DELETE', headers: H.admin })).status, 200);
  assert.equal(await inTeam(b), false); assert.equal((await req('/api/support/' + b, { headers: H.eva })).status, 404);
});

test('API-nyckeln: behörigheten support krävs, vanlig inloggning gäller inte och nyckeln når inget annat', async () => {
  assert.equal((await req('/api/v1/support', { headers: OTHER })).status, 403, 'nyckel utan behörigheten support');
  assert.equal((await post('/api/v1/support/1', OTHER, { status: 'working' })).status, 403);
  assert.equal((await req('/api/v1/support')).status, 401);
  assert.equal((await req('/api/v1/support', { headers: H.admin })).status, 401, 'administratörens inloggning gäller inte i /api/v1');
  assert.equal((await req('/api/v1/now-playing', { headers: KEY })).status, 403, 'supportnyckeln får inte läsa Nu spelas');
  for (const p of ['/api/support', '/api/admin/support', '/api/support/1']) assert.equal((await req(p, { headers: KEY })).status, 401, p);
  assert.equal((await post('/api/support', KEY, { text: 'x' })).status, 401, 'en nyckel kan inte skapa ärenden');
  assert.ok('support' in (await req('/api/apikeys', { headers: H.admin })).data.scopes);
});

test('teamet svarar: working, needinfo → svar som granskas → fixed med version; ogiltigt och för stort nekas', async () => {
  const id = (await post('/api/support', H.bo, { text: 'Ljudet försvinner i Live-TV.', area: 'livetv' })).data.id;
  for (const st of ['working', 'needinfo', 'fixed']) assert.equal((await post('/api/v1/support/' + id, KEY, { status: st, reply: 'x' })).status, 404, `väntande: ${st}`);
  assert.equal((await post('/api/v1/support/999999', KEY, { status: 'working' })).status, 404);
  assert.equal((await post('/api/v1/support/abc', KEY, { status: 'working' })).status, 404);
  await post(`/api/admin/support/${id}/approve`, H.admin);
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'approved' })).status, 400, 'teamet kan inte sätta approved');
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'rejected' })).status, 400);
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'needinfo' })).status, 400, 'needinfo kräver en fråga');
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'working', reply: 'x'.repeat(S.MAX_REPLY + 1) })).status, 400, 'för långt svar');
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'fixed', version: '1.2.3<script>' })).status, 400, 'ogiltig version');
  assert.equal((await req('/api/v1/support/' + id, { method: 'POST', headers: KEY, raw: JSON.stringify({ status: 'working', reply: 'y'.repeat(20000) }) })).status, 413, 'för stor förfrågan');
  assert.equal((await req('/api/v1/support/' + id, { method: 'PUT', headers: KEY, body: { status: 'working' } })).status, 404, 'bara GET och POST finns');
  assert.equal((await req('/api/v1/support/' + id, { method: 'DELETE', headers: KEY })).status, 404);
  const w = await post('/api/v1/support/' + id, KEY, { status: 'working', reply: 'Vi tittar på det.' });
  assert.equal(w.status, 200, w.text); assert.equal(w.data.status, 'working'); assert.ok(!('user' in w.data));
  assert.equal((await req('/api/support/' + id, { headers: H.bo })).data.status, 'working');
  // Svar går bara när teamet bett om mer information
  assert.equal((await post(`/api/support/${id}/reply`, H.bo, { text: 'Hallå?' })).status, 409);
  await post('/api/v1/support/' + id, KEY, { status: 'needinfo', reply: 'Vilken kanal gäller det?' });
  let own = (await req('/api/support/' + id, { headers: H.bo })).data;
  assert.equal(own.status, 'needinfo'); assert.equal(own.canReply, true); assert.equal(own.thread.at(-1).text, 'Vilken kanal gäller det?');
  assert.equal((await req('/api/support/count', { headers: H.bo })).data.needinfo, 1);
  assert.equal((await post(`/api/support/${id}/reply`, H.eva, { text: 'Inte mitt ärende' })).status, 404, 'någon annan kan inte svara');
  assert.equal((await post(`/api/support/${id}/reply`, H.bo, { text: 'z'.repeat(S.MAX_REPLY + 1) })).status, 400);
  const rp = await post(`/api/support/${id}/reply`, H.bo, { text: 'SVT1, varje kväll.' });
  assert.equal(rp.status, 200, rp.text); assert.equal(rp.data.thread.at(-1).pending, true); assert.equal(rp.data.canReply, false);
  assert.equal((await post(`/api/support/${id}/reply`, H.bo, { text: 'En gång till' })).status, 409, 'ett svar i taget väntar på granskning');
  // Svaret syns inte för teamet förrän administratören godkänt det
  let t = (await team()).find(x => x.id === id);
  assert.equal(t.status, 'needinfo'); assert.ok(!JSON.stringify(t).includes('SVT1'), 'väntande svar syns inte i API:t');
  assert.equal((await req('/api/support/count', { headers: H.admin })).data.review, 1);
  assert.equal((await post(`/api/admin/support/${id}/reply/approve`, H.bo)).status, 403);
  const ok = await post(`/api/admin/support/${id}/reply/approve`, H.admin, { text: 'SVT1, på kvällarna.' });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.data.status, 'approved');
  t = (await team()).find(x => x.id === id);
  assert.deepEqual(t.thread.map(m => [m.from, m.text]), [['team', 'Vi tittar på det.'], ['team', 'Vilken kanal gäller det?'], ['användare', 'SVT1, på kvällarna.']]);
  // Åtgärdat: teamets svar och versionen når användaren, och ärendet lämnar teamets lista
  const fx = await post('/api/v1/support/' + id, KEY, { status: 'fixed', reply: 'Rättat – ljudspåret väljs om.', version: '1.2.3' });
  assert.equal(fx.status, 200, fx.text);
  own = (await req('/api/support/' + id, { headers: H.bo })).data;
  assert.equal(own.status, 'fixed'); assert.equal(own.version, '1.2.3'); assert.equal(own.thread.at(-1).text, 'Rättat – ljudspåret väljs om.'); assert.equal(own.thread.at(-1).from, 'team');
  assert.equal(await inTeam(id), false, 'avslutade ärenden listas inte');
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'working' })).status, 404, 'ett avslutat ärende kan inte ändras av nyckeln');
  // Administratören svarar själv på en fråga: går vidare direkt; ett avslaget svar från en användare försvinner
  const a2 = (await post('/api/support', H.admin, { text: 'Admins ärende' })).data.id;
  await post('/api/v1/support/' + a2, KEY, { status: 'needinfo', reply: 'Vilken version?' });
  assert.equal((await post(`/api/support/${a2}/reply`, H.admin, { text: 'Den senaste.' })).data.status, 'approved');
  assert.equal((await team()).find(x => x.id === a2).thread.at(-1).from, 'admin');
  const e2 = (await post('/api/support', H.eva, { text: 'Evas ärende' })).data.id;
  await post(`/api/admin/support/${e2}/approve`, H.admin);
  await post('/api/v1/support/' + e2, KEY, { status: 'needinfo', reply: 'Mer?' });
  await post(`/api/support/${e2}/reply`, H.eva, { text: 'Olämpligt svar' });
  assert.equal((await post(`/api/admin/support/${e2}/reply/reject`, H.admin)).status, 200);
  assert.ok(!JSON.stringify(await team()).includes('Olämpligt'));
  assert.equal((await req('/api/support/' + e2, { headers: H.eva })).data.canReply, true, 'användaren kan svara igen');
});

test('man ser bara sina egna ärenden – även barnprofiler, huvudkontot och administratörer under Mina ärenden', async () => {
  const kid = await post('/api/support', H.barn, { text: 'Min film startar inte', context: { itemId: VUXEN, route: '#/item/' + VUXEN } });
  assert.equal(kid.status, 200, kid.text); assert.equal(kid.data.status, 'pending', 'barnprofiler får rapportera, och det granskas');
  const kc = (await req('/api/support/' + kid.data.id, { headers: H.barn })).data.context;
  assert.equal(kc.title, undefined, 'en titel som profilen inte får se följer inte med');
  assert.deepEqual((await req('/api/support', { headers: H.barn })).data.tickets.map(t => t.id), [kid.data.id]);
  const boIds = (await req('/api/support', { headers: H.bo })).data.tickets.map(t => t.id);
  assert.ok(boIds.length && !boIds.includes(kid.data.id), 'huvudkontot ser inte profilens ärenden');
  for (const who of [H.eva, H.bo, H.admin]) assert.equal((await req('/api/support/' + kid.data.id, { headers: who })).status, 404);
  assert.equal((await req('/api/support/' + boIds[0], { headers: H.eva })).status, 404, 'någon annans ärende finns inte');
  assert.ok(!(await req('/api/support', { headers: H.admin })).data.tickets.some(t => t.id === kid.data.id));
  assert.equal((await req('/api/support')).status, 401); assert.equal((await post('/api/support', {}, { text: 'x' })).status, 401);
  // Förhandsvisningen ger samma innehåll som sedan sparas
  const pv = (await post('/api/support/context', H.bo, { kind: 'bug', context: CTX })).data.context;
  assert.equal(pv.title.name, 'Barnfilmen'); assert.equal(pv.page, '#/item/' + FILM); assert.equal(pv.pageErrors.length, 2);
  assert.equal((await post('/api/support/context', H.bo, { kind: 'idea', context: CTX })).data.context.pageErrors, undefined, 'förslag: inga fel från sidan');
});

test('gränser: text, rubrik, storlek på förfrågan och antal ärenden per timme', async () => {
  assert.equal((await post('/api/support', H.spam, { text: '   ' })).status, 400, 'tomt meddelande');
  assert.equal((await post('/api/support', H.spam, { text: 'x'.repeat(S.MAX_TEXT + 1) })).status, 400);
  assert.equal((await post('/api/support', H.spam, { text: 'ok', title: 'r'.repeat(S.MAX_TITLE + 1) })).status, 400);
  assert.equal((await req('/api/support', { method: 'POST', headers: H.spam, raw: JSON.stringify({ text: 'ok', context: { errors: ['e'.repeat(40000)] } }) })).status, 413);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id=?', SPAM).n, 0, 'nekade ärenden sparas inte');
  // Okänd typ och okänt område faller tillbaka; stor teknisk information kapas
  const big = await post('/api/support', H.spam, { kind: 'hack', area: '<b>', text: 'ok', context: { ua: 'u'.repeat(3000), route: 'r'.repeat(3000), screen: '<script>', errors: Array(20).fill('e '.repeat(450)) } });
  assert.equal(big.status, 200, big.text);
  const row = D.get('SELECT * FROM support_tickets WHERE id=?', big.data.id);
  assert.equal(row.kind, 'bug'); assert.equal(row.area, 'annat'); assert.ok(row.context.length <= S.MAX_CONTEXT, String(row.context.length));
  assert.equal(JSON.parse(row.context).screen, undefined); assert.ok(JSON.parse(row.context).pageErrors.length <= S.MAX_ERRORS);
  for (let i = 1; i < S.MAX_PER_HOUR; i++) assert.equal((await post('/api/support', H.spam, { text: 'nr ' + i })).status, 200);
  const over = await post('/api/support', H.spam, { text: 'en för mycket' });
  assert.equal(over.status, 429, over.text);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id=?', SPAM).n, S.MAX_PER_HOUR);
  // Efter en timme går det igen
  D.run('UPDATE support_tickets SET created=created-3700 WHERE user_id=?', SPAM);
  assert.equal((await post('/api/support', H.spam, { text: 'en timme senare' })).status, 200);
  // Text sparas som den är (ingen HTML tolkas på servern – webben escapar) och kommer tillbaka oförändrad
  const x = (await post('/api/support', H.admin, { text: '<img src=x onerror=alert(1)>', title: '<b>fet</b>' })).data.id;
  const t = (await team()).find(y => y.id === x);
  assert.equal(t.text, '<img src=x onerror=alert(1)>'); assert.equal(t.title, '<b>fet</b>');
});

test('GDPR: exporten tar med ärendena och raderat konto lämnar inga ärenden kvar – inte heller för teamet', async () => {
  assert.ok(privacy.userRefs().some(r => r.table === 'support_tickets' && r.col === 'user_id' && r.onDelete === 'CASCADE'));
  const id = (await post('/api/support', H.gone, { text: 'Mitt sista ärende', context: CTX })).data.id;
  await post(`/api/admin/support/${id}/approve`, H.admin);
  assert.equal(await inTeam(id), true);
  const ex = await req('/api/me/export', { headers: H.gone });
  assert.equal(ex.status, 200);
  assert.equal(ex.data.tables.support_tickets.length, 1); assert.equal(ex.data.tables.support_tickets[0].text, 'Mitt sista ärende');
  assert.ok(!(await req('/api/me/export', { headers: H.eva })).text.includes('Mitt sista ärende'), 'andras export innehåller inte ärendet');
  const del = await req('/api/me', { method: 'DELETE', headers: H.gone, body: { password: PW } });
  assert.equal(del.status, 200, del.text);
  assert.equal(D.get('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id=?', GONE).n, 0);
  assert.equal(await inTeam(id), false);
  assert.ok(!JSON.stringify(D.all('SELECT * FROM support_tickets')).includes('Mitt sista ärende'));
});

test('notis: ärenden och svar att granska ger en notis utan text och namn, högst en per timme, och kan slås av', async () => {
  assert.ok(notify.EVENTS.support, 'händelsen finns bland notiserna'); assert.ok(notify.DEFAULT_EVENTS.split(',').includes('support'), 'på från början');
  assert.ok('support' in (await req('/api/notify', { headers: H.admin })).data.allEvents, 'administratören kan välja den');
  D.setSetting('notify_kind', 'webhook'); D.setSetting('notify_url', `http://127.0.0.1:${hookSrv.address().port}/hook`);
  D.setSetting('notify_events', 'security,support'); D.setSetting('public_url', 'https://tv.example.org');
  S._notice.last = 0; hourPassed();
  // Administratörens eget ärende godkänns direkt – inget att granska, ingen notis
  await post('/api/support', H.admin, { text: 'Inget att granska' });
  await quiet(); assert.equal(hooks.length, 0);
  // En användares ärende: notis direkt
  const id = (await post('/api/support', H.eva, { title: 'Grannens wifi', text: 'Hemlig text om grannens wifi-lösenord', context: CTX })).data.id;
  assert.equal(await waitHooks(1), 1, 'notisen gick ut');
  const n1 = JSON.parse(hooks[0]);
  assert.equal(n1.title, 'BraXhn TV: Feedback att granska');
  assert.match(n1.message, /väntar på granskning/); assert.match(n1.message, /Administration → Support/);
  assert.match(n1.message, /https:\/\/tv\.example\.org\/#\/admin\/support/, 'länk till Administration → Support');
  for (const s of ['Hemlig', 'wifi', 'Grannens', 'Eva', 'Annansdotter', 'Barnfilmen', String(id)]) assert.ok(!hooks[0].includes(s), `notisen innehåller inte ${s}: ${hooks[0]}`);
  // Fler ärenden inom timmen: ingen ny notis direkt, men en samlad när timmen gått
  for (let i = 0; i < 6; i++) assert.equal((await post('/api/support', i % 2 ? H.bo : H.barn, { text: 'Storm ' + i })).status, 200);
  await quiet(); assert.equal(hooks.length, 1, 'ingen notisstorm');
  assert.equal(S.noticeWaiting(), true, 'en samlad notis väntar');
  S._noticeFlush();
  assert.equal(await waitHooks(2), 2);
  assert.match(JSON.parse(hooks[1]).message, /^\d+ ärenden väntar på granskning/);
  assert.ok(!hooks[1].includes('Storm'));
  // Ett svar från en användare på teamets fråga ger också en notis
  await post(`/api/admin/support/${id}/approve`, H.admin);
  await post('/api/v1/support/' + id, KEY, { status: 'needinfo', reply: 'Vilken router?' });
  S._notice.last = 0;
  await post(`/api/support/${id}/reply`, H.eva, { text: 'Hemlig router-modell' });
  assert.equal(await waitHooks(3), 3);
  assert.match(JSON.parse(hooks[2]).message, /1 svar/); assert.ok(!hooks[2].includes('router'));
  // Utan adress utifrån: ingen länk, bara var man hittar det
  assert.equal(S.noticeText({ tickets: 1, replies: 0 }, ''), 'Ett ärende väntar på granskning. Inget skickas till teamet förrän du har godkänt det. Öppna Administration → Support.');
  // Avslaget i notisinställningarna: ingenting går ut
  await req('/api/notify', { method: 'PUT', headers: H.admin, body: { events: ['security'] } });
  S._notice.last = 0;
  hourPassed();
  await post('/api/support', H.bo, { text: 'Tyst' });
  await quiet(); assert.equal(hooks.length, 3, 'avslaget – ingen notis');
  // Inget kvar att granska när timmen gått: ingen notis
  for (const k of S.adminList().filter(r => r.status === 'pending')) S.reject(k.id);
  S.reviewReply(id, true);
  D.setSetting('notify_events', 'support'); S._notice.last = Date.now();
  const e2 = (await post('/api/support', H.bo, { text: 'Snart granskad' })).data.id;
  S.reject(e2); S._noticeFlush();
  await quiet(); assert.equal(hooks.length, 3, 'allt granskat innan timmen gått – ingen notis');
  D.setSetting('notify_kind', 'none'); D.setSetting('public_url', '');
});

test('öppna igen: åtgärdat eller avslaget ärende går tillbaka till godkänt eller väntar – väntar syns inte för teamet', async () => {
  hourPassed();
  const id = (await post('/api/support', H.bo, { text: 'Undertexterna hamnar fel.' })).data.id;
  assert.equal((await post(`/api/admin/support/${id}/reopen`, H.admin, { to: 'approved' })).status, 409, 'ett öppet ärende kan inte öppnas igen');
  await post(`/api/admin/support/${id}/approve`, H.admin);
  assert.equal((await post(`/api/admin/support/${id}/reopen`, H.admin, { to: 'approved' })).status, 409);
  await post('/api/v1/support/' + id, KEY, { status: 'fixed', reply: 'Rättat.', version: '1.3.1' });
  assert.equal((await post(`/api/admin/support/${id}/reopen`, H.bo, { to: 'approved' })).status, 403, 'bara administratörer');
  assert.equal((await post(`/api/admin/support/${id}/reopen`, H.admin, { to: 'working' })).status, 400);
  assert.equal((await post('/api/admin/support/999999/reopen', H.admin, { to: 'approved' })).status, 404);
  // Till väntar: borta för teamet, nyckeln kan inte svara, administratören granskar på nytt (och kan ändra texten)
  const p = await post(`/api/admin/support/${id}/reopen`, H.admin, { to: 'pending', note: 'Intern anteckning: kolla med Bo först' });
  assert.equal(p.status, 200, p.text); assert.equal(p.data.status, 'pending'); assert.equal(p.data.version, null);
  assert.equal(await inTeam(id), false, 'återöppnat som väntar syns inte i teamets API');
  assert.equal((await post('/api/v1/support/' + id, KEY, { status: 'working' })).status, 404);
  assert.equal((await req('/api/support/' + id, { headers: H.bo })).data.status, 'pending', 'användaren ser statusen');
  assert.ok((await req('/api/admin/support', { headers: H.admin })).data.tickets.find(k => k.id === id).status === 'pending');
  assert.equal((await req(`/api/admin/support/${id}`, { method: 'PUT', headers: H.admin, body: { text: 'Undertexterna hamnar fel igen i 1.3.1.' } })).status, 200);
  await post(`/api/admin/support/${id}/approve`, H.admin);
  let t = (await team()).find(x => x.id === id);
  assert.equal(t.text, 'Undertexterna hamnar fel igen i 1.3.1.');
  assert.ok(!JSON.stringify(t).includes('Intern anteckning'), 'anteckningen vid återöppning till väntar stannar på servern');
  // Till godkänt: syns för teamet direkt, med förklaringen och markeringen reopened
  await post('/api/v1/support/' + id, KEY, { status: 'fixed', version: '1.3.2' });
  const a = await post(`/api/admin/support/${id}/reopen`, H.admin, { to: 'approved', note: 'Felet kom tillbaka i 1.3.2.' });
  assert.equal(a.status, 200, a.text); assert.equal(a.data.status, 'approved');
  t = (await team()).find(x => x.id === id);
  assert.ok(t, 'syns för teamet igen'); assert.equal(t.version, null);
  assert.deepEqual([t.thread.at(-1).from, t.thread.at(-1).status, t.thread.at(-1).text], ['admin', 'reopened', 'Felet kom tillbaka i 1.3.2.']);
  assert.ok(!/Hemligsson|"user"/.test(JSON.stringify(t)));
  assert.equal((await req('/api/support/' + id, { headers: H.bo })).data.status, 'approved');
  assert.ok(D.get("SELECT 1 FROM audit WHERE event='support_reopened'"));
  // Ett avslaget ärende kan öppnas igen för granskning – den lokala förklaringen följer inte med till teamet
  const r = (await post('/api/support', H.eva, { text: 'Avslaget av misstag.' })).data.id;
  await post(`/api/admin/support/${r}/reject`, H.admin, { note: 'Fel i webbläsaren.' });
  assert.equal((await post(`/api/admin/support/${r}/reopen`, H.admin, {})).data.status, 'pending', 'standard: tillbaka till granskning');
  assert.equal(await inTeam(r), false);
  await post(`/api/admin/support/${r}/approve`, H.admin);
  t = (await team()).find(x => x.id === r);
  assert.ok(t); assert.ok(!JSON.stringify(t).includes('Fel i webbläsaren'));
});

test('gallring: åtgärdade och avslagna ärenden äldre än gränsen tas bort, öppna och väntande ärenden rörs aldrig', async () => {
  assert.equal(privacy.supportDays(), 180);
  const old = D.now() - 181 * 86400;
  const mk = async (who, status) => {
    const id = (await post('/api/support', who, { text: 'Gammalt ' + status })).data.id;
    D.run('UPDATE support_tickets SET status=?, updated=?, created=? WHERE id=?', status, old, old, id);
    return id;
  };
  const ids = {};
  for (const s of ['fixed', 'rejected', 'pending', 'approved', 'working', 'needinfo']) ids[s] = await mk(H.admin, s);
  const fresh = await mk(H.admin, 'fixed'); D.run('UPDATE support_tickets SET updated=? WHERE id=?', D.now() - 10 * 86400, fresh);
  const r = privacy.prune();
  assert.ok(r.support >= 2, JSON.stringify(r));
  const left = (id) => !!D.get('SELECT 1 FROM support_tickets WHERE id=?', id);
  assert.equal(left(ids.fixed), false); assert.equal(left(ids.rejected), false);
  for (const s of ['pending', 'approved', 'working', 'needinfo']) assert.equal(left(ids[s]), true, `${s} ligger kvar`);
  assert.equal(left(fresh), true, 'nyligen avslutat ligger kvar');
  assert.equal((await req('/api/privacy', { headers: H.bo })).data.retention.supportDays, 180, 'sidan Integritet visar tiden');
  // Miljövariabeln gäller när inget är sparat; inställningen (Administration → Integritet) har golv och tak
  process.env.SUPPORT_DAYS = '400'; assert.equal(privacy.supportDays(), 400);
  process.env.SUPPORT_DAYS = '1'; assert.equal(privacy.supportDays(), 30); delete process.env.SUPPORT_DAYS;
  assert.equal((await req('/api/settings', { method: 'PUT', headers: H.admin, body: { supportDays: 5 } })).status, 200);
  assert.equal(privacy.supportDays(), 30);
  assert.equal((await req('/api/settings', { headers: H.admin })).data.supportDays, 30);
  await req('/api/settings', { method: 'PUT', headers: H.admin, body: { supportDays: 180 } });
  for (const s of ['pending', 'approved', 'working', 'needinfo']) D.run('DELETE FROM support_tickets WHERE id=?', ids[s]);
});
