// Testfiler för e-böcker: ZIP-arkiv (med möjlighet att ljuga i katalogen och ge poster farliga namn), EPUB 2/3,
// CBZ med ComicInfo.xml, en liten PDF och PNG-bilder – allt i ren JS (zlib), utan ffmpeg.
import zlib from 'node:zlib';

/**
 * ZIP-arkiv. entries = [{ name, data (Buffer|string), method (0|8, standard 8), usize (ljug om uppackad storlek),
 * crc (ljug om kontrollsumman) }]. Centralkatalogen och de lokala huvudena får samma värden.
 */
export function zip(entries) {
  const local = [], central = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const method = e.method ?? (e.name === 'mimetype' ? 0 : 8);
    const comp = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const crc = e.crc ?? (zlib.crc32(data) >>> 0);
    const usize = e.usize ?? data.length;
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, eocd]);
}

// ---------- bilder ----------
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
/** PNG i en färg (eller med en diagonal rand i en annan färg så att sidorna skiljer sig) */
export function png(w, h, [r, g, b] = [200, 40, 40], stripe = null) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const on = stripe && Math.abs(x - y * w / h) < w / 10;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      [raw[o], raw[o + 1], raw[o + 2]] = on ? stripe : [r, g, b];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- EPUB ----------
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const xhtml = (title, body, head = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(title)}</title>${head}</head>
<body>${body}</body></html>`;
/** Löptext med n stycken (för sidbrytningen) */
export const paragraphs = (n, word = 'Lorem') => Array.from({ length: n }, (_, i) => `<p>${word} ${i + 1}: ${'Det var en gång en bok som hade många sidor och ord. '.repeat(6)}</p>`).join('\n');
/**
 * EPUB 3 (nav) eller EPUB 2 (ncx: true). chapters = [{ title, body (XHTML i <body>), head }].
 * series/seriesNo som calibre-meta (EPUB 2) eller belongs-to-collection (EPUB 3). extra = fler poster (namn, data).
 */
export function epub({ title = 'Boken', author = 'Författaren', lang = 'sv', series = null, seriesNo = null, description = null, isbn = null,
  chapters = [{ title: 'Kapitel 1', body: paragraphs(3) }], cover = null, css = null, ncx = false, rtl = false, extra = [], date = '2021-03-04',
  publisher = 'Förlaget', subject = 'Äventyr' } = {}) {
  const items = [], spine = [], files = [];
  chapters.forEach((c, i) => {
    items.push(`<item id="c${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i + 1}"/>`);
    files.push({ name: `OEBPS/text/ch${i + 1}.xhtml`, data: xhtml(c.title, `<h1 id="h${i + 1}">${esc(c.title)}</h1>${c.body}`, c.head ?? (css ? '<link rel="stylesheet" href="../style.css" type="text/css"/>' : '')) });
  });
  if (css) { items.push('<item id="css" href="style.css" media-type="text/css"/>'); files.push({ name: 'OEBPS/style.css', data: css }); }
  if (cover) { items.push(`<item id="cover-img" href="images/cover.png" media-type="image/png"${ncx ? '' : ' properties="cover-image"'}/>`); files.push({ name: 'OEBPS/images/cover.png', data: cover }); }
  const toc = chapters.map((c, i) => ({ title: c.title, href: `text/ch${i + 1}.xhtml` }));
  if (ncx) {
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    files.push({ name: 'OEBPS/toc.ncx', data: `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
${toc.map((t, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(t.title)}</text></navLabel><content src="${t.href}"/></navPoint>`).join('')}</navMap></ncx>` });
  } else {
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    files.push({ name: 'OEBPS/nav.xhtml', data: xhtml('Innehåll', `<nav epub:type="toc"><h1>Innehåll</h1><ol>${toc.map(t => `<li><a href="${t.href}">${esc(t.title)}</a></li>`).join('')}</ol></nav>`) });
  }
  const seriesMeta = !series ? '' : ncx
    ? `<meta name="calibre:series" content="${esc(series)}"/>${seriesNo != null ? `<meta name="calibre:series_index" content="${seriesNo}"/>` : ''}`
    : `<meta property="belongs-to-collection" id="coll">${esc(series)}</meta><meta refines="#coll" property="collection-type">series</meta>${seriesNo != null ? `<meta refines="#coll" property="group-position">${seriesNo}</meta>` : ''}`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${ncx ? '2.0' : '3.0'}" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:identifier id="uid">${isbn ? 'urn:isbn:' + isbn : 'urn:uuid:12345678-1234-1234-1234-123456789abc'}</dc:identifier>
<dc:title>${esc(title)}</dc:title><dc:creator${ncx ? ' opf:role="aut"' : ''}>${esc(author)}</dc:creator><dc:language>${lang}</dc:language>
<dc:date>${date}</dc:date><dc:publisher>${esc(publisher)}</dc:publisher>${description ? `<dc:description>${esc(description)}</dc:description>` : ''}<dc:subject>${esc(subject)}</dc:subject>
${seriesMeta}${ncx && cover ? '<meta name="cover" content="cover-img"/>' : ''}</metadata>
<manifest>${items.join('')}</manifest><spine${ncx ? ' toc="ncx"' : ''}${rtl ? ' page-progression-direction="rtl"' : ''}>${spine.join('')}</spine></package>`;
  return zip([{ name: 'mimetype', data: 'application/epub+zip', method: 0 },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf }, ...files, ...extra]);
}

// ---------- serietidningar ----------
export const comicInfo = (o) => `<?xml version="1.0"?><ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${Object.entries(o).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</ComicInfo>`;
/** CBZ med n sidor (PNG i olika färger, ev. med ComicInfo.xml och extra poster) */
export function cbz({ pages = 4, info = null, extra = [], w = 60, h = 90 } = {}) {
  const list = [];
  for (let i = 0; i < pages; i++) list.push({ name: `sida ${String(i + 1).padStart(3, '0')}.png`, data: png(w, h, [40 + i * 30, 80, 160], [250, 250, 250]), method: 0 });
  if (info) list.push({ name: 'ComicInfo.xml', data: comicInfo(info) });
  return zip([...list.reverse(), ...extra]); // omvänd ordning i arkivet: läsaren ska sortera själv
}

// ---------- PDF ----------
/** Minimal PDF med Info-ordlista och n sidor (xref-tabellen räknas fram) */
export function pdf({ title = 'Dokumentet', author = 'Skribenten', pages = 3, utf16 = false } = {}) {
  const str = (s) => utf16 ? `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>` : `(${s.replace(/[()\\]/g, '\\$&')})`;
  const kidsRef = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(' ');
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${kidsRef}] /Count ${pages} >>`,
    `<< /Title ${str(title)} /Author ${str(author)} /CreationDate (D:20190102030405) >>`,
    ...Array.from({ length: pages }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>`)];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
