// Webbappens statiska filer (web/) med Content Security Policy.
//
// Snabb start: appens filer (moduler, stilmall, vendor) laddas från /v/<bygge>/…, där <bygge> är en hash av
// innehållet i web/. Den adressen ändras aldrig för samma innehåll och cachas därför ett år (immutable) – ett
// återbesök hämtar ingenting alls. index.html och sw.js har fasta adresser, cachas aldrig och pekar på rätt bygge.
// Startens moduler (det app.js importerar statiskt) förladdas från index.html (modulepreload) i stället för att
// upptäckas en importnivå i taget; spelaren och vyerna utom startsidan hämtas först när de behövs (web/js/lazy.js).
// Filerna läses, komprimeras (brotli + gzip) och får sin ETag en gång – inte vid varje förfrågan.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fail, MIME } from '../util.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const COMPRESSIBLE = /\.(js|css|html|svg|json|webmanifest|txt)$/;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const rel = (f) => path.relative(WEB, f).split(path.sep).join('/');

// Bygget = hash av alla filer i web/ (inte versionsnumret: :edge byggs om med samma version)
function buildId() {
  const h = crypto.createHash('sha256');
  for (const f of walk(WEB).sort()) h.update(rel(f)).update('\0').update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 12);
}
export const BUILD = buildId();
const PREFIX = `/v/${BUILD}`;
// Innehållshash per fil: /m/<fil>?h=<hash> cachas för alltid, och en uppdatering byter bara adress på filerna som
// faktiskt ändrats – resten finns kvar i webbläsarens och service workerns cache (förut hämtades allt efter varje
// uppdatering). Modulernas relativa importer (./core.js → /m/js/core.js) pekas om till sin hash med en import map.
// Webbläsare utan import maps (Safari före 16.4) får samma filer utan hash: no-cache + ETag, som förut.
const FILEHASH = new Map(walk(WEB).map(f => [rel(f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10)]));
export const hashedUrl = (r) => FILEHASH.has(r) ? `/m/${r}?h=${FILEHASH.get(r)}` : `/${r}`;
const IMPORTMAP = JSON.stringify({ imports: Object.fromEntries([...FILEHASH.keys()].filter(r => /^js\/.*\.js$/.test(r)).sort().map(r => [`/m/${r}`, hashedUrl(r)])) });
const IMPORTMAP_CSP = `'sha256-${crypto.createHash('sha256').update(IMPORTMAP).digest('base64')}'`;
// Startens moduler = allt som web/app.js importerar statiskt (hela kedjan) – förladdas från index.html, så att
// webbläsaren hämtar dem parallellt direkt i stället för en importnivå i taget. Övriga moduler (spelaren, vyerna utom
// startsidan) laddas med import() när de behövs (web/js/lazy.js); deras beroenden står i #moddeps i index.html,
// så att lazy.js kan förladda hela kedjan på en gång.
const IMPORT = /^import (?:[^'"]* from )?'([^']+)';$/gm;
const JS_FILES = [path.join(WEB, 'app.js'), ...walk(path.join(WEB, 'js')).filter(f => f.endsWith('.js'))];
/** Statiska importer per modul (sökvägar relativt web/) */
export const IMPORTS = new Map(JS_FILES.map(f => [rel(f), [...fs.readFileSync(f, 'utf8').matchAll(IMPORT)].map(m => rel(path.join(path.dirname(f), m[1])))]));
const closure = (start) => {
  const seen = new Set(), todo = [start];
  while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f); todo.push(...(IMPORTS.get(f) || [])); }
  return seen;
};
const START = closure('app.js');
export const PRELOAD_FILES = [...START].filter(f => f !== 'app.js').sort();
const PRELOAD = PRELOAD_FILES.map(f => `<link rel="modulepreload" href="${hashedUrl(f)}">`).join('\n');
// Modul -> dess statiska importer utanför startens moduler (relativt web/js/), bara moduler som har några
export const LAZY_DEPS = Object.fromEntries([...IMPORTS].filter(([f]) => !START.has(f))
  .map(([f, d]) => [f.slice(3), d.filter(t => !START.has(t)).map(t => t.slice(3))]).filter(([, d]) => d.length));
const DEPS = JSON.stringify(LAZY_DEPS).replace(/</g, '\\u003c');
// Moduler märkta "// @lazy" (vyer i LAZY i web/js/router.js) får aldrig nås statiskt från app.js (test/web-perf.test.js)
export const isLazy = (src) => /^\/\/ @lazy\b/m.test(String(src).slice(0, 600));
// Service workerns skal: filerna med hash (sw.js läser listan)
const SW_HASHES = JSON.stringify(Object.fromEntries([...FILEHASH].filter(([r]) => /^(js\/.*\.js|app\.js|start\.js|style\.css|vendor\/hls\.min\.js|i18n\/en\.js)$/.test(r))));

// Content Security Policy: bara egna skript (plus Googles Cast-SDK)
const CSP = ["default-src 'self'", `script-src 'self' ${IMPORTMAP_CSP} https://www.gstatic.com`,
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://image.tmdb.org", "media-src 'self' blob:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "frame-src https://www.gstatic.com"].join('; ');

// Färdiga svar per fil: { raw, br, gz, etag, type, mtime }. Byts när filen ändras (utveckling); i imagen aldrig.
const cache = new Map();
// Språk: index.html finns i två varianter – svenska (standard, ingen katalog) och engelska (<html lang="en"> och
// katalogen web/i18n/en.js som ett vanligt skript före modulerna, så att t() i web/js/core.js har den direkt).
function load(f, st, lang = 'sv') {
  const name = rel(f);
  const key = name === 'index.html' && lang === 'en' ? f + '#en' : f;
  const c = cache.get(key);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
  let raw = fs.readFileSync(f);
  if (name === 'index.html') {
    raw = Buffer.from(String(raw).replace('{{i18n}}', key === f ? '' : '<script src="/v/{{b}}/i18n/en.js"></script>')
      .replace('<html lang="sv">', `<html lang="${key === f ? 'sv' : 'en'}">`));
  }
  // Mallvärden: rätt bygge i index.html och service workern
  if (name === 'index.html' || name === 'sw.js' || name === 'offline.html') {
    raw = Buffer.from(String(raw).replace(/\/v\/\{\{b\}\}\/([\w./-]+)/g, (_, r) => FILEHASH.has(r) ? hashedUrl(r) : `${PREFIX}/${r}`)
      .replaceAll('{{b}}', BUILD).replaceAll('{{preload}}', PRELOAD).replaceAll('{{importmap}}', `<script type="importmap">${IMPORTMAP}</script>`)
      .replaceAll('{{hashes}}', SW_HASHES).replaceAll('{{deps}}', DEPS));
  }
  const e = { raw, type: MIME[path.extname(f)] || 'application/octet-stream', mtime: st.mtimeMs, size: st.size,
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"` };
  if (COMPRESSIBLE.test(f) && raw.length > 1024) {
    e.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    e.gz = zlib.gzipSync(raw, { level: 9 });
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, e);
  return e;
}

/** langOf: () => 'sv' | 'en' – sidans språk för index.html (http/router.js, pageLang) */
export function serveStatic(req, res, pathname, search = '', langOf = null) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '');
  // /v/<bygge>/… = samma fil utan prefix. Rätt bygge cachas för alltid; ett gammalt bygge (en flik som stått
  // öppen över en uppdatering) får dagens fil utan cache, så att den inte fastnar i webbläsaren.
  let immutable = false;
  const v = /^\/v\/([0-9a-f]{1,32})(\/.*)$/.exec(pathname);
  if (v) { immutable = v[1] === BUILD; pathname = v[2]; }
  // /m/<fil>?h=<hash>: för alltid när hashen stämmer med filen, annars (gammal sida, ingen import map) utan cache
  const m = /^\/m(\/.+)$/.exec(pathname);
  if (m) { pathname = m[1]; const h = /[?&]h=([0-9a-f]{1,16})/.exec(search)?.[1]; immutable = !!h && h === FILEHASH.get(pathname.slice(1)); }
  let f;
  try { f = path.normalize(path.join(WEB, decodeURIComponent(pathname))); } catch { return fail(res, 400, ''); }
  if (f !== WEB && !f.startsWith(WEB + path.sep)) return fail(res, 403, '');
  if (f.includes('\0')) return fail(res, 400, ''); // fs kastar annars ett undantag (500 och fellogg)
  fs.stat(f, (e, s) => {
    if (e || s.isDirectory()) {
      // Saknade filer med filändelse (t.ex. /vendor/x.js) ger 404 i stället för startsidan
      if (path.extname(f) && !s?.isDirectory()) return fail(res, 404, 'Hittades inte');
      f = path.join(WEB, 'index.html');
      immutable = false;
      try { s = fs.statSync(f); } catch { return fail(res, 404, 'Hittades inte'); }
    }
    let c;
    let lang = 'sv';
    if (f === path.join(WEB, 'index.html') && langOf) { try { lang = langOf(); } catch {} }
    try { c = load(f, s, lang); } catch { return fail(res, 404, 'Hittades inte'); }
    const ext = path.extname(f);
    // Fasta adresser (index.html, sw.js, /app.js utan prefix …): fråga varje gång (no-cache + ETag → 304).
    // Bilder utan prefix (ikoner, logotyp) får cachas en timme.
    const cc = immutable ? 'public, max-age=31536000, immutable'
      : /\.(png|jpe?g|webp|ico|woff2?)$/.test(ext) || pathname.startsWith('/brand/') ? 'max-age=3600' : 'no-cache';
    const h = { 'Content-Type': c.type, 'Cache-Control': cc, ETag: c.etag };
    if (ext === '.html') h['Content-Security-Policy'] = CSP;
    if (f === path.join(WEB, 'index.html')) h.Vary = 'Cookie, Accept-Language';
    if (c.br) h.Vary = h.Vary ? h.Vary + ', Accept-Encoding' : 'Accept-Encoding';
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); return res.end(); }
    const ae = String(req.headers['accept-encoding'] || '');
    let body = c.raw;
    if (c.br && /\bbr\b/.test(ae)) { body = c.br; h['Content-Encoding'] = 'br'; }
    else if (c.gz && /\bgzip\b/.test(ae)) { body = c.gz; h['Content-Encoding'] = 'gzip'; }
    h['Content-Length'] = body.length;
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
