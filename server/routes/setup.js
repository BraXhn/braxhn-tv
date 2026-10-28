// Installationsguiden (webbens #/setup, web/js/views/setup.js): sparat läge (vilka steg som är klara),
// förslag på bibliotek ur mapparna under MEDIA_ROOT, test av TMDB-nyckel och hårdvaruomkodning.
// Allt kräver administratör på betrott nät (admin). Första kontot sätter setup_done=0 (routes/auth.js).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { getSetting, setSetting, all, get } from '../db.js';
import { send, readJson, fail, isHttps } from '../util.js';
import { audit, require2faRemote, quickConnectOn } from '../auth.js';
import { tmdbCheck, hasTmdb, status as scanStatus } from '../scanner.js';
import * as st from '../stream.js';
import * as acme from '../acme.js';
import * as pk from '../passkeys.js';
import { route, admin, adminAnywhere } from '../http/router.js';
import { insideMedia, MEDIA_ROOT, ctx, setupPending } from '../http/context.js';
import { librariesWithRoots, rootsOf } from '../libpaths.js';

export const STEPS = ['welcome', 'metadata', 'libraries', 'hardware', 'remote', 'household', 'done'];

function stepState() {
  let s = {};
  try { s = JSON.parse(getSetting('setup_steps', '{}')) || {}; } catch {}
  return Object.fromEntries(STEPS.map(k => [k, s[k] === 'done' || s[k] === 'skipped' ? s[k] : null]));
}
const serverTz = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Läget som guiden och sammanfattningen visar (inga hemligheter – bara om nycklar finns)
function checks(c) {
  const libs = all(`SELECT l.id, l.name, l.type, l.path, l.home_video,
    CASE WHEN l.type='music' THEN (SELECT COUNT(*) FROM albums a WHERE a.library_id=l.id)
    WHEN l.type='audiobook' THEN (SELECT COUNT(*) FROM books b WHERE b.library_id=l.id)
    ELSE (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind IN('movie','show') AND i.version_of IS NULL) END AS count
    FROM libraries l ORDER BY l.name`).map(l => ({ ...l, paths: rootsOf(l) }));
  const users = all('SELECT id, name, is_admin, parent_id, max_age FROM users ORDER BY name');
  const me = c.user.parent_id || c.user.id;
  return {
    tmdb: hasTmdb(), tmdbFromEnv: !getSetting('tmdb_key') && !!process.env.TMDB_API_KEY,
    language: getSetting('language', 'sv-SE'),
    libraries: libs, scanning: !!scanStatus.running,
    hw: { wanted: st.hwStatus.wanted, active: st.hwStatus.active, error: st.hwStatus.error, hint: st.hwStatus.hint || null },
    publicUrl: getSetting('public_url', process.env.PUBLIC_URL || ''), https: isHttps(c.req), cert: !!acme.certInfo(),
    require2faRemote: require2faRemote(), adminAnywhere: adminAnywhere(),
    my2fa: !!c.user.totp_enabled || pk.hasPasskey(me),
    accounts: users.filter(u => !u.parent_id).map(u => ({ id: u.id, name: u.name, admin: !!u.is_admin })),
    profiles: users.filter(u => u.parent_id).map(u => ({ id: u.id, name: u.name, kid: u.max_age != null, maxAge: u.max_age })),
    quickConnect: quickConnectOn()
  };
}

route('GET', '/api/setup', admin, (c) => send(c.res, 200, {
  steps: STEPS, state: stepState(), current: STEPS.includes(getSetting('setup_step', '')) ? getSetting('setup_step') : 'welcome',
  done: !setupPending(), timezone: serverTz(), mediaRoot: MEDIA_ROOT, checks: checks(c)
}));
// Spara läget: { current } (var man är), { step, status: 'done'|'skipped' }, { done: true|false } (hela guiden)
route('PUT', '/api/setup', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.current != null) { if (!STEPS.includes(b.current)) return fail(c.res, 400, 'Okänt steg'); setSetting('setup_step', b.current); }
  if (b.step != null) {
    if (!STEPS.includes(b.step) || !['done', 'skipped', null].includes(b.status ?? null)) return fail(c.res, 400, 'Okänt steg');
    const s = stepState(); s[b.step] = b.status ?? null;
    setSetting('setup_steps', JSON.stringify(s));
  }
  if (b.done != null) {
    const was = !setupPending();
    setSetting('setup_done', b.done ? '1' : '0');
    if (!!b.done !== was) audit('settings_changed', { ...ctx(c), detail: b.done ? (b.skipped ? 'installationsguiden hoppades över' : 'installationsguiden klar') : 'installationsguiden öppnad igen' });
  }
  send(c.res, 200, { ok: true, state: stepState(), done: !setupPending() });
});

// ---------- TMDB: kontrollera en nyckel utan att spara den ----------
route('POST', '/api/setup/tmdb-test', admin, async (c) => {
  const b = await readJson(c.req);
  const r = await tmdbCheck(typeof b.key === 'string' ? b.key : '');
  r.ok ? send(c.res, 200, { ok: true }) : fail(c.res, 400, r.error);
});

// ---------- Förslag på bibliotek ----------
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpe?g|flv|iso|vob)$/i;
const AUDIO = /\.(mp3|flac|m4a|ogg|oga|opus|wav|aac|wma|aiff?|ape|wv)$/i;
const BOOK = /\.(m4b|aax)$/i;
const EPISODE = /(^|[^a-z0-9])s\d{1,2}[ ._-]?e\d{1,3}|(^|[^0-9])\d{1,2}x\d{2}([^0-9]|$)/i;
const SEASON_DIR = /^(season|säsong|sasong|staffel|saison|series)[ ._-]?\d{1,2}$|^s\d{1,2}$/i;
// Mappnamn → typ (svenska och engelska, även "TV-serier", "Kids Movies", "Barnfilmer")
const W = (re) => new RegExp(`(^|[^a-zåäö])(${re})([^a-zåäö]|$)`, 'i');
const BY_NAME = [
  ['audiobook', /ljudb[öo]c?ker|ljudbok|audio[ ._-]?books?|h[öo]rb[üu]cher/i],
  ['show', W('serier|series|shows?|tv|tv[ ._-]?serier|tv[ ._-]?shows|anime|program')],
  ['movie', /film|movie|bio(graf)?$/i],
  ['music', /musik|music|l[åa]tar|mp3|flac/i]
];
const NICE = { movie: 'Filmer', show: 'Serier', music: 'Musik', audiobook: 'Ljudböcker' };
// Hemvideor (egna filmer från mobilen/kameran): filmbibliotek utan TMDB, sorterat på datum och mappar
const HOME = /hemvideo|hem[ ._-]?video|home[ ._-]?vid(eo|eos)?|familje?(film|video)|mobilvideo|egna[ ._-]?(filmer|videor)|videoklipp|camcorder/i;
const GENERIC = /^(movies?|films?|filmer|tv|tv[ ._-]?shows|shows|series|serier|music|musik|audio[ ._-]?books?|ljudb[öo]cker)$/i;

/** Räknar mediafiler i en mapp (högst 3 nivåer ner och ett begränsat antal poster – stora diskar ska inte väckas helt) */
async function sample(dir) {
  const n = { videos: 0, episodes: 0, audio: 0, books: 0 };
  let seen = 0;
  const walk = async (d, depth, inSeason) => {
    if (seen > 800 || depth > 3) return;
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 800) return;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) await walk(path.join(d, e.name), depth + 1, inSeason || SEASON_DIR.test(e.name));
      else if (VIDEO.test(e.name)) { n.videos++; if (inSeason || EPISODE.test(e.name)) n.episodes++; }
      else if (BOOK.test(e.name)) n.books++;
      else if (AUDIO.test(e.name)) n.audio++;
    }
  };
  await walk(dir, 0, false);
  return n;
}
function guess(name, n) {
  const byName = BY_NAME.find(([, re]) => re.test(name))?.[0] || null;
  let byContent = null;
  if (n.books && n.books >= n.audio * 0.3) byContent = 'audiobook';
  else if (n.videos) byContent = n.episodes >= Math.max(2, n.videos * 0.3) ? 'show' : 'movie';
  else if (n.audio) byContent = 'music';
  // Namnet vinner – utom när innehållet tydligt säger emot (minst 5 filer)
  const files = n.videos + n.audio + n.books;
  if (byName && (!byContent || byContent === byName || files < 5)) return { type: byName, by: 'name' };
  if (byContent) return { type: byContent, by: byName ? 'content-over-name' : 'content' };
  return { type: null, by: null };
}
// Förklaringen följer webbens språk för profilen (users.lang)
function reasonText(g, n, en = false) {
  const parts = [];
  if (n.videos) parts.push(en ? `${n.videos} video files${n.episodes ? `, ${n.episodes} with episode numbers (SxxEyy)` : ''}` : `${n.videos} videofiler${n.episodes ? `, ${n.episodes} med avsnittsnummer (SxxEyy)` : ''}`);
  if (n.audio) parts.push(en ? `${n.audio} audio files` : `${n.audio} ljudfiler`);
  if (n.books) parts.push(en ? `${n.books} audiobooks (m4b)` : `${n.books} ljudböcker (m4b)`);
  const found = parts.length ? parts.join(', ') : en ? 'no media files found yet' : 'inga mediafiler hittades ännu';
  if (g.by === 'name') return en ? `The folder name – ${found}` : `Mappnamnet – ${found}`;
  if (g.by === 'content') return en ? `The content: ${found}` : `Innehållet: ${found}`;
  if (g.by === 'content-over-name') return en ? `The content contradicts the name: ${found}` : `Innehållet säger emot namnet: ${found}`;
  return found;
}

route('GET', '/api/setup/suggest', admin, async (c) => {
  const base = insideMedia(c.q.get('path') || MEDIA_ROOT);
  if (!base) return fail(c.res, 400, `Mappen måste finnas och ligga under ${MEDIA_ROOT}`);
  // Alla bibliotekens mappar (ett bibliotek kan ha flera, libpaths.js)
  const libs = librariesWithRoots();
  const covering = (p) => libs.find(l => l.roots.some(r => p === r || p.startsWith(r + path.sep) || r.startsWith(p + path.sep)));
  const out = [];
  const consider = async (dir, label, depth) => {
    // Symboliska länkar som pekar ut ur MEDIA_ROOT hoppas över (samma kontroll som när biblioteket läggs till)
    const real = insideMedia(dir);
    if (!real || out.length >= 60) return;
    try { if (!(await fs.promises.stat(real)).isDirectory()) return; } catch { return; }
    // Mapp vars namn inte säger något men som har undermappar som gör det (t.ex. /media/data/Movies): en nivå ner
    if (depth < 1 && !BY_NAME.some(([, re]) => re.test(path.basename(dir)))) {
      const kids = await subdirs(real);
      if (kids.some(k => BY_NAME.some(([, re]) => re.test(k)))) { for (const k of kids) await consider(path.join(real, k), `${label}/${k}`, depth + 1); return; }
    }
    const n = await sample(real);
    const g = guess(path.basename(dir), n);
    const lib = covering(real);
    const homeVideo = HOME.test(path.basename(dir)) && (!g.type || g.type === 'movie');
    out.push({ name: label, path: real, type: homeVideo ? 'movie' : g.type, by: g.by || (homeVideo ? 'name' : null), reason: reasonText(g, n, c.user.lang === 'en'), ...n,
      suggestedName: g.type && GENERIC.test(path.basename(dir)) ? NICE[g.type] : path.basename(dir),
      // homeVideo: läggs till som hemvideor; library/libraryId: mappen ingår redan i ett bibliotek
      homeVideo, library: lib ? lib.name : null, libraryId: lib ? lib.id : null });
  };
  const top = await subdirs(base);
  for (const d of top.slice(0, 50)) await consider(path.join(base, d), d, 0);
  // Mediafiler direkt i mappen (utan undermappar) – då föreslås mappen själv
  if (!top.length) await consider(base, path.basename(base), 1);
  send(c.res, 200, { root: MEDIA_ROOT, path: base, parent: base === MEDIA_ROOT ? null : path.dirname(base), suggestions: out });
});
async function subdirs(d) {
  try { return (await fs.promises.readdir(d, { withFileTypes: true })).filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b, 'sv')); }
  catch { return []; }
}

// ---------- Hårdvaruomkodning: vad servern ser och en kort testkodning ----------
let encodersCache = null;
const run = (cmd, args, ms = 5000) => new Promise(r => execFile(cmd, args, { timeout: ms }, (e, o) => r(e ? null : String(o))));
async function encoders() {
  if (!encodersCache) {
    const o = await run('ffmpeg', ['-hide_banner', '-encoders']) || '';
    encodersCache = ['h264_vaapi', 'h264_qsv', 'h264_nvenc', 'libx264'].filter(e => new RegExp(`\\b${e}\\b`).test(o));
  }
  return encodersCache;
}
route('GET', '/api/setup/hw', admin, async (c) => {
  let dri = [];
  try { dri = fs.readdirSync('/dev/dri').filter(f => /^(renderD|card)\d+$/.test(f)).sort(); } catch {}
  const nvidiaDev = fs.existsSync('/dev/nvidiactl') || fs.existsSync('/dev/nvidia0');
  const gpus = nvidiaDev ? ((await run('nvidia-smi', ['-L'], 4000)) || '').split('\n').map(s => s.replace(/\s*\(UUID:.*\)$/, '').trim()).filter(Boolean) : [];
  const enc = await encoders();
  const cpu = os.cpus();
  const recommend = nvidiaDev ? 'nvenc' : dri.some(d => d.startsWith('renderD')) ? (/intel/i.test(cpu[0]?.model || '') ? 'qsv' : 'vaapi') : 'none';
  send(c.res, 200, {
    wanted: st.hwStatus.wanted, active: st.hwStatus.active, error: st.hwStatus.error, hint: st.hwStatus.hint || null,
    dri, nvidia: { device: nvidiaDev, gpus, visible: process.env.NVIDIA_VISIBLE_DEVICES || null },
    encoders: enc, cpu: { model: cpu[0]?.model || 'okänd', cores: cpu.length }, recommend
  });
});
let testing = false;
route('POST', '/api/setup/hw-test', admin, async (c) => {
  const b = await readJson(c.req);
  const mode = String(b.mode || st.hwStatus.active || 'none');
  if (!['none', 'vaapi', 'qsv', 'nvenc'].includes(mode)) return fail(c.res, 400, 'Okänt läge');
  if (testing) return fail(c.res, 409, 'Ett test pågår redan');
  testing = true;
  try {
    const r = await st.testEncode(mode);
    console.log(`[hårdvara] testkodning ${mode}: ${r.ok ? `${r.fps} bilder/s` : 'misslyckades – ' + r.error}`);
    send(c.res, 200, r);
  } finally { testing = false; }
});
