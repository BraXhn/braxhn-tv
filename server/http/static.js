// Webbappens statiska filer (web/) med Content Security Policy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, MIME, send } from '../util.js';

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
      const fresh = ext === '.html' || ext === '.webmanifest' || pathname === '/sw.js'; // nya versioner ska nå appen direkt
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'max-age=3600' };
      if (ext === '.html') h['Content-Security-Policy'] = CSP;
      send(res, 200, data, h);
    });
  });
}
