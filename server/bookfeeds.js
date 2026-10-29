// Privata RSS-flöden för ljudböcker (som Audiobookshelf): en bok eller en hel serie som podd, så att den kan lyssnas i
// vilken poddapp som helst. Varje flöde hör till en profil och har en egen nyckel i adressen (/api/feeds/<nyckel>/…):
// bara SHA-256 av nyckeln sparas (tabellen book_feeds), adressen visas bara när flödet skapas och flödet återkallas
// genom att raden tas bort. Nyckeln gäller bara /api/feeds/* (routealternativet feed i http/router.js) – den är ingen
// inloggning mot något annat API.
//
// Flödet: RSS 2.0 med iTunes- och Podcasting 2.0-taggar. En bok i en fil = ett avsnitt; en bok i flera filer = ett
// avsnitt per fil. Kapitel som Podcasting 2.0 chapters JSON (<podcast:chapters>), relativt avsnittets fil.
// Ljudet lämnas ut som filen den är (Range, ingen omkodning) – poddappar laddar ner och spolar själva.
//
// Vem: inte barnprofiler, inte profiler med skärmtid (poddappen räknas inte) och bara konton som får ladda ner. Det
// kontrolleras både när flödet skapas och vid varje hämtning – ändras rättigheterna slutar flödet fungera.
import { createHash, randomBytes } from 'node:crypto';
import { get, all, run, now, getSetting } from './db.js';
import * as books from './audiobooks.js';
import { canDownload, libOk } from './perms.js';
import * as screen from './screentime.js';
import { isHttps, isPrivate } from './util.js';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
export const MAX_FEEDS = 100;

/** Varför profilen inte får ha RSS-flöden (null = får) */
export function feedDenied(uid) {
  const u = get('SELECT id, max_age FROM users WHERE id=?', uid);
  if (!u) return 'Kontot finns inte';
  if (u.max_age != null) return 'Barnprofiler kan inte ha RSS-flöden';
  if (!canDownload(uid)) return 'Ditt konto får inte ladda ner – RSS-flöden laddar ner boken till poddappen';
  if (screen.rulesFor(uid)) return 'Profiler med skärmtid kan inte ha RSS-flöden (lyssning i poddappar räknas inte)';
  return null;
}
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Nytt flöde för en bok ({ book }) eller en serie ({ library, series }). Returnerar { id, token } – nyckeln visas bara nu. */
export function createFeed(uid, b = {}) {
  const why = feedDenied(uid); if (why) throw err(why, 403);
  if (get('SELECT COUNT(*) AS n FROM book_feeds WHERE user_id=?', uid).n >= MAX_FEEDS) throw err('För många RSS-flöden – återkalla några först');
  const token = randomBytes(24).toString('hex');
  let r;
  if (b.book != null) {
    const bk = get('SELECT id, library_id FROM books WHERE id=?', +b.book);
    if (!bk || !libOk(uid, bk.library_id)) throw err('Finns inte', 404);
    r = run("INSERT INTO book_feeds(user_id,token,kind,book_id,library_id,created) VALUES(?,?,'book',?,?,?)", uid, sha(token), bk.id, bk.library_id, now());
  } else {
    const lib = get("SELECT id FROM libraries WHERE id=? AND type='audiobook'", +b.library);
    const series = String(b.series || '').trim().slice(0, 200);
    if (!lib || !libOk(uid, lib.id)) throw err('Inget ljudboksbibliotek', 404);
    if (!series || !seriesBooks(uid, lib.id, series).length) throw err('Serien finns inte', 404);
    r = run("INSERT INTO book_feeds(user_id,token,kind,library_id,series,created) VALUES(?,?,'series',?,?,?)", uid, sha(token), lib.id, series, now());
  }
  return { id: Number(r.lastInsertRowid), token };
}
/** Profilens flöden (filtrerat på bok eller serie) – utan nyckel */
export function listFeeds(uid, { book = null, library = null, series = null } = {}) {
  return all(`SELECT f.id, f.kind, f.book_id, f.library_id, f.series, f.created, f.last_used, b.title FROM book_feeds f LEFT JOIN books b ON b.id=f.book_id
    WHERE f.user_id=? ORDER BY f.created DESC`, uid)
    .filter(f => (book == null || f.book_id === +book) && (series == null || (f.kind === 'series' && f.library_id === +library && f.series.toLowerCase() === String(series).toLowerCase())))
    .map(f => ({ id: f.id, kind: f.kind, book: f.book_id, library: f.library_id, title: f.kind === 'book' ? f.title : f.series, created: f.created, lastUsed: f.last_used }));
}
export const revokeFeed = (uid, id) => run('DELETE FROM book_feeds WHERE id=? AND user_id=?', +id, uid).changes > 0;

/** Flödet bakom nyckeln i adressen, med profilen. null om nyckeln är fel, återkallad eller profilen inte längre får. */
export function resolve(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  const h = sha(token);
  const f = get('SELECT * FROM book_feeds WHERE token=?', h);
  if (!f) return null;
  const u = get('SELECT id, name, remote_allowed, totp_enabled, parent_id, max_age FROM users WHERE id=?', f.user_id);
  if (!u || feedDenied(u.id)) return null;
  if (now() - (f.last_used || 0) > 3600) run('UPDATE book_feeds SET last_used=? WHERE id=?', now(), f.id);
  return { feed: f, user: { ...u, is_admin: 0, kind: 'feed' } };
}

function seriesBooks(uid, libId, series) {
  return books.listBooks(libId, uid, 'series').filter(b => (b.series || '').toLowerCase() === series.toLowerCase());
}
/** Böckerna i flödet (med filer och kapitel), i lyssningsordning */
export function feedBooks(f, uid) {
  const ids = f.kind === 'book' ? [f.book_id] : seriesBooks(uid, f.library_id, f.series).map(b => b.id);
  return ids.map(id => books.book(id, uid)).filter(Boolean);
}
/** Filen (book_files) om den hör till flödets böcker, annars null */
export function feedFile(f, uid, fid) {
  const r = books.fileRow(+fid);
  if (!r || !libOk(uid, r.library_id)) return null;
  if (f.kind === 'book' ? r.book_id !== f.book_id : !feedBooks(f, uid).some(b => b.id === r.book_id)) return null;
  return r;
}
export const feedHasBook = (f, uid, bid) => f.kind === 'book' ? f.book_id === +bid : feedBooks(f, uid).some(b => b.id === +bid);

/** Kapitlen inom en fil, relativt filens början (Podcasting 2.0 chapters JSON) */
export function chaptersJson(b, file) {
  const from = file.offset || 0, to = from + (file.duration || 0);
  const list = (b.chapters || []).filter(c => b.files.length === 1 || (c.start < to - 0.5 && (c.end ?? to) > from + 0.5));
  return { version: '1.2.0', chapters: list.map(c => ({ startTime: +Math.max(0, c.start - from).toFixed(3), ...(c.end != null ? { endTime: +Math.max(0, Math.min(c.end, to) - from).toFixed(3) } : {}), title: c.title })) };
}

// ---------- RSS ----------
const x = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EXT_MIME = { '.m4b': 'audio/x-m4b', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
export const mimeOf = (p) => EXT_MIME[(String(p).match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase()] || 'application/octet-stream';
const extOf = (p) => (String(p).match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'mp3').toLowerCase();
const dur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** Serverns adress utifrån: inställningen public_url, annars förfrågans värd (bakom omvänd proxy: X-Forwarded-*) */
export function originOf(req) {
  const pub = String(getSetting('public_url', process.env.PUBLIC_URL || '') || '').replace(/\/+$/, '');
  if (/^https?:\/\/[^/\s]+$/i.test(pub)) return pub;
  const host = (isPrivate(req.socket.remoteAddress) && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()) || req.headers.host || 'localhost';
  return `${isHttps(req) ? 'https' : 'http'}://${String(host).replace(/[^\w.:[\]-]/g, '')}`;
}

/** Hela flödet som XML. token = nyckeln från adressen (behövs i länkarna till ljud, kapitel och omslag). */
export function feedXml(f, uid, token, origin) {
  const list = feedBooks(f, uid);
  const base = `${origin}/api/feeds/${token}`;
  const first = list[0];
  const title = f.kind === 'book' ? first?.title || 'Ljudbok' : f.series;
  const author = [...new Set(list.map(b => b.author).filter(Boolean))].join(', ');
  const cover = list.find(b => b.cover);
  const t0 = Math.min(...list.map(b => get('SELECT added FROM books WHERE id=?', b.id)?.added || now()), now()); // stabil ordning: avsnitten får stigande tider
  const lang = first?.language || 'sv';
  const items = [];
  let n = 0;
  list.forEach((b, bi) => {
    b.files.forEach((file, fi) => {
      n++;
      const fr = books.fileRow(file.id) || {};
      const one = b.files.length === 1;
      const name = one ? b.title : `${b.title} – ${file.title || `del ${fi + 1}`}`;
      const at = new Date((t0 + n * 3600) * 1000).toUTCString();
      items.push(`<item><title>${x(f.kind === 'series' && b.seriesNo ? `#${b.seriesNo} ${name}` : name)}</title>
<guid isPermaLink="false">braxhn-bok-${b.id}-del-${file.idx}</guid><pubDate>${at}</pubDate>
<description>${x(fi === 0 ? b.description || '' : '')}</description><itunes:author>${x(b.author || '')}</itunes:author>
<itunes:duration>${dur(file.duration)}</itunes:duration><itunes:episode>${n}</itunes:episode><itunes:episodeType>full</itunes:episodeType>${f.kind === 'series' ? `<itunes:season>${bi + 1}</itunes:season>` : ''}
${b.cover ? `<itunes:image href="${x(`${base}/cover/${b.id}.jpg`)}"/>` : ''}<enclosure url="${x(`${base}/audio/${file.id}.${extOf(fr.path)}`)}" length="${+fr.size || 0}" type="${mimeOf(fr.path)}"/>
${b.chapters?.length > 1 ? `<podcast:chapters url="${x(`${base}/chapters/${file.id}.json`)}" type="application/json+chapters"/>` : ''}</item>`);
    });
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>${x(title)}</title><link>${x(origin)}/</link><atom:link href="${x(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>
<description>${x((f.kind === 'book' ? first?.description : `${list.length} ${list.length === 1 ? 'bok' : 'böcker'} i serien`) || title)}</description><language>${x(lang)}</language>
<generator>BraXhn TV</generator><itunes:author>${x(author)}</itunes:author><itunes:type>serial</itunes:type><itunes:block>Yes</itunes:block>
<itunes:explicit>false</itunes:explicit><podcast:locked>yes</podcast:locked>
${cover ? `<itunes:image href="${x(`${base}/cover/${cover.id}.jpg`)}"/><image><url>${x(`${base}/cover/${cover.id}.jpg`)}</url><title>${x(title)}</title><link>${x(origin)}/</link></image>` : ''}
${items.join('\n')}
</channel></rss>
`;
}
