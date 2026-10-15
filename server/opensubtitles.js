// Sök och ladda ner undertexter från OpenSubtitles.com (REST API v1).
// Kräver en gratis API-nyckel (opensubtitles.com/consumers). Konto behövs för fler nedladdningar/dygn.
import fs from 'node:fs';
import path from 'node:path';
import { get, getSetting, SUBS_DIR } from './db.js';

const BASE = 'https://api.opensubtitles.com/api/v1';
const UA = 'BraXhn TV v0.2';
let login = null; // { token, base, until }

function key() { return getSetting('os_key') || process.env.OPENSUBTITLES_API_KEY || ''; }
export const enabled = () => !!key();

async function call(p, { method = 'GET', body, token, base } = {}) {
  const headers = { 'Api-Key': key(), 'User-Agent': UA, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch((base || BASE) + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { message: txt.slice(0, 200) }; }
  if (!r.ok) throw new Error(j.message || j.error || `OpenSubtitles svarade ${r.status}`);
  return j;
}

async function userToken() {
  const user = getSetting('os_user'), pass = getSetting('os_pass');
  if (!user || !pass) return null;
  if (login && login.until > Date.now()) return login;
  const j = await call('/login', { method: 'POST', body: { username: user, password: pass } });
  login = { token: j.token, base: j.base_url ? `https://${j.base_url.replace(/^https?:\/\//, '')}/api/v1` : BASE, until: Date.now() + 12 * 3600e3 };
  return login;
}

// OpenSubtitles-hash: filstorlek + summan av första och sista 64 KiB som 64-bitars tal
export function movieHash(file) {
  const CH = 65536, fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < CH * 2) return null;
    let h = BigInt(size);
    for (const pos of [0, size - CH]) {
      const b = Buffer.alloc(CH); fs.readSync(fd, b, 0, CH, pos);
      for (let i = 0; i < CH; i += 8) h = (h + b.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, '0');
  } finally { fs.closeSync(fd); }
}

export async function search(it, langs) {
  if (!key()) throw Object.assign(new Error('Ingen OpenSubtitles-nyckel angiven (Administration → Inställningar)'), { status: 400 });
  const q = new URLSearchParams({ languages: langs.join(',') });
  try { const h = movieHash(it.path); if (h) q.set('moviehash', h); } catch {}
  if (it.kind === 'episode') {
    const show = get('SELECT title, tmdb_id FROM items WHERE id=?', it.parent_id);
    if (show?.tmdb_id) q.set('parent_tmdb_id', show.tmdb_id); else q.set('query', show?.title || it.title);
    q.set('season_number', it.season); q.set('episode_number', it.episode);
  } else {
    if (it.tmdb_id) q.set('tmdb_id', it.tmdb_id); else { q.set('query', it.title); if (it.year) q.set('year', it.year); }
  }
  // API:t kräver sorterade parametrar för att undvika omdirigering
  const sorted = new URLSearchParams([...q.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const j = await call('/subtitles?' + sorted.toString());
  return (j.data || []).flatMap(d => (d.attributes?.files || []).slice(0, 1).map(f => ({
    fileId: f.file_id, name: d.attributes.release || f.file_name || '', lang: d.attributes.language,
    downloads: d.attributes.download_count || 0, hi: !!d.attributes.hearing_impaired,
    hashMatch: !!d.attributes.moviehash_match, fps: d.attributes.fps || null
  }))).sort((a, b) => (b.hashMatch - a.hashMatch) || (b.downloads - a.downloads));
}

export async function download(it, fileId, lang) {
  if (!key()) throw Object.assign(new Error('Ingen OpenSubtitles-nyckel angiven'), { status: 400 });
  const lg = await userToken().catch(e => { throw new Error('Inloggning till OpenSubtitles misslyckades: ' + e.message); });
  const j = await call('/download', { method: 'POST', body: { file_id: +fileId, sub_format: 'srt' }, token: lg?.token, base: lg?.base });
  if (!j.link || !/^https:\/\//i.test(j.link)) throw new Error(j.message || 'Ingen giltig nedladdningslänk');
  const r = await fetch(j.link, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('Nedladdningen misslyckades');
  if (+(r.headers.get('content-length') || 0) > 5 << 20) throw new Error('Undertextfilen är för stor');
  const dir = path.join(SUBS_DIR, String(it.id));
  fs.mkdirSync(dir, { recursive: true });
  const safeLang = String(lang || 'und').replace(/[^a-z-]/gi, '').slice(0, 8) || 'und';
  const file = path.join(dir, `${safeLang}.${+fileId}.srt`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 5 << 20) throw new Error('Undertextfilen är för stor');
  fs.writeFileSync(file, buf);
  return { file: path.basename(file), remaining: j.remaining };
}

export function removeDownloaded(it, name) {
  const f = path.join(SUBS_DIR, String(it.id), path.basename(name));
  fs.rmSync(f, { force: true });
}
