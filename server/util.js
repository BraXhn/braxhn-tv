import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import net from 'node:net';
import os from 'node:os';
import { spawn as spawnProc } from 'node:child_process';
// Text som lönar sig att komprimera (bibliotekslistor i JSON är ~15 ggr mindre med gzip)
const COMPRESSIBLE = /^(application\/(json|javascript|manifest\+json|vnd\.apple\.mpegurl)|text\/|image\/svg)/;
// Svar över ASYNC_MIN komprimeras utanför händelseloopen (zlib i trådpoolen): ett bibliotek med tusentals titlar
// (100–500 kB JSON) låser annars servern några millisekunder per svar, och alla andra förfrågningar väntar.
// Brotli (kvalitet 4: snabbt, ~20 % mindre än gzip) när klienten stöder det, annars gzip. Små svar som förut.
const ASYNC_MIN = 64 << 10;
const PENDING = Symbol('komprimeras');
const BR_OPTS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } };
/** Skickar ett svar. headers.ETag === 'auto' räknar fram en ETag ur innehållet; If-None-Match ger då 304. */
export function send(res, code, body, headers = {}) {
  if (res.headersSent || res[PENDING]) return;
  if (typeof body === 'object' && !Buffer.isBuffer(body) && body !== null) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  const req = res.req;
  if (code === 200 && headers.ETag) {
    if (headers.ETag === 'auto') headers.ETag = `"${crypto.createHash('sha1').update(body ?? '').digest('base64url').slice(0, 22)}"`;
    if (req?.headers['if-none-match'] === headers.ETag) {
      const { 'Content-Type': _, ...rest } = headers;
      res.writeHead(304, { 'Cache-Control': 'no-store', ...rest });
      return res.end();
    }
  }
  const ae = req?.headers['accept-encoding'] || '';
  if (body != null && body.length > 1024 && COMPRESSIBLE.test(headers['Content-Type'] || '')) {
    const br = body.length > ASYNC_MIN && /\bbr\b/.test(ae), gz = /\bgzip\b/.test(ae);
    if (br || (gz && body.length > ASYNC_MIN)) {
      // ETag och 304 ovan gäller det okomprimerade innehållet – samma som för små svar
      res[PENDING] = true;
      const done = (e, out) => {
        res[PENDING] = false;
        if (res.headersSent || res.destroyed) return;
        if (!e) { body = out; headers['Content-Encoding'] = br ? 'br' : 'gzip'; headers['Vary'] = 'Accept-Encoding'; }
        res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
        res.end(body);
      };
      if (br) zlib.brotliCompress(body, { ...BR_OPTS, params: { ...BR_OPTS.params, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(body) } }, done);
      else zlib.gzip(body, { level: 5 }, done);
      return;
    }
    if (gz) {
      body = zlib.gzipSync(body, { level: 5 });
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
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
  let v;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Ogiltig JSON'), { status: 400 }); }
  // Routerna destrukturerar svaret – null, tal och strängar ska ge 400, inte ett internt fel
  if (v === null || typeof v !== 'object') throw Object.assign(new Error('Ogiltig JSON'), { status: 400 });
  return v;
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

// ---- filsökning för skannrar ----
/**
 * Går igenom en mapp utan att blockera händelseloopen. accept(namn) väljer filer, skip(namn) hoppar över mappar.
 * Returnerar { files, rootOk, failed } där failed är mappar som inte gick att läsa (t.ex. avmonterad NAS-delning).
 */
export async function listFiles(root, accept, skip = () => false, dirs = null) {
  const files = [], failed = [];
  let rootOk = true, n = 0;
  async function visit(dir, isRoot) {
    let d;
    try { d = await fs.promises.opendir(dir); }
    catch (e) { if (isRoot) rootOk = false; else failed.push(dir); return; }
    const subdirs = [];
    try {
      for await (const e of d) {
        if (++n % 200 === 0) await new Promise(setImmediate);
        if (e.name.startsWith('.') || skip(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) subdirs.push(p);
        else if (e.isFile() && accept(e.name)) files.push(p);
      }
    } catch { if (isRoot) rootOk = false; else failed.push(dir); return; }
    dirs?.add(dir); // mappar som lästes helt (lokal metadata rör bara titlar i sådana mappar)
    for (const s of subdirs) await visit(s, false);
  }
  await visit(root, true);
  if (rootOk && !files.length) {
    // En tom rotmapp kan vara en avmonterad monteringspunkt – kontrollera att den går att läsa alls
    try { await fs.promises.access(root, fs.constants.R_OK); } catch { rootOk = false; }
  }
  return { files, rootOk, failed };
}

/** Skriv en fil atomiskt (temporär fil + rename): ett avbrott mitt i lämnar aldrig en halv fil som läses som giltig */
export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/**
 * Får skannern ta bort försvunna filer ur databasen? Skydd mot att ett helt bibliotek töms när
 * t.ex. en NAS inte är monterad. missing = sökvägar som finns i databasen men inte hittades.
 * Returnerar null om det är OK, annars ett meddelande.
 */
export function deletionBlocked({ name, rootOk, files, known, missing, allowMass = false }) {
  if (!rootOk) return `${name}: biblioteksmappen går inte att läsa – inget tas bort (är disken/NAS:en monterad?)`;
  if (!missing) return null;
  if (files === 0 && known > 0) return `${name}: inga filer hittades men ${known} finns i biblioteket – inget tas bort (är disken/NAS:en monterad?)`;
  if (!allowMass && known >= 20 && missing > known * 0.5) return `${name}: ${missing} av ${known} filer saknas – inget tas bort för säkerhets skull (tillåt i inställningarna om det är avsiktligt)`;
  return null;
}
/** Ligger filen under någon av mapparna som inte gick att läsa? */
export const underFailed = (file, failed) => failed.some(d => file.startsWith(d + path.sep));

// ---- filströmning med Range-stöd ----
/**
 * Skickar en fil (ev. del av den enligt Range). pipeline stänger filen även om klienten avbryter,
 * och läsfel kraschar inte servern. Tomma filer ger 200 med tom kropp.
 */
export function streamFile(req, res, file, size, headers = {}, { ranges = true } = {}) {
  let start = 0, end = size - 1, code = 200;
  const m = ranges && size > 0 ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - +m[2]);
    else { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], size - 1); }
    if (start > end || start >= size) return send(res, 416, '', { 'Content-Range': `bytes */${size}` });
    code = 206;
  }
  const h = { ...headers, 'Content-Length': size > 0 ? end - start + 1 : 0 };
  if (ranges) h['Accept-Ranges'] = 'bytes';
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, h);
  if (req.method === 'HEAD' || size <= 0) return res.end();
  pipeline(fs.createReadStream(file, { start, end }), res, () => {});
}

// Bakgrundsjobb (förhandsbilder, intro-detektering, platshållarfärger …) körs med lägsta prioritet – processor (nice 19)
// och disk (ionice "idle", om verktyget finns) – så att strömning och omkodning alltid går före.
let ioniceOk = null;
export function lowPriority(child) {
  const pid = child?.pid;
  if (!pid) return child;
  try { os.setPriority(pid, 19); } catch {}
  if (ioniceOk == null) ioniceOk = String(process.env.PATH || '').split(path.delimiter).some(d => { try { return fs.statSync(path.join(d, 'ionice')).isFile(); } catch { return false; } });
  if (ioniceOk) { try { spawnProc('ionice', ['-c', '3', '-p', String(pid)], { stdio: 'ignore' }).on('error', () => {}); } catch {} }
  return child;
}
