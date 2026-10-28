// Inspelning (DVR): enstaka program och serieinspelningar från TV-guiden. Spelar in strömmen orörd (MPEG-TS) och
// efterbearbetar sedan till MP4 (standard, spelas överallt), MKV (alla ljudspår och undertexter) eller behåller TS.
// Serieregler: bara nya avsnitt (guidens flaggor, avsnittsnummer, redan inspelat eller i biblioteket), kanal, veckodagar
// och tidsfönster, behåll senaste N, marginaler och prioritet. När tunrarna inte räcker avgör prioriteten, konflikter
// visas i förväg (dvrplan.js) och serieinspelningar flyttas själva till en annan sändning av samma avsnitt om det går.
// Inspelningarna sparas i /recordings med namn som skannern känner igen (Serie/Season 01/Serie - S01E02 - Titel.mp4)
// och en NFO bredvid, så att mappen kan läggas till i seriebiblioteket.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { get, all, run, now, getSetting, CONFIG } from './db.js';
import { liveEncoder, activeTranscodes } from './stream.js';
import { acquireTuner, releaseTuner, SAFE_LIVE, httpOpts, activeLive } from './livetv.js';
import { guardFor } from './iptv/live.js';
import { redact } from './iptv/net.js';
import * as comskip from './comskip.js';
import * as growing from './dvrlive.js';
import { simulate, inWindow, episodeKey, outcomeText, worse } from './dvrplan.js';
import { notify } from './notify.js';
import * as webhooks from './webhooks.js';
import { fail, streamFile } from './util.js';
import * as jobs from './jobs.js';

// Tabellerna dvr_rules och recordings skapas och migreras i db.js

export function dvrDir() {
  const d = getSetting('dvr_dir', process.env.DVR_DIR || (fs.existsSync('/recordings') ? '/recordings' : path.join(CONFIG, 'recordings')));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const globalPad = () => ({ before: Math.max(0, +getSetting('dvr_pad_before', '60') || 0), after: Math.max(0, +getSetting('dvr_pad_after', '180') || 0) });
/** Marginaler för en inspelning: egna (från regeln eller bokningen) eller serverns inställning */
export const padOf = (r) => { const g = globalPad(); return { before: r?.pad_before ?? g.before, after: r?.pad_after ?? g.after }; };
// Namn ur guiden (leverantörens text) blir mappar och filer: inga avgränsare, och inga punkter eller mellanslag först eller
// sist – ". .." blev annars ".." (mappen ovanför inspelningsmappen)
export const safeName = (s) => String(s || 'Inspelning').replace(/[\/\\:*?"<>|\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').slice(0, 100).replace(/^[\s.]+|[\s.]+$/g, '') || 'Inspelning';
export const FORMATS = ['mp4', 'mkv', 'ts'], TRANSCODES = ['auto', 'always', 'never'];
const fmtOf = (r) => FORMATS.includes(r?.format) ? r.format : (FORMATS.includes(getSetting('dvr_format', 'mp4')) ? getSetting('dvr_format', 'mp4') : 'mp4');
const tcOf = (r) => TRANSCODES.includes(r?.transcode) ? r.transcode : (TRANSCODES.includes(getSetting('dvr_transcode', 'auto')) ? getSetting('dvr_transcode', 'auto') : 'auto');
const MEDIA_EXT = /\.(mp4|mkv|ts)$/;

// Status: scheduled → recording → processing → done | failed. Avbokade ('cancelled') och borttagna ('deleted') rader sparas som
// "gravstenar" utan fil: de visas inte, men hindrar att serieinspelningar bokar om samma sändning eller spelar in ett borttaget avsnitt igen.
const WAIT_TUNER = 'Väntar på ledig tuner';

// ---------- fält från API:t ----------
const int = (v, lo, hi) => { if (v === '' || v == null) return null; const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
/** "HH:MM" eller minuter → minuter efter midnatt */
const minuteOf = (v) => {
  if (v === '' || v == null) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v));
  return m ? Math.min(1439, +m[1] * 60 + +m[2]) : int(v, 0, 1439);
};
/** Gemensamma inställningar för regler och bokningar (bara de fält som skickats) */
function optFields(b) {
  const o = {};
  if ('priority' in b) o.priority = int(b.priority, -10, 10) ?? 0;
  if ('padBefore' in b) o.pad_before = int(b.padBefore, 0, 1800);
  if ('padAfter' in b) o.pad_after = int(b.padAfter, 0, 3600);
  if ('format' in b) o.format = FORMATS.includes(b.format) ? b.format : null;
  if ('transcode' in b) o.transcode = TRANSCODES.includes(b.transcode) ? b.transcode : null;
  return o;
}
/** Inställningar för en enstaka bokning från API:t (priority, padBefore, padAfter, format, transcode) */
export const bookingOpts = (b) => optFields(b || {});
function ruleFields(b) {
  const o = optFields(b);
  if ('title' in b) { o.title = String(b.title || '').trim().slice(0, 200); if (!o.title) throw new Error('Ange en titel'); }
  if ('channelId' in b) {
    o.channel_id = b.channelId ? +b.channelId : null;
    if (o.channel_id && !get('SELECT 1 FROM channels WHERE id=?', o.channel_id)) throw new Error('Kanalen finns inte');
  }
  if ('newOnly' in b) o.new_only = b.newOnly ? 1 : 0;
  if ('keep' in b) o.keep = int(b.keep, 0, 1000) ?? 0;
  if ('days' in b) o.days = Array.isArray(b.days) ? (b.days.reduce((m, d) => m | (d >= 0 && d <= 6 ? 1 << d : 0), 0) || null) : (int(b.days, 0, 127) || null);
  if ('timeFrom' in b) o.time_from = minuteOf(b.timeFrom);
  if ('timeTo' in b) o.time_to = minuteOf(b.timeTo);
  if ('skipLibrary' in b) o.skip_library = b.skipLibrary ? 1 : 0;
  if ('enabled' in b) o.enabled = b.enabled ? 1 : 0;
  return o;
}
const setClause = (o) => Object.keys(o).map(k => `${k}=?`).join(', ');

// ---------- schemaläggning ----------
/** Bokar en sändning. ruleId: från en serieinspelning (bokar inte om avbokade/borttagna). opts: priority, pad_before … */
export function scheduleProgram(programId, user, ruleId = null, opts = {}) {
  const p = get('SELECT p.*, c.name AS cname FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.id=?', programId);
  if (!p) throw new Error('Programmet finns inte');
  if (p.stop < now()) throw new Error('Programmet har redan sänts');
  const ex = get("SELECT id FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start);
  if (ex) return ex.id;
  const rule = ruleId ? get('SELECT * FROM dvr_rules WHERE id=?', ruleId) : null;
  const o = { priority: rule?.priority ?? 0, pad_before: rule?.pad_before ?? null, pad_after: rule?.pad_after ?? null, format: rule?.format ?? null, transcode: rule?.transcode ?? null, ...opts };
  const tomb = get("SELECT id, status FROM recordings WHERE channel_id=? AND start=? AND status IN ('cancelled','deleted') ORDER BY id DESC", p.channel_id, p.start);
  if (tomb) {
    if (ruleId) return null; // avbokad eller borttagen – serieinspelningen ska inte boka om den
    if (tomb.status === 'cancelled') { // bokas igen av en användare: återanvänd raden
      run(`UPDATE recordings SET status='scheduled', error=NULL, program_id=?, title=?, subtitle=?, description=?, season=?, episode=?, stop=?, is_new=?,
        priority=?, pad_before=?, pad_after=?, format=?, transcode=? WHERE id=?`,
        p.id, p.title, p.subtitle, p.description, p.season, p.episode, p.stop, p.is_new, o.priority, o.pad_before, o.pad_after, o.format, o.transcode, tomb.id);
      if (p.start <= now() + 60 + padOf(o).before) setImmediate(tick);
      return tomb.id;
    }
  }
  const id = Number(run(`INSERT INTO recordings(channel_id,channel_name,program_id,rule_id,title,subtitle,description,season,episode,start,stop,is_new,
    priority,pad_before,pad_after,format,transcode,created_by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.channel_id, p.cname, p.id, ruleId, p.title, p.subtitle, p.description, p.season, p.episode, p.start, p.stop, p.is_new,
    o.priority, o.pad_before, o.pad_after, o.format, o.transcode, user?.id || null, now()).lastInsertRowid);
  if (p.start <= now() + 60 + padOf(o).before) setImmediate(tick); // pågående program: börja spela in direkt
  return id;
}
export function scheduleManual({ channelId, start, stop, title, ...rest }, user) {
  // Hela sekunder: Android-appen läser start/stop som Long – ett decimaltal (t.ex. Date.now()/1000) gör att
  // hela inspelningslistan inte går att avkoda
  start = Math.floor(start); stop = Math.floor(stop);
  const c = get('SELECT * FROM channels WHERE id=?', channelId);
  if (!c) throw new Error('Kanalen finns inte');
  if (!(stop > start) || stop - start > 12 * 3600) throw new Error('Ogiltig tid (max 12 timmar)');
  const o = { priority: 0, pad_before: null, pad_after: null, format: null, transcode: null, ...optFields(rest) };
  const id = Number(run('INSERT INTO recordings(channel_id,channel_name,title,start,stop,priority,pad_before,pad_after,format,transcode,created_by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    c.id, c.name, safeName(title || c.name), start, stop, o.priority, o.pad_before, o.pad_after, o.format, o.transcode, user?.id || null, now()).lastInsertRowid);
  setImmediate(tick); // börjar den nu startar inspelningen direkt
  return id;
}
/** Ny serieinspelning. b: { title, channelId, newOnly, keep, priority, padBefore, padAfter, days, timeFrom, timeTo, skipLibrary, format, transcode } */
export function addRule(b, user) {
  const o = { new_only: 1, keep: 0, ...ruleFields({ title: '', ...b }) };
  const keys = Object.keys(o);
  const id = Number(run(`INSERT INTO dvr_rules(${keys.join(',')},created_by,created) VALUES(${keys.map(() => '?').join(',')},?,?)`, ...keys.map(k => o[k]), user?.id || null, now()).lastInsertRowid);
  applyRules();
  return id;
}
/** Ändra en regel. Kommande bokningar från regeln görs om (de som redan pågår eller är klara rörs inte). */
export function updateRule(id, b) {
  const o = ruleFields(b);
  if (!Object.keys(o).length) return;
  run(`UPDATE dvr_rules SET ${setClause(o)} WHERE id=?`, ...Object.values(o), id);
  // Bokningar som inte längre passar tas bort i applyRules; inställningar som marginaler och prioritet följer med
  const r = get('SELECT * FROM dvr_rules WHERE id=?', id);
  run("UPDATE recordings SET priority=?, pad_before=?, pad_after=?, format=?, transcode=? WHERE rule_id=? AND status='scheduled'", r.priority, r.pad_before, r.pad_after, r.format, r.transcode, id);
  if (!r.enabled) run("DELETE FROM recordings WHERE rule_id=? AND status='scheduled'", id);
  applyRules();
}
/** Ändra en bokning eller inspelning: prioritet, marginaler, format och "behåll alltid" */
export function updateRecording(id, b) {
  const o = optFields(b);
  if ('keepForever' in b) o.keep_forever = b.keepForever ? 1 : 0;
  const r = get('SELECT status FROM recordings WHERE id=?', id);
  if (!r) throw new Error('Finns inte');
  // Marginaler och format kan bara ändras innan inspelningen börjat
  if (r.status !== 'scheduled') for (const k of ['pad_before', 'format', 'transcode']) delete o[k];
  if (!['scheduled', 'recording'].includes(r.status)) { delete o.pad_after; delete o.priority; }
  if (Object.keys(o).length) run(`UPDATE recordings SET ${setClause(o)} WHERE id=?`, ...Object.values(o), id);
}

/** Finns avsnittet redan i ett seriebibliotek? (samma serie via titel/originaltitel/mappnamn, och säsong+avsnitt eller avsnittstitel) */
export function inLibrary(title, { season = null, episode = null, subtitle = null } = {}) {
  if ((season == null || episode == null) && !subtitle) return false;
  const like = String(title).replace(/[\\%_]/g, '\\$&') + ' (____)';
  return !!get(`SELECT 1 FROM items e JOIN items s ON s.id=e.parent_id
    WHERE e.kind='episode' AND e.path IS NOT NULL AND s.kind='show'
      AND (s.title=? COLLATE NOCASE OR s.original_title=? COLLATE NOCASE OR s.src_name=? COLLATE NOCASE OR s.src_name LIKE ? ESCAPE '\\')
      AND ((? IS NOT NULL AND ? IS NOT NULL AND e.season=? AND e.episode=?) OR (? IS NOT NULL AND e.title=? COLLATE NOCASE)) LIMIT 1`,
    title, title, title, like, season, episode, season, episode, subtitle || null, subtitle || null);
}
/** Har avsnittet redan spelats in (eller bokats, eller spelats in och tagits bort)? Samma sändning räknas inte. */
function alreadyHave(p) {
  const not = 'AND NOT (channel_id=? AND start=?)';
  if (p.season != null && p.episode != null) return !!get(`SELECT 1 FROM recordings WHERE title=? COLLATE NOCASE AND season=? AND episode=? AND status NOT IN ('failed','cancelled') ${not}`, p.title, p.season, p.episode, p.channel_id, p.start);
  if (p.subtitle) return !!get(`SELECT 1 FROM recordings WHERE title=? COLLATE NOCASE AND subtitle=? COLLATE NOCASE AND status NOT IN ('failed','cancelled') ${not}`, p.title, p.subtitle, p.channel_id, p.start);
  return false;
}
/** Ska regeln spela in sändningen? (utan hänsyn till dubbletter av samma avsnitt i samma körning) */
function wanted(r, p, guideFlagsNew) {
  if (!inWindow(r, p.start)) return false;
  if (!r.new_only) return true;
  if (alreadyHave(p)) return false;
  if (r.skip_library && inLibrary(p.title, p)) return false;
  // Utan avsnittsinfo: guiden markerar nya sändningar för den här titeln – då är en omarkerad sändning en repris
  if (episodeKey(p) == null && guideFlagsNew && !p.is_new) return false;
  return true;
}

/** Serieinspelning: schemalägg kommande sändningar som matchar reglerna (utan dubbletter). Bokningar från en regel som inte
 *  längre finns i guiden (t.ex. flyttad sändningstid) eller inte längre passar regeln tas bort, så att den nya tiden kan bokas.
 *  Bara nya avsnitt: av flera sändningar av samma avsnitt väljs den första som får en tuner. */
export function applyRules() {
  const t = now();
  for (const r of all('SELECT * FROM dvr_rules ORDER BY priority DESC, id')) {
    if (!r.enabled) continue;
    const progs = all(`SELECT * FROM programs WHERE title = ? COLLATE NOCASE AND start > ? ${r.channel_id ? 'AND channel_id=?' : ''} ORDER BY start`,
      ...[r.title, t - 60, ...(r.channel_id ? [r.channel_id] : [])]);
    const flagsNew = progs.some(p => p.is_new);
    const ok = new Set(progs.filter(p => inWindow(r, p.start)).map(p => `${p.channel_id}:${p.start}`));
    for (const x of all("SELECT id, channel_id, start, pad_before FROM recordings WHERE rule_id=? AND status='scheduled' AND start > ?", r.id, t))
      if (x.start - padOf(x).before > t && !ok.has(`${x.channel_id}:${x.start}`)) run("DELETE FROM recordings WHERE id=? AND status='scheduled'", x.id);
    // Avsnitt med flera sändningar: välj en som inte krockar (annars den första)
    const groups = new Map();
    for (const p of progs) {
      const k = r.new_only ? episodeKey(p) : null;
      const g = k ? 'e:' + k : 'p:' + p.id;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    for (const list of groups.values()) {
      // Redan bokad sändning av avsnittet från regeln: låt den vara (resolveConflicts flyttar den vid behov)
      const booked = list.find(p => get("SELECT 1 FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start));
      if (booked) continue;
      const cands = list.filter(p => wanted(r, p, flagsNew));
      if (!cands.length) continue;
      const pick = cands.length > 1 ? (cands.find(p => fits(p, r)) || cands[0]) : cands[0];
      try { scheduleProgram(pick.id, { id: r.created_by }, r.id); } catch {}
    }
  }
  try { resolveConflicts(); } catch (e) { console.warn('[dvr] konflikter:', e.message); }
}

/** Vad en regel skulle spela in (utan att boka något): kommande sändningar med record = true/false och orsak */
export function previewRule(b) {
  const r = { new_only: 1, keep: 0, priority: 0, skip_library: 1, ...ruleFields({ title: '', ...b }) };
  const progs = all(`SELECT p.*, c.name AS channel FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.title=? COLLATE NOCASE AND p.start > ?
    ${r.channel_id ? 'AND p.channel_id=?' : ''} ORDER BY p.start LIMIT 50`, ...[r.title, now() - 60, ...(r.channel_id ? [r.channel_id] : [])]);
  const flagsNew = progs.some(p => p.is_new);
  const seen = new Set();
  return progs.map(p => {
    let why = null;
    const k = episodeKey(p);
    if (!inWindow(r, p.start)) why = 'utanför tidsfönstret';
    else if (r.new_only) {
      if (k && seen.has(k)) why = 'samma avsnitt sänds tidigare';
      else if (alreadyHave(p)) why = 'redan inspelat eller bokat';
      else if (r.skip_library && inLibrary(p.title, p)) why = 'finns redan i biblioteket';
      else if (!k && flagsNew && !p.is_new) why = 'repris';
    }
    if (!why && k) seen.add(k);
    return { programId: p.id, channel: p.channel, channelId: p.channel_id, start: p.start, stop: p.stop, subtitle: p.subtitle, season: p.season, episode: p.episode,
      isNew: !!p.is_new, record: !why, reason: why };
  });
}

// ---------- tunrar och konflikter ----------
const PLAN_COLS = "r.id, r.title, r.subtitle, r.channel_id, r.channel_name, r.start, r.stop, r.status, r.priority, r.pad_before, r.pad_after, r.rule_id, r.season, r.episode, r.program_id, c.tuner_id";
function planInput(extra = []) {
  const recs = all(`SELECT ${PLAN_COLS} FROM recordings r JOIN channels c ON c.id=r.channel_id WHERE r.status IN ('scheduled','recording') AND r.stop > ?`, now());
  const rows = [...recs, ...extra];
  const tuners = Object.fromEntries(all('SELECT id, tuner_count FROM tuners').map(t => [t.id, t.tuner_count]));
  const input = rows.map(r => { const p = padOf(r); return { id: r.id, tunerId: r.tuner_id, start: r.start, stop: r.stop, padBefore: p.before, padAfter: p.after, priority: r.priority || 0, recording: r.status === 'recording' }; });
  return { rows, tuners, input };
}
/** Simulerat utfall för alla kommande och pågående inspelningar: Map id → { outcome, from, to, by } */
export function plan() {
  const { input, tuners } = planInput();
  return simulate(input, tuners, now());
}
/** Får sändningen p en tuner om den bokas (med regelns prioritet och marginaler), utan att någon annan bokning blir sämre? */
function fits(p, opts = {}, excludeId = null) {
  const ch = get('SELECT tuner_id FROM channels WHERE id=?', p.channel_id);
  if (!ch) return false;
  const cand = { id: -1, tuner_id: ch.tuner_id, start: p.start, stop: p.stop, status: 'scheduled', priority: opts.priority || 0, pad_before: opts.pad_before ?? null, pad_after: opts.pad_after ?? null };
  const { input, tuners } = planInput([cand]);
  const filtered = excludeId ? input.filter(x => x.id !== excludeId) : input;
  const before = simulate(filtered.filter(x => x.id !== -1), tuners, now());
  const after = simulate(filtered, tuners, now());
  if (after.get(-1)?.outcome !== 'ok') return false;
  for (const [id, v] of after) if (id !== -1 && worse(v.outcome, before.get(id)?.outcome || 'ok')) return false;
  return true;
}
/** Andra sändningar av samma avsnitt som skulle få en tuner (förslag när en bokning krockar) */
export function alternativesFor(rec, limit = 3) {
  if (!rec.program_id) return [];
  const p = get('SELECT * FROM programs WHERE id=?', rec.program_id) || rec;
  const k = episodeKey(p);
  if (!k) return [];
  const same = p.season != null && p.episode != null ? 'AND p.season=? AND p.episode=?' : 'AND p.subtitle=? COLLATE NOCASE';
  const cands = all(`SELECT p.*, c.name AS channel FROM programs p JOIN channels c ON c.id=p.channel_id WHERE p.title=? COLLATE NOCASE ${same}
    AND p.start > ? AND NOT (p.channel_id=? AND p.start=?) ORDER BY p.start LIMIT 20`,
    ...[p.title, ...(p.season != null && p.episode != null ? [p.season, p.episode] : [p.subtitle]), now(), rec.channel_id, rec.start]);
  const out = [];
  for (const c of cands) {
    if (out.length >= limit) break;
    if (get("SELECT 1 FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording')", c.channel_id, c.start)) continue;
    if (fits(c, rec, rec.id)) out.push({ programId: c.id, channelId: c.channel_id, channel: c.channel, start: c.start, stop: c.stop });
  }
  return out;
}
/** Kommande problem: bokningar som börjar sent, avbryts eller inte spelas in alls, med vilka de krockar med och alternativ */
export function conflictList({ withAlternatives = true } = {}) {
  const pl = plan();
  const rows = new Map(all(`SELECT ${PLAN_COLS} FROM recordings r JOIN channels c ON c.id=r.channel_id WHERE r.status IN ('scheduled','recording') AND r.stop > ?`, now()).map(r => [r.id, r]));
  const out = [];
  for (const [id, v] of pl) {
    if (v.outcome === 'ok') continue;
    const r = rows.get(id); if (!r) continue;
    out.push({
      recording: { id: r.id, title: r.title, subtitle: r.subtitle, channel_name: r.channel_name, start: r.start, stop: r.stop, priority: r.priority, status: r.status, rule_id: r.rule_id },
      outcome: v.outcome, text: outcomeText(v.outcome), from: v.from, to: v.to,
      with: v.by.map(b => rows.get(b)).filter(Boolean).map(b => ({ id: b.id, title: b.title, channel_name: b.channel_name, start: b.start, stop: b.stop, priority: b.priority })),
      alternatives: withAlternatives && r.status === 'scheduled' ? alternativesFor(r) : []
    });
  }
  return out.sort((a, b) => a.recording.start - b.recording.start);
}
/** Byt en bokning mot en annan sändning av samma program. Den gamla blir avbokad (bokas inte om av serieinspelningen). */
export function swapRecording(id, programId, user) {
  const r = get('SELECT * FROM recordings WHERE id=?', id);
  if (!r || r.status !== 'scheduled') throw new Error('Bara bokade inspelningar kan flyttas');
  const p = get('SELECT * FROM programs WHERE id=?', programId);
  if (!p || p.title.toLowerCase() !== r.title.toLowerCase()) throw new Error('Sändningen är inte samma program');
  // Finns sändningen redan bokad/inspelad (av någon annan) återanvänds den raden – den får inte flyttas in i regeln,
  // annars kunde regelns "Behåll senaste N" ta bort en annan användares inspelning
  const existed = get("SELECT id FROM recordings WHERE channel_id=? AND start=? AND status IN ('scheduled','recording','processing','done')", p.channel_id, p.start);
  const nid = scheduleProgram(p.id, user, null, { priority: r.priority, pad_before: r.pad_before, pad_after: r.pad_after, format: r.format, transcode: r.transcode });
  if (r.rule_id && !existed) run('UPDATE recordings SET rule_id=? WHERE id=? AND rule_id IS NULL', r.rule_id, nid);
  cancel(id);
  return nid;
}
/** Serieinspelningar som skulle missas eller avbrytas flyttas till en annan sändning av samma avsnitt, om en sådan får en tuner */
function resolveConflicts() {
  for (const c of conflictList({ withAlternatives: false })) {
    if (!c.recording.rule_id || c.recording.status !== 'scheduled' || c.outcome === 'late') continue;
    const rule = get('SELECT new_only FROM dvr_rules WHERE id=?', c.recording.rule_id);
    if (!rule?.new_only) continue;
    const rec = get('SELECT * FROM recordings WHERE id=?', c.recording.id);
    if (!rec || rec.start - padOf(rec).before <= now() + 300) continue; // nära start: rör inte
    const alt = alternativesFor(rec, 1)[0];
    if (!alt) continue;
    try { swapRecording(rec.id, alt.programId, { id: rec.created_by }); console.log(`[dvr] ${rec.title}: flyttad till ${alt.channel} för att undvika tunerkrock`); } catch {}
  }
}

/** Tunerkrockar (äldre API, används vid bokning): för varje källa, hur många inspelningar som som mest pågår samtidigt
 *  inom [start, stop] (med marginaler) jämfört med antalet tuners. channelId begränsar till kanalens källa; excludeId räknas inte med. */
export function conflicts(start, stop, { channelId = null, excludeId = null } = {}) {
  const g = globalPad();
  const tunerOf = channelId ? get('SELECT tuner_id FROM channels WHERE id=?', channelId)?.tuner_id : null;
  if (channelId && !tunerOf) return [];
  const recs = all(`SELECT r.id, r.title, r.channel_name, r.start, r.stop, r.pad_before, r.pad_after, c.tuner_id FROM recordings r JOIN channels c ON c.id=r.channel_id
    WHERE r.status IN ('scheduled','recording') AND r.start - COALESCE(r.pad_before, ?) < ? AND r.stop + COALESCE(r.pad_after, ?) > ? ${tunerOf ? 'AND c.tuner_id=?' : ''} ${excludeId ? 'AND r.id != ?' : ''} ORDER BY r.start`,
    ...[g.before, stop + g.after, g.after, start - g.before, ...(tunerOf ? [tunerOf] : []), ...(excludeId ? [excludeId] : [])]);
  const by = new Map();
  for (const r of recs) { if (!by.has(r.tuner_id)) by.set(r.tuner_id, []); by.get(r.tuner_id).push(r); }
  if (tunerOf && !by.has(tunerOf)) by.set(tunerOf, []);
  return [...by].map(([tunerId, list]) => {
    const t = get('SELECT name, tuner_count FROM tuners WHERE id=?', tunerId);
    // Största antal samtidiga (svep över start/slut), plus den nya bokningen själv när en kanal anges
    const ev = list.flatMap(r => { const p = padOf(r); return [[r.start - p.before, 1], [r.stop + p.after, -1]]; }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, peak = 0; for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur); }
    const tuners = t?.tuner_count || 2;
    return { tunerId, tunerName: t?.name || null, tuners, peak, recordings: list.map(({ tuner_id, pad_before, pad_after, ...r }) => r), conflict: channelId ? peak >= tuners : peak > tuners };
  });
}

// ---------- inspelning ----------
const active = new Map(); // recordingId → { proc, key, tuner, ts, priority }
const converting = new Map(); // recordingId → pågående ffprobe/ffmpeg i efterbearbetningen
// Aktivitetsindikatorn: pågående inspelningar och efterbearbetning
jobs.addSource(() => [
  ...[...active.keys()].map(id => { const r = get('SELECT title, start, stop FROM recordings WHERE id=?', id); const t = Date.now() / 1000;
    return { id: 'rec-' + id, kind: 'record', title: `Spelar in: ${r?.title || ''}`, detail: '', done: r ? Math.max(0, t - r.start) : 0, total: r ? r.stop - r.start : null }; }),
  ...[...converting.keys()].map(id => ({ id: 'conv-' + id, kind: 'record', title: `Bearbetar inspelning: ${get('SELECT title FROM recordings WHERE id=?', id)?.title || ''}`, detail: '', done: 0, total: null }))
]);
let shuttingDown = false;
// ffmpegs sista felrad – adresser i den kan innehålla inloggningen (Xtream): bara värden visas (iptv/net.js redact)
export const lastLine = (s, def) => redact(s.trim().split('\n').pop() || def);
const p2 = (n) => String(n).padStart(2, '0');

/** Mapp och filnamn (utan filändelse) som skannern känner igen: Serie/Season 01/Serie - S01E02 - Titel, annars
 *  Serie/Serie - 2026-10-27 2000 - Titel (datumavsnitt) */
export function recordingName(rec) {
  const show = safeName(rec.title);
  const d = new Date(rec.start * 1000);
  const sub = rec.subtitle ? ' - ' + safeName(rec.subtitle).slice(0, 60) : '';
  if (rec.season != null && rec.episode != null)
    return { dir: path.join(show, `Season ${p2(rec.season)}`), base: `${show} - S${p2(rec.season)}E${p2(rec.episode)}${sub}` };
  return { dir: show, base: `${show} - ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${sub}` };
}
/** Inspelningens slutliga namn ur TS-filen (som spelas in dold, med punkt först, så att skannern inte tar med den halvfärdig) */
const finalBase = (ts) => path.join(path.dirname(ts), path.basename(ts).replace(/\.ts$/, '').replace(/^\./, ''));

/** Högre prioritet: stoppa den pågående inspelningen med lägst prioritet på samma källa (det inspelade sparas) */
function preemptFor(rec, tunerId) {
  const prio = rec.priority || 0;
  const victims = [...active.entries()].filter(([, a]) => a.tuner === tunerId && (a.priority || 0) < prio && !a.preempted)
    .sort((a, b) => (a[1].priority || 0) - (b[1].priority || 0));
  if (!victims.length) return false;
  const [vid, a] = victims[0];
  a.preempted = true;
  run('UPDATE recordings SET error=? WHERE id=?', `Avbröts för ${rec.title} (högre prioritet) – det inspelade sparas`, vid);
  gentleStop(a.proc);
  console.log('[dvr] avbryter inspelning', vid, 'för', rec.title, '(högre prioritet)');
  return true;
}

function startRecording(rec) {
  let ch = null, key = null, acquired = false, g = null;
  try {
    ch = get('SELECT * FROM channels WHERE id=?', rec.channel_id);
    if (!ch) { run("UPDATE recordings SET status='failed', error='Kanalen finns inte längre' WHERE id=?", rec.id); return; }
    key = `rec-${rec.id}`;
    // IPTV: samma kontroll som live-TV – ffmpegs anslutningar går genom strömvakten (iptv/net.js)
    g = guardFor(ch);
    if (!acquireTuner(ch.tuner_id, key)) {
      // Ingen ledig tuner just nu: en inspelning med lägre prioritet får ge plats, annars väntar den kvar som schemalagd
      // och försöker igen vid nästa kontroll (tills programmet är slut)
      const bumped = preemptFor(rec, ch.tuner_id);
      if (!bumped && rec.error !== WAIT_TUNER) run("UPDATE recordings SET error=? WHERE id=? AND status='scheduled'", WAIT_TUNER, rec.id);
      return;
    }
    acquired = true;
    const nm = recordingName(rec);
    const dir = path.join(dvrDir(), nm.dir);
    fs.mkdirSync(dir, { recursive: true });
    let base = nm.base;
    // Samma avsnitt eller sändning på två kanaler (regel utan kanal) får inte skriva till samma fil
    const taken = (b) => [...active.values()].some(a => a.ts === path.join(dir, '.' + b + '.ts')) || ['.' + b + '.ts', b + '.ts', b + '.mp4', b + '.mkv'].some(f => fs.existsSync(path.join(dir, f)));
    if (taken(base)) base += ` (${rec.id})`;
    const ts = path.join(dir, '.' + base + '.ts');
    const until = rec.stop + padOf(rec).after;
    const dur = Math.max(10, until - now());
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_LIVE, ...g.args, ...httpOpts(ch.stream_url), '-fflags', '+genpts+discardcorrupt',
      '-i', ch.stream_url, '-map', '0:v:0?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-t', String(dur), '-f', 'mpegts', ts], { stdio: ['ignore', 'ignore', 'pipe'], env: g.env });
    let err = '', ended = false;
    proc.stderr.on('data', x => { err = (err + x).slice(-800); });
    active.set(rec.id, { proc, key, tuner: ch.tuner_id, ts, priority: rec.priority || 0 });
    run("UPDATE recordings SET status='recording', file=?, error=NULL WHERE id=?", ts, rec.id);
    console.log('[dvr] spelar in', rec.title, '→', ts);
    const tunerId = ch.tuner_id;
    const finish = (code, spawnErr) => {
      if (ended) return; ended = true;
      g.release();
      active.delete(rec.id);
      releaseTuner(tunerId, key);
      try {
        const r = get('SELECT status FROM recordings WHERE id=?', rec.id);
        if (!r || r.status === 'deleted') { fs.rmSync(ts, { force: true }); return; } // borttagen under inspelningen – ingen notis
        if (r.status === 'cancelled') return;
        if (shuttingDown) return; // servern stängs: den delvisa filen tas om hand vid nästa start
        const size = fs.existsSync(ts) ? fs.statSync(ts).size : 0;
        if (size < 100e3) {
          const why = spawnErr ? 'ffmpeg kunde inte startas: ' + spawnErr.message : lastLine(err, `ffmpeg avslutades (${code})`);
          run("UPDATE recordings SET status='failed', error=? WHERE id=?", why.slice(0, 300), rec.id);
          notify('dvr', 'Inspelning misslyckades', `${rec.title}: ${spawnErr ? why : lastLine(err, 'tom fil')}`, { priority: 4 });
          return;
        }
        run("UPDATE recordings SET status='processing', size=? WHERE id=?", size, rec.id);
        postProcess(rec.id, ts);
      } catch (e) { console.warn('[dvr] efter inspelning:', e.message); }
    };
    proc.on('error', (e) => finish(null, e));
    proc.on('close', (code) => finish(code));
  } catch (e) {
    console.warn('[dvr] kunde inte starta inspelning:', e.message);
    if (!active.has(rec.id)) g?.release();
    const a = active.get(rec.id);
    if (a) { active.delete(rec.id); try { a.proc.kill('SIGKILL'); } catch {} }
    if (acquired) releaseTuner(ch.tuner_id, key);
    try { run("UPDATE recordings SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), rec.id); } catch {}
  }
}

// ---------- efterbearbetning ----------
let processing = Promise.resolve();
const recStatus = (id) => get('SELECT status FROM recordings WHERE id=?', id)?.status;
/** Kör en process i efterbearbetningen (kan avbrytas av removeRecording/shutdown) → { code, out, err } */
function proc(id, cmd, args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: null, out: '', err: e.message }); }
    converting.set(id, p);
    let out = '', err = '', ended = false;
    p.stdout.on('data', x => { out = (out + x).slice(-2000); });
    p.stderr.on('data', x => { err = (err + x).slice(-500); });
    const done = (code, e) => { if (ended) return; ended = true; if (converting.get(id) === p) converting.delete(id); resolve({ code, out, err: e ? e.message : err }); };
    p.on('error', (e) => done(null, e));
    p.on('close', (code) => done(code));
  });
}
/** Metadata i filen (titel, serie, avsnitt) så att spelare och bibliotek visar rätt */
function metaArgs(rec) {
  const m = [];
  const add = (k, v) => { if (v != null && v !== '') m.push('-metadata', `${k}=${String(v).slice(0, 500)}`); };
  add('title', rec.subtitle || rec.title);
  add('show', rec.title);
  if (rec.season != null) add('season_number', rec.season);
  if (rec.episode != null) add('episode_sort', rec.episode);
  add('network', rec.channel_name);
  add('description', rec.description);
  add('date', new Date(rec.start * 1000).toISOString().slice(0, 10));
  return m;
}
/** ffmpeg-argument att prova i tur och ordning (utan utfil). copyOk = videon kan kopieras (H.264, ej flätad) */
export function postArgs(fmt, tc, copyOk, rec = {}) {
  const enc = liveEncoder({ deinterlace: true });
  const inp = (copy) => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...(copy ? [] : enc.pre), '-fflags', '+genpts'];
  const vEnc = [...enc.vf, ...enc.enc];
  const meta = metaArgs(rec);
  if (fmt === 'mkv') {
    // MKV behåller alla ljudspår och undertexter; video kopieras om den inte ska kodas om
    const copy = tc !== 'always';
    const v = copy ? ['-c:v', 'copy'] : vEnc;
    const withSubs = [...inp(copy), '-i', null, '-map', '0:v:0', '-map', '0:a?', '-map', '0:s?', ...v, '-c:a', 'copy', '-c:s', 'copy', ...meta, '-f', 'matroska'];
    const noSubs = [...inp(copy), '-i', null, '-map', '0:v:0', '-map', '0:a?', ...v, '-c:a', 'copy', ...meta, '-f', 'matroska'];
    return [withSubs, noSubs]; // teletext m.m. går inte i MKV – då utan undertexter
  }
  // MP4: H.264/AAC med faststart, spelas i webbläsare och appar
  const copy = tc === 'never' || (tc === 'auto' && copyOk);
  const mk = (c) => [...inp(c), '-i', null, '-map', '0:v:0', '-map', '0:a:0?', ...(c ? ['-c:v', 'copy'] : vEnc), '-c:a', 'aac', '-b:a', '192k', '-ac', '2', ...meta, '-movflags', '+faststart', '-f', 'mp4'];
  return copy && tc !== 'never' ? [mk(true), mk(false)] : [mk(copy)]; // kopieringen misslyckas → koda om
}
const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
/** NFO bredvid filen (Kodi/Jellyfin-format, läses av skannern) och tvshow.nfo med seriens TMDB-id om serien finns i biblioteket */
export function writeNfo(rec, file) {
  if (getSetting('dvr_nfo', '1') === '0') return;
  const d = new Date(rec.start * 1000);
  const aired = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const ep = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<episodedetails>',
    `  <title>${xmlEsc(rec.subtitle || `${rec.title} ${aired}`)}</title>`, `  <showtitle>${xmlEsc(rec.title)}</showtitle>`,
    ...(rec.season != null ? [`  <season>${rec.season}</season>`] : []), ...(rec.episode != null ? [`  <episode>${rec.episode}</episode>`] : []),
    ...(rec.description ? [`  <plot>${xmlEsc(rec.description)}</plot>`] : []), `  <aired>${aired}</aired>`,
    ...(rec.channel_name ? [`  <studio>${xmlEsc(rec.channel_name)}</studio>`] : []), '</episodedetails>', ''].join('\n');
  try { fs.writeFileSync(file.replace(MEDIA_EXT, '.nfo'), ep); } catch (e) { console.warn('[dvr] nfo:', e.message); }
  const show = get(`SELECT tmdb_id FROM items WHERE kind='show' AND tmdb_id IS NOT NULL AND (title=? COLLATE NOCASE OR original_title=? COLLATE NOCASE OR src_name=? COLLATE NOCASE) LIMIT 1`, rec.title, rec.title, rec.title);
  const showDir = path.join(dvrDir(), safeName(rec.title));
  const tv = path.join(showDir, 'tvshow.nfo');
  if (show?.tmdb_id && !fs.existsSync(tv)) {
    try { fs.writeFileSync(tv, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow>\n  <title>${xmlEsc(rec.title)}</title>\n  <uniqueid type="tmdb" default="true">${show.tmdb_id}</uniqueid>\n</tvshow>\n`); } catch {}
  }
}
/** Efterbearbetning (en i taget): MP4/MKV/TS enligt inställningen, metadata och NFO. TS-filen tas bort efteråt (om inte annat valts). */
function postProcess(id, ts) {
  processing = processing.then(() => doPost(id, ts)).catch((e) => console.warn('[dvr] efterbearbetning:', e.message)); // kedjan får aldrig fastna
}
async function doPost(id, ts) {
  // Borttagen medan den väntade i kön
  if (!['processing', 'recording'].includes(recStatus(id))) { fs.rmSync(ts, { force: true }); return; }
  const rec = get('SELECT * FROM recordings WHERE id=?', id);
  const fmt = fmtOf(rec), tc = tcOf(rec);
  const base = finalBase(ts);
  const gone = () => { const st = recStatus(id); return !st || st === 'deleted' || st === 'cancelled'; };
  let out = base + '.' + fmt;
  const cleanup = () => { if (out !== ts) fs.rmSync(out, { force: true }); fs.rmSync(ts, { force: true }); };
  let error = null;
  if (fmt === 'ts') {
    // Behåll originalet: bara byt till det synliga namnet
    if (out !== ts) { try { fs.renameSync(ts, out); } catch (e) { error = e.message; out = ts; } }
  } else {
    // H.264-källor (IPTV/DVB-T2) kopieras direkt, annars omkodning (MPEG-2 från DVB-T/kabel)
    const pr = await proc(id, 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,field_order', '-of', 'csv=p=0', ts]);
    if (gone()) return cleanup();
    if (shuttingDown) return; // görs om vid nästa start
    const v = pr.out.trim();
    const copyOk = /^h264,(progressive|unknown)?/.test(v) || v === 'h264';
    error = 'okänt fel';
    for (const args of postArgs(fmt, tc, copyOk, rec)) {
      const r = await proc(id, 'ffmpeg', [...args.map(a => a === null ? ts : a), out]);
      if (gone()) return cleanup();
      if (shuttingDown) return;
      if (r.code === 0) { error = null; break; }
      error = lastLine(r.err, `ffmpeg avslutades (${r.code})`);
    }
    if (error) {
      fs.rmSync(out, { force: true });
      // TS-filen finns kvar och går att spela i apparna (och laddas ner) – byt till det synliga namnet
      const vis = base + '.ts';
      try { if (vis !== ts) fs.renameSync(ts, vis); } catch { }
      const file = fs.existsSync(vis) ? vis : ts;
      run("UPDATE recordings SET status='done', file=?, size=?, error=? WHERE id=?", file, fs.existsSync(file) ? fs.statSync(file).size : null, `Kunde inte göra ${fmt.toUpperCase()}: ${error}`.slice(0, 300), id);
      notify('dvr', 'Inspelning sparad som TS', `${rec.title}: ${error}`, { priority: 3 });
      return;
    }
    if (getSetting('dvr_keep_ts', '0') === '1') { const vis = base + '.ts'; try { if (vis !== ts) fs.renameSync(ts, vis); } catch {} }
    else fs.rmSync(ts, { force: true });
  }
  if (gone()) return cleanup();
  writeNfo(rec, out);
  const st = fs.statSync(out);
  run("UPDATE recordings SET status='done', file=?, size=?, error=? WHERE id=?", out, st.size, error ? error.slice(0, 300) : (rec.error && /Avbröts/.test(rec.error) ? rec.error : null), id);
  notify('dvr', 'Inspelning klar', `${rec.title}${rec.subtitle ? ' – ' + rec.subtitle : ''} (${rec.channel_name}) finns att titta på.`, { priority: 2 });
  webhooks.emit('recording.done', { recording: { id: rec.id, title: rec.title, subtitle: rec.subtitle || null, channel: rec.channel_name || null, start: rec.start, stop: rec.stop, size: st.size } });
  comskip.enqueue(id); // reklamavbrott letas i bakgrunden
  enforceKeep(rec.rule_id);
}
/** "Behåll senaste N" för en regel: äldre klara inspelningar tas bort – aldrig de som markerats "behåll alltid" */
export function enforceKeep(ruleId) {
  if (!ruleId) return;
  const r = get('SELECT keep FROM dvr_rules WHERE id=?', ruleId);
  if (!r?.keep) return;
  for (const old of all("SELECT id FROM recordings WHERE rule_id=? AND status='done' AND keep_forever=0 ORDER BY start DESC LIMIT -1 OFFSET ?", ruleId, r.keep)) removeRecording(old.id);
}
/** Ta bort en inspelning: filerna tas bort och raden blir en gravsten ('deleted') så att avsnittet inte spelas in igen. */
export function removeRecording(id) {
  const r = get('SELECT * FROM recordings WHERE id=?', id); if (!r) return;
  if (r.status === 'scheduled') return cancel(id);
  if (r.status === 'cancelled' || r.status === 'deleted') return;
  if (r.status === 'failed') { run('DELETE FROM recordings WHERE id=?', id); return; } // inget spelades in – inget att komma ihåg
  // Markera först, så att avslutande processer ser att den är borttagen (ingen felnotis, ingen efterbearbetning)
  run("UPDATE recordings SET status='deleted', file=NULL, size=NULL, error=NULL WHERE id=?", id);
  comskip.forget(id);
  growing.stop(id);
  const a = active.get(id);
  if (a) try { a.proc.kill('SIGINT'); } catch {}
  const c = converting.get(id);
  if (c) try { c.kill('SIGKILL'); } catch {}
  if (r.file) {
    const dir = path.dirname(r.file);
    const b = path.basename(r.file).replace(MEDIA_EXT, '').replace(/^\./, '');
    for (const f of new Set([r.file, ...['.ts', '.mp4', '.mkv', '.nfo'].map(e => path.join(dir, b + e)), path.join(dir, '.' + b + '.ts')])) fs.rmSync(f, { force: true });
    // Tomma mappar upp till inspelningsmappen (Season 01, serien); tvshow.nfo ensam räknas som tom
    try {
      const root = path.resolve(dvrDir());
      for (let d = path.resolve(dir); d.startsWith(root + path.sep); d = path.dirname(d)) {
        const left = fs.readdirSync(d);
        if (left.length === 1 && left[0] === 'tvshow.nfo') fs.rmSync(path.join(d, 'tvshow.nfo'));
        else if (left.length) break;
        fs.rmdirSync(d);
      }
    } catch {}
  }
}
/** Be ffmpeg avsluta snyggt (SIGINT skriver klart filen). En ström som står still kan hindra det – då SIGKILL efter
 *  några sekunder (MPEG-TS tål att sista paketet saknas). */
function gentleStop(p, ms = 5000) {
  try { p.kill('SIGINT'); } catch {}
  setTimeout(() => { if (p.exitCode == null && p.signalCode == null) try { p.kill('SIGKILL'); } catch {} }, ms).unref();
}
export function stopRecording(id) {
  const a = active.get(id);
  if (a) gentleStop(a.proc); // ffmpeg avslutar filen och efterbearbetningen körs
}

/** Körs var 5:e sekund: starta inspelningar som ska börja (högst prioritet först) */
function tick() {
  try {
    const g = globalPad();
    for (const rec of all("SELECT * FROM recordings WHERE status='scheduled' AND start - COALESCE(pad_before, ?) <= ? ORDER BY priority DESC, start, id", g.before, now())) {
      try {
        if (rec.stop <= now()) {
          const noTuner = rec.error === WAIT_TUNER;
          run("UPDATE recordings SET status='failed', error=? WHERE id=?", noTuner ? 'Ingen ledig tuner' : 'Missades (servern var avstängd)', rec.id);
          if (noTuner) notify('dvr', 'Inspelning misslyckades', `${rec.title}: ingen ledig tuner.`, { priority: 4 });
          continue;
        }
        if (!active.has(rec.id)) startRecording(rec);
      } catch (e) { console.warn('[dvr] inspelning', rec.id, e.message); }
    }
    // Gamla gravstenar: avbokningar behövs bara tills sändningen är över, borttagna utan avsnittsinfo hindrar inga dubbletter
    run("DELETE FROM recordings WHERE (status='cancelled' AND stop < ?) OR (status='deleted' AND stop < ? AND season IS NULL AND subtitle IS NULL)", now() - 86400, now() - 86400);
  } catch (e) { console.warn('[dvr] tick:', e.message); }
}
setInterval(tick, 5000).unref();
setInterval(() => { try { applyRules(); } catch (e) { console.warn('[dvr] regler:', e.message); } }, 3600e3).unref();
// Konflikter som uppstår (ny bokning, ändrad guide): notis en gång per inspelning, i god tid
const warned = new Set();
setInterval(() => {
  try {
    for (const c of conflictList({ withAlternatives: false })) {
      if (c.outcome === 'ok' || warned.has(c.recording.id) || c.recording.start > now() + 86400) continue;
      warned.add(c.recording.id);
      notify('dvr', 'Tunerkrock', `${c.recording.title} (${c.recording.channel_name || ''}) ${c.text}.`, { priority: 3, key: 'dvr-conflict:' + c.recording.id, minInterval: 86400 });
    }
  } catch {}
}, 600e3).unref();
// Reklamanalysen väntar medan inspelningar konverteras eller servern kodar om flera strömmar
comskip.setBusyCheck(() => converting.size > 0 || activeTranscodes().length + activeLive().length >= 2);
setTimeout(() => { try { comskip.resume(); } catch (e) { console.warn('[dvr] reklamanalys:', e.message); } }, 20000).unref();
// Avbrutna inspelningar vid omstart
for (const r of all("SELECT * FROM recordings WHERE status IN ('recording','processing')")) {
  // Det som hann spelas in innan omstarten tas till vara
  if (r.file && fs.existsSync(r.file) && fs.statSync(r.file).size > 1e6 && r.file.endsWith('.ts')) { run("UPDATE recordings SET status='processing', error='Avbröts av omstart – delvis inspelad' WHERE id=?", r.id); postProcess(r.id, r.file); }
  else run("UPDATE recordings SET status='failed', error='Avbröts av omstart' WHERE id=?", r.id);
}

/** Vid avstängning: be ffmpeg avsluta inspelningarna snyggt (SIGINT skriver klart .ts-filen) och avbryt konverteringar.
 *  Inspelningarna efterbearbetas vid nästa start. Väntar högst timeoutMs. */
export async function shutdown(timeoutMs = 5000) {
  shuttingDown = true;
  comskip.stop(); // görs om vid nästa start
  growing.shutdown();
  const procs = [...active.values()].map(a => a.proc);
  for (const p of procs) try { p.kill('SIGINT'); } catch {}
  for (const p of converting.values()) try { p.kill('SIGKILL'); } catch {}
  await Promise.race([
    Promise.all(procs.map(p => p.exitCode != null || p.signalCode != null ? null : new Promise(r => p.once('close', r)))),
    new Promise(r => setTimeout(r, timeoutMs).unref())
  ]);
  for (const p of procs) if (p.exitCode == null && p.signalCode == null) try { p.kill('SIGKILL'); } catch {}
}

// ---------- API-hjälp ----------
/** Reklamavbrott på klara inspelningar: commercials = [{ start, end }] i sekunder, commercials_status = pending|running|done|failed|null */
function withCommercials(rows) {
  const info = comskip.infoFor(rows.filter(r => r.status === 'done').map(r => r.id));
  return rows.map(r => { const c = info.get(r.id); return { ...r, commercials: c?.status === 'done' ? c.segments : [], commercials_status: c?.status || null }; });
}
/** Diskutrymme: ledigt/totalt där inspelningarna sparas, vad de tar och en uppskattning för de kommande */
export function diskInfo(scheduled = null) {
  let free = null, total = null;
  try { const s = fs.statfsSync(dvrDir()); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {}
  const used = get("SELECT COALESCE(SUM(size),0) AS n FROM recordings WHERE status='done'").n;
  // Bytes per sekund ur tidigare inspelningar (annars ungefär 2,5 GB/timme som för HD-TV)
  const rate = get("SELECT SUM(size) AS b, SUM(stop - start) AS s FROM (SELECT size, start, stop FROM recordings WHERE status='done' AND size > 0 ORDER BY start DESC LIMIT 50)");
  const bps = rate?.s > 0 ? rate.b / rate.s : 2.5e9 / 3600;
  const sched = scheduled || all("SELECT start, stop FROM recordings WHERE status IN ('scheduled','recording') AND start < ?", now() + 7 * 86400);
  const upcoming = Math.round(sched.reduce((a, r) => a + Math.max(0, r.stop - Math.max(r.start, now())), 0) * bps);
  return { free, total, used, upcoming, bytesPerHour: Math.round(bps * 3600) };
}
export const list = () => {
  const pl = plan();
  const scheduled = all("SELECT * FROM recordings WHERE status IN ('scheduled','recording') ORDER BY start").map(r => {
    const o = pl.get(r.id)?.outcome || 'ok';
    return { ...r, plan: o, planText: outcomeText(o) || null, watchable: r.status === 'recording' };
  });
  return {
    scheduled,
    done: withCommercials(all("SELECT * FROM recordings WHERE status IN ('done','processing','failed') ORDER BY start DESC LIMIT 500")),
    rules: all(`SELECT r.*, c.name AS channel_name, (SELECT COUNT(*) FROM recordings x WHERE x.rule_id=r.id AND x.status='scheduled') AS upcoming,
      (SELECT COUNT(*) FROM recordings x WHERE x.rule_id=r.id AND x.status='done') AS recorded FROM dvr_rules r LEFT JOIN channels c ON c.id=r.channel_id ORDER BY r.title`),
    conflicts: scheduled.filter(r => r.plan !== 'ok').length,
    disk: diskInfo(scheduled.filter(r => r.start < now() + 7 * 86400)),
    defaults: { format: fmtOf(null), transcode: tcOf(null), padBefore: globalPad().before, padAfter: globalPad().after }
  };
};
export const removeRule = (id) => { run("DELETE FROM recordings WHERE rule_id=? AND status IN ('scheduled','cancelled')", id); run('DELETE FROM dvr_rules WHERE id=?', id); };
/** Avboka: en schemalagd blir en gravsten (bokas inte om av serieinspelningen), en pågående stoppas och sparas. */
export const cancel = (id) => {
  const r = get('SELECT status FROM recordings WHERE id=?', id);
  if (r?.status === 'scheduled') run("UPDATE recordings SET status='cancelled', error=NULL WHERE id=? AND status='scheduled'", id);
  else if (r?.status === 'recording') stopRecording(id);
};

const MIME = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.ts': 'video/mp2t' };
export function serveRecording(req, res, id) {
  const r = get('SELECT * FROM recordings WHERE id=?', id);
  if (r?.status !== 'done' || !r.file || !MEDIA_EXT.test(r.file)) return fail(res, 404, 'Inspelningen är inte klar');
  let st;
  try { st = fs.statSync(r.file); } catch { return fail(res, 404, 'Inspelningen är inte klar'); }
  // Gemensam Range-hantering; pipeline stänger filen när spelaren avbryter vid spolning
  streamFile(req, res, r.file, st.size, { 'Content-Type': MIME[path.extname(r.file)] || 'application/octet-stream' });
}
/** Titta medan den spelas in: HLS av den växande TS-filen (dvrlive.js) */
export function serveGrowing(res, id, token) {
  const r = get('SELECT status, file FROM recordings WHERE id=?', id);
  if (r?.status !== 'recording' || !r.file?.endsWith('.ts')) return fail(res, 404, 'Inspelningen pågår inte');
  return growing.servePlaylist(res, id, r.file, token);
}
export const serveGrowingSegment = (req, res, id, name) => growing.serveSegment(req, res, id, name);
