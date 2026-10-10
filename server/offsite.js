// Säkerhetskopior utanför servern: krypterad kopia (AES-256-GCM, nyckel från lösenfras via scrypt)
// till en annan mapp (t.ex. en annan disk/NAS monterad i containern) eller S3-kompatibel lagring
// (Backblaze B2, Wasabi, MinIO, Cloudflare R2, AWS S3).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { getSetting, CACHE } from './db.js';
import { notify } from './notify.js';

export const state = { running: false, last: null, error: null, lastName: null };

export const cfg = () => ({
  kind: getSetting('offsite_kind', process.env.OFFSITE_KIND || 'none'),
  dir: getSetting('offsite_dir', process.env.OFFSITE_DIR || ''),
  endpoint: getSetting('s3_endpoint', process.env.S3_ENDPOINT || ''),
  region: getSetting('s3_region', process.env.S3_REGION || 'us-east-1'),
  bucket: getSetting('s3_bucket', process.env.S3_BUCKET || ''),
  prefix: getSetting('s3_prefix', process.env.S3_PREFIX || 'braxhn-tv/').replace(/^\/+/, ''),
  accessKey: getSetting('s3_access_key', process.env.S3_ACCESS_KEY || ''),
  secretKey: getSetting('s3_secret_key', process.env.S3_SECRET_KEY || ''),
  vhost: getSetting('s3_vhost', '0') === '1',
  passphrase: getSetting('offsite_pass', process.env.BACKUP_PASSPHRASE || ''),
  keep: Math.max(1, +getSetting('offsite_keep', '30'))
});

export { encryptFile, decryptFile } from './backupcrypt.js';
import { encryptFile, decryptFile } from './backupcrypt.js';

// Namnen innehåller tidsstämpel (braxhn-tv-ÅÅÅÅ-MM-DD...): sortera på namn, nyast först – mtime ändras vid kopiering/synk och är opålitlig
const byNameDesc = (a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

// ---------- S3 (AWS Signature V4) ----------
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function signS3(c, method, key, { query = {}, headers = {}, payloadHash = 'UNSIGNED-PAYLOAD', date = new Date() } = {}) {
  const ep = new URL(c.endpoint.includes('://') ? c.endpoint : 'https://' + c.endpoint);
  const host = c.vhost ? `${c.bucket}.${ep.host}` : ep.host;
  const pathPart = (c.vhost ? '' : '/' + enc(c.bucket)) + '/' + key.split('/').map(enc).join('/');
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(h).sort();
  const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const canonical = [method, pathPart, qs, names.map(n => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac('AWS4' + c.secretKey, day), kRegion = hmac(kDate, c.region), kService = hmac(kRegion, 's3'), kSigning = hmac(kService, 'aws4_request');
  const sig = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  delete h.host;
  return { url: `${ep.protocol}//${host}${pathPart}${qs ? '?' + qs : ''}`, headers: h, canonical };
}

async function s3(c, method, key, opts = {}) {
  const { url, headers } = signS3(c, method, key, opts);
  const r = await fetch(url, { method, headers, body: opts.body, duplex: opts.body ? 'half' : undefined, signal: AbortSignal.timeout(opts.timeout || 60000) });
  if (!r.ok && !(method === 'DELETE' && r.status === 404)) {
    const t = await r.text().catch(() => '');
    throw new Error(`S3 ${r.status}: ${(/<Message>([^<]*)/.exec(t)?.[1] || /<Code>([^<]*)/.exec(t)?.[1] || t.slice(0, 160))}`);
  }
  return r;
}

async function s3Upload(c, file, name) {
  const size = fs.statSync(file).size;
  await s3(c, 'PUT', c.prefix + name, { headers: { 'content-length': size, 'content-type': 'application/octet-stream' }, body: fs.createReadStream(file), timeout: 30 * 60e3 });
}
async function s3List(c) {
  const out = []; let token = null;
  do {
    const q = { 'list-type': '2', prefix: c.prefix, ...(token ? { 'continuation-token': token } : {}) };
    const x = await (await s3(c, 'GET', '', { query: q, payloadHash: sha256('') })).text();
    for (const m of x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]*)/.exec(m[1])?.[1] || '', size = +(/<Size>(\d+)/.exec(m[1])?.[1] || 0), mod = /<LastModified>([^<]*)/.exec(m[1])?.[1];
      const name = key.slice(c.prefix.length).replace(/&amp;/g, '&');
      if (/^braxhn-tv-[\w-]+\.bxtv$/.test(name)) out.push({ name, size, mtime: Math.floor(new Date(mod).getTime() / 1000) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(x) ? /<NextContinuationToken>([^<]*)/.exec(x)?.[1] : null;
  } while (token);
  return out.sort(byNameDesc);
}

// ---------- mål ----------
function dirList(c) {
  try {
    return fs.readdirSync(c.dir).filter(f => /^braxhn-tv-[\w-]+\.bxtv$/.test(f))
      .map(f => { const st = fs.statSync(path.join(c.dir, f)); return { name: f, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }; })
      .sort(byNameDesc);
  } catch { return []; }
}
export async function list() {
  const c = cfg();
  if (c.kind === 'folder') return dirList(c);
  if (c.kind === 's3') return s3List(c);
  return [];
}

function validate(c) {
  if (c.kind === 'none') throw new Error('Ingen extern säkerhetskopiering vald');
  if (!c.passphrase || c.passphrase.length < 12) throw new Error('Ange en lösenfras på minst 12 tecken – utan den går kopian inte att läsa');
  if (c.kind === 'folder') {
    if (!c.dir || !path.isAbsolute(c.dir)) throw new Error('Ange en absolut sökväg, t.ex. /backup');
    if (!fs.existsSync(c.dir)) throw new Error(`Mappen ${c.dir} finns inte i containern – lägg till en sökvägsmappning i Unraid`);
  }
  if (c.kind === 's3' && (!c.endpoint || !c.bucket || !c.accessKey || !c.secretKey)) throw new Error('Fyll i adress, bucket, nyckel-id och hemlig nyckel');
}

/** Kryptera och skicka en lokal säkerhetskopia (.db) till det externa målet. */
export async function upload(localDb) {
  const c = cfg();
  if (c.kind === 'none') return null;
  if (state.running) throw new Error('Pågår redan');
  state.running = true; state.error = null;
  const name = path.basename(localDb).replace(/\.db$/, '.bxtv');
  const tmp = path.join(CACHE, name + '.tmp');
  try {
    validate(c);
    fs.mkdirSync(CACHE, { recursive: true });
    await encryptFile(localDb, tmp, c.passphrase);
    if (c.kind === 'folder') { fs.copyFileSync(tmp, path.join(c.dir, name + '.part')); fs.renameSync(path.join(c.dir, name + '.part'), path.join(c.dir, name)); }
    else await s3Upload(c, tmp, name);
    state.last = Date.now(); state.lastName = name;
    console.log('[offsite] skickade', name);
    // Gallra gamla kopior – ett fel här betyder inte att säkerhetskopieringen misslyckades
    try {
      const all = await list();
      for (const f of all.slice(c.keep)) {
        if (f.name === name) continue;
        if (c.kind === 'folder') fs.rmSync(path.join(c.dir, f.name), { force: true });
        else await s3(c, 'DELETE', c.prefix + f.name, { payloadHash: sha256('') }).catch(() => {});
      }
    } catch (e) { console.warn('[offsite] kunde inte gallra gamla kopior:', e.message); }
    return name;
  } catch (e) {
    state.error = e.message;
    console.warn('[offsite] misslyckades:', e.message);
    notify('backup', 'Extern säkerhetskopiering misslyckades', e.message, { priority: 4, key: 'offsite', minInterval: 20 * 3600 });
    throw e;
  } finally { fs.rmSync(tmp, { force: true }); state.running = false; }
}

/** Kontrollera att målet går att skriva till (skriver och tar bort en liten testfil) */
export async function test() {
  const c = cfg();
  validate(c);
  if (c.kind === 'folder') { const f = path.join(c.dir, '.braxhn-test'); fs.writeFileSync(f, 'ok'); fs.rmSync(f); return true; }
  const key = c.prefix + '.braxhn-test';
  await s3(c, 'PUT', key, { headers: { 'content-length': 2 }, body: 'ok', payloadHash: sha256('ok') });
  await s3(c, 'DELETE', key, { payloadHash: sha256('') });
  return true;
}

/** Hämta en extern kopia och dekryptera den (för återställning från webben) */
export async function fetchAndDecrypt(name, dstDb) {
  const c = cfg();
  if (!/^braxhn-tv-[\w-]+\.bxtv$/.test(name)) throw new Error('Ogiltigt namn');
  const tmp = path.join(CACHE, name + '.dl');
  try {
    if (c.kind === 'folder') fs.copyFileSync(path.join(c.dir, name), tmp);
    else { const r = await s3(c, 'GET', c.prefix + name, { payloadHash: sha256(''), timeout: 30 * 60e3 }); await pipeline(r.body, fs.createWriteStream(tmp)); }
    await decryptFile(tmp, dstDb, c.passphrase);
  } finally { fs.rmSync(tmp, { force: true }); }
}
