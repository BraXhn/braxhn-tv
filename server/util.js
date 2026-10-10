import net from 'node:net';
export function send(res, code, body, headers = {}) {
  if (res.headersSent) return;
  if (typeof body === 'object' && !Buffer.isBuffer(body) && body !== null) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body ?? '');
}
export const fail = (res, code, msg) => send(res, code, { error: msg });

export async function readJson(req, limit = 1 << 20) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('För stor förfrågan'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Ogiltig JSON'), { status: 400 }); }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.webmanifest': 'application/manifest+json'
};

// ---- klientens IP och om den är på hemnätverket ----
// Kontrolltecken tas bort ur allt som skrivs till loggar (förhindrar falska loggrader)
export const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max);
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i];
export const isPrivate = (ip) => PRIVATE.some(r => r.test(String(ip || '').replace(/^::ffff:/, '')));
// Vilka direkta motparter (TCP) räknas som omvänd proxy? TRUSTED_PROXIES (CIDR-lista) om satt,
// annars alla privata adresser (t.ex. Nginx Proxy Manager i Docker). TRUST_PROXY=0 stänger av helt.
const norm = (ip) => String(ip || '').trim().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
function isProxy(ip) {
  if (process.env.TRUST_PROXY === '0') return false;
  if (process.env.TRUST_PROXY === '1') return true;
  const list = String(process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list.some(c => inCidr(ip, c)) : isPrivate(ip);
}
/**
 * Klientens riktiga IP. X-Forwarded-For läses från HÖGER: proxyn lägger till klientens adress sist,
 * allt till vänster kan klienten ha hittat på själv. Vi går bakåt så länge hoppet är en betrodd proxy.
 */
export function clientIp(req) {
  let ip = norm(req.socket.remoteAddress);
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(norm).filter(Boolean);
  while (isProxy(ip) && hops.length) {
    const next = hops.pop();
    if (!net.isIP(next)) break;
    ip = next;
  }
  return ip;
}
export const peerIp = (req) => norm(req.socket.remoteAddress);
export const isLocalReq = (req) => isPrivate(clientIp(req));
export const isHttps = (req) => !!req.socket.encrypted || (isProxy(norm(req.socket.remoteAddress)) && String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim() === 'https');

/** IPv4-CIDR-matchning, t.ex. inCidr('100.70.1.2', '100.64.0.0/10'). IPv6 stöds för exakta adresser. */
export function inCidr(ip, cidr) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  const [net, bitsStr] = String(cidr).split('/');
  if (!net) return false;
  if (net.includes(':') || ip.includes(':')) return ip.toLowerCase() === net.toLowerCase();
  const toInt = (a) => { const p = a.split('.').map(Number); return p.length === 4 && p.every(x => x >= 0 && x <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; };
  const a = toInt(ip), n = toInt(net);
  if (a === null || n === null) return false;
  const bits = bitsStr === undefined ? 32 : Math.max(0, Math.min(32, parseInt(bitsStr)));
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((n & mask) >>> 0);
}
