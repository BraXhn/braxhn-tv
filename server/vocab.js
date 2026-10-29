// Ordlistan i språkinlärningsläget (webbspelaren, web/js/player/learn.js): ord som tittaren klickat på i
// undertexten sparas per profil med meningen (repliken), översättningen (den andra undertextens replik vid samma tid
// – ingen extern tjänst), tidpunkten och titeln. Export till Anki som CSV/TSV med Ankis filhuvud (#separator,
// #columns) eller som ZIP med ljudklipp av repliken (MP3 ur filmens ljudspår med ffmpeg, en i taget).
// Tabellen vocab finns i db.js; raden finns kvar om titeln tas bort (item_id blir NULL, source behålls).
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { all, get, run, now } from './db.js';
import { SAFE_IN, streamsOf } from './stream.js';
import { lowPriority } from './util.js';

export const MAX_WORDS = 5000;      // per profil
export const MAX_CLIP = 15;         // sekunder per ljudklipp
export const MAX_ZIP_CLIPS = 100;   // ljudklipp i en ZIP-export
const PAD = 0.25;                   // marginal före och efter repliken i ljudklippet
const LIMITS = { word: 100, sentence: 600, translation: 600, lang: 16 };

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (x) => { const v = Number(x); return Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v * 1000) / 1000 : null; };

/** Titelns namn som källa: "Film (2020)" eller "Serie S01E02 – Avsnitt" */
export function sourceOf(it) {
  if (!it) return '';
  if (it.kind === 'episode') {
    const show = it.parent_id ? get('SELECT title FROM items WHERE id=?', it.parent_id)?.title : null;
    const se = it.season != null && it.episode != null ? ` S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}` : '';
    return `${show || ''}${se}${it.title ? (show ? ' – ' : '') + it.title : ''}`.trim();
  }
  return it.year ? `${it.title} (${it.year})` : it.title || '';
}

/** Läser och kontrollerar ett nytt ord från klienten. Fel → { error } */
export function parse(b) {
  const word = clean(b?.word, LIMITS.word);
  if (!word || !/[\p{L}\p{N}]/u.test(word)) return { error: 'Ordet saknas' };
  const s = num(b.start), e = num(b.end);
  return { word, sentence: clean(b.sentence, LIMITS.sentence), translation: clean(b.translation, LIMITS.translation),
    lang: clean(b.lang, LIMITS.lang).replace(/[^\w-]/g, '') || null, s, e: s != null && e != null && e > s ? e : null,
    position: num(b.position), audio: Number.isInteger(b.audio) || /^\d{1,3}$/.test(String(b.audio ?? '')) ? +b.audio : null };
}

/** Sparar ordet. Samma ord ur samma replik i samma titel sparas inte två gånger (svaret har då dup: true). */
export function add(uid, it, w) {
  const old = get('SELECT id FROM vocab WHERE user_id=? AND item_id IS ? AND lower(word)=lower(?) AND sentence=?', uid, it?.id ?? null, w.word, w.sentence);
  if (old) return { id: old.id, dup: true };
  if (get('SELECT COUNT(*) AS n FROM vocab WHERE user_id=?', uid).n >= MAX_WORDS) return { error: `Ordlistan är full (högst ${MAX_WORDS} ord)` };
  const r = run(`INSERT INTO vocab(user_id, item_id, word, sentence, translation, lang, source, s, e, position, audio, created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, uid, it?.id ?? null, w.word, w.sentence, w.translation, w.lang, sourceOf(it), w.s, w.e, w.position, w.audio, now());
  return { id: Number(r.lastInsertRowid), dup: false };
}

const out = (r) => ({ id: r.id, word: r.word, sentence: r.sentence, translation: r.translation, lang: r.lang, source: r.source,
  itemId: r.item_id, start: r.s, end: r.e, position: r.position, created: r.created, clip: r.item_id != null && r.s != null });

/** Profilens ord, nyast först. allowed(itemRow) – titlar profilen inte längre får se (åldersgräns, bibliotek) döljs. */
export function list(uid, allowed, { item = null, q = '' } = {}) {
  const rows = all(`SELECT v.*, i.library_id, i.age, i.parent_id, i.version_of, i.kind AS ikind FROM vocab v LEFT JOIN items i ON i.id=v.item_id
    WHERE v.user_id=? ${item != null ? 'AND v.item_id=?' : ''} ORDER BY v.created DESC, v.id DESC`, uid, ...(item != null ? [item] : []));
  const needle = String(q || '').toLowerCase().trim();
  return rows.filter(r => (r.item_id == null || allowed({ id: r.item_id, library_id: r.library_id, age: r.age, parent_id: r.parent_id, version_of: r.version_of, kind: r.ikind }))
    && (!needle || `${r.word} ${r.sentence} ${r.translation}`.toLowerCase().includes(needle))).map(out);
}

export const one = (uid, id) => get('SELECT * FROM vocab WHERE id=? AND user_id=?', id, uid);
export function update(uid, id, b) {
  const r = one(uid, id); if (!r) return null;
  const word = b.word !== undefined ? clean(b.word, LIMITS.word) : r.word;
  if (!word) return { error: 'Ordet saknas' };
  const translation = b.translation !== undefined ? clean(b.translation, LIMITS.translation) : r.translation;
  run('UPDATE vocab SET word=?, translation=? WHERE id=?', word, translation, id);
  return out({ ...r, word, translation });
}
export const remove = (uid, id) => Number(run('DELETE FROM vocab WHERE id=? AND user_id=?', id, uid).changes) > 0;

// ---------------- export ----------------
const FIELDS = ['Ord', 'Mening', 'Översättning', 'Källa'];
const csvCell = (s) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
const tsvCell = (s) => s.replace(/[\t\r\n]+/g, ' ');
export const clipName = (r) => `braxhn-${r.id}.mp3`;
/**
 * Anki-fil (Arkiv → Importera): filhuvudet talar om avgränsare, att fälten är ren text och kolumnernas namn.
 * sound = rader med ljudklipp får fältet "[sound:braxhn-<id>.mp3]" (filerna ligger bredvid i ZIP:en).
 */
export function exportText(rows, format = 'tsv', sound = null) {
  const tsv = format !== 'csv', cell = tsv ? tsvCell : csvCell, sep = tsv ? '\t' : ',';
  const cols = sound ? [...FIELDS, 'Ljud'] : FIELDS;
  const head = [`#separator:${tsv ? 'Tab' : 'Comma'}`, '#html:false', `#columns:${cols.join(sep)}`];
  const lines = rows.map(r => [r.word, r.sentence, r.translation, r.source, ...(sound ? [sound.has(r.id) ? `[sound:${clipName(r)}]` : ''] : [])].map(x => cell(String(x ?? ''))).join(sep));
  return [...head, ...lines].join('\n') + '\n';
}

// ---------------- ljudklipp ----------------
let clipsRunning = 0;
export const MAX_CLIPS = 2;
export const clipsBusy = () => clipsRunning;
/** Platsen tas innan något väntar (annars kommer samtidiga förfrågningar alla förbi taket). null = fullt. */
export function clipSlot() {
  if (clipsRunning >= MAX_CLIPS) return null;
  clipsRunning++;
  let done = false;
  return () => { if (!done) { done = true; clipsRunning--; } };
}
/** Repliken som MP3 (mono 64 kbit/s) ur titelns fil, valt ljudspår om det finns. Buffer eller fel. */
export function clipMp3(it, r) {
  const a = streamsOf(it).filter(s => s.type === 'audio');
  const track = r.audio != null && a.some(s => s.index === r.audio) ? `0:${r.audio}` : '0:a:0';
  const ss = Math.max(0, r.s - PAD), dur = Math.min(MAX_CLIP, Math.max(0.3, (r.e ?? r.s + 3) - r.s + 2 * PAD));
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...SAFE_IN, '-ss', ss.toFixed(3), '-i', it.path, '-t', dur.toFixed(3),
    '-map', track, '-vn', '-sn', '-dn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1', '-f', 'mp3', 'pipe:1'];
  return new Promise((ok, no) => {
    const p = lowPriority(spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const chunks = []; let err = '', size = 0;
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stdout.on('data', (c) => { size += c.length; if (size > 4 << 20) p.kill('SIGKILL'); else chunks.push(c); });
    p.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
    p.on('error', (e) => { clearTimeout(timer); no(e); });
    p.on('close', (code) => { clearTimeout(timer); const b = Buffer.concat(chunks); code === 0 && b.length ? ok(b) : no(new Error(err.trim().split('\n').pop() || 'ffmpeg avbröts')); });
  });
}

// ---------------- ZIP (utan komprimering – MP3 och text packas ändå dåligt) ----------------
/** files: [{ name, data: Buffer }] → Buffer med en ZIP (lagrade poster, UTF-8-namn) */
export function zip(files) {
  const parts = [], central = [];
  let off = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = zlib.crc32(f.data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, f.data); central.push(c, name);
    off += h.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
