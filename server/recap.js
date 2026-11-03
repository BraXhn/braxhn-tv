// "Det här har hänt": en kort sammanfattning av förra säsongen (eller de senaste avsnitten) innan man fortsätter en
// serie, ihopklippt ur de egna filerna (webben: knappen på seriesidan och erbjudandet i spelaren, player/recap.js).
//
// Urvalet (ren databasläsning, billigt – görs vid varje fråga):
//   - Spoilergräns: bara avsnitt som profilen redan sett (progress.watched) och som ligger före avsnittet man ska se.
//     Första avsnittet i en säsong → förra säsongen (de sedda avsnitten); annars de senaste RECENT sedda avsnitten
//     i samma säsong (saknas de: förra säsongen).
//   - Scener: repliksökningens index (sub_lines, med undertextsynken) ger fönster på 5–12 s med sammanhängande
//     repliker. Poäng för namn (versaler mitt i en mening) och nyckelord ur avsnittens och seriens handling (TMDB),
//     för repliktäthet och för var i avsnittet scenen ligger (senare = viktigare). Säsongens sista avsnitt väger
//     tyngst. Utan undertexter: jämnt fördelade fönster med låg poäng.
//   - Undviks: intro, "tidigare i serien"-segmentet och eftertexterna (intro.js), avsnittets första och sista sekund,
//     repliker med svordomar och scener profilen hoppar över (familjefiltret), och – när klippet görs – svart bild
//     och tystnad (ffmpeg blackdetect/silencedetect med lägsta prioritet; underkända klipp ersätts av reserver).
//
// Sammanfattningen är HLS: titelskylten "Tidigare i <serie>" (t.ts, kodad) och ett TS-segment per klipp med
// EXT-X-DISCONTINUITY emellan, så att varje klipp kan ha egen upplösning och kodning. Ett klipp kopieras (stream
// copy) när källan är H.264 i 8 bitar utan HDR/fläta, högst 1080 rader och med en nyckelbild högst 0,5 s före
// starten – annars snabb omkodning (veryfast, högst 720 rader) med korta övertoningar i bilden. Ljudet kodas alltid
// om (AAC stereo) med övertoning in och ut och tystade svordomar för profiler med familjefiltret på.
//
// Cache: en rad i recaps per nyckel = sha256 av urvalet (avsnitten med filernas mtime, klippens tider och reserver),
// familjefiltret, språket och titeln – alltså per serie/säsong och profilens sett-läge. Profiler med samma läge
// delar sammanfattningen. Filerna i /config/recaps/<id>/ (index.m3u8 skrivs sist), lagringsgräns RECAP_MAX_MB
// (äldst använda tas bort först), oanvända tas bort efter RECAP_KEEP_DAYS dagar. Ett jobb i taget (RECAP_JOBS).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { all, get, run, now, CONFIG } from './db.js';
import { SAFE_IN, streamsOf } from './stream.js';
import { lowPriority } from './util.js';
import { wordsOf } from './sublines.js';
import { copyStart } from './moments.js';
import * as family from './familyfilter.js';
import * as jobs from './jobs.js';

export const DIR = path.join(CONFIG, 'recaps');
const envNum = (k, def, lo, hi) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, v)) : def; };
const MAX_JOBS = envNum('RECAP_JOBS', 1, 1, 2);          // samtidiga sammanfattningar (ffmpeg)
const MAX_QUEUE = 4;                                     // väntande (fler → 429)
export const maxBytes = () => envNum('RECAP_MAX_MB', 2048, 50, 1e6) * 1048576;
const KEEP_DAYS = envNum('RECAP_KEEP_DAYS', 30, 1, 3650);
export const offerDays = () => envNum('RECAP_OFFER_DAYS', 14, 1, 3650); // uppehåll innan spelaren erbjuder den
export const VERSION = 1;                                // höj när urvalet eller filerna ändras (nya nycklar)
export const MIN_CLIP = 5, MAX_CLIP = 12;                // klippets längd (sekunder)
export const MIN_CLIPS = 6, MAX_CLIPS = 12, LEAST = 2;   // klipp per sammanfattning (LEAST = färre → ingen)
const RECENT = 4;                                        // senaste sedda avsnitt mitt i en säsong
const TITLE_SECS = 3, FADE = 0.4;
const STATE = ['pending', 'ready', 'failed'];
const err = (status, message) => Object.assign(new Error(message), { status });
const round = (x) => Math.round(x * 1000) / 1000;

// ---------------- vilka avsnitt ----------------
const EPS = `SELECT i.id, i.path, i.mtime, i.size, i.duration, i.season, i.episode, i.title, i.overview, i.intro_start, i.intro_end,
  i.recap_start, i.recap_end, i.credits_start, i.streams, i.hdr, i.library_id, i.parent_id, i.age, COALESCE(p.watched, 0) AS watched,
  COALESCE(p.position, 0) AS position, p.updated FROM items i LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=?
  WHERE i.parent_id=? AND i.kind='episode' AND i.version_of IS NULL ORDER BY i.season, i.episode`;
/**
 * Vad en sammanfattning för profilen uid skulle visa inför titeln id (serie eller avsnitt): { show, target, eps, scope,
 * season, first } eller { show, reason } när det inte finns något att sammanfatta. Serie → nästa avsnitt (samma val som
 * seriesidans ▶-knapp). eps = de sedda avsnitten som ingår, i ordning.
 */
export function scopeFor(uid, id) {
  const it = get(`SELECT id, kind, parent_id FROM items WHERE id=? AND kind IN ('show','episode')`, id);
  if (!it) return null;
  const show = get(`SELECT * FROM items WHERE id=? AND kind='show'`, it.kind === 'show' ? it.id : it.parent_id);
  if (!show) return null;
  const all2 = all(EPS, uid, show.id);
  const target = it.kind === 'episode' ? all2.find(e => e.id === it.id)
    : all2.find(e => !e.watched && e.position > 0) || all2.find(e => !e.watched) || null;
  if (!target) return { show, reason: 'Du har sett hela serien' };
  if (!target.season) return { show, target, reason: 'Specialavsnitt har ingen sammanfattning' };
  const inSeason = all2.filter(e => e.season === target.season);
  const first = target.episode === Math.min(...inSeason.map(e => e.episode));
  const seen = (e) => e.watched && e.path && e.duration > 0;
  const prevSeason = () => {
    const s = Math.max(0, ...all2.filter(e => e.season > 0 && e.season < target.season && seen(e)).map(e => e.season));
    return s ? { season: s, eps: all2.filter(e => e.season === s && seen(e)) } : null;
  };
  let pick = null, scope = 'season';
  if (!first) {
    const eps = inSeason.filter(e => e.episode < target.episode && seen(e)).slice(-RECENT);
    if (eps.length) { pick = { season: target.season, eps }; scope = 'episodes'; }
  }
  pick ??= prevSeason();
  if (!pick) return { show, target, reason: 'Du har inte sett något före det här avsnittet' };
  // Säsongens sista avsnitt (av alla, inte bara de sedda) – väger tyngst när profilen sett det
  const lastEp = Math.max(...all2.filter(e => e.season === pick.season).map(e => e.episode));
  return { show, target, eps: pick.eps, scope, season: pick.season, first, lastEp, lastWatch: Math.max(0, ...all2.filter(e => e.id !== target.id).map(e => e.updated || 0)) };
}

// ---------------- scener ----------------
const STOP = new Set(('about after again also because before being could their there these those through under where which while would ' +
  'första andra efter eller genom hennes deras medan mellan sedan under under kommer måste också redan aldrig alltid något några ' +
  'season episode säsong avsnitt').split(' '));
/** Nyckelord ur handlingarna: Map ord → vikt (namn = versal mitt i en mening väger 3, andra ord på minst 5 tecken 1) */
export function keywordsOf(texts) {
  const out = new Map();
  for (const text of texts) {
    for (const sent of String(text || '').normalize('NFC').split(/[.!?…:;]\s+|\n+/)) {
      const toks = sent.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
      toks.forEach((w, i) => {
        const lw = wordsOf(w)[0]; if (!lw || STOP.has(lw)) return;
        const name = i > 0 && /^\p{Lu}\p{Ll}/u.test(w) && lw.length >= 3;
        if (!name && lw.length < 5) return;
        out.set(lw, Math.max(out.get(lw) || 0, name ? 3 : 1));
      });
    }
  }
  return out;
}
/** Replikerna för ett avsnitt ur indexet: en undertext (svenska, engelska, annars flest repliker), synken pålagd */
function cuesFor(itemId) {
  const subs = all(`SELECT si.sub, si.lang, si.lines, ss.shift, ss.ratio FROM sub_index si
    LEFT JOIN sub_sync ss ON ss.item_id=si.item_id AND ss.sub=si.sub AND ss.sub_mtime=si.fmtime WHERE si.item_id=? AND si.state=1 AND si.lines > 0`, itemId);
  if (!subs.length) return { cues: [], lang: null };
  const rank = (s) => { const l = family.langOf(s.lang); return l === 'sv' ? 0 : l === 'en' ? 1 : 2; };
  const s = subs.sort((a, b) => rank(a) - rank(b) || b.lines - a.lines)[0];
  const ratio = s.ratio || 1, shift = s.shift || 0;
  return { lang: s.lang, cues: all('SELECT s, e, text FROM sub_lines WHERE item_id=? AND sub=? ORDER BY s', itemId, s.sub).map(c => ({ s: c.s * ratio + shift, e: c.e * ratio + shift, text: c.text })) };
}
/** Intervallen i avsnittet som aldrig ska med: intro, sammanfattningen i avsnittet, eftertexterna och kanterna */
export function blockedOf(ep, extra = []) {
  const d = ep.duration || 0, out = [[0, 1], [Math.max(0, d - 1), d]];
  if (ep.intro_end > (ep.intro_start ?? 0)) out.push([ep.intro_start || 0, ep.intro_end]);
  if (ep.recap_end > (ep.recap_start ?? 0)) out.push([ep.recap_start || 0, ep.recap_end]);
  if (ep.credits_start > 0) out.push([ep.credits_start, d]);
  return [...out, ...extra];
}
const hits = (a, b, list, pad = 0.5) => list.some(([x, y]) => b > x - pad && a < y + pad);
/**
 * Kandidatfönster i ett avsnitt: [{ item, s, e, score }]. cues = repliker [{ s, e, text }], kw = nyckelorden,
 * blocked = intervall att undvika, bad(text) = repliken får inte vara med (svordomar med familjefiltret).
 */
export function windowsOf(ep, cues, kw, blocked, bad = () => false) {
  const d = ep.duration || 0, out = [];
  if (d < MIN_CLIP + 2) return out;
  const fit = (s, e) => {
    // Minst MIN_CLIP: förläng mest efter repliken, inom avsnittet
    if (e - s < MIN_CLIP) { const need = MIN_CLIP - (e - s); s = Math.max(1, s - need * 0.3); e = Math.min(d - 1, s + MIN_CLIP); s = Math.max(1, e - MIN_CLIP); }
    return [round(s), round(e)];
  };
  if (cues.length) {
    for (let i = 0; i < cues.length; i++) {
      let j = i; const s0 = Math.max(1, cues[i].s - 0.4);
      while (j + 1 < cues.length && cues[j + 1].s - cues[j].e < 2 && cues[j + 1].e + 0.6 - s0 <= MAX_CLIP) j++;
      const [s, e] = fit(s0, Math.min(d - 1, cues[j].e + 0.6));
      if (e - s < MIN_CLIP - 0.01 || e - s > MAX_CLIP + 0.01 || hits(s, e, blocked)) continue;
      const lines = cues.slice(i, j + 1);
      // Repliker som bara delvis ligger i fönstret räknas också (svordomen får inte höras i kanten)
      if (cues.some(c => c.e > s && c.s < e && bad(c.text))) continue;
      let score = 0;
      for (const w of wordsOf(lines.map(c => c.text).join(' '))) score += kw.get(w) || 0;
      score += Math.min(3, lines.length * 0.5) + 1.5 * (s / d);
      out.push({ item: ep.id, s, e, score });
    }
  } else {
    // Utan undertexter: jämnt fördelade fönster, låg poäng (senare i avsnittet först)
    const step = Math.max(10, (d - 4) / 5); // ≥ 10 s: fönstren (6 s) får 4 s emellan som choose() kräver
    for (let s0 = 2; s0 + 6 <= d - 1; s0 += step) {
      const [s, e] = fit(s0, s0 + 6);
      if (!hits(s, e, blocked)) out.push({ item: ep.id, s, e, score: 0.1 + 0.2 * (s / d) });
    }
  }
  return out;
}
/**
 * Väljer klippen: kvot per avsnitt efter vikt (säsongens sista avsnitt 1,6, senaste avsnittet 1,3), sedan de bästa
 * över lag. Fönster i samma avsnitt får inte överlappa (minst 4 s emellan). Ger { clips, spare } i rangordning.
 */
export function choose(perEp, weights, target) {
  const taken = [], spare = [];
  const free = (c) => !taken.some(x => x.item === c.item && c.e > x.s - 4 && c.s < x.e + 4);
  const sumW = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = new Map([...perEp].map(([id, list]) => [id, [...list].sort((a, b) => b.score - a.score)]));
  for (const [id, list] of ranked) {
    const quota = Math.max(1, Math.round(target * (weights.get(id) || 1) / sumW));
    let n = 0;
    for (const c of list) { if (n >= quota || taken.length >= target) break; if (free(c)) { taken.push(c); n++; } }
  }
  const rest = [...ranked.values()].flat().map(c => ({ ...c, w: c.score * (weights.get(c.item) || 1) })).sort((a, b) => b.w - a.w);
  for (const c of rest) {
    if (!free(c)) continue;
    if (taken.length < target) taken.push(c); else if (spare.length < target * 2) spare.push(c);
  }
  return { clips: taken.map(({ item, s, e }) => ({ item, s, e })), spare: spare.map(({ item, s, e }) => ({ item, s, e })) };
}

const userRow = (uid) => get('SELECT id, name, max_age, family_filter, lang FROM users WHERE id=?', uid);
/** Titelskylten på profilens språk */
export const titleOf = (show, lang) => lang === 'en' ? `Previously on ${show.title}` : `Tidigare i ${show.title}`;
/**
 * Hela planen för profilen: scopeFor + valda klipp och nyckeln. Ger { ...scope, plan, key } eller { reason }.
 * Familjefiltret: läget på → inga repliker med svordomar, tystade intervall i ljudet (nyckeln får ff).
 */
export function planFor(uid, id) {
  const sc = scopeFor(uid, id);
  if (!sc || sc.reason) return sc;
  const u = userRow(uid);
  const mode = family.modeFor(u), ff = mode !== 'off';
  const kw = keywordsOf([...sc.eps.map(e => e.overview), sc.show.overview]);
  const perEp = new Map(), weights = new Map();
  sc.eps.forEach((ep, i) => {
    const { cues, lang } = cuesFor(ep.id);
    const skips = mode === 'skip' ? family.skipsFor(ep.id, uid).map(k => [k.start, k.end]) : [];
    const fl = family.langOf(lang);
    perEp.set(ep.id, windowsOf(ep, cues, kw, blockedOf(ep, skips), ff ? (t) => family.hasProfanity(t, fl) : undefined));
    weights.set(ep.id, (ep.episode === sc.lastEp ? 1.6 : 1) * (i === sc.eps.length - 1 ? 1.3 : 1) * (0.85 + 0.15 * (i + 1) / sc.eps.length));
  });
  const target = Math.max(MIN_CLIPS, Math.min(MAX_CLIPS, sc.eps.length * 2));
  const { clips, spare } = choose(perEp, weights, target);
  if (clips.length < LEAST) return { ...sc, reason: 'För lite att visa – avsnitten saknar repliker eller är för korta' };
  const lang = u?.lang === 'en' ? 'en' : 'sv';
  const plan = { v: VERSION, show: sc.show.id, season: sc.season, scope: sc.scope, title: titleOf(sc.show, lang), lang, ff,
    eps: sc.eps.map(e => [e.id, e.mtime || 0, e.size || 0]), clips, spare, want: clips.length };
  const key = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 40);
  return { ...sc, plan, key };
}

// ---------------- ffmpeg ----------------
function ffmpeg(args, { cwd, timeout = 10 * 60e3, label = '', stderr = false } = {}) {
  return new Promise((ok, no) => {
    const p = lowPriority(spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...(stderr ? ['-nostats'] : ['-loglevel', 'error']), ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] }));
    let e = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stderr.on('data', (c) => { if (e.length < (stderr ? 1 << 20 : 4000)) e += c; });
    p.on('error', (x) => { clearTimeout(timer); no(x); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? ok(e) : no(new Error((label ? label + ': ' : '') + (e.trim().split('\n').pop() || 'ffmpeg avbröts'))); });
  });
}
const durationOf = (file) => new Promise((ok) => {
  const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
  let o = ''; p.stdout.on('data', (c) => { o += c; }); p.on('error', () => ok(0)); p.on('close', () => ok(parseFloat(o) || 0));
});
/** Andel svart bild och tystnad i stderr från blackdetect/silencedetect (dur = fönstrets längd) */
export function badShare(stderr, dur) {
  let black = 0, silence = 0, open = null;
  for (const m of String(stderr).matchAll(/black_duration:\s*([\d.]+)|silence_start:\s*(-?[\d.]+)|silence_end:\s*[\d.]+\s*\|\s*silence_duration:\s*([\d.]+)/g)) {
    if (m[1]) black += parseFloat(m[1]);
    else if (m[2] != null) open = Math.max(0, parseFloat(m[2]));
    else { silence += parseFloat(m[3]); open = null; }
  }
  if (open != null) silence += Math.max(0, dur - open); // tystnaden räckte till slutet
  return { black: dur ? black / dur : 0, silence: dur ? silence / dur : 0 };
}
const audioOf = (it) => { const a = streamsOf(it).filter(s => s.type === 'audio'); return a.find(s => s.default) || a[0] || null; };
/** Kontroll före klippet: för mycket svart bild (≥ 35 %) eller tystnad (≥ 60 %) underkänner. Fel i kontrollen = godkänt. */
async function looksOk(it, c) {
  const dur = c.e - c.s, a = audioOf(it);
  try {
    const out = await ffmpeg([...SAFE_IN, '-ss', c.s.toFixed(3), '-t', dur.toFixed(3), '-i', it.path, '-map', '0:v:0', '-vf', 'scale=160:-2,blackdetect=d=0.4:pix_th=0.12',
      ...(a ? ['-map', `0:${a.index}`, '-af', 'silencedetect=n=-45dB:d=1.5'] : []), '-f', 'null', '-'], { stderr: true, timeout: 120e3, label: 'kontrollen' });
    const r = badShare(out, dur);
    return r.black < 0.35 && (!a || r.silence < 0.6);
  } catch { return true; }
}
const SILENT = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
const AUDIO_OUT = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
/** Ett klipp som TS-segment. Ger 'copy' eller 'encode'. */
async function cut(it, c, out, mute, cwd) {
  const v = streamsOf(it).find(s => s.type === 'video');
  const a = audioOf(it);
  const kf = (v?.height || 0) <= 1080 ? await copyStart(it, { s: c.s, e: c.e }, {}) : null;
  const start = kf ?? c.s, dur = c.e - start;
  const fades = [`afade=t=in:st=0:d=${FADE}`, `afade=t=out:st=${Math.max(0, dur - FADE - 0.1).toFixed(3)}:d=${FADE}`];
  const m = (mute || []).filter(([x, y]) => y > start && x < c.e).map(([x, y]) => [Math.max(0, x - start), Math.min(dur, y - start)]);
  const af = [...family.muteFilters(m, 0), ...fades, 'aresample=async=1'].join(',');
  let video;
  if (kf != null) video = ['-map', '0:v:0', '-c:v', 'copy'];
  else {
    const vf = [];
    if (it.hdr) vf.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
    if (/^(tt|bb|tb|bt)$/.test(v?.field || '')) vf.push('yadif=mode=0:deint=interlaced');
    if ((v?.height || 0) > 720) vf.push('scale=-2:720');
    vf.push(`fade=t=in:st=0:d=${FADE}`, `fade=t=out:st=${Math.max(0, dur - FADE).toFixed(3)}:d=${FADE}`, 'format=yuv420p');
    video = ['-map', '0:v:0', '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-threads', '2',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  }
  const ss = kf != null ? Math.ceil(start * 1000) / 1000 : start; // som ögonblicken: aldrig strax före nyckelbilden
  await ffmpeg([...SAFE_IN, '-ss', ss.toFixed(3), '-t', dur.toFixed(3), '-i', it.path, ...(a ? [] : SILENT), ...video,
    '-map', a ? `0:${a.index}` : '1:a', '-af', af, ...AUDIO_OUT, '-shortest', '-sn', '-dn', '-map_metadata', '-1', '-f', 'mpegts', out], { cwd, label: 'klippet' });
  return { mode: kf != null ? 'copy' : 'encode', start };
}
const assText = (s) => String(s).replace(/\\/g, '＼').replace(/[{}]/g, (x) => x === '{' ? '（' : '）').replace(/\r?\n/g, ' ');
/** ASS för titelskylten: titeln stort i mitten och en rad under (t.ex. "Säsong 1") */
export function titleAss(title, line) {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,80,80,40,1
Style: L,DejaVu Sans,34,&H00B5A8A3,&H00B5A8A3,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,80,80,40,1

[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:${String(TITLE_SECS + 1).padStart(2, '0')}.00,T,,0,0,0,,{\\pos(640,330)}${assText(title)}
${line ? `Dialogue: 0,0:00:00.00,0:00:${String(TITLE_SECS + 1).padStart(2, '0')}.00,L,,0,0,0,,{\\pos(640,410)}${assText(line)}\n` : ''}`;
}
async function titleCard(dir, title, line) {
  fs.writeFileSync(path.join(dir, 't.ass'), titleAss(title, line));
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x0d0f14:s=1280x720:r=25:d=${TITLE_SECS}`, ...SILENT, '-t', String(TITLE_SECS),
    '-vf', `subtitles=t.ass,fade=t=in:st=0:d=${FADE},fade=t=out:st=${TITLE_SECS - FADE - 0.1}:d=${FADE},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2',
    ...AUDIO_OUT, '-f', 'mpegts', 't.ts'], { cwd: dir, label: 'titelskylten' });
  fs.rmSync(path.join(dir, 't.ass'), { force: true });
}
/** Spellistan: titelskylten och klippen med en diskontinuitet före varje klipp */
export function playlist(parts) {
  const td = Math.max(1, ...parts.map(p => Math.ceil(p.d)));
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${td}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
    parts.map((p, i) => `${i ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:${p.d.toFixed(3)},\n${p.file}\n`).join('') + '#EXT-X-ENDLIST\n';
}
export const dirOf = (id) => path.join(DIR, String(+id));
const lineOf = (r, lang) => r.scope === 'season' ? (lang === 'en' ? `Season ${r.season}` : `Säsong ${r.season}`) : (lang === 'en' ? `Season ${r.season}, latest episodes` : `Säsong ${r.season}, senaste avsnitten`);

/** Gör sammanfattningen för raden r (state 0). Kastar vid fel. */
export async function make(r) {
  const plan = JSON.parse(r.plan);
  const dir = dirOf(r.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const items = new Map();
  const itemOf = (id) => { if (!items.has(id)) items.set(id, get('SELECT * FROM items WHERE id=? AND path IS NOT NULL', id) || null); return items.get(id); };
  // Svart bild och tystnad: kandidaterna i rangordning, underkända ersätts av reserverna
  const ok = [];
  for (const c of [...plan.clips, ...plan.spare]) {
    if (ok.length >= plan.want) break;
    const it = itemOf(c.item);
    if (!it || !fs.existsSync(it.path)) continue;
    if (ok.some(x => x.item === c.item && c.e > x.s - 4 && c.s < x.e + 4)) continue; // reserverna kan överlappa varandra
    if (await looksOk(it, c)) ok.push(c);
  }
  if (ok.length < LEAST) throw new Error('För lite att visa – scenerna var svarta eller tysta');
  const order = new Map(plan.eps.map(([id], i) => [id, i]));
  ok.sort((a, b) => order.get(a.item) - order.get(b.item) || a.s - b.s);
  await titleCard(dir, plan.title, lineOf(r, plan.lang));
  const parts = [{ file: 't.ts', d: await durationOf(path.join(dir, 't.ts')) || TITLE_SECS }];
  const clips = [], modes = new Set();
  for (const [i, c] of ok.entries()) {
    const it = itemOf(c.item), file = `c${i}.ts`;
    const mute = plan.ff ? family.muteIntervals(it, audioOf(it)?.lang || null) : null;
    const res = await cut(it, c, file, mute, dir);
    const d = await durationOf(path.join(dir, file)) || (c.e - res.start);
    parts.push({ file, d });
    modes.add(res.mode);
    clips.push({ item: c.item, season: it.season, episode: it.episode, s: round(res.start), e: c.e, d: round(d), mode: res.mode });
  }
  fs.writeFileSync(path.join(dir, 'index.m3u8.tmp'), playlist(parts));
  fs.renameSync(path.join(dir, 'index.m3u8.tmp'), path.join(dir, 'index.m3u8'));
  const size = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  run('UPDATE recaps SET state=1, mode=?, clips=?, dur=?, size=?, error=NULL, used=? WHERE id=?',
    modes.size > 1 ? 'mixed' : [...modes][0], JSON.stringify(clips), round(parts.reduce((s, p) => s + p.d, 0)), size, now(), r.id);
}

// ---------------- kön ----------------
const queue = [];
let active = 0;
export const queued = () => queue.length + active;
let idleWaiters = [];
/** Väntar tills kön är tom (tester) */
export const drain = () => queued() ? new Promise(r => idleWaiters.push(r)) : Promise.resolve();
function pump() {
  while (active < MAX_JOBS && queue.length) {
    const id = queue.shift();
    const r = get('SELECT * FROM recaps WHERE id=? AND state=0', id);
    if (!r) continue;
    active++;
    const show = get('SELECT title FROM items WHERE id=?', r.show_id);
    const jb = jobs.track('recap', `Det här har hänt: ${show?.title || ''}`, { detail: `Säsong ${r.season}` });
    make(r).then(() => evict(r.id), (e) => {
      console.warn(`[det här har hänt] ${r.id}: ${e.message}`);
      fs.rmSync(dirOf(r.id), { recursive: true, force: true });
      run('UPDATE recaps SET state=2, size=0, error=? WHERE id=?', String(e.message || '').replace(/\/[^\s:]+/g, '…').slice(0, 300) || 'Sammanfattningen kunde inte göras', r.id);
    }).finally(() => {
      jb.end(); active--;
      if (!queued()) { const w = idleWaiters; idleWaiters = []; w.forEach(f => f()); }
      pump();
    });
  }
}
/** Ser till att sammanfattningen för planen finns eller görs: ger raden. Kastar 429 när kön är full. */
export function ensure(p) {
  let r = get('SELECT * FROM recaps WHERE key=?', p.key);
  if (r && r.state !== 2) { run('UPDATE recaps SET used=? WHERE id=?', now(), r.id); return r; }
  if (queue.length >= MAX_QUEUE) throw err(429, 'Många sammanfattningar görs redan – försök igen om en stund');
  if (r) run("UPDATE recaps SET state=0, error=NULL, used=? WHERE id=?", now(), r.id);
  else run('INSERT INTO recaps(key, show_id, season, scope, eps, plan, ff, state, created, used) VALUES(?,?,?,?,?,?,?,0,?,?)',
    p.key, p.show.id, p.season, p.scope, JSON.stringify(p.eps.map(e => e.id)), JSON.stringify(p.plan), p.plan.ff ? 1 : 0, now(), now());
  r = get('SELECT * FROM recaps WHERE key=?', p.key);
  queue.push(r.id);
  setImmediate(pump);
  return r;
}
export const byKey = (key) => get('SELECT * FROM recaps WHERE key=?', key);
export const byId = (id) => get('SELECT * FROM recaps WHERE id=?', id);
export const touch = (id) => run('UPDATE recaps SET used=? WHERE id=?', now(), id);
/** Lagringsgränsen: de äldst använda tas bort (aldrig keep = den nyss gjorda) */
function evict(keep) {
  let used = get('SELECT COALESCE(SUM(size),0) AS n FROM recaps').n;
  for (const r of all('SELECT id, size FROM recaps WHERE state=1 AND id!=? ORDER BY used', keep)) {
    if (used <= maxBytes()) break;
    remove(r.id); used -= r.size;
  }
}
export function remove(id) { run('DELETE FROM recaps WHERE id=?', id); fs.rmSync(dirOf(id), { recursive: true, force: true }); }
/** Vid start: avbrutna jobb glöms (görs om vid nästa fråga), mappar utan rad tas bort */
export function init() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  for (const r of all('SELECT id FROM recaps WHERE state=0')) remove(r.id);
  sweep();
  setInterval(sweep, 6 * 3600e3).unref();
}
export function sweep() {
  for (const r of all('SELECT id FROM recaps WHERE used < ? AND state!=0', now() - KEEP_DAYS * 86400)) remove(r.id);
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return; }
  const ids = new Set(all('SELECT id FROM recaps').map(r => String(r.id)));
  for (const f of files) if (!ids.has(f)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
}

// ---------------- behörighet och svar ----------------
/**
 * Får profilen se sammanfattningen? Serien och varje avsnitt tillåtna (allowed = allowedFor), alla avsnitten sedda av
 * profilen (spoilergränsen gäller även en delad sammanfattning) och – med familjefiltret på – en tystad sammanfattning.
 */
export function visibleTo(uid, r, allowed) {
  const show = get('SELECT id, library_id, age, kind, parent_id, version_of FROM items WHERE id=?', r.show_id);
  if (!show || !allowed(show)) return false;
  if (family.modeFor(uid) !== 'off' && !r.ff) return false;
  let ids; try { ids = JSON.parse(r.eps || '[]'); } catch { return false; }
  for (const id of ids) {
    const e = get(`SELECT i.id, i.library_id, i.age, i.kind, i.parent_id, i.version_of, COALESCE(p.watched,0) AS watched FROM items i
      LEFT JOIN progress p ON p.item_id=i.id AND p.user_id=? WHERE i.id=?`, uid, id);
    if (!e || !e.watched || !allowed(e)) return false;
  }
  return true;
}
/** Svaret för GET/POST /api/items/:id/recap */
export function out(p, r) {
  const o = { available: !p.reason, show: { id: p.show.id, title: p.show.title } };
  if (p.target) o.target = { id: p.target.id, season: p.target.season, episode: p.target.episode, title: p.target.title, position: p.target.position || 0 };
  if (p.reason) return { ...o, reason: p.reason, offer: false, state: 'none' };
  Object.assign(o, {
    scope: p.scope, season: p.season, title: p.plan.title, episodes: p.eps.map(e => ({ id: e.id, season: e.season, episode: e.episode, title: e.title })),
    clips: p.plan.want, estimate: Math.round(TITLE_SECS + p.plan.clips.reduce((s, c) => s + c.e - c.s, 0)),
    // Erbjudandet i spelaren: första avsnittet i en ny säsong, inte påbörjat, efter ett uppehåll
    offer: p.scope === 'season' && p.first && p.target.position < 30 && p.lastWatch > 0 && now() - p.lastWatch > offerDays() * 86400,
    state: r ? STATE[r.state] : 'none'
  });
  if (r) {
    o.id = r.id;
    if (r.state === 1) { o.duration = r.dur; o.mode = r.mode; o.url = `/api/recaps/${r.id}/index.m3u8`; try { o.clipList = JSON.parse(r.clips || '[]'); } catch { o.clipList = []; } }
    if (r.state === 2) o.error = r.error || 'Sammanfattningen kunde inte göras';
  }
  return o;
}
