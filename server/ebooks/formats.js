// Metadata ur e-böcker och serietidningar: EPUB (OPF, innehållsförteckning ur nav/NCX, omslag), CBZ (ComicInfo.xml,
// sidorna i naturlig ordning) och PDF (Info-ordlistan/XMP, sidantal och ev. ett JPEG-omslag). Rena funktioner över
// ett öppnat arkiv (zip.js) eller en fil – inget skrivs till disk. Allt som inte går att läsa blir null/tomt, aldrig ett
// undantag som stoppar skanningen (utom att filen inte är ett arkiv alls).
import fs from 'node:fs';
import path from 'node:path';
import { parseXml, find, findAll, attr, kids, textOf } from './xml.js';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const XML_ENTRY = 4 << 20;  // OPF, NCX, nav, ComicInfo
const DOC_ENTRY = 16 << 20; // XHTML-kapitel (teckenräkningen)
const natural = (a, b) => a.localeCompare(b, 'sv', { numeric: true, sensitivity: 'base' });
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t ? t.slice(0, n) : null; };

/** Sökvägen href relativt mappen base inne i arkivet ('/' mellan delarna), utan #fragment och ?fråga – null om den går ovanför roten */
export function resolveHref(base, href) {
  let h = String(href || '').split('#')[0].split('?')[0];
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // http:, data:, javascript: … är aldrig poster i arkivet
  try { h = decodeURIComponent(h); } catch {}
  const parts = h.startsWith('/') ? [] : (base ? base.split('/') : []);
  for (const p of h.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(p);
  }
  return parts.length ? parts.join('/') : null;
}
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
/** Bildtypen ur de första byten (inte ur filnamnet) – null om det inte är en bild webbläsaren visar */
export function imageType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}

// ---------- EPUB ----------
async function xmlEntry(zip, name) {
  if (!name || !zip.entries.has(name)) return null;
  try { return parseXml(await zip.read(name, XML_ENTRY)); } catch { return null; }
}
/** Ungefärligt antal tecken text i ett XHTML-dokument (för procent och läsposition) – taggar räknas inte */
export function textLength(buf) {
  const s = buf.toString('utf8');
  let n = 0, i = 0;
  const body = s.search(/<body[\s>]/i);
  if (body > 0) i = body;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const end = lt < 0 ? s.length : lt;
    for (let k = i; k < end; k++) { const c = s.charCodeAt(k); if (c !== 32 && c !== 10 && c !== 13 && c !== 9) n++; }
    if (lt < 0) break;
    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    i = gt + 1;
  }
  return n;
}
const isbnOf = (s) => {
  const d = String(s || '').replace(/^urn:isbn:/i, '').replace(/[\s-]/g, '');
  return /^(97[89]\d{10}|\d{9}[\dXx])$/.test(d) ? d.toUpperCase() : null;
};
/** Navigeringsdokumentets (EPUB 3) innehållsförteckning: nav[epub:type=toc] > ol > li > a */
function tocFromNav(doc, base) {
  const navs = findAll(doc, 'nav', 20);
  const nav = navs.find(n => /\btoc\b/.test(attr(n, 'epub:type') || attr(n, 'type') || '')) || navs[0];
  const out = [];
  const walk = (ol, level) => {
    for (const li of kids(ol, 'li')) {
      if (out.length >= 2000) return;
      const a = kids(li, 'a')[0] || kids(li, 'span')[0];
      const href = a && attr(a, 'href');
      const title = clip(textOf(a, 300), 300);
      const res = href ? resolveHref(base, href) : null;
      if (title) out.push({ title, href: res, frag: href && href.includes('#') ? href.slice(href.indexOf('#') + 1).slice(0, 200) : null, level });
      const sub = kids(li, 'ol')[0];
      if (sub && level < 6) walk(sub, level + 1);
    }
  };
  const ol = nav && find(nav, 'ol');
  if (ol) walk(ol, 0);
  return out;
}
/** NCX (EPUB 2): navMap > navPoint (navLabel > text, content@src), nästlade */
function tocFromNcx(doc, base) {
  const out = [];
  const walk = (el, level) => {
    for (const np of kids(el, 'navpoint')) {
      if (out.length >= 2000) return;
      const title = clip(textOf(find(np, 'navlabel'), 300), 300);
      const src = attr(kids(np, 'content')[0], 'src');
      if (title) out.push({ title, href: src ? resolveHref(base, src) : null, frag: src && src.includes('#') ? src.slice(src.indexOf('#') + 1).slice(0, 200) : null, level });
      if (level < 6) walk(np, level + 1);
    }
  };
  const map = find(doc, 'navmap');
  if (map) walk(map, 0);
  return out;
}

/**
 * Läser en EPUB. Returnerar { meta, spine: [{ href, chars, linear }], toc, manifest: { href: mediaType }, cover (href), rtl }.
 * Kastar Error om filen saknar paketdokument (OPF).
 */
export async function readEpub(zip) {
  const container = await xmlEntry(zip, 'META-INF/container.xml');
  const rfs = findAll(container, 'rootfile', 10);
  let opfPath = rfs.map(r => attr(r, 'full-path')).map(p => p && resolveHref('', p)).find(p => p && zip.entries.has(p));
  if (!opfPath) opfPath = [...zip.entries.keys()].find(k => k.toLowerCase().endsWith('.opf'));
  const opf = await xmlEntry(zip, opfPath);
  if (!opf) throw new Error('EPUB-filen saknar paketdokument (OPF)');
  const base = dirOf(opfPath);
  const md = find(opf, 'metadata') || opf;
  const metas = findAll(md, 'meta', 500);
  const refines = (id, prop) => metas.find(m => attr(m, 'refines') === '#' + id && attr(m, 'property') === prop);
  // Titel: EPUB 3 kan märka huvudtiteln med title-type=main
  const titles = findAll(md, 'title', 20);
  const mainTitle = titles.find(tl => { const id = attr(tl, 'id'); return id && textOf(refines(id, 'title-type')) === 'main'; }) || titles[0];
  const creators = findAll(md, 'creator', 30).filter(c => {
    const role = attr(c, 'opf:role') || attr(c, 'role') || (attr(c, 'id') && textOf(refines(attr(c, 'id'), 'role')));
    return !role || role === 'aut';
  }).map(c => clip(textOf(c, 200), 200)).filter(Boolean);
  const metaNamed = (n) => metas.find(m => attr(m, 'name') === n);
  let series = clip(attr(metaNamed('calibre:series'), 'content'), 200);
  let seriesNo = parseFloat(attr(metaNamed('calibre:series_index'), 'content'));
  if (!series) {
    const coll = metas.find(m => attr(m, 'property') === 'belongs-to-collection');
    if (coll) {
      series = clip(textOf(coll, 200), 200);
      const id = attr(coll, 'id');
      if (id) seriesNo = parseFloat(textOf(refines(id, 'group-position')));
    }
  }
  const date = textOf(find(md, 'date'), 40);
  const ids = findAll(md, 'identifier', 20);
  const isbn = ids.map(x => isbnOf(textOf(x, 60))).find(Boolean) || null;
  const desc = textOf(find(md, 'description'), 8000).replace(/<[^<>]{0,500}>/g, ' ');
  const meta = {
    title: clip(textOf(mainTitle, 400), 300), author: creators.slice(0, 5).join(', ') || null,
    series, seriesNo: Number.isFinite(seriesNo) ? seriesNo : null,
    language: clip(textOf(find(md, 'language'), 20), 20), publisher: clip(textOf(find(md, 'publisher'), 200), 200),
    description: clip(desc, 6000), isbn, year: parseInt(/(\d{4})/.exec(date)?.[1]) || null,
    genres: findAll(md, 'subject', 30).map(x => clip(textOf(x, 80), 80)).filter(Boolean).slice(0, 10)
  };
  // Manifest och läsordning
  const items = new Map(), manifest = {};
  for (const it of findAll(find(opf, 'manifest'), 'item', 20000)) {
    const href = resolveHref(base, attr(it, 'href'));
    if (!href) continue;
    const mt = String(attr(it, 'media-type') || '').toLowerCase().slice(0, 80);
    items.set(attr(it, 'id'), { href, mt, props: String(attr(it, 'properties') || '') });
    manifest[href] = mt;
  }
  const spineEl = find(opf, 'spine');
  const rtl = attr(spineEl, 'page-progression-direction') === 'rtl';
  const spine = [];
  for (const ref of kids(spineEl, 'itemref')) {
    const it = items.get(attr(ref, 'idref'));
    if (!it || !zip.entries.has(it.href) || spine.length >= 5000) continue;
    let chars = 0;
    try { chars = textLength(await zip.read(it.href, DOC_ENTRY)); } catch {}
    spine.push({ href: it.href, chars, linear: attr(ref, 'linear') !== 'no' });
  }
  // Innehållsförteckning: navigeringsdokumentet (EPUB 3), annars NCX
  let toc = [];
  const navItem = [...items.values()].find(x => /\bnav\b/.test(x.props));
  if (navItem) { const d = await xmlEntry(zip, navItem.href); if (d) toc = tocFromNav(d, dirOf(navItem.href)); }
  if (!toc.length) {
    const ncxItem = items.get(attr(spineEl, 'toc')) || [...items.values()].find(x => x.mt === 'application/x-dtbncx+xml');
    if (ncxItem) { const d = await xmlEntry(zip, ncxItem.href); if (d) toc = tocFromNcx(d, dirOf(ncxItem.href)); }
  }
  // Omslag: properties=cover-image (EPUB 3), <meta name="cover"> (EPUB 2), annars en bild som heter cover
  const isImg = (x) => x && /^image\//.test(x.mt) && zip.entries.has(x.href);
  let cover = [...items.values()].find(x => /\bcover-image\b/.test(x.props) && isImg(x))
    || items.get(attr(metaNamed('cover'), 'content'))
    || [...items.values()].find(x => isImg(x) && /cover/i.test(x.href));
  if (!isImg(cover)) cover = null;
  return { meta, spine, toc, manifest, cover: cover?.href || null, rtl };
}

// ---------- serietidningar (CBZ) ----------
const AGE = [[/^(everyone|g|kids to adults|all ages)$/, 0], [/^early childhood$/, 3], [/^everyone 10\+$/, 10], [/^pg$/, 7],
  [/^(teen|t)$/, 13], [/^(ma ?15\+|m ?15)$/, 15], [/^(mature 17\+|m)$/, 17], [/^(adults only 18\+|r18\+|x18\+|x|r18)$/, 18]];
/** ComicInfo-åldersgränsen ("Teen", "Mature 17+" …) som år – null om okänd */
export function ageFromRating(s) {
  const k = String(s || '').trim().toLowerCase();
  for (const [re, n] of AGE) if (re.test(k)) return n;
  return null;
}
/** ComicInfo.xml (ComicRack/Kavita/Komga) → metadata */
export function parseComicInfo(xml) {
  let d;
  try { d = parseXml(xml); } catch { return null; }
  const ci = find(d, 'comicinfo');
  if (!ci) return null;
  const v = (k) => clip(textOf(kids(ci, k.toLowerCase())[0], 6000), 6000);
  const num = parseFloat(v('Number'));
  const writers = [v('Writer'), v('Penciller')].filter(Boolean);
  const pages = kids(find(ci, 'pages'), 'page');
  const front = pages.find(p => /frontcover/i.test(attr(p, 'Type') || ''));
  return {
    title: v('Title'), series: v('Series')?.slice(0, 200) || null, seriesNo: Number.isFinite(num) ? num : null, volume: parseInt(v('Volume')) || null,
    description: v('Summary'), year: parseInt(v('Year')) || null, author: writers.length ? [...new Set(writers.join(', ').split(/\s*,\s*/))].slice(0, 5).join(', ') : null,
    publisher: v('Publisher')?.slice(0, 200) || null, language: v('LanguageISO')?.slice(0, 20) || null,
    genres: (v('Genre') || '').split(/\s*,\s*/).filter(Boolean).slice(0, 10),
    rtl: /^yesandrighttoleft$/i.test(v('Manga') || ''), manga: /^yes/i.test(v('Manga') || ''),
    age: ageFromRating(v('AgeRating')), frontCover: front ? parseInt(attr(front, 'Image')) : null
  };
}
/** Sidorna i ett serietidningsarkiv: bilder i naturlig ordning, utan __MACOSX och dolda filer */
export function comicPages(zip) {
  return [...zip.entries.keys()].filter(k => IMAGE_EXT.has(path.extname(k).toLowerCase()) && !k.split('/').some(p => p.startsWith('.') || p === '__MACOSX')).sort(natural);
}
/** "Serien 012 (2020)", "Serien v02", "Serien #3" → { series, no } ur filnamnet (utan filändelse) */
export function seriesFromName(stem) {
  const s = String(stem).slice(0, 200).replace(/_+/g, ' ').replace(/\.(?!\d)|(?<!\d)\./g, ' ').replace(/\s*\((?:19|20)\d\d\)\s*$/, '').replace(/\s*\[[^\]]{0,60}\]\s*/g, ' ').trim();
  const m = /^(.{1,180}?)\s*(?:[-–]\s*)?(?:#|vol\.?\s*|v|no\.?\s*|nr\.?\s*|ch\.?\s*|kapitel\s*)?(\d{1,4}(?:\.\d{1,2})?)$/i.exec(s);
  return m && m[1].trim().length > 1 ? { series: m[1].trim().replace(/[-–\s]+$/, ''), no: parseFloat(m[2]) } : null;
}
/** Läser en CBZ: { meta, pages, cover (postnamn) } */
export async function readComic(zip) {
  const pages = comicPages(zip);
  const ciName = [...zip.entries.keys()].find(k => k.toLowerCase() === 'comicinfo.xml' || k.toLowerCase().endsWith('/comicinfo.xml'));
  let ci = null;
  if (ciName) { try { ci = parseComicInfo(await zip.read(ciName, XML_ENTRY)); } catch {} }
  const ci0 = ci || {};
  const cover = Number.isInteger(ci0.frontCover) && pages[ci0.frontCover] ? pages[ci0.frontCover] : pages[0] || null;
  return { meta: ci0, pages, cover, rtl: !!ci0.rtl };
}

// ---------- PDF ----------
const HEAD = 2 << 20, TAIL = 256 << 10;
/** PDF-sträng (literal med \-escape eller UTF-16 med BOM) → text */
export function pdfString(raw, hex = false) {
  let b;
  if (hex) {
    const h = raw.replace(/[^0-9a-fA-F]/g, '');
    b = Buffer.from(h.length % 2 ? h + '0' : h, 'hex');
  } else {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
      const d = raw[++i];
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      if (d in map) out.push(map[d]);
      else if (/[0-7]/.test(d)) { let o = d; while (o.length < 3 && /[0-7]/.test(raw[i + 1])) o += raw[++i]; out.push(parseInt(o, 8) & 0xff); }
      else if (d === '\r' || d === '\n') { if (d === '\r' && raw[i + 1] === '\n') i++; }
      else if (d != null) out.push(d.charCodeAt(0) & 0xff);
    }
    b = Buffer.from(out);
  }
  if (b[0] === 0xfe && b[1] === 0xff) { const sw = Buffer.from(b.subarray(2)); if (sw.length % 2) return null; sw.swap16(); return sw.toString('utf16le'); }
  return b.toString('latin1');
}
/** Värdet för /Nyckel i en ordlista (literal med nästlade parenteser eller hex), högst 2000 tecken */
function dictString(dict, key) {
  const i = dict.indexOf('/' + key);
  if (i < 0) return null;
  let p = i + key.length + 1;
  while (p < dict.length && /\s/.test(dict[p])) p++;
  if (dict[p] === '(') {
    let depth = 0, k = p;
    for (; k < dict.length && k < p + 4000; k++) {
      if (dict[k] === '\\') { k++; continue; }
      if (dict[k] === '(') depth++;
      else if (dict[k] === ')' && --depth === 0) break;
    }
    return clip(pdfString(dict.slice(p + 1, k)), 300);
  }
  if (dict[p] === '<' && dict[p + 1] !== '<') { const e = dict.indexOf('>', p); return e > 0 && e - p < 4000 ? clip(pdfString(dict.slice(p + 1, e), true), 300) : null; }
  return null;
}
async function readRange(fh, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}
/** Objektets ordlista (text) via den klassiska xref-tabellen, eller null */
async function objectViaXref(fh, size, tail, num) {
  const sx = /startxref\s+(\d{1,15})\s+%%EOF\s*$/.exec(tail.slice(-1024));
  if (!sx || +sx[1] >= size) return null;
  const x = (await readRange(fh, +sx[1], 1 << 20)).toString('latin1');
  if (!x.startsWith('xref')) return null; // xref-ström (PDF 1.5+) – komprimerad, läses inte
  const re = /(\d{1,9}) (\d{1,9})\s*\r?\n/y;
  let p = 4;
  while (/\s/.test(x[p])) p++;
  for (let guard = 0; guard < 1000; guard++) {
    re.lastIndex = p;
    const m = re.exec(x);
    if (!m) return null;
    const first = +m[1], cnt = +m[2];
    p = re.lastIndex;
    if (num >= first && num < first + cnt) {
      const e = x.slice(p + (num - first) * 20, p + (num - first) * 20 + 20);
      const off = parseInt(e.slice(0, 10), 10);
      if (!/n/.test(e) || !(off > 0 && off < size)) return null;
      return (await readRange(fh, off, 16384)).toString('latin1');
    }
    p += cnt * 20;
  }
  return null;
}
/** Första JPEG-bilden (DCTDecode) i början av filen – ofta omslaget i inskannade böcker och serier */
function firstJpeg(head) {
  for (let i = 0, guard = 0; guard < 200; guard++) {
    const k = head.indexOf('/DCTDecode', i);
    if (k < 0) return null;
    const st = head.indexOf('stream', k);
    if (st < 0 || st - k > 4000) { i = k + 10; continue; }
    let s = st + 6;
    if (head[s] === '\r') s++;
    if (head[s] === '\n') s++;
    const e = head.indexOf('endstream', s);
    if (e < 0) return null;
    const dictStart = head.lastIndexOf('<<', k);
    const dict = head.slice(Math.max(0, dictStart), k + 200);
    const w = +(/\/Width\s+(\d+)/.exec(dict)?.[1] || 0);
    if (w >= 200 && e - s > 4096) return Buffer.from(head.slice(s, e), 'latin1');
    i = e;
  }
  return null;
}
/** PDF: { meta: { title, author, … }, pages, cover (Buffer med JPEG eller null) } – bara metadata, PDF:en ritas aldrig */
export async function readPdf(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = (await readRange(fh, 0, Math.min(size, HEAD))).toString('latin1');
    if (!head.startsWith('%PDF-') && head.slice(0, 1024).indexOf('%PDF-') < 0) throw new Error('inte en PDF-fil');
    const tail = size > HEAD ? (await readRange(fh, Math.max(0, size - TAIL), Math.min(size, TAIL))).toString('latin1') : head;
    const meta = {};
    const info = /\/Info\s+(\d{1,9})\s+(\d{1,9})\s+R/.exec(tail) || /\/Info\s+(\d{1,9})\s+(\d{1,9})\s+R/.exec(head);
    if (info) {
      const marker = new RegExp(`(?:^|[\\r\\n\\s])${info[1]}\\s+${info[2]}\\s+obj`);
      let dict = null;
      for (const win of [head, tail]) { const m = marker.exec(win); if (m) { dict = win.slice(m.index, m.index + 16384); break; } }
      if (!dict) dict = await objectViaXref(fh, size, tail, +info[1]);
      if (dict) {
        const end = dict.indexOf('endobj');
        if (end > 0) dict = dict.slice(0, end);
        meta.title = dictString(dict, 'Title');
        meta.author = dictString(dict, 'Author');
        const sub = dictString(dict, 'Subject');
        if (sub) meta.description = sub;
        const cd = dictString(dict, 'CreationDate');
        meta.year = parseInt(/D?:?(\d{4})/.exec(cd || '')?.[1]) || null;
      }
    }
    // XMP (okomprimerad i de flesta filer): dc:title/dc:creator när Info saknas
    const xmp = (w) => { const a = w.indexOf('<x:xmpmeta'); if (a < 0) return null; const e = w.indexOf('</x:xmpmeta>', a); return e > a && e - a < 200000 ? w.slice(a, e) : null; };
    const x = xmp(head) || xmp(tail);
    if (x) {
      try {
        const d = parseXml(Buffer.from(x, 'latin1').toString('utf8'));
        const li = (k) => clip(textOf(find(find(d, k), 'li') || find(d, k), 300), 300);
        meta.title ||= li('title');
        meta.author ||= li('creator');
      } catch {}
    }
    for (const k of ['title', 'author']) if (meta[k] && /^(untitled|unknown|microsoft word - .*)$/i.test(meta[k])) meta[k] = k === 'title' ? meta[k].replace(/^microsoft word - /i, '').replace(/\.docx?$/i, '') || null : null;
    // Sidantalet: största /Count i ett /Type /Pages-objekt
    let pages = 0;
    for (const w of [head, tail]) for (const m of w.matchAll(/\/Type\s*\/Pages\b[^>]{0,400}?\/Count\s+(\d{1,6})|\/Count\s+(\d{1,6})[^>]{0,400}?\/Type\s*\/Pages\b/g)) pages = Math.max(pages, +(m[1] || m[2]));
    return { meta, pages: pages || null, cover: firstJpeg(head) };
  } finally { await fh.close().catch(() => {}); }
}
