// E-böcker och serietidningar: bibliotek, bok, omslag, EPUB-innehåll, serietidningssidor, läsposition, bokmärken och
// markeringar, lösenordet för läsappar och OPDS-katalogen (/api/opds/*).
//
// Säkerhet:
//   - Varje route slår upp boken med ebooks.ebookFor (biblioteksbehörighet, barnprofiler bara i bibliotek med
//     "barnprofiler får se" och inom åldersgränsen) – annars 404 som för en okänd bok.
//   - EPUB-innehåll är fientligt. /res lämnar bara ut poster som finns i arkivet, med en typ ur en vitlista: XHTML som
//     text/plain (webbläsaren tolkar den aldrig som en sida – läsaren rensar och visar den i en sandlåde-iframe utan
//     skript, se web/js/reader/epub.js), CSS, typsnitt och bilder (typen ur byten, inte ur filnamnet). Alla svar har
//     CSP sandbox och default-src 'none', så att även en direkt öppnad post aldrig kör skript eller hämtar något.
//   - Nedladdning av filen (även via OPDS) kräver rätten att ladda ner; PDF visas i webbläsarens egen läsare.
//   - OPDS loggar in med Basic och lösenordet för läsappar (server/opds.js) – routealternativet opds i http/router.js.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { get, run } from '../db.js';
import { send, fail, readJson, clientIp, streamFile } from '../util.js';
import { audit, checkPw, ipBlocked, noteFail, verifyTotp } from '../auth.js';
import * as eb from '../ebooks.js';
import * as opds from '../opds.js';
import { openZip, safeName } from '../ebooks/zip.js';
import { imageType } from '../ebooks/formats.js';
import { sized } from '../imgsize.js';
import { parseQuery } from '../search.js';
import { route, user, img, opds as opdsRoute, isTrusted, remoteDenied, has2fa } from '../http/router.js';
import { ctx, householdRoot, canDownload } from '../http/context.js';

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const ebookLib = (c, id = c.p.lib) => {
  const l = get("SELECT * FROM libraries WHERE id=? AND type='ebook'", +id || 0);
  if (!eb.canSeeLib(c.user.id, l)) { fail(c.res, 404, 'Inget e-boksbibliotek'); return null; }
  return l;
};
const bookOf = (c, uid = c.user.id) => { const r = eb.ebookFor(uid, c.p.id); if (!r) fail(c.res, 404, 'Boken finns inte'); return r; };

// ---------- öppna arkiv (en serietidning läses sida för sida – centralkatalogen tolkas bara en gång) ----------
const zips = new Map(); // nyckel sökväg|storlek|tid → { z, at, users }
const ZIP_CACHE = 8, ZIP_IDLE = 60e3;
async function zipOf(r) {
  const key = `${r.path}|${r.size}|${r.mtime}`;
  let e = zips.get(key);
  if (!e) {
    for (const [k, v] of zips) if (k.startsWith(r.path + '|')) { zips.delete(k); v.p.then(z => z.close(), () => {}); } // filen har ändrats
    if (zips.size >= ZIP_CACHE) { const [k, v] = [...zips].sort((a, b) => a[1].at - b[1].at)[0]; zips.delete(k); v.p.then(z => z.close(), () => {}); }
    e = { p: openZip(r.path), at: Date.now() };
    zips.set(key, e);
    e.p.catch(() => zips.delete(key));
  }
  e.at = Date.now();
  return e.p;
}
setInterval(() => { for (const [k, v] of zips) if (Date.now() - v.at > ZIP_IDLE) { zips.delete(k); v.p.then(z => z.close(), () => {}); } }, 30e3).unref();

// Posternas svar: aldrig skript, aldrig externa resurser – även om någon öppnar adressen direkt
const RES_HEADERS = { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, max-age=86400' };
const FONT = { '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const DOC_EXT = new Set(['.xhtml', '.html', '.htm', '.xml', '.ncx', '.opf']);
/** Svarstypen för en post i en EPUB – null = lämnas inte ut */
function resType(name, mt, buf) {
  const e = path.extname(name).toLowerCase();
  const im = imageType(buf);
  if (im) return im;
  if (e === '.svg' || mt === 'image/svg+xml') return 'image/svg+xml'; // i <img> kör SVG aldrig skript; direkt öppnad: CSP sandbox
  if (e === '.css' || mt === 'text/css') return 'text/css; charset=utf-8';
  if (FONT[e]) return FONT[e];
  if (/^font\/|opentype|font-woff|truetype/.test(mt)) return 'application/octet-stream';
  if (DOC_EXT.has(e) || /xhtml|html|xml/.test(mt)) return 'text/plain; charset=utf-8';
  return null;
}

// ---------- bibliotek och böcker (webben) ----------
route('GET', '/api/ebooks/lib/:lib', user, (c) => {
  const l = ebookLib(c); if (!l) return;
  const sort = eb.SORTS.includes(c.q.get('sort')) ? c.q.get('sort') : 'title';
  const series = c.q.has('series') ? String(c.q.get('series')).slice(0, 200) : null;
  send(c.res, 200, { library: { id: l.id, name: l.name, kids: l.kids === 1 }, series: series == null ? eb.seriesOf(l, c.user.id) : [],
    continue: series == null ? eb.continueReading(c.user.id, 12, l.id) : [], books: eb.listBooks(l, c.user.id, { sort, series }) });
});
route('GET', '/api/ebooks/:id', user, (c) => {
  const r = bookOf(c); if (!r) return;
  send(c.res, 200, { ...eb.details(r, c.user.id), canDownload: canDownload(c.user.id) });
});
route('GET', '/api/ebooks/:id/cover', img, async (c) => {
  const r = bookOf(c); if (!r) return;
  const f = r.cover ? eb.coverPath(r.id) : null;
  if (!f) return fail(c.res, 404, 'Inget omslag');
  const out = await sized(f, c.q.get('w'));
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  pipeline(fs.createReadStream(out), c.res, () => {});
});
// En post i EPUB:en: ?p=sökväg i arkivet (som i manifestet)
route('GET', '/api/ebooks/:id/res', user, async (c) => {
  const r = bookOf(c); if (!r) return;
  if (r.format !== 'epub') return fail(c.res, 404, 'Finns inte');
  const name = safeName(c.q.get('p') || '');
  if (!name || name.endsWith('/')) return fail(c.res, 400, 'Ogiltig sökväg');
  const manifest = json(r.manifest, {});
  let z;
  try { z = await zipOf(r); } catch { return fail(c.res, 422, 'Boken går inte att läsa'); }
  if (!z.entries.has(name)) return fail(c.res, 404, 'Finns inte');
  let buf;
  try { buf = await z.read(name); } catch (e) { return fail(c.res, 422, `Delen av boken går inte att läsa (${e.message})`); }
  const type = resType(name, Object.hasOwn(manifest, name) ? manifest[name] : '', buf);
  if (!type) return fail(c.res, 415, 'Den här delen av boken visas inte');
  send(c.res, 200, buf, { ...RES_HEADERS, 'Content-Type': type });
});
// Serietidningens sida n (0 = första)
async function comicPage(c, r) {
  if (r.format !== 'cbz') return fail(c.res, 404, 'Finns inte');
  const pages = json(r.page_names, []);
  const n = /^\d{1,5}$/.test(c.p.n) ? +c.p.n : -1;
  if (n < 0 || n >= pages.length) return fail(c.res, 404, 'Sidan finns inte');
  let buf;
  try { buf = await (await zipOf(r)).read(pages[n]); } catch { return fail(c.res, 422, 'Sidan går inte att läsa'); }
  const type = imageType(buf);
  if (!type) return fail(c.res, 415, 'Sidan är ingen bild som kan visas');
  send(c.res, 200, buf, { ...RES_HEADERS, 'Content-Type': type, ETag: 'auto' });
}
route('GET', '/api/ebooks/:id/page/:n', user, async (c) => { const r = bookOf(c); if (r) await comicPage(c, r); });
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
function sendFile(c, r, inline) {
  let st; try { st = fs.statSync(r.path); } catch { return fail(c.res, 404, 'Filen finns inte längre'); }
  const name = path.basename(r.path);
  streamFile(c.req, c.res, r.path, st.size, { 'Content-Type': opds.MIME[r.format] || 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'private, no-store' });
}
// Originalfilen som nedladdning – kräver rätten att ladda ner
route('GET', '/api/ebooks/:id/file', user, (c) => {
  const r = bookOf(c); if (!r) return;
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  sendFile(c, r, false);
});
// PDF i webbläsarens egen läsare (öppnas i en ny flik)
route('GET', '/api/ebooks/:id/pdf', user, (c) => {
  const r = bookOf(c); if (!r) return;
  if (r.format !== 'pdf') return fail(c.res, 404, 'Finns inte');
  sendFile(c, r, true);
});
route('POST', '/api/ebooks/:id/progress', user, async (c) => {
  const r = bookOf(c); if (!r) return;
  const b = await readJson(c.req);
  send(c.res, 200, eb.saveProgress(c.user.id, r.id, { locator: b.locator, percent: b.percent, finished: b.finished, at: b.at }));
});
// Börja om / markera som oläst
route('DELETE', '/api/ebooks/:id/progress', user, (c) => { const r = bookOf(c); if (!r) return; eb.resetProgress(c.user.id, r.id); send(c.res, 200, { ok: true }); });
route('POST', '/api/ebooks/:id/marks', user, async (c) => {
  const r = bookOf(c); if (!r) return;
  const m = eb.addMark(c.user.id, r.id, await readJson(c.req));
  send(c.res, 200, { ...m, locator: json(m.locator, null) });
});
route('PUT', '/api/ebooks/marks/:mid', user, async (c) => {
  const m = eb.updateMark(c.user.id, c.p.mid, await readJson(c.req));
  if (!m) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, { ...m, locator: json(m.locator, null) });
});
route('DELETE', '/api/ebooks/marks/:mid', user, (c) => send(c.res, 200, { ok: eb.deleteMark(c.user.id, c.p.mid) }));

// ---------- lösenord för läsappar (Mitt konto) ----------
const accountInfo = (c) => ({ password: opds.info(c.user.id), user: c.user.name, path: '/api/opds', libraries: eb.ebookLibs(c.user.id).length,
  atHome: isTrusted(c.req), profile: !!c.user.parent_id });
route('GET', '/api/me/opds', user, (c) => send(c.res, 200, accountInfo(c)));
// Kräver kontots lösenord (huvudkontots för profiler); utanför hemmet dessutom en kod från autentiseringsappen –
// lösenordet ger långvarig åtkomst utan tvåstegsverifiering (som musikappens lösenord)
route('POST', '/api/me/opds', user, async (c) => {
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, 'För många försök – vänta en stund');
  const { password, code } = await readJson(c.req);
  const root = get('SELECT id, name, pass, totp_enabled, totp_secret, totp_last FROM users WHERE id=?', householdRoot(c.user));
  if (!root || !await checkPw(String(password || ''), root.pass)) { noteFail(ip, root?.name); return fail(c.res, 400, 'Fel lösenord'); }
  const trusted = isTrusted(c.req);
  if (!trusted) {
    if (!root.totp_enabled) return fail(c.res, 403, 'Utanför hemmet kan lösenord för läsappar bara skapas om kontot har tvåstegsverifiering med autentiseringsapp. Skapa det hemifrån.');
    const step = verifyTotp(root.totp_secret, code, root.totp_last);
    if (step < 0) { noteFail(ip, root.name); return send(c.res, 401, { error: code ? 'Fel kod' : 'Ange koden från din autentiseringsapp', need2fa: true }); }
    run('UPDATE users SET totp_last=? WHERE id=?', step, root.id);
  }
  const secret = opds.createPassword(c.user.id, { ip, trusted });
  audit('opds_password_created', { ...ctx(c), detail: trusted ? 'hemifrån' : 'utifrån med tvåstegskod' });
  // Lösenordet visas bara i det här svaret
  send(c.res, 200, { ...accountInfo(c), secret, has2fa: has2fa(c.user) });
});
route('DELETE', '/api/me/opds', user, (c) => {
  if (opds.revokePassword(c.user.id)) audit('opds_password_revoked', ctx(c));
  send(c.res, 200, accountInfo(c));
});

// ---------- OPDS (läsappar) ----------
const BASE = '/api/opds';
const PER_PAGE = 50;
const atom = (c, kind, body) => send(c.res, 200, body, { 'Content-Type': `${kind}; charset=utf-8` });
/** Inloggad profil eller null (svaret är då skickat: 401 med Basic-utmaning, 403 eller 429) */
function opdsLogin(c) {
  const ip = clientIp(c.req);
  try {
    const u = opds.authenticate(c.req.headers.authorization, { ip, trusted: isTrusted(c.req), client: c.req.headers['user-agent'] });
    const why = remoteDenied(u, c.req, true);
    if (why) { audit('opds_denied', { ip, user: u, detail: why }); fail(c.res, 403, why + (why.includes('Tvåsteg') ? ' – aktivera den under Mitt konto' : '')); return null; }
    return u;
  } catch (e) {
    if (e.status === 401 && c.req.headers.authorization) audit('opds_login_fail', { ip, detail: String(c.req.headers['user-agent'] || 'okänd app').slice(0, 80) });
    if (e.status === 401) c.res.setHeader('WWW-Authenticate', 'Basic realm="BraXhn TV", charset="UTF-8"');
    fail(c.res, e.status || 401, e.message);
    return null;
  }
}
const o = (fn) => async (c) => { const u = opdsLogin(c); if (u) { c.user = u; await fn(c, u); } };
const startLinks = (self, kind = opds.NAV) => [{ rel: 'self', href: self, type: kind }, { rel: 'start', href: BASE, type: opds.NAV },
  { rel: 'search', href: `${BASE}/opensearch.xml`, type: 'application/opensearchdescription+xml' }];
const books = (list, u) => list.map(b => opds.bookEntry(b, { base: BASE, download: canDownload(u.id) }));

route('GET', '/api/opds', opdsRoute, o((c, u) => {
  const libsList = eb.ebookLibs(u.id);
  const entries = [opds.navEntry({ id: 'urn:braxhn:opds:continue', title: 'Fortsätt läsa', href: `${BASE}/continue`, kind: opds.ACQ }),
    opds.navEntry({ id: 'urn:braxhn:opds:recent', title: 'Senast tillagda', href: `${BASE}/recent`, kind: opds.ACQ })];
  for (const l of libsList) {
    entries.push(opds.navEntry({ id: `urn:braxhn:opds:lib:${l.id}`, title: l.name, content: 'Alla böcker', href: `${BASE}/lib/${l.id}`, kind: opds.ACQ }));
    entries.push(opds.navEntry({ id: `urn:braxhn:opds:series:${l.id}`, title: `${l.name} – serier`, href: `${BASE}/lib/${l.id}/series` }));
  }
  atom(c, opds.NAV, opds.feed({ id: 'urn:braxhn:opds', title: 'BraXhn TV', links: startLinks(BASE), entries }));
}));
route('GET', '/api/opds/opensearch.xml', opdsRoute, o((c) => send(c.res, 200, opds.OPENSEARCH(BASE), { 'Content-Type': 'application/opensearchdescription+xml; charset=utf-8' })));
route('GET', '/api/opds/continue', opdsRoute, o((c, u) => atom(c, opds.ACQ, opds.feed({ id: 'urn:braxhn:opds:continue', title: 'Fortsätt läsa',
  links: startLinks(`${BASE}/continue`, opds.ACQ), entries: books(eb.continueReading(u.id, 50), u) }))));
route('GET', '/api/opds/recent', opdsRoute, o((c, u) => atom(c, opds.ACQ, opds.feed({ id: 'urn:braxhn:opds:recent', title: 'Senast tillagda',
  links: startLinks(`${BASE}/recent`, opds.ACQ), entries: books(eb.recentBooks(u.id, 50), u) }))));
route('GET', '/api/opds/search', opdsRoute, o((c, u) => {
  const q = String(c.q.get('q') || '').slice(0, 200);
  atom(c, opds.ACQ, opds.feed({ id: 'urn:braxhn:opds:search', title: `Sök: ${q}`, links: startLinks(`${BASE}/search?q=${encodeURIComponent(q)}`, opds.ACQ),
    entries: books(eb.searchEbooks(parseQuery(q), u.id, 50), u) }));
}));
/** Sidindelat flöde (50 per sida) med next/previous */
function paged(c, u, l, series) {
  const total = eb.countBooks(l, u.id, series);
  const page = Math.max(1, Math.min(10000, parseInt(c.q.get('page')) || 1));
  const self = series == null ? `${BASE}/lib/${l.id}` : `${BASE}/lib/${l.id}/series/${encodeURIComponent(series)}`;
  const links = startLinks(page > 1 ? `${self}?page=${page}` : self, opds.ACQ);
  if (page * PER_PAGE < total) links.push({ rel: 'next', href: `${self}?page=${page + 1}`, type: opds.ACQ });
  if (page > 1) links.push({ rel: 'previous', href: `${self}?page=${page - 1}`, type: opds.ACQ });
  const list = eb.listBooks(l, u.id, { sort: series == null ? 'title' : 'series', series, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
  atom(c, opds.ACQ, opds.feed({ id: `urn:braxhn:opds:lib:${l.id}${series != null ? ':' + series : ''}:${page}`, title: series ?? l.name, links,
    entries: books(list, u), total, start: (page - 1) * PER_PAGE + 1, perPage: PER_PAGE }));
}
route('GET', '/api/opds/lib/:lib', opdsRoute, o((c, u) => { const l = ebookLib(c); if (l) paged(c, u, l, null); }));
route('GET', '/api/opds/lib/:lib/series', opdsRoute, o((c, u) => {
  const l = ebookLib(c); if (!l) return;
  const entries = eb.seriesOf(l, u.id).map(s => opds.navEntry({ id: `urn:braxhn:opds:series:${l.id}:${s.name}`, title: s.name,
    content: s.count === 1 ? '1 bok' : `${s.count} böcker`, href: `${BASE}/lib/${l.id}/series/${encodeURIComponent(s.name)}`, kind: opds.ACQ }));
  atom(c, opds.NAV, opds.feed({ id: `urn:braxhn:opds:series:${l.id}`, title: `${l.name} – serier`, links: startLinks(`${BASE}/lib/${l.id}/series`), entries }));
}));
route('GET', '/api/opds/lib/:lib/series/:name', opdsRoute, o((c, u) => { const l = ebookLib(c); if (l) paged(c, u, l, String(c.p.name).slice(0, 200)); }));
route('GET', '/api/opds/book/:id/cover', opdsRoute, o(async (c) => {
  const r = bookOf(c); if (!r) return;
  const f = r.cover ? eb.coverPath(r.id) : null;
  if (!f) return fail(c.res, 404, 'Inget omslag');
  const out = await sized(f, c.q.get('w'));
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  pipeline(fs.createReadStream(out), c.res, () => {});
}));
route('GET', '/api/opds/book/:id/file', opdsRoute, o((c, u) => {
  const r = bookOf(c); if (!r) return;
  if (!canDownload(u.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  sendFile(c, r, false);
}));
// Sidströmning (OPDS-PSE): serietidningar sida för sida utan att hela filen laddas ner
route('GET', '/api/opds/book/:id/page/:n', opdsRoute, o(async (c) => { const r = bookOf(c); if (r) await comicPage(c, r); }));
