// Uppspelningsval per konto: spårval (ljud/undertexter), undertextlägen, automatisk överhoppning och API:t
// /api/me/playback-prefs + förvalen i /api/items/:id och /playback. Serverdelen kräver ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-pbp-'));
const MEDIA = path.join(ROOT, 'media'), CONFIG = path.join(ROOT, 'config');
const PORT = 23000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}`;
const PW = 'Testlösen-2026!';
let srv, cookie = '';

process.env.CONFIG_DIR = path.join(ROOT, 'unitconfig');
process.env.TRANSCODE_DIR = path.join(ROOT, 'unit-tc');
const pp = await import('../server/playprefs.js');
const { skipPlan, nextPlan } = await import('../web/js/player/autoskip.js');

// ---------------- spårval ----------------
const A = (index, lang, extra = {}) => ({ index, type: 'audio', lang, title: null, default: false, ...extra });
const S = (id, lang, extra = {}) => ({ id, lang, forced: false, hi: false, bitmap: false, pgs: false, label: lang || id, ...extra });
const P = (o = {}) => pp.normalize(o);

test('langKey: tre bokstäver (B/T) blir två, okänt blir null', () => {
  assert.equal(pp.langKey('swe'), 'sv'); assert.equal(pp.langKey('ger'), 'de'); assert.equal(pp.langKey('deu'), 'de');
  assert.equal(pp.langKey('en-US'), 'en'); assert.equal(pp.langKey('nob'), 'no');
  assert.equal(pp.langKey('und'), null); assert.equal(pp.langKey(''), null); assert.equal(pp.langKey(null), null);
});

test('normalize: giltiga värden, dubbletter bort, felaktiga fält får standard', () => {
  const p = P({ audioLangs: ['swe', 'sv', 'orig', 'EN', 'x!'], subMode: 'nej', subLangs: 'eng,sv,orig', sdh: 'prefer', nextCountdown: '999',
    qualityHome: '720', qualityRemote: 'hög', skipIntro: 1 });
  assert.deepEqual(p.audioLangs, ['sv', 'orig', 'en']);
  assert.deepEqual(p.subLangs, ['en', 'sv']); // orig gäller bara ljud
  assert.equal(p.subMode, 'forced'); assert.equal(p.sdh, 'prefer'); assert.equal(p.nextCountdown, 60);
  assert.equal(p.qualityHome, '720'); assert.equal(p.qualityRemote, 'auto'); assert.equal(p.skipIntro, true);
  assert.equal(P().autoNext, true); assert.equal(P().nextCountdown, 8); assert.equal(P({ nextCountdown: 0 }).nextCountdown, 0);
});

test('ljud: första föredragna språket, originalspråk = standardspåret, annars standardspåret', () => {
  const audios = [A(1, 'eng', { default: true }), A(2, 'swe'), A(3, 'ger')];
  assert.equal(pp.pickAudio(audios, P()).index, 1);
  assert.equal(pp.pickAudio(audios, P({ audioLangs: ['sv', 'en'] })).index, 2);
  assert.equal(pp.pickAudio(audios, P({ audioLangs: ['fr', 'de'] })).index, 3);
  assert.equal(pp.pickAudio(audios, P({ audioLangs: ['orig', 'sv'] })).index, 1);
  assert.equal(pp.pickAudio(audios, P({ audioLangs: ['fr'] })).index, 1);
  // Flera spår på samma språk: standardflaggan avgör, annars filens ordning
  assert.equal(pp.pickAudio([A(1, 'eng'), A(2, 'eng', { default: true })], P({ audioLangs: ['en'] })).index, 2);
  assert.equal(pp.pickAudio([], P()), null);
});

test('ljud: kommentarsspår och syntolkning väljs aldrig automatiskt', () => {
  const audios = [A(1, 'eng', { comment: true, default: true }), A(2, 'swe', { title: 'Syntolkning' }), A(3, 'swe', { vi: true }),
    A(4, 'eng', { title: "Director's Commentary" }), A(5, 'eng', { title: 'Swedish AD' }), A(6, 'eng')];
  assert.equal(pp.pickAudio(audios, P()).index, 6);
  assert.equal(pp.pickAudio(audios, P({ audioLangs: ['sv'] })).index, 6); // bara syntolkning på svenska
  assert.equal(pp.pickAudio(audios, P({ audioLangs: ['orig'] })).index, 6);
  // Har filen inget annat spelas ändå något
  assert.equal(pp.pickAudio([A(1, 'eng', { comment: true })], P()).index, 1);
  // "AD" i titeln bara som eget ord med versaler
  assert.equal(pp.isSpecialAudio({ title: 'Read along' }), false);
});

// Undertexter: e1 eng, e2 eng tvingade, e3 swe, e4 eng SDH, e5 swe PGS, e6 dvdsub swe, e7 kommentar
const SUBS = [S('e1', 'eng'), S('e2', 'eng', { forced: true }), S('e3', 'swe'), S('e4', 'eng', { hi: true }),
  S('e5', 'swe', { bitmap: true, pgs: true }), S('e6', 'swe', { bitmap: true }), S('e7', 'eng', { label: 'Commentary · eng' })];
const eng = A(1, 'eng'), swe = A(2, 'swe'), und = A(3, null);
const pick = (prefs, audio = eng, subs = SUBS, o) => pp.pickSub(subs, audio, P(prefs), o)?.id ?? null;

test('undertexter: Av', () => {
  assert.equal(pick({ subMode: 'off', subLangs: ['sv'] }), null);
});

test('undertexter: Bara tvingade – på ljudets språk, aldrig hela undertexter', () => {
  assert.equal(pick({ subMode: 'forced' }), 'e2');
  assert.equal(pick({ subMode: 'forced', subLangs: ['sv'] }), 'e2');
  // Svensk dubbning: de engelska tvingade hör till originalljudet
  assert.equal(pick({ subMode: 'forced', subLangs: ['sv'] }, swe), null);
  assert.equal(pick({ subMode: 'forced' }, swe, [S('e1', 'swe'), S('e2', 'swe', { forced: true })]), 'e2');
  // Okänt ljudspråk och inga egna språk: vilken tvingad som helst (som förut)
  assert.equal(pick({ subMode: 'forced' }, und), 'e2');
  assert.equal(pick({ subMode: 'forced' }, eng, SUBS.filter(s => !s.forced)), null);
});

test('undertexter: När ljudet är på ett annat språk än mina språk', () => {
  // Engelskt ljud, mina språk = svenska → svenska undertexter (text före PGS)
  assert.equal(pick({ subMode: 'foreign', audioLangs: ['sv'], subLangs: ['sv'] }), 'e3');
  // Ljudspråken räknas också som mina språk: engelska → inga hela undertexter, bara tvingade
  assert.equal(pick({ subMode: 'foreign', audioLangs: ['sv', 'en'], subLangs: ['sv'] }), 'e2');
  // Svenskt ljud → inga hela undertexter
  assert.equal(pick({ subMode: 'foreign', audioLangs: ['sv'], subLangs: ['sv'] }, swe), null);
  // Inga undertexter på mina språk → tvingade
  assert.equal(pick({ subMode: 'foreign', subLangs: ['fi'] }), 'e2');
  // Okänt ljudspråk räknas inte som främmande (och engelska tvingade passar inte till okänt ljud när mitt språk är svenska)
  assert.equal(pick({ subMode: 'foreign', subLangs: ['sv'] }, und), null);
  assert.equal(pick({ subMode: 'foreign', subLangs: ['sv'] }, und, [S('e3', 'swe'), S('e9', null, { forced: true })]), 'e9');
  // Bara ljudspråk angivna: de används som undertextspråk
  assert.equal(pick({ subMode: 'foreign', audioLangs: ['sv'] }), 'e3');
});

test('undertexter: Alltid, i språkordning, SDH föredras eller undviks', () => {
  assert.equal(pick({ subMode: 'always', subLangs: ['sv', 'en'] }), 'e3');
  assert.equal(pick({ subMode: 'always', subLangs: ['fi', 'en'] }), 'e1');
  assert.equal(pick({ subMode: 'always', subLangs: ['en'], sdh: 'prefer' }), 'e4');
  assert.equal(pick({ subMode: 'always', subLangs: ['en'], sdh: 'avoid' }), 'e1');
  // Bara SDH finns: används ändå när SDH undviks
  assert.equal(pick({ subMode: 'always', subLangs: ['en'] }, eng, [S('e4', 'eng', { hi: true }), S('e1', 'eng', { label: 'English SDH' })]), 'e4');
  // SDH känns igen på titeln/filnamnet också
  assert.equal(pp.isSdh(S('x0', 'en', { label: 'en.sdh (fil)' })), true);
  assert.equal(pp.isSdh(S('x0', 'en', { label: 'English' })), false);
  // Inget på mina språk → tvingade (på ljudets språk)
  assert.equal(pick({ subMode: 'always', subLangs: ['fi'] }), 'e2');
});

test('undertexter: bildundertexter och kommentarer', () => {
  const only = [S('e5', 'swe', { bitmap: true, pgs: true }), S('e6', 'swe', { bitmap: true }), S('e7', 'swe', { label: 'Kommentar · swe' })];
  // Utan PGS-stöd (appar, Chromecast): ingen bild – de kräver inbränning
  assert.equal(pick({ subMode: 'always', subLangs: ['sv'] }, eng, only), null);
  // Webbspelaren ritar PGS själv – andra bildformat väljs aldrig automatiskt
  assert.equal(pick({ subMode: 'always', subLangs: ['sv'] }, eng, only, { pgs: true }), 'e5');
  assert.equal(pick({ subMode: 'always', subLangs: ['sv'] }, eng, [S('e6', 'swe', { bitmap: true })], { pgs: true }), null);
  // Text går före PGS på samma språk
  assert.equal(pick({ subMode: 'always', subLangs: ['sv'] }, eng, [only[0], S('e3', 'swe')], { pgs: true }), 'e3');
  assert.equal(pick({ subMode: 'always', subLangs: ['en'] }, eng, [S('e7', 'eng', { comment: true })]), null);
});

test('kvalitet: hemma eget val, utanför hemmet inom administratörens tak', () => {
  assert.deepEqual(pp.autoQuality(P(), false, '1080'), { q: null, cap: null });
  assert.deepEqual(pp.autoQuality(P({ qualityHome: '720' }), false, '480'), { q: '720', cap: null });
  assert.deepEqual(pp.autoQuality(P(), true, '1080'), { q: null, cap: '1080' });
  assert.deepEqual(pp.autoQuality(P({ qualityRemote: '480' }), true, '1080'), { q: null, cap: '480' });
  assert.deepEqual(pp.autoQuality(P({ qualityRemote: 'orig' }), true, '720'), { q: null, cap: '720' });
  assert.equal(pp.minQuality('orig', '1080'), '1080'); assert.equal(pp.minQuality('auto', '720'), '720');
});

// ---------------- automatisk överhoppning ----------------
test('skipPlan: sammanfattning före intro, eftertexter bara med nästa avsnitt, auto bara en gång', () => {
  const pb = { recap: { start: 0, end: 40 }, intro: { start: 30, end: 90 }, credits: 1300, autoSkip: { intro: true, recap: false, credits: true } };
  assert.deepEqual(skipPlan(pb, 10), { kind: 'recap', to: 40, auto: false });
  assert.deepEqual(skipPlan(pb, 50), { kind: 'intro', to: 90, auto: true });
  assert.equal(skipPlan(pb, 89.5), null); // sista sekunden: ingen knapp
  assert.equal(skipPlan(pb, 500), null);
  assert.equal(skipPlan(pb, 1310), null); // inget nästa avsnitt
  assert.deepEqual(skipPlan(pb, 1310, { hasNext: true }), { kind: 'credits', to: 'next', auto: true });
  assert.equal(skipPlan(pb, 1370, { hasNext: true }), null); // efter en minut försvinner knappen
  // Redan överhoppat eller avbrutet: knappen finns kvar men ingen automatik
  assert.deepEqual(skipPlan(pb, 50, { done: new Set(['intro']) }), { kind: 'intro', to: 90, auto: false });
  // Äldre server utan autoSkip: bara knappar
  assert.equal(skipPlan({ intro: { start: 0, end: 60 } }, 5).auto, false);
  assert.equal(skipPlan(null, 5), null);
});

test('nextPlan: nästa avsnitt automatiskt med inställd nedräkning', () => {
  assert.equal(nextPlan({ autoNext: { enabled: true, countdown: 8 } }, false), null);
  assert.deepEqual(nextPlan({ autoNext: { enabled: true, countdown: 15 } }, true), { auto: true, seconds: 15 });
  assert.deepEqual(nextPlan({ autoNext: { enabled: false, countdown: 15 } }, true), { auto: false, seconds: 15 });
  assert.deepEqual(nextPlan({ autoNext: { enabled: true, countdown: 0 } }, true), { auto: true, seconds: 0 });
  assert.deepEqual(nextPlan({}, true), { auto: true, seconds: 8 }); // äldre server
});

// ---------------- API mot en riktig server ----------------
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
async function req(p, { method = 'GET', body, auth = true } = {}) {
  const h = {};
  if (cookie && auth) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FILMER = path.join(MEDIA, 'Filmer');
/** Film med tre ljudspår (eng standard, swe, eng kommentar) och fyra undertexter (eng, eng tvingade, swe, eng SDH) */
function multiTrackFile(file, dir) {
  const srt = (n, text) => { const f = path.join(dir, `s${n}.srt`); fs.writeFileSync(f, `1\n00:00:00,500 --> 00:00:05,000\n${text}\n`); return f; };
  const subs = [srt(0, 'English'), srt(1, 'Forced'), srt(2, 'Svenska'), srt(3, '[MUSIC] English SDH')];
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-f', 'lavfi', '-i', 'sine=frequency=500',
    '-f', 'lavfi', '-i', 'sine=frequency=700', ...subs.flatMap(s => ['-i', s]), '-t', '6',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4', '-map', '5', '-map', '6', '-map', '7',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=swe', '-metadata:s:a:2', 'language=eng', '-metadata:s:a:2', 'title=Commentary',
    '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', 'comment',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=eng', '-metadata:s:s:2', 'language=swe', '-metadata:s:s:3', 'language=eng',
    '-metadata:s:s:3', 'title=SDH', '-disposition:s:0', '0', '-disposition:s:1', 'forced', '-disposition:s:2', '0', '-disposition:s:3', 'hearing_impaired', file);
}

before(async () => {
  if (!hasFfmpeg) return;
  fs.mkdirSync(FILMER, { recursive: true });
  multiTrackFile(path.join(FILMER, 'Spår (2021).mkv'), ROOT);
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), CONFIG_DIR: CONFIG, MEDIA_ROOT: MEDIA, TRANSCODE_DIR: path.join(ROOT, 'tc'), HTTPS_PORT: String(PORT + 1) },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await sleep(200); } }
});
after(() => { srv?.kill(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);

let id;
t('API: uppspelningsval sparas per konto och styr förvalen', async () => {
  assert.equal((await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } })).status, 200);
  assert.equal((await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: FILMER } })).status, 200);
  const lib = (await req('/api/libraries')).data.find(l => l.type === 'movie');
  for (let i = 0; i < 60 && !id; i++) { await sleep(500); id = (await req(`/api/libraries/${lib.id}/items`)).data.items?.[0]?.id; }
  assert.ok(id, 'filmen skannades');

  assert.equal((await req('/api/me/playback-prefs', { auth: false })).status, 401);
  let p = (await req('/api/me/playback-prefs')).data;
  assert.equal(p.saved, false); assert.equal(p.subMode, 'forced'); assert.deepEqual(p.audioLangs, []); assert.equal(p.remoteCap, '1080');

  // Standard: filens standardspår (engelska) och de tvingade engelska undertexterna
  let it = (await req(`/api/items/${id}`)).data;
  assert.equal(it.audio.length, 3);
  assert.equal(it.audio.find(a => a.index === 3).comment, true, 'kommentarsspåret märks vid skanningen');
  assert.equal(it.defaultAudio, 1); assert.equal(it.defaultSub, 'e5');
  let pb = (await req(`/api/items/${id}/playback?info=1`)).data;
  assert.equal(pb.defaultAudio, 1); assert.equal(pb.defaultSub, 'e5'); assert.equal(pb.audioSelected, '1');
  assert.deepEqual(pb.autoSkip, { intro: false, recap: false, credits: false });
  assert.deepEqual(pb.autoNext, { enabled: true, countdown: 8 });

  // Svenska först: ljudet väljs av servern när klienten inte skickar audio= (apparna)
  p = (await req('/api/me/playback-prefs', { method: 'PUT', body: { audioLangs: ['swe', 'en'], subMode: 'foreign', subLangs: ['sv'], skipIntro: true, nextCountdown: 5 } })).data;
  assert.deepEqual(p.audioLangs, ['sv', 'en']); assert.equal(p.saved, true); assert.equal(p.skipIntro, true);
  pb = (await req(`/api/items/${id}/playback?info=1`)).data;
  assert.equal(pb.audioSelected, '2'); assert.equal(pb.defaultAudio, 2);
  assert.equal(pb.defaultSub, null, 'svenskt ljud: varken hela eller engelska tvingade undertexter');
  assert.deepEqual(pb.autoSkip, { intro: true, recap: false, credits: false });
  assert.deepEqual(pb.autoNext, { enabled: true, countdown: 5 });
  // Klientens eget val går före
  pb = (await req(`/api/items/${id}/playback?info=1&audio=1`)).data;
  assert.equal(pb.audioSelected, '1'); assert.equal(pb.defaultSub, 'e5', 'engelska är ett av mina språk: bara tvingade');
  // Bara svenska som mitt språk: engelskt ljud → svenska undertexter
  await req('/api/me/playback-prefs', { method: 'PUT', body: { audioLangs: ['sv'] } });
  pb = (await req(`/api/items/${id}/playback?info=1&audio=1`)).data;
  assert.equal(pb.defaultSub, 'e6');
  // Kommentarsspåret väljs aldrig, inte ens med engelska först
  await req('/api/me/playback-prefs', { method: 'PUT', body: { audioLangs: ['en'], subMode: 'always', subLangs: ['en'], sdh: 'prefer' } });
  it = (await req(`/api/items/${id}`)).data;
  assert.equal(it.defaultAudio, 1); assert.equal(it.defaultSub, 'e7');
  await req('/api/me/playback-prefs', { method: 'PUT', body: { sdh: 'avoid' } });
  assert.equal((await req(`/api/items/${id}`)).data.defaultSub, 'e4');
  await req('/api/me/playback-prefs', { method: 'PUT', body: { subMode: 'off' } });
  assert.equal((await req(`/api/items/${id}/playback?info=1`)).data.defaultSub, null);
  // PUT ändrar bara skickade fält
  p = (await req('/api/me/playback-prefs')).data;
  assert.deepEqual(p.subLangs, ['en']); assert.equal(p.skipIntro, true); assert.equal(p.subMode, 'off');
});

t('API: standardkvalitet hemma gäller när klienten väljer Auto', async () => {
  await req('/api/me/playback-prefs', { method: 'PUT', body: { qualityHome: '360' } });
  assert.equal((await req(`/api/items/${id}/playback?info=1`)).data.quality, '360');
  assert.equal((await req(`/api/items/${id}/playback?info=1&q=auto`)).data.quality, '360');
  assert.equal((await req(`/api/items/${id}/playback?info=1&q=orig`)).data.quality, 'orig');
  await req('/api/me/playback-prefs', { method: 'PUT', body: { qualityHome: 'auto' } });
  assert.equal((await req(`/api/items/${id}/playback?info=1`)).data.quality, 'orig');
});

t('API: felaktiga val avvisas eller rättas', async () => {
  assert.equal((await req('/api/me/playback-prefs', { method: 'PUT', body: [1, 2] })).status, 400);
  const p = (await req('/api/me/playback-prefs', { method: 'PUT', body: { subMode: '<script>', qualityRemote: '9999', audioLangs: 'sv,<b>' } })).data;
  assert.equal(p.subMode, 'forced'); assert.equal(p.qualityRemote, 'auto'); assert.deepEqual(p.audioLangs, ['sv']);
});
