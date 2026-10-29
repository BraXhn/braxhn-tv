// Musikmetadata och låttexter från nätet (som Plexamp, fast med öppna källor). Källor:
//   MusicBrainz  – artistens id (MBID) via sökning på namnet, säkrad med albumtitlarna; typ, född/bildad, ursprung, genrer,
//                  länkar, relationer (medlemmar, samarbeten) och releasegrupper (album/singel/EP/samling). Högst 1 anrop/s
//                  och en User-Agent med kontaktadress – MusicBrainz krav.
//   Wikidata     – länken till Wikipedia (svenska först, annars engelska) och bilden (P18, Wikimedia Commons).
//   Wikipedia    – biografin och albumens beskrivning (REST-sammanfattningen).
//   Fanart.tv    – artistbild och bakgrund om FANART_API_KEY (eller nyckeln i inställningarna) finns. Valfritt.
//   Last.fm      – liknande artister om Last.fm-nyckeln för scrobbling finns. Valfritt.
//   LRCLIB       – synkade låttexter när filen saknar egen .lrc/tagg. Ingen nyckel.
// Körs i bakgrunden efter musikskanningen, en artist i taget; låttexter hämtas när de öppnas (och valfritt i bakgrunden).
// Alla anrop: fasta värdar (bas-adresserna kan bytas med miljövariabler för tester), tidsgräns, storleksgräns, paus per källa,
// omdirigeringar bara till tillåtna värdar och svar cachade i minnet. Nycklar skrivs aldrig ut (felen nämner bara värden).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get, all, run, now, getSetting, setSetting, IMAGES, CACHE } from './db.js';
import { similarity } from './match.js';
import { dropVariants } from './imgsize.js';
import { lyricsFor, parseLrc } from './listening.js';

const pexec = promisify(execFile);
const base = (env, def) => String(process.env[env] || def).replace(/\/+$/, '');
const MB = () => base('MUSICBRAINZ_URL', 'https://musicbrainz.org/ws/2');
const WD = () => base('WIKIDATA_URL', 'https://www.wikidata.org');
const WP = (lang) => base('WIKIPEDIA_URL', 'https://{lang}.wikipedia.org').replace('{lang}', lang === 'sv' ? 'sv' : 'en');
const CM = () => base('COMMONS_URL', 'https://commons.wikimedia.org');
const FA = () => base('FANART_URL', 'https://webservice.fanart.tv/v3');
const LRC = () => base('LRCLIB_URL', 'https://lrclib.net/api');
const LF = () => base('LASTFM_API', 'https://ws.audioscrobbler.com/2.0');
const ENV_OF = { mb: 'MUSICBRAINZ_URL', wd: 'WIKIDATA_URL', wp: 'WIKIPEDIA_URL', cm: 'COMMONS_URL', fa: 'FANART_URL', lrc: 'LRCLIB_URL', lf: 'LASTFM_API' };
const TIMEOUT = 15000, LYRICS_TIMEOUT = 8000, MAX_JSON = 4 << 20, MAX_IMG = 10 << 20;
const PER_RUN = 150;           // högst så många artister per omgång (MusicBrainz: ~4 anrop per artist à 1 s)
const ALBUMS_PER_ARTIST = 15;  // högst så många albumbeskrivningar per artist och omgång
const RETRY_DAYS = 30, REFRESH_DAYS = 120, LYRICS_RETRY_DAYS = 14;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const mbidOk = (s) => MBID.test(String(s || ''));

// ---------- inställningar ----------
export const enabled = () => getSetting('music_meta', process.env.MUSIC_METADATA || '1') === '1';
export const lyricsOnline = () => getSetting('music_lyrics_online', process.env.MUSIC_LYRICS_ONLINE || '1') === '1';
export const lyricsBackground = () => getSetting('music_lyrics_bg', process.env.MUSIC_LYRICS_BACKGROUND || '0') === '1';
export const contact = () => getSetting('music_meta_contact', process.env.MUSIC_META_CONTACT || '');
const fanartKey = () => getSetting('fanart_api_key', '') || process.env.FANART_API_KEY || '';
const lastfmKey = () => getSetting('lastfm_api_key', process.env.LASTFM_API_KEY || '');
/** MusicBrainz kräver en User-Agent som säger vilken app det är och hur man når den som kör den */
export const userAgent = () => `BraXhnTV/${globalThis.__braxhnAppVersion || '0'} ( ${contact() || 'https://github.com/braxhn/braxhn-tv'} )`;
/** Kontaktadressen hamnar i en HTTP-rubrik: bara en e-postadress eller en http(s)-adress, inga radbrytningar */
export function validContact(s) {
  s = String(s ?? '').trim();
  if (!s) return '';
  if (s.length > 200 || !/^([\w.+-]+@[\w-]+(\.[\w-]+)+|https?:\/\/[^\s()]+)$/i.test(s)) throw Object.assign(new Error('Ange en e-postadress eller en webbadress, t.ex. du@exempel.se'), { status: 400 });
  return s;
}
export const status = { running: false, library: null, done: 0, total: 0, matched: 0, last: null, error: null, lyrics: 0 };

// ---------- hämtning ----------
// Tillåtna värdar: de konfigurerade bas-adresserna plus bildvärdarna som Wikipedia/Commons/Fanart.tv skickar vidare till
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'commons.wikimedia.org', 'assets.fanart.tv']);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const allowedHosts = () => new Set([MB(), WD(), WP('sv'), WP('en'), CM(), FA(), LRC(), LF()].map(hostOf).filter(Boolean));
/** Får adressen hämtas? Bara http(s) till de konfigurerade värdarna, eller https till de kända bildvärdarna */
export const hostOk = (u) => { let x; try { x = new URL(u); } catch { return false; } return /^https?:$/.test(x.protocol) && (allowedHosts().has(x.host) || (IMAGE_HOSTS.has(x.hostname) && !x.port && x.protocol === 'https:')); };
// Testerna får aldrig nå de riktiga tjänsterna: under node --test används bara källor med en bas-adress i miljön
const offlineInTests = (src) => !!process.env.NODE_TEST_CONTEXT && !process.env[ENV_OF[src] || '-'];
// Paus per källa: MusicBrainz högst ett anrop per sekund, övriga lite luft
const GAP = { mb: () => +(process.env.MUSICBRAINZ_GAP_MS ?? 1100) };
const gapOf = (src) => Math.max(0, (GAP[src] || (() => +(process.env.MUSIC_META_GAP_MS ?? 250)))());
const nextAt = new Map();
async function slot(src) {
  const t = Math.max(Date.now(), nextAt.get(src) || 0);
  nextAt.set(src, t + gapOf(src));
  if (t > Date.now()) await new Promise(r => setTimeout(r, t - Date.now()));
}
const cache = new Map(); // adress → { at, v } (även "finns inte"), 24 h, högst 600
const TTL = 24 * 3600e3;
const remember = (k, v) => { cache.set(k, { at: Date.now(), v }); if (cache.size > 600) cache.delete(cache.keys().next().value); return v; };
export const clearCache = () => { cache.clear(); nextAt.clear(); };
async function readCapped(r, max) {
  if (+r.headers.get('content-length') > max) { r.body?.cancel().catch(() => {}); throw new Error('svaret är för stort'); }
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error('svaret är för stort'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const drop = (r) => r?.body?.cancel().catch(() => {});
/** GET med fast värd: omdirigeringar följs för hand (högst 3) och bara till tillåtna värdar. 404 → null. */
async function fetchOk(src, url, accept, timeout = TIMEOUT) {
  if (offlineInTests(src)) throw new Error('nätet används inte i tester');
  let host = hostOf(url);
  if (!hostOk(url)) throw new Error(`otillåten adress (${host})`);
  await slot(src);
  const signal = AbortSignal.timeout(timeout);
  let r;
  for (let hop = 0; ; hop++) {
    try { r = await fetch(url, { headers: { Accept: accept, 'User-Agent': userAgent() }, redirect: 'manual', signal }); }
    catch (e) { throw new Error(e.name === 'TimeoutError' ? `${host} svarade inte i tid` : `kunde inte nå ${host} (${e.cause?.code || e.message})`); }
    if (r.status < 300 || r.status >= 400) break;
    drop(r);
    const next = r.headers.get('location');
    if (!next || hop >= 3) throw new Error(`${host} skickade vidare för många gånger`);
    url = new URL(next, url).href;
    if (!hostOk(url)) throw new Error(`${host} skickade vidare till en otillåten värd`);
    host = hostOf(url);
  }
  if (r.status === 404) { drop(r); return null; }
  if (r.status === 429 || r.status === 503 || r.status === 403) {
    drop(r);
    if (src === 'mb') nextAt.set(src, Date.now() + 10000); // MusicBrainz: 503 = för många anrop, vänta en stund
    throw Object.assign(new Error(`${host}: för många anrop just nu (${r.status})`), { rateLimited: true });
  }
  if (!r.ok) { drop(r); throw new Error(`${host} svarade ${r.status}`); }
  return r;
}
async function getJson(src, url, timeout) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < TTL) return c.v;
  const r = await fetchOk(src, url, 'application/json', timeout);
  if (!r) return remember(url, null);
  const buf = await readCapped(r, MAX_JSON);
  try { return remember(url, JSON.parse(buf.toString('utf8'))); } catch { throw new Error(`${hostOf(url)} skickade inget giltigt JSON-svar`); }
}
async function fetchImage(src, url) {
  const r = await fetchOk(src, url, 'image/*');
  const type = r?.headers.get('content-type') || '';
  if (!r || !/^image\/(jpeg|png|webp|gif)/.test(type)) { drop(r); throw new Error('Ingen bild'); }
  return readCapped(r, MAX_IMG);
}

// ---------- namn och titlar ----------
/** Jämförbar form: gemener, utan accenter, skiljetecken och inledande "the" – fungerar även för icke-latinska namn */
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
  .replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const bigrams = (s) => { const x = norm(s).replace(/ /g, ''); const out = new Map(); for (let i = 0; i < x.length - 1; i++) { const b = x.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } return out; };
/** Hur lika två artistnamn är (0–1) */
export function nameSim(a, b) {
  if (!norm(a) || !norm(b)) return 0;
  if (norm(a) === norm(b)) return 1;
  const A = bigrams(a), B = bigrams(b);
  let common = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) common += Math.min(v, B.get(k) || 0);
  return na + nb ? 2 * common / (na + nb) : 0;
}
// "(Remastered 2011)", "[Deluxe Edition]" … räknas inte när album jämförs
const cleanAlbum = (t) => String(t || '').replace(/[([][^)\]]*(remaster|deluxe|edition|expanded|anniversary|bonus|version|utgåva|mono|stereo)[^)\]]*[)\]]/gi, ' ')
  .replace(/\s+-\s+(remaster|deluxe).*$/i, '').replace(/\s+/g, ' ').trim();
export function albumSim(a, b) {
  a = cleanAlbum(a); b = cleanAlbum(b);
  if (norm(a) && norm(a) === norm(b)) return 1;
  return similarity(a, b);
}
const SKIP_ARTIST = /^(okänd artist|unknown artist|various artists|various|va|diverse artister|blandade artister|soundtrack)$/i;
const cut = (s, n) => { s = String(s ?? '').trim(); return s ? s.slice(0, n) : null; };
const uniq = (a) => [...new Set(a.filter(Boolean))];

// ---------- MusicBrainz ----------
const luceneQ = (s) => `"${String(s).replace(/["\\]/g, ' ').trim()}"`;
async function mbSearch(name) {
  const q = `artist:${luceneQ(name)} OR alias:${luceneQ(name)}`;
  const j = await getJson('mb', `${MB()}/artist?query=${encodeURIComponent(q)}&limit=10&fmt=json`);
  return (j?.artists || []).filter(a => mbidOk(a.id)).map(a => ({
    mbid: a.id, name: a.name || '', score: +a.score || 0, type: a.type || null, country: a.country || null, area: a.area?.name || null,
    begin: a['life-span']?.begin || null, disambiguation: a.disambiguation || null, aliases: (a.aliases || []).map(x => x.name).filter(Boolean).slice(0, 20) }));
}
/** Artistens releasegrupper (album, singlar, EP …) – högst 200 */
async function releaseGroups(mbid) {
  const out = [];
  for (let offset = 0; offset < 200; offset += 100) {
    const j = await getJson('mb', `${MB()}/release-group?artist=${mbid}&limit=100&offset=${offset}&fmt=json`);
    const list = j?.['release-groups'] || [];
    out.push(...list.filter(g => mbidOk(g.id)).map(g => ({ mbid: g.id, title: g.title || '', primary: g['primary-type'] || null,
      secondary: g['secondary-types'] || [], date: g['first-release-date'] || null })));
    if (list.length < 100 || out.length >= (+j['release-group-count'] || 0)) break;
  }
  return out;
}
const mbArtist = (mbid) => getJson('mb', `${MB()}/artist/${mbid}?inc=url-rels+genres+tags+artist-rels&fmt=json`);
const mbReleaseGroup = (mbid) => getJson('mb', `${MB()}/release-group/${mbid}?inc=url-rels&fmt=json`);
/** Hur många av våra album som finns bland releasegrupperna */
const overlap = (ours, rgs) => ours.filter(t => rgs.some(g => albumSim(t, g.title) >= 0.85)).length;

/**
 * Bästa MusicBrainz-artisten för ett namn, säkrad med albumtitlarna: en träff kräver att minst ett av våra album finns
 * hos artisten – eller, utan albumträff, att namnet är exakt lika och ingen annan kandidat heter likadant.
 * Hellre ingen träff än fel artist (många artister delar namn).
 */
export async function findArtist(name, albumTitles = []) {
  if (!norm(name) || SKIP_ARTIST.test(String(name).trim())) return null;
  const ours = uniq(albumTitles.map(cleanAlbum)).filter(t => norm(t) && !/^okänt album$/i.test(t)).slice(0, 30);
  const cands = (await mbSearch(name)).map(c => ({ ...c, sim: Math.max(nameSim(name, c.name), ...c.aliases.map(a => nameSim(name, a) * 0.97)) }))
    .filter(c => c.sim >= 0.8).sort((a, b) => (b.sim - a.sim) || (b.score - a.score)).slice(0, 4);
  if (!cands.length) return null;
  let best = null;
  if (ours.length) for (const c of cands.slice(0, 3)) {
    const n = overlap(ours, await releaseGroups(c.mbid));
    if (n && (!best || n > best.n || (n === best.n && c.sim > best.c.sim))) best = { c, n };
  }
  if (best) return best.c;
  const exact = cands.filter(c => c.sim === 1);
  if (exact.length === 1 && exact[0].score >= 90 && !ours.length) return exact[0];
  // Album finns men inget av dem hos någon kandidat: bara ett exakt, entydigt namn med full poäng
  if (exact.length === 1 && exact[0].score === 100 && cands.filter(c => c.sim >= 0.9).length === 1) return exact[0];
  return null;
}
/** Manuell sökning ("Fel artist?") */
export async function search(name) {
  const list = await mbSearch(String(name || '').slice(0, 200));
  return list.map(c => ({ ...c, sim: nameSim(name, c.name) })).sort((a, b) => b.score - a.score || b.sim - a.sim);
}

// ---------- länkar ----------
const LINK_HOSTS = [[/spotify\.com$/, 'Spotify'], [/music\.apple\.com$|itunes\.apple\.com$/, 'Apple Music'], [/tidal\.com$/, 'Tidal'], [/deezer\.com$/, 'Deezer'],
  [/youtube\.com$|youtu\.be$/, 'YouTube'], [/instagram\.com$/, 'Instagram'], [/facebook\.com$/, 'Facebook'], [/(twitter|x)\.com$/, 'X'], [/tiktok\.com$/, 'TikTok'],
  [/soundcloud\.com$/, 'SoundCloud'], [/bandcamp\.com$/, 'Bandcamp'], [/discogs\.com$/, 'Discogs'], [/allmusic\.com$/, 'AllMusic'], [/last\.fm$/, 'Last.fm'],
  [/genius\.com$/, 'Genius'], [/imdb\.com$/, 'IMDb'], [/setlist\.fm$/, 'setlist.fm'], [/songkick\.com$/, 'Songkick']];
const SKIP_LINK = new Set(['wikidata', 'wikipedia', 'image', 'VIAF', 'lyrics', 'other databases', 'purchase for download', 'purchase for mail-order', 'download for free']);
function linksOf(rels = [], mbid) {
  const out = [], seen = new Set();
  const add = (label, url) => { if (!seen.has(label) && out.length < 14) { seen.add(label); out.push({ label, url }); } };
  for (const r of rels) {
    if (r['target-type'] !== 'url' || r.ended || SKIP_LINK.has(r.type)) continue;
    let u; try { u = new URL(r.url?.resource); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const h = u.hostname.replace(/^www\./, '');
    if (r.type === 'official homepage') { add('Officiell webbplats', u.href); continue; }
    const known = LINK_HOSTS.find(([re]) => re.test(h));
    if (known) add(known[1], u.href);
  }
  if (mbid) add('MusicBrainz', `https://musicbrainz.org/artist/${mbid}`);
  return out;
}
const wikidataOf = (rels = []) => { for (const r of rels) { const m = /wikidata\.org\/wiki\/(Q\d{1,12})$/.exec(r.url?.resource || ''); if (r.type === 'wikidata' && m) return m[1]; } return null; };
const wikipediaOf = (rels = []) => {
  for (const lang of ['sv', 'en']) for (const r of rels) {
    const m = new RegExp(`^https?://${lang}\\.wikipedia\\.org/wiki/(.+)$`).exec(r.url?.resource || '');
    if (r.type === 'wikipedia' && m) { try { return { lang, title: decodeURIComponent(m[1]).replace(/_/g, ' ') }; } catch {} }
  }
  return null;
};

// ---------- Wikidata, Wikipedia och Commons ----------
async function wikiTitle(qid) {
  const j = await getJson('wd', `${WD()}/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=svwiki%7Cenwiki&format=json`);
  const s = j?.entities?.[qid]?.sitelinks || {};
  if (s.svwiki?.title) return { lang: 'sv', title: s.svwiki.title };
  if (s.enwiki?.title) return { lang: 'en', title: s.enwiki.title };
  return null;
}
async function wikiImageFile(qid) {
  const j = await getJson('wd', `${WD()}/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`);
  const v = j?.claims?.P18?.find(c => c.rank !== 'deprecated')?.mainsnak?.datavalue?.value;
  return typeof v === 'string' && v.length < 300 ? v : null;
}
/** Wikipedia-sammanfattningen (REST): text, bild och adress. Förgreningssidor räknas inte. */
async function summary(w) {
  if (!w) return null;
  const j = await getJson('wp', `${WP(w.lang)}/api/rest_v1/page/summary/${encodeURIComponent(w.title.replace(/ /g, '_'))}`);
  if (!j || j.type === 'disambiguation' || !j.extract) return null;
  return { lang: w.lang, text: cut(j.extract, 6000), url: j.content_urls?.desktop?.page || `https://${w.lang}.wikipedia.org/wiki/${encodeURIComponent(w.title.replace(/ /g, '_'))}`,
    image: j.originalimage?.source || j.thumbnail?.source || null };
}
async function wikiFor(rels) {
  const qid = wikidataOf(rels);
  const w = wikipediaOf(rels) || (qid ? await wikiTitle(qid) : null);
  return { qid, sum: await summary(w).catch(() => null) };
}

// ---------- bilder ----------
export const photoFile = (artistId) => path.join(IMAGES, `ar${+artistId}-photo.jpg`);
export const backdropFile = (artistId) => path.join(IMAGES, `ar${+artistId}-bg.jpg`);
/** Bilden för en artist om den finns (raden i artist_meta avgör – id:n kan återanvändas) */
export function photoPath(artistId, kind = 'photo') {
  const m = get('SELECT image, backdrop FROM artist_meta WHERE artist_id=?', artistId);
  const f = kind === 'bg' ? (m?.backdrop ? backdropFile(artistId) : null) : (m?.image ? photoFile(artistId) : null);
  return f && fs.existsSync(f) ? f : null;
}
async function convert(srcFile, out, width) {
  await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', srcFile, '-frames:v', '1',
    '-vf', `scale='min(${width},iw)':-2`, '-q:v', '3', out + '.tmp.jpg'], { timeout: 30000 });
  fs.renameSync(out + '.tmp.jpg', out);
  dropVariants(out);
}
async function saveImage(src, url, out, width) {
  const tmp = path.join(CACHE, `artistimg-${process.pid}-${crypto.randomBytes(4).toString('hex')}.img`);
  try {
    const body = await fetchImage(src, url);
    if (body.length < 1000) return false;
    fs.writeFileSync(tmp, body);
    await convert(tmp, out, width);
    return true;
  } catch (e) { console.warn('[musikmetadata] bild', hostOf(url), e.message); return false; }
  finally { fs.rm(tmp, { force: true }, () => {}); fs.rm(out + '.tmp.jpg', { force: true }, () => {}); }
}
const LOCAL_PHOTO = ['artist.jpg', 'artist.png', 'artist.webp'];
/** artist.jpg i artistens mapp (föräldern till albummapparna) – går före bilderna från nätet */
function localPhoto(artistId) {
  const dirs = uniq(all('SELECT dir FROM albums WHERE artist_id=? AND dir IS NOT NULL LIMIT 20', artistId).map(r => path.dirname(r.dir)));
  for (const d of dirs) {
    let names; try { names = fs.readdirSync(d); } catch { continue; }
    const f = names.find(n => LOCAL_PHOTO.includes(n.toLowerCase()));
    if (f) return path.join(d, f);
  }
  return null;
}

// ---------- artisten ----------
function upsertArtist(id, f) {
  const keys = Object.keys(f);
  run(`INSERT INTO artist_meta(artist_id, ${keys.join(',')}) VALUES(?, ${keys.map(() => '?').join(',')})
    ON CONFLICT(artist_id) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(',')}`, id, ...keys.map(k => f[k]));
}
function upsertAlbum(id, f) {
  const keys = Object.keys(f);
  run(`INSERT INTO album_meta(album_id, ${keys.join(',')}) VALUES(?, ${keys.map(() => '?').join(',')})
    ON CONFLICT(album_id) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(',')}`, id, ...keys.map(k => f[k]));
}
const RELATION = { 'member of band': 'Medlem', 'collaboration': 'Samarbete', 'is person': 'Samma person', 'supporting musician': 'Musiker', 'vocal supporting musician': 'Sångare',
  'instrumental supporting musician': 'Musiker', 'subgroup': 'Grupp', 'founder': 'Grundare', 'tribute': 'Hyllning', 'married': 'Gift med', 'sibling': 'Syskon', 'parent': 'Förälder', 'child': 'Barn' };
const kindOf = (g) => {
  if (!g) return null;
  const s = (g.secondary || []).map(x => x.toLowerCase());
  if (s.includes('compilation')) return 'compilation';
  if (s.includes('live')) return 'live';
  if (s.includes('soundtrack')) return 'soundtrack';
  if (s.includes('remix') || s.includes('dj-mix') || s.includes('mixtape/street')) return 'remix';
  return { Album: 'album', Single: 'single', EP: 'ep', Broadcast: 'other', Other: 'other' }[g.primary] || null;
};

/** Hämtar allt för en artist. mbid = känt id (låst/manuellt), annars söks det. Returnerar true vid träff. */
export async function refreshArtist(artistId, { mbid = null, locked = false } = {}) {
  const ar = get('SELECT * FROM artists WHERE id=?', artistId);
  if (!ar) return null;
  const albums = all('SELECT id, title FROM albums WHERE artist_id=?', ar.id);
  if (!mbid) mbid = (await findArtist(ar.name, albums.map(a => a.title)))?.mbid || null;
  if (!mbid) { upsertArtist(ar.id, { state: 2, tried: now(), locked: locked ? 1 : 0 }); return false; }
  const d = await mbArtist(mbid);
  if (!d?.id) { upsertArtist(ar.id, { state: 2, tried: now(), locked: locked ? 1 : 0 }); return false; }
  const rels = d.relations || [];
  const { qid, sum } = await wikiFor(rels);
  const genres = uniq([...(d.genres || []).sort((a, b) => (b.count || 0) - (a.count || 0)).map(g => g.name), ...(d.tags || []).filter(t => t.count > 1).sort((a, b) => b.count - a.count).map(t => t.name)])
    .map(g => String(g).slice(0, 40)).slice(0, 8);
  const related = rels.filter(r => r['target-type'] === 'artist' && r.artist?.name && RELATION[r.type])
    .map(r => ({ name: String(r.artist.name).slice(0, 200), mbid: mbidOk(r.artist.id) ? r.artist.id : null, rel: RELATION[r.type], src: 'musicbrainz' }));
  // Last.fm: liknande artister (bara om nyckeln för scrobbling finns)
  let lastfm = null;
  if (lastfmKey()) {
    const j = await getJson('lf', `${LF()}/?${new URLSearchParams({ method: 'artist.getsimilar', mbid, api_key: lastfmKey(), format: 'json', limit: '40', autocorrect: '1' })}`).catch(() => null);
    for (const x of j?.similarartists?.artist || []) if (x?.name) related.push({ name: String(x.name).slice(0, 200), mbid: mbidOk(x.mbid) ? x.mbid : null, rel: 'Liknande', src: 'lastfm', match: +x.match || 0 });
    const i = await getJson('lf', `${LF()}/?${new URLSearchParams({ method: 'artist.getinfo', mbid, api_key: lastfmKey(), format: 'json' })}`).catch(() => null);
    lastfm = /^https:\/\/www\.last\.fm\//.test(i?.artist?.url || '') ? i.artist.url : null;
  }
  const fields = {
    state: 1, locked: locked ? 1 : 0, tried: now(), fetched: now(), mbid, mb_name: cut(d.name, 200), kind: cut(d.type, 30), disambiguation: cut(d.disambiguation, 200),
    country: cut(d.country, 4), area: cut(d.area?.name, 100), begin_area: cut(d['begin-area']?.name, 100),
    life_begin: cut(d['life-span']?.begin, 10), life_end: cut(d['life-span']?.end, 10), ended: d['life-span']?.ended ? 1 : 0,
    genres: JSON.stringify(genres), links: JSON.stringify(linksOf(rels, mbid)), related: JSON.stringify(related.slice(0, 80)),
    bio: sum?.text || null, bio_lang: sum?.lang || null, bio_url: sum?.url || null, wikidata: qid, lastfm_url: lastfm,
  };
  upsertArtist(ar.id, fields);
  await artistImages(ar.id, mbid, qid, sum);
  await albumInfo(ar.id, mbid, albums);
  return true;
}
/** Bild och bakgrund: artist.jpg i mappen → Fanart.tv (med nyckel) → Wikidata/Commons → Wikipedia */
async function artistImages(id, mbid, qid, sum) {
  const prev = get('SELECT image, image_src, backdrop FROM artist_meta WHERE artist_id=?', id) || {};
  const local = localPhoto(id);
  let image = 0, src = null, backdrop = 0;
  if (local) {
    try { await convert(local, photoFile(id), 1000); image = 1; src = 'local'; } catch (e) { console.warn('[musikmetadata] artist.jpg', e.message); }
  }
  let fa = null;
  if (fanartKey() && mbid) fa = await getJson('fa', `${FA()}/music/${mbid}?api_key=${encodeURIComponent(fanartKey())}`).catch(() => null);
  if (!image && fa?.artistthumb?.[0]?.url && await saveImage('fa', fa.artistthumb[0].url, photoFile(id), 1000)) { image = 1; src = 'fanart'; }
  if (!image && qid) {
    const file = await wikiImageFile(qid).catch(() => null);
    if (file && await saveImage('cm', `${CM()}/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=1000`, photoFile(id), 1000)) { image = 1; src = 'commons'; }
  }
  if (!image && sum?.image && await saveImage('wp', sum.image, photoFile(id), 1000)) { image = 1; src = 'wikipedia'; }
  if (fa?.artistbackground?.[0]?.url && await saveImage('fa', fa.artistbackground[0].url, backdropFile(id), 1920)) backdrop = 1;
  // Ingen ny bild: behåll den förra (ett tillfälligt fel ska inte ta bort en bild)
  if (!image && prev.image && fs.existsSync(photoFile(id))) { image = 1; src = prev.image_src; }
  if (!backdrop && prev.backdrop && fs.existsSync(backdropFile(id))) backdrop = 1;
  upsertArtist(id, { image, image_src: src, backdrop });
}
/** Albumens typ (album/singel/EP/samling …) från releasegrupperna och beskrivningen från Wikipedia */
async function albumInfo(artistId, mbid, albums) {
  if (!albums.length) return;
  const rgs = await releaseGroups(mbid).catch(() => []);
  let described = 0;
  for (const a of albums) {
    let best = null;
    for (const g of rgs) { const s = albumSim(a.title, g.title); if (s >= 0.85 && (!best || s > best.s)) best = { g, s }; }
    if (!best) { upsertAlbum(a.id, { mbid: null, kind: null, released: null, tried: now() }); continue; }
    const prev = get('SELECT * FROM album_meta WHERE album_id=?', a.id);
    const f = { mbid: best.g.mbid, kind: kindOf(best.g), released: cut(best.g.date, 10), tried: now() };
    if (described < ALBUMS_PER_ARTIST && (!prev || prev.mbid !== best.g.mbid || !prev.description)) {
      described++;
      const d = await mbReleaseGroup(best.g.mbid).catch(() => null);
      const { sum } = await wikiFor(d?.relations || []);
      if (sum) Object.assign(f, { description: sum.text, desc_lang: sum.lang, desc_url: sum.url });
    }
    upsertAlbum(a.id, f);
  }
}

/** "Fel artist?": välj MusicBrainz-artisten för hand – matchningen låses */
export async function matchManual(artistId, mbid) {
  if (!mbidOk(mbid)) throw Object.assign(new Error('Ogiltigt MusicBrainz-id'), { status: 400 });
  return refreshArtist(artistId, { mbid, locked: true });
}
/** Lås upp och matcha om automatiskt vid nästa omgång */
export function unlock(artistId) { upsertArtist(artistId, { locked: 0, state: 0, tried: null }); }
/** Ta bort matchningen helt (fel artist och ingen rätt finns) – låst utan källa */
export function clearMatch(artistId) {
  upsertArtist(artistId, { state: 2, locked: 1, tried: now(), mbid: null, mb_name: null, bio: null, bio_lang: null, bio_url: null, genres: null, links: null, related: null,
    kind: null, country: null, area: null, begin_area: null, life_begin: null, life_end: null, ended: 0, wikidata: null, lastfm_url: null, image: 0, image_src: null, backdrop: 0 });
  run('UPDATE album_meta SET mbid=NULL, kind=NULL, description=NULL, desc_lang=NULL, desc_url=NULL WHERE album_id IN (SELECT id FROM albums WHERE artist_id=?)', artistId);
  fs.rmSync(photoFile(artistId), { force: true }); fs.rmSync(backdropFile(artistId), { force: true });
}

// ---------- läsning (API) ----------
const json = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
/** Fälten för artistsidan (null om inget hämtats) */
export function artistInfo(artistId) {
  const m = get('SELECT * FROM artist_meta WHERE artist_id=?', artistId);
  if (!m) return null;
  return { state: m.state, locked: !!m.locked, mbid: m.mbid, name: m.mb_name, type: m.kind, disambiguation: m.disambiguation,
    country: m.country, area: m.area, beginArea: m.begin_area, begin: m.life_begin, end: m.life_end, ended: !!m.ended,
    genres: json(m.genres, []), links: json(m.links, []), bio: m.bio, bioLang: m.bio_lang, bioUrl: m.bio_url, lastfmUrl: m.lastfm_url,
    image: !!m.image && fs.existsSync(photoFile(artistId)), imageSource: m.image ? m.image_src : null, backdrop: !!m.backdrop && fs.existsSync(backdropFile(artistId)) };
}
/**
 * Relaterade artister som finns i samma bibliotek: MusicBrainz-relationer (medlemmar, samarbeten) och Last.fm:s
 * liknande artister, matchade på MBID eller namn.
 */
export function relatedLocal(artistId, limit = 24) {
  const a = get('SELECT a.library_id, m.related FROM artists a LEFT JOIN artist_meta m ON m.artist_id=a.id WHERE a.id=?', artistId);
  const list = json(a?.related, []);
  if (!list.length) return [];
  const out = [], seen = new Set([artistId]);
  for (const r of list) {
    const hit = (r.mbid && get('SELECT a.id FROM artist_meta m JOIN artists a ON a.id=m.artist_id WHERE m.mbid=? AND a.library_id=?', r.mbid, a.library_id))
      || get('SELECT id FROM artists WHERE library_id=? AND name=? COLLATE NOCASE', a.library_id, r.name);
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push({ id: hit.id, relation: r.rel, source: r.src });
    if (out.length >= limit) break;
  }
  if (!out.length) return [];
  const rows = new Map(all(`SELECT ar.id, ar.name, (SELECT COUNT(*) FROM albums x WHERE x.artist_id=ar.id) AS albums,
    (SELECT x.id FROM albums x WHERE x.artist_id=ar.id AND x.cover=1 ORDER BY x.year DESC LIMIT 1) AS cover_album
    FROM artists ar WHERE ar.id IN (${out.map(() => '?').join(',')})`, ...out.map(x => x.id)).map(r => [r.id, r]));
  return out.filter(x => rows.has(x.id)).map(x => ({ ...rows.get(x.id), image: hasPhoto(x.id), relation: x.relation, source: x.source }));
}
export const hasPhoto = (artistId) => !!get('SELECT 1 FROM artist_meta WHERE artist_id=? AND image=1', artistId);
/** Albumets typ: MusicBrainz om känd, annars en gissning från antal låtar och längd (och ord i titeln) */
export function albumKind(a, m = undefined) {
  if (m === undefined) m = get('SELECT kind FROM album_meta WHERE album_id=?', a.id);
  if (m?.kind) return { kind: m.kind, guessed: false };
  const t = String(a.title || '');
  if (/\b(greatest hits|best of|the very best|samlade|collection|anthology|hits)\b/i.test(t)) return { kind: 'compilation', guessed: true };
  if (/\blive\b/i.test(t)) return { kind: 'live', guessed: true };
  const n = +a.tracks || 0, d = +a.duration || 0;
  if (n && n <= 3 && d < 1200) return { kind: 'single', guessed: true };
  if (n && n <= 7 && d <= 1800) return { kind: 'ep', guessed: true };
  return { kind: 'album', guessed: true };
}
export function albumInfoOf(albumId) {
  const m = get('SELECT * FROM album_meta WHERE album_id=?', albumId);
  return m ? { mbid: m.mbid, type: m.kind, released: m.released, description: m.description, descLang: m.desc_lang, descUrl: m.desc_url } : null;
}

// ---------- låttexter (LRCLIB) ----------
const inflight = new Map();
const lyricsRow = (t) => get('SELECT * FROM track_lyrics WHERE track_id=?', t.id);
const fromRow = (r) => {
  if (r.instrumental) return { source: 'lrclib', synced: false, instrumental: true, lines: [] };
  const p = parseLrc(r.lyrics || '');
  return p.lines.length ? { source: 'lrclib', ...p } : null;
};
/** Bästa träffen bland LRCLIB:s sökresultat: längden inom 3 s och samma artist */
function pickLrc(list, artist, title, duration) {
  let best = null;
  for (const x of Array.isArray(list) ? list.slice(0, 30) : []) {
    if (!x || (!x.syncedLyrics && !x.plainLyrics && !x.instrumental)) continue;
    if (duration && x.duration && Math.abs(x.duration - duration) > 3) continue;
    const s = nameSim(artist, x.artistName) * 0.5 + albumSim(title, x.trackName) * 0.5 + (x.syncedLyrics ? 0.05 : 0);
    if (s >= 0.8 && (!best || s > best.s)) best = { x, s };
  }
  return best?.x || null;
}
/** Hämta (och cacha i databasen) texten för ett spår från LRCLIB. null = ingen text. */
export async function onlineLyrics(t, { timeout = LYRICS_TIMEOUT } = {}) {
  const row = lyricsRow(t);
  if (row?.state === 1) return fromRow(row);
  if (row?.state === 2 && row.fetched > now() - LYRICS_RETRY_DAYS * 86400) return null;
  if (inflight.has(t.id)) return inflight.get(t.id);
  const p = (async () => {
    const info = get(`SELECT t.title, t.duration, al.title AS album, COALESCE(ar.name, aa.name) AS artist FROM tracks t LEFT JOIN albums al ON al.id=t.album_id
      LEFT JOIN artists ar ON ar.id=t.artist_id LEFT JOIN artists aa ON aa.id=al.artist_id WHERE t.id=?`, t.id);
    if (!info?.artist || !info.title || SKIP_ARTIST.test(info.artist)) return null;
    const dur = Math.round(info.duration || 0);
    const q = new URLSearchParams({ artist_name: info.artist, track_name: info.title, ...(info.album && !/^okänt album$/i.test(info.album) ? { album_name: info.album } : {}), ...(dur ? { duration: String(dur) } : {}) });
    let hit = await getJson('lrc', `${LRC()}/get?${q}`, timeout);
    if (hit && !hit.syncedLyrics && !hit.plainLyrics && !hit.instrumental) hit = null;
    if (!hit) hit = pickLrc(await getJson('lrc', `${LRC()}/search?${new URLSearchParams({ track_name: info.title, artist_name: info.artist })}`, timeout), info.artist, info.title, dur);
    const text = hit ? String(hit.syncedLyrics || hit.plainLyrics || '').slice(0, 256 * 1024) : '';
    const r = { state: hit ? 1 : 2, fetched: now(), synced: hit?.syncedLyrics ? 1 : 0, instrumental: hit?.instrumental && !text ? 1 : 0, lyrics: text || null, source: hit ? 'lrclib' : null,
      ext_id: hit?.id != null ? String(hit.id).slice(0, 20) : null };
    run(`INSERT INTO track_lyrics(track_id,state,fetched,synced,instrumental,lyrics,source,ext_id) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(track_id) DO UPDATE SET state=excluded.state, fetched=excluded.fetched, synced=excluded.synced, instrumental=excluded.instrumental,
      lyrics=excluded.lyrics, source=excluded.source, ext_id=excluded.ext_id`, t.id, r.state, r.fetched, r.synced, r.instrumental, r.lyrics, r.source, r.ext_id);
    return hit ? fromRow(r) : null;
  })().finally(() => inflight.delete(t.id));
  inflight.set(t.id, p);
  return p;
}
/**
 * Låttexten för ett spår: egen synkad text (.lrc, SYLT, taggar) först, sedan LRCLIB (om påslaget). Har filen bara
 * osynkad text används LRCLIB:s synkade text i stället, annars filens egen. Fel från nätet → filens text.
 */
export async function lyrics(t) {
  const local = await lyricsFor(t);
  if (local.synced || !lyricsOnline() || offlineInTests('lrc')) return local;
  try {
    const o = await onlineLyrics(t);
    if (!local.lines.length) return o || local;
    return o?.synced ? o : local;
  }
  catch (e) { console.warn('[låttexter]', e.message); return local; }
}

// ---------- bakgrundskö ----------
const pending = new Set();
let loop = null;
/** Köa ett musikbibliotek efter skanningen. Löftet blir klart när kön är tom (testerna väntar på det). */
export function queue(libId) {
  if (!enabled() && !lyricsBackground()) return Promise.resolve();
  pending.add(libId);
  if (!loop) loop = (async () => {
    status.running = true; status.error = null;
    try { while (pending.size) { const id = pending.values().next().value; pending.delete(id); await runLibrary(id); } }
    finally { loop = null; Object.assign(status, { running: false, library: null, done: 0, total: 0, last: now() }); }
  })().catch(e => { console.warn('[musikmetadata]', e.message); });
  return loop;
}
export const busy = () => !!loop;
/** Bilder för artister som inte finns längre (id:n kan återanvändas – raden i artist_meta avgör ändå) */
function cleanOrphans() {
  let names; try { names = fs.readdirSync(IMAGES); } catch { return; }
  for (const n of names) {
    const m = /^ar(\d+)-(photo|bg)\.jpg$/.exec(n);
    if (m && !get('SELECT 1 FROM artist_meta WHERE artist_id=? AND (image=1 OR backdrop=1)', +m[1])) { fs.rmSync(path.join(IMAGES, n), { force: true }); dropVariants(path.join(IMAGES, n)); }
  }
}
async function runLibrary(libId) {
  const lib = get("SELECT * FROM libraries WHERE id=? AND type='music'", libId); if (!lib) return;
  cleanOrphans();
  if (enabled() && !offlineInTests('mb')) {
    const t = now();
    const todo = all(`SELECT ar.id, ar.name, m.mbid, m.locked FROM artists ar LEFT JOIN artist_meta m ON m.artist_id=ar.id
      WHERE ar.library_id=? AND EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=ar.id)
      AND (m.artist_id IS NULL OR m.state=0 OR (m.locked=0 AND m.state=2 AND COALESCE(m.tried,0) < ?) OR (m.state=1 AND COALESCE(m.fetched,0) < ?))
      ORDER BY m.artist_id IS NOT NULL, (SELECT MAX(added) FROM albums a WHERE a.artist_id=ar.id) DESC LIMIT ?`, libId, t - RETRY_DAYS * 86400, t - REFRESH_DAYS * 86400, PER_RUN);
    Object.assign(status, { library: lib.name, done: 0, total: todo.length });
    let errors = 0;
    for (const a of todo) {
      if (!enabled()) break;
      status.done++;
      // Matchade artister hämtas om med samma MBID (låsta och automatiska) – namnsökningen görs bara en gång
      try { if (await refreshArtist(a.id, { mbid: a.mbid || null, locked: !!a.locked })) status.matched++; errors = 0; }
      catch (e) {
        status.error = e.message;
        console.warn('[musikmetadata]', a.name, '–', e.message);
        if (e.rateLimited || ++errors >= 3) break;
      }
    }
  }
  if (lyricsBackground() && lyricsOnline() && !offlineInTests('lrc')) await lyricsLibrary(libId);
}
/** Låttexter i bakgrunden (valfritt): spår utan egen text och utan försök, högst 300 per omgång */
async function lyricsLibrary(libId) {
  const todo = all(`SELECT t.* FROM tracks t LEFT JOIN track_lyrics l ON l.track_id=t.id WHERE t.library_id=? AND l.track_id IS NULL ORDER BY t.added DESC LIMIT 300`, libId);
  let errors = 0;
  for (const t of todo) {
    if (!lyricsBackground()) break;
    try {
      const local = await lyricsFor(t);
      if (local.synced) { run("INSERT OR IGNORE INTO track_lyrics(track_id,state,fetched,source) VALUES(?,2,?,'local')", t.id, now()); continue; }
      if (await onlineLyrics(t, { timeout: TIMEOUT })) status.lyrics++;
      errors = 0;
    } catch (e) { status.error = e.message; if (e.rateLimited || ++errors >= 3) break; }
  }
}
/** Hämta om allt (administrationen): matchade artister behåller sitt MBID, omatchade söks igen */
export function refetchAll() {
  run('UPDATE artist_meta SET fetched=0, tried=0, state=CASE WHEN state=2 AND locked=0 THEN 0 ELSE state END');
  run('DELETE FROM track_lyrics WHERE state=2');
  for (const l of all("SELECT id FROM libraries WHERE type='music'")) queue(l.id);
}

// ---------- inställningar och förlopp (administrationen) ----------
export function adminInfo() {
  const c = get(`SELECT COUNT(*) AS n, SUM(state=1) AS matched, SUM(state=2) AS none, SUM(image=1) AS images, SUM(bio IS NOT NULL) AS bios, SUM(locked=1) AS locked FROM artist_meta`);
  const total = get('SELECT COUNT(*) AS n FROM artists ar WHERE EXISTS (SELECT 1 FROM albums a WHERE a.artist_id=ar.id)').n;
  const ly = get('SELECT SUM(state=1) AS found, SUM(state=2 AND source IS NULL) AS none FROM track_lyrics');
  return { enabled: enabled(), lyricsOnline: lyricsOnline(), lyricsBackground: lyricsBackground(), contact: contact(), userAgent: userAgent(),
    fanartKeySet: !!fanartKey(), fanartFromEnv: !getSetting('fanart_api_key', '') && !!process.env.FANART_API_KEY, lastfm: !!lastfmKey(),
    artists: total, matched: c.matched || 0, unmatched: c.none || 0, images: c.images || 0, bios: c.bios || 0, locked: c.locked || 0,
    lyricsFound: ly.found || 0, lyricsMissing: ly.none || 0, status };
}
export function configure(b = {}) {
  if (b.enabled != null) setSetting('music_meta', b.enabled ? '1' : '0');
  if (b.lyricsOnline != null) setSetting('music_lyrics_online', b.lyricsOnline ? '1' : '0');
  if (b.lyricsBackground != null) setSetting('music_lyrics_bg', b.lyricsBackground ? '1' : '0');
  if (typeof b.contact === 'string') setSetting('music_meta_contact', validContact(b.contact));
  if (typeof b.fanartKey === 'string') {
    const k = b.fanartKey.trim();
    if (k && !/^[A-Za-z0-9]{16,64}$/.test(k)) throw Object.assign(new Error('Fanart.tv-nyckeln ska vara bokstäver och siffror'), { status: 400 });
    setSetting('fanart_api_key', k);
  }
  if (b.refetchAll) refetchAll();
  else if (b.enabled || b.lyricsBackground) for (const l of all("SELECT id FROM libraries WHERE type='music'")) queue(l.id);
  return adminInfo();
}

// ---------- signerade bildadresser (Subsonic-appar hämtar bilder utan inloggning) ----------
let imgKey = null;
const key = () => {
  if (imgKey) return imgKey;
  let k = getSetting('music_img_key', '');
  if (!/^[0-9a-f]{64}$/.test(k)) { k = crypto.randomBytes(32).toString('hex'); setSetting('music_img_key', k); }
  return (imgKey = Buffer.from(k, 'hex'));
};
const sigOf = (kind, id) => crypto.createHmac('sha256', key()).update(`${kind}:${+id}`).digest('hex').slice(0, 32);
/** Signaturen för en bild (artist eller album) – gäller bara just den bilden */
export const signImage = (kind, id) => sigOf(kind, id);
export function checkImageSig(kind, id, sig) {
  const want = Buffer.from(sigOf(kind, id)), got = Buffer.from(String(sig || ''));
  return got.length === want.length && crypto.timingSafeEqual(want, got);
}
