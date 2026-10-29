// Låttexter ur ID3v2-taggar (MP3, AIFF/WAV/FLAC med ID3 först): SYLT (synkad text med tider) och USLT (vanlig text).
// ffprobe visar USLT som taggen lyrics-<språk> men läser inte SYLT alls – därför en egen, liten läsare.
// Bara ramarna SYLT/USLT (ID3v2.2: SLT/ULT) läses in; bilder och annat hoppas över utan att läsas.
// Stöder ID3v2.2–2.4, syncsafe-storlekar (2.4), avsynkronisering (hela taggen i 2.3, per ram i 2.4) och
// textkodningarna ISO-8859-1, UTF-16 med BOM, UTF-16BE och UTF-8. SYLT med tider i MPEG-bildrutor (format 1) går inte
// att räkna om utan bildfrekvens och hoppas över – nästan alla program skriver millisekunder (format 2).
import fs from 'node:fs';

const MAX_TAG = 32 << 20, MAX_FRAME = 1 << 20;
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => b.readUInt32BE(o);
/** Tar bort avsynkroniseringens 0x00 efter 0xFF */
function unsync(b) {
  const out = Buffer.alloc(b.length); let n = 0;
  for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; }
  return out.subarray(0, n);
}
/** Läser en nollterminerad sträng med kodningen enc från pos. Returnerar [text, nästa position]. */
export function readStr(b, pos, enc) {
  const wide = enc === 1 || enc === 2;
  let end = pos;
  if (wide) { while (end + 1 < b.length && !(b[end] === 0 && b[end + 1] === 0)) end += 2; }
  else { while (end < b.length && b[end] !== 0) end++; }
  const raw = b.subarray(pos, Math.min(end, b.length));
  const next = Math.min(b.length, end + (wide ? 2 : 1));
  return [decode(raw, enc), next];
}
function decode(raw, enc) {
  if (enc === 0) return raw.toString('latin1');
  if (enc === 3) return raw.toString('utf8').replace(/^﻿/, '');
  let le = enc === 1; // UTF-16 med BOM (standard: little endian om BOM saknas – vanligast i praktiken)
  let s = raw;
  if (s.length >= 2 && s[0] === 0xff && s[1] === 0xfe) { le = true; s = s.subarray(2); }
  else if (s.length >= 2 && s[0] === 0xfe && s[1] === 0xff) { le = false; s = s.subarray(2); }
  if (!le) { const c = Buffer.from(s.subarray(0, s.length & ~1)); c.swap16(); return c.toString('utf16le'); }
  return Buffer.from(s.subarray(0, s.length & ~1)).toString('utf16le');
}

/**
 * SYLT-ramens innehåll → rader. Två skrivsätt finns: en post per rad, eller en post per stavelse/ord där en ny rad
 * börjar med radbrytning (så skriver t.ex. SyltEdit och MiniLyrics). Ord-tiderna följer med som words.
 * @returns {{ t: number, text: string, words?: { t: number, text: string }[] }[] | null}
 */
export function parseSylt(b) {
  if (b.length < 6) return null;
  const enc = b[0], fmt = b[4];
  if (fmt !== 2) return null; // 1 = MPEG-bildrutor
  let [, pos] = readStr(b, 6, enc); // beskrivning
  const items = [];
  while (pos < b.length && items.length < 20000) {
    const [text, next] = readStr(b, pos, enc);
    if (next + 4 > b.length) break;
    items.push({ t: be32(b, next) / 1000, text });
    pos = next + 4;
  }
  if (!items.length) return null;
  const perWord = items.slice(1).some(x => /^[\r\n]/.test(x.text));
  const lines = [];
  if (!perWord) for (const x of items) lines.push({ t: x.t, text: clean(x.text) });
  else {
    let cur = null;
    for (const x of items) {
      if (!cur || /^[\r\n]/.test(x.text)) { cur = { t: x.t, text: '', words: [] }; lines.push(cur); }
      const w = x.text.replace(/^[\r\n]+/, '');
      if (w) { cur.words.push({ t: x.t, text: w }); cur.text += w; }
    }
    for (const l of lines) { l.text = clean(l.text); if (l.words.length < 2) delete l.words; }
  }
  lines.sort((a, c) => a.t - c.t);
  return lines.slice(0, 3000).map(l => ({ ...l, t: Math.round(l.t * 1000) / 1000 }));
}
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

/** USLT-ramens text (kodning, språk, beskrivning, text) */
export function parseUslt(b) {
  if (b.length < 5) return '';
  const enc = b[0];
  const [, pos] = readStr(b, 4, enc);
  return decode(b.subarray(pos), enc).replace(/\0+$/, '');
}

/**
 * Läser SYLT och USLT ur filens ID3v2-tagg. Fel (saknad fil, trasig tagg) ger tomt svar.
 * @returns {Promise<{ sylt: object[] | null, uslt: string }>}
 */
export async function id3Lyrics(file) {
  const out = { sylt: null, uslt: '' };
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const head = Buffer.alloc(10);
    if ((await fh.read(head, 0, 10, 0)).bytesRead < 10 || head.toString('latin1', 0, 3) !== 'ID3') return out;
    const ver = head[3], flags = head[5], size = syncsafe(head, 6);
    if (ver < 2 || ver > 4 || size <= 0 || size > MAX_TAG) return out;
    const tagUnsync = (flags & 0x80) && ver < 4;
    let tag = null; // hela taggen läses bara när avsynkroniseringen gäller hela taggen (2.2/2.3)
    const read = async (pos, len) => {
      if (tag) return tag.subarray(pos, pos + len);
      const b = Buffer.alloc(len); const r = await fh.read(b, 0, len, 10 + pos); return b.subarray(0, r.bytesRead);
    };
    if (tagUnsync) { tag = Buffer.alloc(size); await fh.read(tag, 0, size, 10); tag = unsync(tag); }
    const end = tag ? tag.length : size;
    let pos = 0;
    if ((flags & 0x40) && ver >= 3) { // utökat huvud
      const e = await read(0, 4);
      pos = ver === 4 ? syncsafe(e, 0) : be32(e, 0) + 4;
    }
    const hl = ver === 2 ? 6 : 10;
    for (let n = 0; pos + hl <= end && n < 5000; n++) {
      const h = await read(pos, hl);
      if (h.length < hl || h[0] === 0) break; // utfyllnad
      const id = h.toString('latin1', 0, ver === 2 ? 3 : 4);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const len = ver === 2 ? (h[3] << 16) | (h[4] << 8) | h[5] : ver === 4 ? syncsafe(h, 4) : be32(h, 4);
      const fflags = ver === 2 ? 0 : h[9];
      pos += hl;
      if (len <= 0 || pos + len > end) break;
      const want = (id === 'SYLT' || id === 'SLT') ? 'sylt' : (id === 'USLT' || id === 'ULT') ? 'uslt' : null;
      if (want && len <= MAX_FRAME && !(want === 'sylt' && out.sylt) && !(want === 'uslt' && out.uslt)) {
        let body = await read(pos, len);
        if (ver === 4 && (fflags & 0x02)) body = unsync(body);
        if (ver === 4 && (fflags & 0x01)) body = body.subarray(4); // datalängd före innehållet
        if (!(fflags & (ver === 4 ? 0x0c : 0xc0))) { // komprimerat/krypterat hoppas över
          if (want === 'sylt') out.sylt = parseSylt(body);
          else out.uslt = parseUslt(body).trim();
        }
      }
      pos += len;
    }
  } catch { /* ingen eller trasig tagg */ }
  finally { await fh?.close().catch(() => {}); }
  return out;
}

// ---------- för testerna: bygger en ID3v2.3-tagg ----------
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
function frame(id, body) { const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); }
/** ID3v2.3 med SYLT (entries: [[ms, text]]) och/eller USLT. Används av testerna för att skapa filer. */
export function buildId3({ sylt, uslt, title } = {}) {
  const frames = [];
  if (title) frames.push(frame('TIT2', Buffer.concat([Buffer.from([1]), utf16(title).subarray(0, -2)])));
  if (uslt) frames.push(frame('USLT', Buffer.concat([Buffer.from([1]), Buffer.from('swe'), utf16(''), utf16(uslt).subarray(0, -2)])));
  if (sylt) {
    const parts = [Buffer.from([1]), Buffer.from('swe'), Buffer.from([2, 1]), utf16('')];
    for (const [ms, text] of sylt) { const ts = Buffer.alloc(4); ts.writeUInt32BE(ms); parts.push(utf16(text), ts); }
    frames.push(frame('SYLT', Buffer.concat(parts)));
  }
  const body = Buffer.concat([...frames, Buffer.alloc(64)]);
  const h = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  const s = body.length;
  h[6] = (s >> 21) & 0x7f; h[7] = (s >> 14) & 0x7f; h[8] = (s >> 7) & 0x7f; h[9] = s & 0x7f;
  return Buffer.concat([h, body]);
}
