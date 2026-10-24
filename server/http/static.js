// Webbappens statiska filer (web/) med Content Security Policy.
//
// Snabb start: appens filer (moduler, stilmall, vendor) laddas från /v/<bygge>/…, där <bygge> är en hash av
// innehållet i web/. Den adressen ändras aldrig för samma innehåll och cachas därför ett år (immutable) – ett
// återbesök hämtar ingenting alls. index.html och sw.js har fasta adresser, cachas aldrig och pekar på rätt bygge.
// Startens moduler förladdas från index.html (modulepreload) i stället för att upptäckas en importnivå i taget;
// moduler märkta "// @lazy" (sällan använda vyer, LAZY i web/js/router.js) hämtas först när vyn öppnas.
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
// Modulerna i web/js/ som behövs vid start – förladdas från index.html (webbläsaren hämtar dem parallellt direkt).
// En modul med raden "// @lazy" i början laddas med import() när den behövs och förladdas inte.
export const isLazy = (src) => /^\/\/ @lazy\b/m.test(String(src).slice(0, 600));
export const PRELOAD_FILES = walk(path.join(WEB, 'js')).filter(f => f.endsWith('.js') && !isLazy(fs.readFileSync(f, 'utf8'))).sort().map(rel);
const PRELOAD = PRELOAD_FILES.map(f => `<link rel="modulepreload" href="${PREFIX}/${f}">`).join('\n');

// Content Security Policy: bara egna skript (plus Googles Cast-SDK)
const CSP = ["default-src 'self'", "script-src 'self' https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://image.tmdb.org", "media-src 'self' blob:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "frame-src https://www.gstatic.com"].join('; ');

// Färdiga svar per fil: { raw, br, gz, etag, type, mtime }. Byts när filen ändras (utveckling); i imagen aldrig.
const cache = new Map();
function load(f, st) {
  const c = cache.get(f);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
  let raw = fs.readFileSync(f);
  const name = rel(f);
  // Mallvärden: rätt bygge i index.html och service workern
  if (name === 'index.html' || name === 'sw.js' || name === 'offline.html') {
    raw = Buffer.from(String(raw).replaceAll('{{b}}', BUILD).replaceAll('{{preload}}', PRELOAD));
  }
  const e = { raw, type: MIME[path.extname(f)] || 'application/octet-stream', mtime: st.mtimeMs, size: st.size,
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"` };
  if (COMPRESSIBLE.test(f) && raw.length > 1024) {
    e.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    e.gz = zlib.gzipSync(raw, { level: 9 });
  }
  if (cache.size > 500) cache.clear();
  cache.set(f, e);
  return e;
}

export function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '');
  // /v/<bygge>/… = samma fil utan prefix. Rätt bygge cachas för alltid; ett gammalt bygge (en flik som stått
  // öppen över en uppdatering) får dagens fil utan cache, så att den inte fastnar i webbläsaren.
  let immutable = false;
  const v = /^\/v\/([0-9a-f]{1,32})(\/.*)$/.exec(pathname);
  if (v) { immutable = v[1] === BUILD; pathname = v[2]; }
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
    try { c = load(f, s); } catch { return fail(res, 404, 'Hittades inte'); }
    const ext = path.extname(f);
    // Fasta adresser (index.html, sw.js, /app.js utan prefix …): fråga varje gång (no-cache + ETag → 304).
    // Bilder utan prefix (ikoner, logotyp) får cachas en timme.
    const cc = immutable ? 'public, max-age=31536000, immutable'
      : /\.(png|jpe?g|webp|ico|woff2?)$/.test(ext) || pathname.startsWith('/brand/') ? 'max-age=3600' : 'no-cache';
    const h = { 'Content-Type': c.type, 'Cache-Control': cc, ETag: c.etag };
    if (ext === '.html') h['Content-Security-Policy'] = CSP;
    if (c.br) h.Vary = 'Accept-Encoding';
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
