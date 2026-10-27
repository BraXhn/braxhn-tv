// Hälsokontroll av biblioteket: hittar filer som är trasiga, avkortade, ur synk, felmärkta, i sämre kvalitet än resten
// av biblioteket, dubbletter, saknade avsnitt och filer med så hög bithastighet att de flesta klienter behöver omkodning.
// Resultatet visas i adminvyn #/health (web/js/views/health.js) med åtgärderna "Be Radarr/Sonarr om en ny version"
// (arr.replaceFile, ev. med spärr av den nuvarande releasen), "Rätta språkmärkning" (lang_overrides – stream.js lägger
// den på spåren, filen skrivs aldrig om) och "Ignorera".
//
// Per fil (bara nya och ändrade – health_files.sig = mtime:storlek, sub_sig = undertextfilernas version, ver = VERSION):
//   broken    ffprobe kan inte läsa filen eller hittar ingen bild
//   truncated sista paketen slutar långt före behållarens längd (avbruten nedladdning)
//   length    en ström är mycket kortare än behållaren (t.ex. ljudet tar slut efter halva filmen)
//   decode    avkodningsfel vid stickprov (SAMPLES punkter, 2 s var: ffmpeg -v error -ss X -t 2 -f null -)
//   sync      grov kontroll av ljud mot bild: startpts skiljer mer än SYNC_MAX s mellan första bild- och ljudström
//   audiolang ljudspår utan språk (när filen har flera) eller vars titel säger ett annat språk än märkningen
//   sublang   textundertext vars text (vanliga ord) är ett annat språk än märkningen
//   bitrate   bithastigheten över gränsen (health_max_mbps, 2,5 × för 4K)
// För hela biblioteket (räknas ur databasen vid varje genomgång, ingen filåtkomst):
//   quality   SD när minst hälften av biblioteket (filmer) eller serien (avsnitt) är 1080p eller bättre
//   duplicate samma film (TMDB-id) eller samma avsnitt flera gånger i samma bibliotek (inte versioner)
//   missing   avsnitt som saknas mitt i en säsong eller sända avsnitt (kalendern) i en säsong som finns delvis
// Jobbet körs med lägsta prioritet (util.lowPriority), väntar medan något spelas eller kodas om (setBusyCheck i app.js),
// en fil åt gången, och syns i aktivitetspanelen.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { all, get, run, tx, now, getSetting } from './db.js';
import { streamsOf, subtitleVtt, SAFE_IN } from './stream.js';
import { lowPriority } from './util.js';
import { langKey } from './playprefs.js';
import { cuesOf, wantedFor, wordsOf } from './sublines.js';
import * as calendar from './calendar.js';
import * as jobs from './jobs.js';

export const VERSION = 1;          // höjs när kontrollerna per fil ändras – då kontrolleras allt om
const SAMPLE_SECONDS = 2;
const SYNC_MAX = 0.5;              // sekunder mellan bildens och ljudets start
const MAX_SUBS = 6;                // textundertexter per fil som språkgissas
export const KINDS = ['broken', 'truncated', 'length', 'decode', 'sync', 'audiolang', 'sublang', 'bitrate', 'quality', 'duplicate', 'missing'];
const FILE_KINDS = ['broken', 'truncated', 'length', 'decode', 'sync', 'audiolang', 'bitrate'];
const SEVERITY = { broken: 'error', truncated: 'error', decode: 'error', length: 'warn', sync: 'warn', audiolang: 'warn', sublang: 'warn',
  missing: 'warn', quality: 'info', duplicate: 'info', bitrate: 'info' };

export const enabled = () => getSetting('health_enabled', process.env.HEALTH || '1') !== '0';
export const samples = () => Math.max(0, Math.min(20, +getSetting('health_samples', process.env.HEALTH_SAMPLES || '5') || 0));
export const maxMbps = () => Math.max(1, +getSetting('health_max_mbps', '40') || 40);

// ---------------- språk ----------------
// Vanliga ord per språk (ISO 639-2). Svenska, norska och danska delar många ord – de ord som skiljer dem åt avgör.
const WORDS = {
  swe: 'och inte är jag vad hur också någon något mig dig sig ska varför här där bara vill finns tack hej att det som så men han hon vi du var med för på av till nej ja kanske mycket måste',
  nor: 'ikke jeg og hva hvordan også noen noe meg deg seg skal hvorfor her der nå bare vil takk hei å det som så men han hun vi du er med for på av til nei ja kanskje mye må',
  dan: 'ikke jeg og hvad hvordan også nogen noget mig dig sig skal hvorfor her der nu bare vil tak hej at det som så men han hun vi du er med for på af til nej ja måske meget skal',
  eng: 'the and you to is that it of what this not are have we i me my your do don t was he she for with on in be just know can no yes okay',
  fin: 'ja ei on se että en mitä minä sinä hän me te he kun niin mutta tämä tuo olen olet ole kiitos mikä joo nyt',
  deu: 'und nicht ich du ist das die der ein eine was wir sie es mit zu auf nein mir dich sein haben auch noch',
  fra: 'le la les et est je tu vous nous pas que qui ne un une des il elle ce ça oui non pour avec mais',
  spa: 'el los las y es que no yo tú usted un una qué de por para con sí está pero muy',
};
const LEX = new Map();
for (const [lang, w] of Object.entries(WORDS)) for (const x of new Set(w.split(' '))) { if (!LEX.has(x)) LEX.set(x, []); LEX.get(x).push(lang); }
/** Gissa språket i en text ur vanliga ord: { lang, hits, share, sure } (sure = tillräckligt många träffar och tydlig marginal) */
export function guessLang(text) {
  const words = wordsOf(text), score = {};
  for (const w of words) for (const l of LEX.get(w) || []) score[l] = (score[l] || 0) + 1;
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!best) return { lang: null, hits: 0, share: 0, sure: false };
  const share = best[1] / Math.max(1, words.length);
  return { lang: best[0], hits: best[1], share, sure: best[1] >= 20 && share >= 0.12 && best[1] >= 1.4 * (second?.[1] || 0) };
}
// Språk som står i spårets titel ("Svenska", "English 5.1", "Dansk tale")
const TITLE_LANG = [[/\b(svensk[a-z]*|swedish)\b/i, 'swe'], [/\b(engelsk[a-z]*|english)\b/i, 'eng'], [/\b(norsk[a-z]*|norwegian)\b/i, 'nor'],
  [/\b(dansk[a-z]*|danish)\b/i, 'dan'], [/\b(finsk[a-z]*|finnish|suomi)\b/i, 'fin'], [/\b(tysk[a-z]*|german|deutsch)\b/i, 'deu'],
  [/\b(fransk[a-z]*|french|français)\b/i, 'fra'], [/\b(spansk[a-z]*|spanish|español)\b/i, 'spa']];
export function langFromTitle(t) { for (const [re, l] of TITLE_LANG) if (re.test(String(t || ''))) return l; return null; }
const same = (a, b) => !!langKey(a) && langKey(a) === langKey(b);
const LANG_NAME = { swe: 'svenska', eng: 'engelska', nor: 'norska', dan: 'danska', fin: 'finska', deu: 'tyska', fra: 'franska', spa: 'spanska' };
const langName = (l) => LANG_NAME[l] || (langKey(l) ? String(l) : 'inget språk');

/** Ljudspårens märkning: utan språk (när filen har flera spår) eller titel som säger ett annat språk */
export function audioLangIssues(streams) {
  const a = streams.filter(s => s.type === 'audio'), out = [];
  a.forEach((s, i) => {
    const hint = langFromTitle(s.title), cur = langKey(s.lang) ? s.lang : null;
    const label = `Ljudspår ${i + 1}${s.title ? ` (${s.title})` : ''}`;
    if (hint && cur && !same(hint, cur)) out.push({ kind: 'audiolang', key: 'a' + s.index, detail: { track: 'a' + s.index, label, current: cur, suggest: hint, msg: `${label} är märkt ${langName(cur)} men titeln säger ${langName(hint)}` } });
    else if (!cur && (hint || a.length > 1)) out.push({ kind: 'audiolang', key: 'a' + s.index, detail: { track: 'a' + s.index, label, current: s.lang || null, suggest: hint, msg: `${label} saknar språkmärkning` } });
  });
  return out;
}

// ---------------- ffmpeg/ffprobe ----------------
function runLow(cmd, args, { timeout = 120e3, max = 8 << 20 } = {}) {
  return new Promise((ok) => {
    let p; try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return ok({ code: -1, out: '', err: e.message }); }
    lowPriority(p);
    const out = [], err = []; let size = 0;
    p.stdout.on('data', c => { size += c.length; if (size > max) p.kill('SIGKILL'); else out.push(c); });
    p.stderr.on('data', c => { if (err.length < 200) err.push(c); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => { clearTimeout(timer); ok({ code: -1, out: '', err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); ok({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }); });
  });
}
const firstLine = (s) => String(s || '').split('\n').map(x => x.replace(/^\[[^\]]*\]\s*/, '').trim()).find(Boolean) || '';
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
/** Strömmens längd: duration eller Matroskas DURATION-tagg (HH:MM:SS.nnn) */
function streamDur(s) {
  const d = num(s.duration); if (d != null) return d;
  const m = /^(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(s.tags?.DURATION || s.tags?.duration || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}
// Meddelanden som kommer av själva hoppet (avkodningen börjar mellan nyckelbilder), inte av en trasig fil
const BENIGN = /non-existing PPS|decode_slice_header error|no frame!|Missing reference picture|reference picture missing|mmco: unref short|co located POCs unavailable|Could not find ref with POC|Last message repeated|^\s*$/i;
const fmtS = (s) => s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
const sv = (x, d = 1) => x.toFixed(d).replace('.', ',');
const rank = (w, h) => (w >= 3200 || h >= 1800) ? 4 : (w >= 1700 || h >= 1000) ? 3 : (w >= 1100 || h >= 700) ? 2 : h ? 1 : 0;
const RES = ['okänd', 'SD', '720p', '1080p', '4K'];

/** Bithastighet över gränsen? (kbit/s ur behållaren, annars storlek/längd) */
export function bitrateIssue({ kbps, width = 0, height = 0 }, limitMbps = maxMbps()) {
  const lim = limitMbps * (rank(width, height) >= 4 ? 2.5 : 1) * 1000;
  if (!kbps || kbps <= lim) return null;
  return { kind: 'bitrate', key: '', detail: { kbps: Math.round(kbps), limit: lim, msg: `${sv(kbps / 1000, 0)} Mbit/s – över ${sv(lim / 1000, 0)} Mbit/s, kräver omkodning för de flesta klienter utanför hemnätet` } };
}

/** Kontrollera en fil fullt: [{ kind, key, detail }] */
export async function checkFile(it) {
  const file = it.path, issues = [];
  const pr = await runLow('ffprobe', ['-v', 'error', ...SAFE_IN, '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 120e3 });
  let j = null; try { j = pr.code === 0 ? JSON.parse(pr.out) : null; } catch {}
  const st = (j?.streams || []).filter(s => !s.disposition?.attached_pic);
  const v = st.find(s => s.codec_type === 'video'), a = st.find(s => s.codec_type === 'audio' && s.disposition?.default) || st.find(s => s.codec_type === 'audio');
  if (!j || !v) {
    issues.push({ kind: 'broken', key: '', detail: { msg: !j ? `Filen går inte att läsa: ${firstLine(pr.err) || 'okänt fel'}` : 'Filen har ingen bild' } });
    return issues;
  }
  const dur = num(j.format?.duration);
  // Avkortad: sista paketen (alla strömmar) mot behållarens längd
  let end = null;
  if (dur && dur > 10) {
    const e = await runLow('ffprobe', ['-v', 'error', ...SAFE_IN, '-read_intervals', String(Math.max(0, Math.floor(dur - 30))), '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], { timeout: 180e3 });
    for (const line of e.out.split('\n')) { const [p, d] = line.split(','); const t = num(p); if (t != null) end = Math.max(end ?? 0, t + (num(d) || 0)); }
    const slack = Math.max(5, dur * 0.005);
    if (end != null && end < dur - slack) issues.push({ kind: 'truncated', key: '', detail: { end, duration: dur, msg: `Filen tar slut vid ${fmtS(end)} men ska vara ${fmtS(dur)} lång – troligen en avbruten nedladdning` } });
    else if (end == null) issues.push({ kind: 'truncated', key: '', detail: { duration: dur, msg: `Slutet av filen går inte att läsa: ${firstLine(e.err) || 'inga paket'}` } });
    // En ström mycket kortare än behållaren
    for (const s of [v, a].filter(Boolean)) {
      const sd = streamDur(s);
      if (sd != null && sd < dur - Math.max(10, dur * 0.05)) {
        issues.push({ kind: 'length', key: s.codec_type, detail: { stream: s.index, streamDuration: sd, duration: dur, msg: `${s.codec_type === 'audio' ? 'Ljudet' : 'Bilden'} är ${fmtS(sd)} men filen ${fmtS(dur)}` } });
      }
    }
  }
  // Stickprov: avkoda SAMPLE_SECONDS på några punkter (inte bortom det som finns)
  const n = samples(), errs = [];
  if (dur && n) {
    const limit = (end ?? dur) - SAMPLE_SECONDS;
    for (let i = 0; i < n; i++) {
      const at = Math.max(0, Math.floor(dur * (i + 0.5) / n));
      if (at > limit) continue;
      while (busy()) await sleep(10e3);
      const r = await runLow('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...SAFE_IN, '-threads', '2', '-ss', String(at), '-i', file, '-t', String(SAMPLE_SECONDS),
        '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'], { timeout: 120e3, max: 1 << 16 });
      const bad = r.err.split('\n').filter(l => !BENIGN.test(l));
      if (r.code !== 0 || bad.length) errs.push({ at, error: (bad.map(l => l.replace(/^\[[^\]]*\]\s*/, '').trim()).find(Boolean) || `ffmpeg avslutades med ${r.code}`).slice(0, 200) });
    }
  }
  if (errs.length) issues.push({ kind: 'decode', key: '', detail: { points: errs, tested: n, msg: `Avkodningsfel vid ${errs.map(e => fmtS(e.at)).join(', ')}: ${errs[0].error}` } });
  // Ljud mot bild (grov kontroll)
  const vs = num(v.start_time), as = a ? num(a.start_time) : null;
  if (vs != null && as != null && Math.abs(as - vs) > SYNC_MAX) {
    const d = as - vs;
    issues.push({ kind: 'sync', key: '', detail: { video: vs, audio: as, diff: d, msg: `Ljudet börjar ${sv(Math.abs(d))} s ${d > 0 ? 'efter' : 'före'} bilden` } });
  }
  issues.push(...audioLangIssues(streamsOf(it)));
  const kbps = num(j.format?.bit_rate) ? num(j.format.bit_rate) / 1000 : (it.size && dur ? it.size * 8 / dur / 1000 : null);
  const br = bitrateIssue({ kbps, width: v.width || 0, height: v.height || 0 });
  if (br) issues.push(br);
  return issues;
}

/** Textundertexternas språk mot märkningen (samma undertexter och cache som repliksökningen) */
export async function checkSubs(it) {
  const out = [];
  for (const w of wantedFor(it).slice(0, MAX_SUBS)) {
    if (w.sub.forced) continue;
    let text = '';
    try { text = cuesOf(await subtitleVtt(it, w.sub, { low: true })).slice(0, 600).map(c => c.text).join(' '); } catch { continue; }
    const g = guessLang(text);
    if (!g.sure || same(g.lang, w.sub.lang)) continue;
    const label = w.sub.label || w.key, cur = langKey(w.sub.lang) ? w.sub.lang : null;
    out.push({ kind: 'sublang', key: w.key, detail: { track: w.key, label, current: cur, suggest: g.lang,
      msg: cur ? `Undertexten ${label} är märkt ${langName(cur)} men texten är ${langName(g.lang)}` : `Undertexten ${label} saknar språk – texten är ${langName(g.lang)}` } });
  }
  return out;
}

// ---------------- hela biblioteket ----------------
const LIB_ITEMS = `SELECT i.id, i.kind, i.library_id, i.parent_id, i.season, i.episode, i.version_of, i.tmdb_id, i.width, i.height, i.size, i.path, i.ep_guess
  FROM items i JOIN libraries l ON l.id=i.library_id WHERE i.kind IN ('movie','episode') AND i.path IS NOT NULL AND l.type IN ('movie','show') AND COALESCE(l.home_video,0)=0`;
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const base = (p) => path.basename(String(p || ''));

/** SD när minst hälften av biblioteket (filmer, minst 5) eller serien (avsnitt, minst 3) är 1080p eller bättre */
export function qualityIssues(rows) {
  const out = [];
  const movies = rows.filter(r => r.kind === 'movie');
  const best = new Map(); // huvudrad → bästa versionens klass
  for (const r of movies) { const id = r.version_of || r.id; best.set(id, Math.max(best.get(id) || 0, rank(r.width || 0, r.height || 0))); }
  const libOf = new Map(movies.filter(r => !r.version_of).map(r => [r.id, r.library_id]));
  for (const [, ids] of groupBy([...best.keys()].filter(id => libOf.has(id)), id => libOf.get(id))) {
    const known = ids.filter(id => best.get(id) > 0), hd = known.filter(id => best.get(id) >= 3).length;
    if (known.length < 5 || hd / known.length < 0.5) continue;
    for (const id of known) if (best.get(id) === 1) out.push({ item: id, kind: 'quality', key: '', sig: 'sd', detail: { msg: `SD-kvalitet – ${Math.round(100 * hd / known.length)} % av filmerna i biblioteket är 1080p eller bättre` } });
  }
  for (const [, eps] of groupBy(rows.filter(r => r.kind === 'episode' && !r.version_of), r => r.parent_id)) {
    const known = eps.filter(r => rank(r.width || 0, r.height || 0) > 0), hd = known.filter(r => rank(r.width || 0, r.height || 0) >= 3).length;
    if (known.length < 3 || hd / known.length < 0.5) continue;
    for (const r of known) if (rank(r.width || 0, r.height || 0) === 1) out.push({ item: r.id, kind: 'quality', key: '', sig: 'sd', detail: { msg: `SD-kvalitet – ${Math.round(100 * hd / known.length)} % av seriens avsnitt är 1080p eller bättre` } });
  }
  return out;
}
/** Samma film (TMDB-id) eller avsnitt flera gånger i ett bibliotek – alla utom den största filen markeras */
export function duplicateIssues(rows) {
  const out = [];
  const groups = [...groupBy(rows.filter(r => r.kind === 'movie' && !r.version_of && r.tmdb_id), r => `${r.library_id}:${r.tmdb_id}`).values(),
    ...groupBy(rows.filter(r => r.kind === 'episode' && !r.version_of && r.season != null && r.episode != null), r => `${r.parent_id}:${r.season}:${r.episode}`).values()];
  for (const g of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => (b.size || 0) - (a.size || 0) || a.id - b.id);
    const sig = g.map(r => r.id).sort((a, b) => a - b).join(',');
    for (const r of g.slice(1)) out.push({ item: r.id, kind: 'duplicate', key: '', sig, detail: { others: g.filter(x => x !== r).map(x => ({ id: x.id, file: base(x.path), size: x.size })),
      msg: `Finns ${g.length} gånger i biblioteket – även ${g.filter(x => x !== r).map(x => base(x.path)).join(', ')}` } });
  }
  return out;
}
const pad = (n) => String(n).padStart(2, '0');
const rangesLabel = (season, nums) => {
  const out = [];
  for (const n of nums) { const l = out[out.length - 1]; if (l && n === l[1] + 1) l[1] = n; else out.push([n, n]); }
  return out.map(([a, b]) => `S${pad(season)}E${pad(a)}${b > a ? `–E${pad(b)}` : ''}`).join(', ');
};
/** Saknade avsnitt per säsong: luckor bland avsnitten (multiavsnitt som E01-E02 räknas) + sända avsnitt enligt kalendern */
export function missingIssues(rows, aired = () => []) {
  const out = [];
  for (const [show, eps] of groupBy(rows.filter(r => r.kind === 'episode' && !r.version_of), r => r.parent_id)) {
    if (eps.some(r => r.ep_guess)) continue; // datumavsnitt utan säkra nummer
    const air = groupBy(aired(show) || [], e => e.season);
    for (const [season, list] of groupBy(eps.filter(r => r.season > 0 && r.episode > 0), r => r.season)) {
      const have = new Set();
      for (const r of list) {
        have.add(r.episode);
        const m = /[Ee](\d{1,3})(?:[-_ ]?[Ee]|-)(\d{1,3})(?!\d)/.exec(base(r.path));
        if (m && +m[1] === r.episode && +m[2] > r.episode && +m[2] - r.episode < 10) for (let k = r.episode; k <= +m[2]; k++) have.add(k);
      }
      const miss = new Set();
      for (let k = 1; k < Math.max(...have); k++) if (!have.has(k)) miss.add(k);
      for (const e of air.get(season) || []) if (!have.has(e.episode)) miss.add(e.episode);
      if (!miss.size) continue;
      const nums = [...miss].sort((a, b) => a - b);
      out.push({ item: show, kind: 'missing', key: `S${pad(season)}`, sig: nums.join(','), detail: { season, episodes: nums, label: rangesLabel(season, nums),
        msg: `Saknas: ${rangesLabel(season, nums)} (${nums.length} avsnitt)` } });
    }
  }
  return out;
}
const airedOf = (show) => { try { const m = calendar.missing(show); return m.known ? m.episodes : []; } catch { return []; } };
const LIB_KINDS = ['quality', 'duplicate', 'missing'];
function libraryPass() {
  const rows = all(LIB_ITEMS);
  const found = [...qualityIssues(rows), ...duplicateIssues(rows), ...missingIssues(rows, airedOf)];
  const old = new Map(all(`SELECT id, item_id, kind, key FROM health_issues WHERE kind IN (${LIB_KINDS.map(() => '?').join(',')})`, ...LIB_KINDS).map(r => [`${r.item_id}|${r.kind}|${r.key}`, r.id]));
  tx(() => {
    for (const f of found) { old.delete(`${f.item}|${f.kind}|${f.key}`); upsert(f.item, f, f.sig); }
    for (const id of old.values()) run('DELETE FROM health_issues WHERE id=?', id);
  });
  return found.length;
}

// ---------------- lagring ----------------
function upsert(itemId, f, sig) {
  const ex = get('SELECT id, sig FROM health_issues WHERE item_id=? AND kind=? AND key=?', itemId, f.kind, f.key || '');
  const detail = JSON.stringify(f.detail || {});
  if (ex) {
    // Ny version av det fyndet gällde (annan fil, andra avsnitt): ignorerat och begärt gäller inte längre
    if (ex.sig === sig) run('UPDATE health_issues SET detail=?, severity=? WHERE id=?', detail, SEVERITY[f.kind] || 'warn', ex.id);
    else run('UPDATE health_issues SET detail=?, severity=?, sig=?, found=?, ignored=0, action=NULL, action_at=NULL WHERE id=?', detail, SEVERITY[f.kind] || 'warn', sig, now(), ex.id);
  } else run('INSERT INTO health_issues(item_id, kind, key, severity, detail, sig, found) VALUES(?,?,?,?,?,?,?)', itemId, f.kind, f.key || '', SEVERITY[f.kind] || 'warn', detail, sig, now());
}
/** Ersätt fynden av typerna kinds för en titel */
export function storeIssues(itemId, kinds, list, sig) {
  tx(() => {
    const keep = new Set(list.map(f => `${f.kind}|${f.key || ''}`));
    for (const r of all(`SELECT id, kind, key FROM health_issues WHERE item_id=? AND kind IN (${kinds.map(() => '?').join(',')})`, itemId, ...kinds)) if (!keep.has(`${r.kind}|${r.key}`)) run('DELETE FROM health_issues WHERE id=?', r.id);
    for (const f of list) upsert(itemId, f, sig);
  });
}

// ---------------- rättad språkmärkning ----------------
const fixes = new Map(); // titel → Map(spår → { lang, sig })
function loadFixes() {
  fixes.clear();
  for (const r of all('SELECT item_id, track, lang, sig FROM lang_overrides')) { if (!fixes.has(r.item_id)) fixes.set(r.item_id, new Map()); fixes.get(r.item_id).set(r.track, { lang: r.lang, sig: r.sig }); }
}
loadFixes();
const fileSig = (it) => `${it.mtime ?? ''}:${it.size ?? ''}`;
/** För stream.setLangFix: { spår: språk } för titeln – bara så länge filen är densamma som när märkningen rättades */
export function langFixFor(it) {
  const m = fixes.get(it.id); if (!m) return null;
  let out = null;
  for (const [track, f] of m) if (!f.sig || it.mtime == null || f.sig === fileSig(it)) (out ||= {})[track] = f.lang;
  return out;
}
export const TRACK = /^(a\d{1,3}|e\d{1,3}|(external|downloaded):[^/\\]{1,255})$/;
/** Rätta (lang = ISO 639-2, t.ex. 'swe') eller ta bort (lang = null) märkningen för ett spår */
export function setLang(it, track, lang, orig = null) {
  if (lang) run('INSERT INTO lang_overrides(item_id, track, lang, orig, sig, created) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id, track) DO UPDATE SET lang=excluded.lang, sig=excluded.sig, created=excluded.created',
    it.id, track, lang, orig, fileSig(it), now());
  else run('DELETE FROM lang_overrides WHERE item_id=? AND track=?', it.id, track);
  loadFixes();
  // Fyndet för spåret är åtgärdat; undertexterna gissas om vid nästa genomgång
  run("DELETE FROM health_issues WHERE item_id=? AND kind IN ('audiolang','sublang') AND key=?", it.id, track);
}
export const overrides = () => all(`SELECT o.item_id, o.track, o.lang, o.orig, o.created, i.title, i.kind, i.season, i.episode, s.title AS show_title
  FROM lang_overrides o JOIN items i ON i.id=o.item_id LEFT JOIN items s ON s.id=i.parent_id ORDER BY o.created DESC`);

// ---------------- genomgången ----------------
const ITEMS = `SELECT i.* FROM items i JOIN libraries l ON l.id=i.library_id WHERE i.kind IN ('movie','episode') AND i.path IS NOT NULL AND l.type IN ('movie','show')`;
let busy = () => false;
/** Pausa medan något viktigare pågår (app.js: uppspelning och omkodning) */
export function setBusyCheck(fn) { busy = fn; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());
const S = { running: false, again: false, timer: null, at: 0, done: 0, total: 0, last: null, full: false };
export const progress = () => S.running ? { done: S.done, total: S.total } : null;
export const lastPass = () => S.last;
const subSigOf = (it) => { try { return wantedFor(it).filter(w => w.fmtime != null).map(w => `${w.key}=${w.sig}`).join('|'); } catch { return ''; } };

/** Gå igenom biblioteket: hela biblioteket ur databasen, nya och ändrade filer fullt */
export async function pass() {
  if (S.running) { S.again = true; return; }
  if (!enabled()) return;
  S.running = true;
  let jb = null;
  try {
    do {
      S.again = false;
      const t0 = Date.now();
      libraryPass();
      const have = new Map(all('SELECT item_id, sig, sub_sig, ver FROM health_files').map(r => [r.item_id, r]));
      const items = all(ITEMS), todo = [];
      for (let k = 0; k < items.length; k++) {
        const it = items[k], h = have.get(it.id), sig = fileSig(it), ss = subSigOf(it);
        if (!h || h.sig !== sig || h.ver !== VERSION) todo.push({ it, full: true, sig, ss });
        else if ((h.sub_sig || '') !== ss) todo.push({ it, full: false, sig, ss });
        if (k % 200 === 199) await new Promise(r => setImmediate(r));
      }
      S.done = 0; S.total = todo.length;
      if (todo.length) jb = jobs.track('health', 'Hälsokontroll av biblioteket', { total: todo.length });
      let found = 0;
      for (const t of todo) {
        while (busy()) await sleep(10e3);
        if (!enabled()) break;
        const it = get('SELECT * FROM items WHERE id=?', t.it.id); // kan ha ändrats eller tagits bort medan jobbet väntade
        if (!it || fileSig(it) !== t.sig) { S.done++; continue; }
        jb?.update(S.done, todo.length, it.title || base(it.path));
        const s0 = Date.now();
        try {
          if (t.full) { const f = await checkFile(it); found += f.length; storeIssues(it.id, FILE_KINDS, f, t.sig); }
          const s = await checkSubs(it); found += s.length; storeIssues(it.id, ['sublang'], s, `${t.sig}|${t.ss}`);
          if (get('SELECT 1 FROM items WHERE id=?', it.id)) {
            run(`INSERT INTO health_files(item_id, sig, sub_sig, ver, checked, ms) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
              sig=excluded.sig, sub_sig=excluded.sub_sig, ver=excluded.ver, checked=excluded.checked, ms=CASE WHEN ? THEN excluded.ms ELSE health_files.ms END`,
            it.id, t.sig, t.ss, VERSION, now(), Date.now() - s0, t.full ? 1 : 0);
          }
        } catch (e) { console.warn('[hälsa]', it.path, e.message); }
        S.done++;
      }
      jb?.end(); jb = null;
      S.last = { at: now(), files: todo.length, seconds: Math.round((Date.now() - t0) / 1000) };
      if (todo.length) console.log(`[hälsa] ${todo.length} filer kontrollerade, ${found} fynd`);
    } while (S.again);
  } finally { jb?.end(); S.running = false; S.total = 0; }
}
/** Starta en genomgång om ms (flera anrop i rad blir en, den tidigaste gäller) */
export function kick(ms = 5000) {
  const at = Date.now() + ms;
  if (S.timer && S.at <= at) return;
  clearTimeout(S.timer);
  S.at = at;
  S.timer = setTimeout(() => { S.timer = null; pass().catch(e => console.warn('[hälsa]', e.message)); }, ms);
  S.timer.unref?.();
}
/** Kontrollera alla filer fullt igen (adminvyn: "Kontrollera allt igen") */
export function recheckAll() { run('DELETE FROM health_files'); kick(500); }
/** För tester: kör tills inget återstår */
export async function drain() { await pass(); while (S.running) await sleep(20); }
export const running = () => S.running;
