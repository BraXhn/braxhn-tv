// Webbappens statiska filer (web/) med Content Security Policy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, MIME, send } from '../util.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// ---------- statiska filer ----------
// Content Security Policy: bara egna skript (plus Googles Cast-SDK och reserv-CDN för hls.js/QR)
const CSP = ["default-src 'self'", "script-src 'self' https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://image.tmdb.org", "media-src 'self' blob:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "frame-src https://www.gstatic.com"].join('; ');
export function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '');
  let f;
  try { f = path.normalize(path.join(WEB, decodeURIComponent(pathname))); } catch { return fail(res, 400, ''); }
  if (f !== WEB && !f.startsWith(WEB + path.sep)) return fail(res, 403, '');
  if (f.includes('\0')) return fail(res, 400, ''); // fs kastar annars ett undantag (500 och fellogg)
  fs.stat(f, (e, s) => {
    if (e || s.isDirectory()) {
      // Saknade filer med filändelse (t.ex. /vendor/x.js) ger 404 i stället för startsidan
      if (path.extname(f) && !s?.isDirectory()) return fail(res, 404, 'Hittades inte');
      f = path.join(WEB, 'index.html');
    }
    fs.readFile(f, (e2, data) => {
      if (e2) return fail(res, 404, 'Hittades inte');
      const ext = path.extname(f);
      // Nya versioner ska nå appen direkt. Webbklientens moduler (/app.js, /js/…) måste dessutom alltid komma från
      // samma version – en blandning av gamla och nya moduler i webbläsarens cache kan stoppa appen helt.
      // (no-cache + ETag: webbläsaren frågar varje gång men får 304 om inget ändrats.)
      // Stilmallen hör också dit: en ny sida med gammal stilmall (max-age) gav en helt trasig layout efter uppdatering.
      // Bara vendor-filer och bilder (som byter namn eller sällan ändras) får cachas en timme.
      const fresh = !(pathname.startsWith('/vendor/') || pathname.startsWith('/brand/') || /\.(png|jpe?g|webp|ico|woff2?)$/.test(pathname));
      // ETag: appen frågar om nya versioner (no-cache) och får 304 i stället för hela filen
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'max-age=3600', ETag: 'auto' };
      if (ext === '.html') {
        h['Content-Security-Policy'] = CSP;
        // Versionsnummer på stilmall och startmodul: webbläsaren hämtar dem på nytt efter varje uppdatering
        data = Buffer.from(String(data).replaceAll('{{v}}', VERSION));
      }
      send(res, 200, data, h);
    });
  });
}
