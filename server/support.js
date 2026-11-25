// Feedback och felrapporter: alla inloggade kan skicka ett ärende från webben (knappen Feedback). Inget lämnar
// servern av sig självt: en vanlig användares ärende får status pending och syns för teamet (utvecklarna, via
// /api/v1/support och en API-nyckel med behörigheten support) först när en administratör har granskat och godkänt det.
// Administratörens egna ärenden är godkända direkt. Teamet ser aldrig namn – bara "admin" eller "användare".
//
// Flödet: pending → (administratören) approved | rejected → (teamet) working | needinfo | fixed.
// needinfo: den som rapporterade (eller en administratör) svarar i ärendet. Svaret från en vanlig användare är
// pending tills administratören godkänt det – först då syns det i API:t och ärendet går tillbaka till approved.
// fixed | rejected → (administratören öppnar igen) approved (syns för teamet igen) eller pending (granskas på nytt).
// Det som väntar på granskning ger administratören en notis (händelsen support i notify.js) – utan text och namn.
// Avslutade ärenden gallras efter supportDays() i privacy.js.
//
// Tabellen support_tickets skapas i db.js. Rutterna: server/routes/support.js. Webben: web/js/feedback.js (knappen),
// web/js/views/support.js (dialogen och Mina ärenden) och web/js/views/admin-support.js (granskningen).
import { all, get, run, now, getSetting } from './db.js';
import { clean } from './util.js';
import { maskSupport } from './supportpack.js';
import { VERSION } from './updates.js';
import { notify, enabled as notifyOn } from './notify.js';

/** Typ av ärende */
export const KINDS = ['bug', 'idea']; // fel eller förslag/synpunkt
/** Vad ärendet gäller (namnen visas i webben och skickas till teamet) */
export const AREAS = {
  film: 'Film och serier', musik: 'Musik', ljud: 'Ljudböcker och poddar', livetv: 'Live-TV',
  uppspelning: 'Uppspelning', appen: 'Appen i allmänhet', annat: 'Annat'
};
/** Status som teamet ser (godkända ärenden som inte är avslutade) och får sätta */
export const OPEN = ['approved', 'working', 'needinfo'];
export const TEAM_STATUS = ['working', 'needinfo', 'fixed'];

export const MAX_TITLE = 120;
export const MAX_TEXT = 4000;
export const MAX_REPLY = 4000;
export const MAX_VERSION = 30;
export const MAX_CONTEXT = 6000;   // tecken JSON
export const MAX_THREAD = 40;      // inlägg per ärende
export const MAX_PER_HOUR = 5;     // nya ärenden per användare och timme (administratörer: ingen gräns)
export const MAX_REPLIES_HOUR = 10;
export const MAX_ERRORS = 5;

const err = (status, message) => Object.assign(new Error(message), { status });
/** Fri text: radbrytningar behålls, övriga kontrolltecken tas bort */
const body = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ').trim();
/** Text med längdgräns – för lång text nekas (kapas aldrig tyst) */
function limited(v, max, msg) {
  const s = body(v);
  if (s.length > max) throw err(400, msg);
  return s;
}
const line = (v, max, msg) => limited(v, max, msg).replace(/\n+/g, ' ');
const LONG = { text: 'Meddelandet är för långt (högst 4000 tecken)', title: 'Rubriken är för lång (högst 120 tecken)', reply: 'Svaret är för långt (högst 4000 tecken)',
  note: 'Förklaringen är för lång (högst 4000 tecken)', version: 'Versionen är för lång (högst 30 tecken)' };
const json = (s, def) => { try { const v = JSON.parse(s); return v ?? def; } catch { return def; } };
/** Teknisk text (sida, webbläsare, fel): token, nycklar, e-post och IP-adresser maskeras alltid */
const tech = (v, max) => maskSupport(clean(v, max * 2), { names: true }).slice(0, max);
const num = (v, max = 1e7) => Number.isFinite(+v) && +v >= 0 ? Math.min(max, Math.round(+v)) : null;

/** Titeln man står på: namn och filformat – bara om profilen får se den (allowed = allowedFor för användaren) */
function titleInfo(id, allowed) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const it = get('SELECT id, library_id, kind, title, year, season, episode, parent_id, version_of, age, container, vcodec, acodec, height FROM items WHERE id=?', id);
  if (!it || !allowed(it)) return null;
  const show = it.kind === 'episode' && it.parent_id ? get('SELECT title FROM items WHERE id=?', it.parent_id)?.title : null;
  const o = { id: it.id, kind: it.kind, name: clean(show ? `${show} S${String(it.season ?? 0).padStart(2, '0')}E${String(it.episode ?? 0).padStart(2, '0')}` : it.title, 160) };
  if (it.year) o.year = it.year;
  const fmt = [it.container, it.vcodec, it.acodec, it.height ? it.height + 'p' : ''].filter(Boolean).join(' / ');
  if (fmt) o.format = clean(fmt, 80);
  return o;
}

/** Senaste uppspelningen (film/serier) det senaste dygnet, ur tittarhistoriken – utan enhet och IP-adress */
function lastPlayback(uid, allowed, at) {
  const p = get(`SELECT item_id, ts, ended, mode, quality, remote, pos_end, duration FROM plays WHERE user_id=? AND COALESCE(ended, ts) > ?
    ORDER BY COALESCE(ended, ts) DESC LIMIT 1`, uid, at - 86400);
  if (!p) return null;
  const t = titleInfo(Number(p.item_id), allowed);
  if (!t) return null;
  const o = { item: t.id, name: t.name, minutesAgo: Math.max(0, Math.round((at - (p.ended || p.ts)) / 60)) };
  if (t.format) o.format = t.format;
  if (p.mode) o.mode = clean(p.mode, 20);
  if (p.quality) o.quality = clean(p.quality, 20);
  if (p.pos_end != null) o.position = num(p.pos_end);
  if (p.duration) o.duration = num(p.duration);
  o.remote = !!p.remote;
  return o;
}

/**
 * Den tekniska informationen som bifogas ett ärende: det webben skickar (sida, webbläsare, skärm, språk, titel-id, fel
 * på sidan) rensat och begränsat, plus det servern själv vet (version, titelns namn och format, senaste uppspelningen
 * för felrapporter). Aldrig IP-adresser, namn eller token. Samma funktion ger förhandsvisningen i dialogen.
 */
export function buildContext(user, input, kind, allowed, at = now()) {
  const c = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const o = { version: VERSION };
  // Sidan: hash-rutten utan frågedel (filter och koder hör inte hit)
  const route = tech(String(c.route ?? '').split('?')[0], 200);
  if (route) o.page = route;
  // Webbläsarens egen beskrivning: versionsnummer (Chrome/126.0.0.0) ska vara kvar, så IP-adresser tas bort med en
  // egen regel (fyra tal som inte står efter ett snedstreck) i stället för maskSupport
  const ua = clean(c.ua, 300).replace(/(?<![\/\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, '<ip>').replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>').trim();
  if (ua) o.browser = ua;
  if (/^\d{2,5}×\d{2,5}( @[\d.]{1,4})?$/.test(String(c.screen ?? ''))) o.screen = String(c.screen);
  if (/^(sv|en)$/.test(String(c.lang ?? ''))) o.lang = c.lang;
  if (c.app === true) o.installed = true;
  const t = titleInfo(parseInt(c.itemId), allowed);
  if (t) o.title = t;
  if (kind === 'bug') {
    const p = lastPlayback(user.id, allowed, at);
    if (p) o.lastPlayback = p;
    const errors = (Array.isArray(c.errors) ? c.errors : []).slice(-MAX_ERRORS).map(e => tech(e, 300)).filter(Boolean);
    if (errors.length) o.pageErrors = errors;
  }
  // Över gränsen: felen först, sedan uppspelningen – resten är alltid litet
  if (JSON.stringify(o).length > MAX_CONTEXT) delete o.pageErrors;
  if (JSON.stringify(o).length > MAX_CONTEXT) delete o.lastPlayback;
  return o;
}

const row = (id) => /^\d{1,12}$/.test(String(id)) ? get('SELECT * FROM support_tickets WHERE id=?', +id) : null;
const threadOf = (r) => { const t = json(r.thread, []); return Array.isArray(t) ? t : []; };
const save = (r, thread, extra = {}) => {
  const f = { thread: JSON.stringify(thread), updated: now(), ...extra };
  run(`UPDATE support_tickets SET ${Object.keys(f).map(k => `${k}=?`).join(', ')} WHERE id=?`, ...Object.values(f), r.id);
  return row(r.id);
};
const hasPendingReply = (r) => threadOf(r).some(m => m.pending);

/** Ärendet som den som rapporterade ser det */
export function forOwner(r) {
  return {
    id: r.id, kind: r.kind, area: r.area, title: r.title || null, text: r.text,
    // Administratören ändrade texten före godkännandet: det här är vad som skickades
    sentTitle: r.out_title != null && r.out_title !== (r.title || '') ? r.out_title : null,
    sentText: r.out_text != null && r.out_text !== r.text ? r.out_text : null,
    context: json(r.context, null), status: r.status, version: r.version || null, created: r.created, updated: r.updated,
    thread: threadOf(r).map(m => ({ from: m.from, text: m.text, created: m.ts, status: m.status || null, version: m.version || null, pending: !!m.pending })),
    canReply: r.status === 'needinfo' && !hasPendingReply(r)
  };
}
/** Ärendet som administratören ser det: även vem som skickade och exakt det som lämnar servern (outgoing) */
export function forAdmin(r) {
  const u = get('SELECT name FROM users WHERE id=?', r.user_id);
  return { ...forOwner(r), user: u?.name || null, byAdmin: !!r.by_admin, pendingReply: hasPendingReply(r), reviewed: r.reviewed || null,
    outgoing: forTeam(r, { preview: true }) };
}
/**
 * Ärendet som teamet ser det (/api/v1/support): inga namn, bara avsändartyp. Väntande svar tas aldrig med, och inte
 * administratörens lokala anteckningar. preview = administratörens förhandsvisning av ett ärende som inte är godkänt än.
 */
export function forTeam(r, { preview = false } = {}) {
  return {
    id: r.id, kind: r.kind, area: AREAS[r.area] || AREAS.annat, title: (r.out_title ?? r.title) || null, text: r.out_text ?? r.text,
    context: json(r.context, null), from: r.by_admin ? 'admin' : 'användare', created: r.created, updated: r.updated,
    status: preview && !OPEN.includes(r.status) && r.status !== 'fixed' ? 'approved' : r.status, version: r.version || null,
    thread: threadOf(r).filter(m => !m.pending && !m.local).map(m => ({ from: m.from === 'team' ? 'team' : m.from === 'admin' ? 'admin' : 'användare', text: m.text, created: m.ts,
      ...(m.status ? { status: m.status } : {}), ...(m.version ? { version: m.version } : {}) }))
  };
}

/** Nytt ärende. user = den inloggade (id, is_admin), allowed = (titel) => får profilen se den */
export function create(user, b, allowed) {
  const kind = KINDS.includes(b.kind) ? b.kind : 'bug';
  const area = Object.hasOwn(AREAS, String(b.area)) ? String(b.area) : 'annat';
  const text = limited(b.text, MAX_TEXT, LONG.text);
  if (!text) throw err(400, 'Skriv ett meddelande');
  const title = line(b.title, MAX_TITLE, LONG.title) || null;
  const admin = !!user.is_admin;
  if (!admin && get('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id=? AND created > ?', user.id, now() - 3600).n >= MAX_PER_HOUR)
    throw err(429, 'Du har skickat flera ärenden den senaste timmen – vänta en stund innan du skickar fler');
  const context = b.tech === false ? null : JSON.stringify(buildContext(user, b.context, kind, allowed));
  const t = now();
  const id = Number(run(`INSERT INTO support_tickets(user_id,by_admin,kind,area,title,text,context,status,created,updated,reviewed) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, admin ? 1 : 0, kind, area, title, text, context, admin ? 'approved' : 'pending', t, t, admin ? t : null).lastInsertRowid);
  if (!admin) noticeReview();
  return row(id);
}

/** Användarens egna ärenden, nyast först */
export const mine = (uid) => all('SELECT * FROM support_tickets WHERE user_id=? ORDER BY created DESC LIMIT 200', uid);
/** Ett eget ärende – någon annans finns inte (null) */
export const ownTicket = (uid, id) => { const r = row(id); return r && r.user_id === uid ? r : null; };
export const ticket = row;

/** Siffran vid knappen: egna ärenden där teamet väntar på svar och (administratörer) det som väntar på granskning */
export function counts(user) {
  const o = { needinfo: mine(user.id).filter(r => r.status === 'needinfo' && !hasPendingReply(r)).length };
  if (user.is_admin) o.review = reviewCount();
  return o;
}
export const reviewCount = () => { const c = reviewCounts(); return c.tickets + c.replies; };
/** Det som väntar på granskning: nya ärenden och svar från användare */
export const reviewCounts = () => ({ tickets: get("SELECT COUNT(*) AS n FROM support_tickets WHERE status='pending'").n,
  replies: all("SELECT thread FROM support_tickets WHERE status<>'pending' AND thread LIKE '%pending%'").filter(hasPendingReply).length });

// ---------- notis till administratören ----------
// Notistjänsten (ntfy, Pushover, Discord …) ligger oftast utanför servern, så notisen säger bara hur mycket som väntar
// och var det finns – aldrig ärendets text, rubrik, nummer eller vem som skrev. Högst en notis per NOTICE_GAP: det som
// kommer in under tiden samlas i en notis när tiden gått (om något fortfarande väntar då).
export const NOTICE_GAP = 3600; // sekunder
export const _notice = { last: 0, timer: null }; // exporteras för testerna
/** Notisens text. url = serverns adress utifrån (public_url) eller tom */
export function noticeText({ tickets, replies }, url) {
  const parts = [tickets === 1 && !replies ? 'Ett ärende' : tickets ? `${tickets} ärenden` : '', replies ? `${replies} svar` : ''].filter(Boolean);
  const where = url ? `Öppna Administration → Support: ${url.replace(/\/+$/, '')}/#/admin/support` : 'Öppna Administration → Support.';
  return `${parts.join(' och ')} väntar på granskning. Inget skickas till teamet förrän du har godkänt det. ${where}`;
}
function sendNotice() {
  const c = reviewCounts();
  if (!c.tickets && !c.replies) return;
  if (!notifyOn('support')) return; // avslaget: tiden räknas inte, nästa ärende ger en notis direkt om den slås på
  _notice.last = Date.now();
  notify('support', 'Feedback att granska', noticeText(c, getSetting('public_url', process.env.PUBLIC_URL || '')), { priority: 3 }).catch(() => {});
}
/** Något nytt väntar på granskning: notis nu, eller en samlad notis när NOTICE_GAP gått sedan den förra */
function noticeReview() {
  if (_notice.timer) return;
  const wait = _notice.last + NOTICE_GAP * 1000 - Date.now();
  if (wait <= 0) return sendNotice();
  _notice.timer = setTimeout(_noticeFlush, wait);
  _notice.timer.unref?.();
}
/** Väntar en samlad notis? (för testerna) */
export const noticeWaiting = () => !!_notice.timer;
/** Skicka den samlade notisen nu (timern, och testerna) */
export function _noticeFlush() {
  clearTimeout(_notice.timer); _notice.timer = null;
  try { sendNotice(); } catch (e) { console.warn('[support] notisen:', e.message); }
}

/** Alla ärenden för administratören: det som väntar på granskning först, sedan öppna, sist avslutade */
export function adminList() {
  const rank = (r) => r.status === 'pending' || hasPendingReply(r) ? 0 : OPEN.includes(r.status) ? 1 : 2;
  return all('SELECT * FROM support_tickets ORDER BY updated DESC LIMIT 500').sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
}

/** Administratören ändrar det som ska skickas (bara före godkännandet): rubrik, text och om tekniken följer med */
function applyEdit(r, b) {
  const f = {};
  if (b.title !== undefined) f.out_title = line(b.title, MAX_TITLE, LONG.title);
  if (b.text !== undefined) { f.out_text = limited(b.text, MAX_TEXT, LONG.text); if (!f.out_text) throw err(400, 'Skriv ett meddelande'); }
  if (b.withContext === false) f.context = null;
  return f;
}
export function edit(id, b) {
  const r = row(id);
  if (!r) return null;
  if (r.status !== 'pending') throw err(409, 'Ärendet är redan granskat – texten kan inte ändras');
  return save(r, threadOf(r), applyEdit(r, b));
}
/** Godkänn: ärendet syns för teamet. b kan ha de sista ändringarna (samma som edit) */
export function approve(id, b = {}) {
  const r = row(id);
  if (!r) return null;
  if (r.status !== 'pending') throw err(409, 'Ärendet är redan granskat');
  return save(r, threadOf(r), { ...applyEdit(r, b), status: 'approved', reviewed: now() });
}
/** Avslå: ärendet lämnar aldrig servern. note = valfri förklaring till användaren (stannar på servern) */
export function reject(id, b = {}) {
  const r = row(id);
  if (!r) return null;
  if (r.status !== 'pending') throw err(409, 'Ärendet är redan granskat');
  const note = limited(b.note, MAX_REPLY, LONG.note);
  const th = threadOf(r);
  if (note) th.push({ from: 'admin', text: note, ts: now(), local: 1 });
  return save(r, th, { status: 'rejected', reviewed: now() });
}
/**
 * Öppna ett avslutat (åtgärdat eller avslaget) ärende igen, t.ex. när felet kom tillbaka eller avslaget var fel.
 * to = 'approved' (syns för teamet igen, med note som förklaring) eller 'pending' (granskas på nytt – syns inte för
 * teamet, och note stannar på servern som anteckningen vid avslag). Användaren ser den nya statusen i Mina ärenden.
 */
export const REOPEN_TO = ['approved', 'pending'];
export function reopen(id, b = {}) {
  const r = row(id);
  if (!r) return null;
  if (!['fixed', 'rejected'].includes(r.status)) throw err(409, 'Bara åtgärdade och avslagna ärenden kan öppnas igen');
  const to = b.to ?? 'pending';
  if (!REOPEN_TO.includes(to)) throw err(400, 'to ska vara approved eller pending');
  const note = limited(b.note, MAX_REPLY, LONG.note);
  const th = threadOf(r);
  if (th.length >= MAX_THREAD) throw err(400, 'Ärendet har för många inlägg – skicka ett nytt ärende');
  th.push({ from: 'admin', text: note, ts: now(), status: 'reopened', ...(to === 'pending' ? { local: 1 } : {}) });
  return save(r, th, { status: to, version: null, reviewed: to === 'approved' ? now() : null });
}
/** Gallring (privacy.js): åtgärdade och avslagna ärenden som inte ändrats på days dagar. Öppna ärenden rörs aldrig. */
export const pruneClosed = (days, at = now()) =>
  Number(run("DELETE FROM support_tickets WHERE status IN ('fixed','rejected') AND updated < ?", at - days * 86400).changes);
export const remove = (id) => { const r = row(id); return !!r && Number(run('DELETE FROM support_tickets WHERE id=?', r.id).changes) > 0; };

/**
 * Svar i ett ärende där teamet bett om mer information. Administratörens svar går vidare direkt; en vanlig användares
 * svar väntar på granskning (pending) och syns inte i API:t förrän det godkänts.
 */
export function reply(r, user, b) {
  if (r.status !== 'needinfo') throw err(409, 'Det går bara att svara när teamet har bett om mer information');
  const th = threadOf(r);
  if (th.some(m => m.pending)) throw err(409, 'Det finns redan ett svar som väntar på granskning');
  if (th.length >= MAX_THREAD) throw err(400, 'Ärendet har för många inlägg – skicka ett nytt ärende');
  const text = limited(b.text, MAX_REPLY, LONG.reply);
  if (!text) throw err(400, 'Skriv ett svar');
  const admin = !!user.is_admin;
  if (!admin) {
    const since = now() - 3600;
    const n = mine(user.id).reduce((s, x) => s + threadOf(x).filter(m => m.from === 'user' && m.ts > since).length, 0);
    if (n >= MAX_REPLIES_HOUR) throw err(429, 'Du har skickat många svar den senaste timmen – vänta en stund');
    th.push({ from: 'user', text, ts: now(), pending: 1 });
    const saved = save(r, th);
    noticeReview();
    return saved;
  }
  th.push({ from: 'admin', text, ts: now() });
  return save(r, th, { status: 'approved' });
}
/** Administratören granskar ett väntande svar: godkänn (ev. med ändrad text) eller avslå (svaret tas bort) */
export function reviewReply(id, ok, b = {}) {
  const r = row(id);
  if (!r) return null;
  const th = threadOf(r), i = th.findIndex(m => m.pending);
  if (i < 0) throw err(409, 'Det finns inget svar som väntar på granskning');
  if (!ok) { th.splice(i, 1); return save(r, th); }
  if (b.text !== undefined) { const text = limited(b.text, MAX_REPLY, LONG.reply); if (!text) throw err(400, 'Skriv ett svar'); th[i].text = text; }
  delete th[i].pending;
  th[i].ts = now();
  return save(r, th, r.status === 'needinfo' ? { status: 'approved' } : {});
}

// ---------- teamet (API-nyckel med behörigheten support) ----------
/** Godkända ärenden som inte är avslutade, äldst först */
export const teamList = () => all(`SELECT * FROM support_tickets WHERE status IN ('approved','working','needinfo') ORDER BY created LIMIT 500`).map(r => forTeam(r));

/**
 * Teamet sätter status och svar: { status: 'working'|'needinfo'|'fixed', reply?, version? }. Bara godkända, öppna
 * ärenden – allt annat (väntar, avslaget, avslutat, okänt) ger null (404), så att nyckeln inte kan känna av vad som finns.
 */
export function teamUpdate(id, b) {
  const r = row(id);
  if (!r || !OPEN.includes(r.status)) return null;
  if (!TEAM_STATUS.includes(b.status)) throw err(400, 'status ska vara working, needinfo eller fixed');
  const text = limited(b.reply, MAX_REPLY, LONG.reply);
  const version = line(b.version, MAX_VERSION, LONG.version);
  if (version && !/^[\w.+-]+$/.test(version)) throw err(400, 'Versionen får bara ha bokstäver, siffror, punkt, plus och bindestreck');
  if (b.status === 'needinfo' && !text) throw err(400, 'Skriv frågan i reply när status är needinfo');
  const th = threadOf(r);
  if (th.length >= MAX_THREAD) th.splice(0, th.length - MAX_THREAD + 1);
  // Ett svar som väntar på granskning hör till en tidigare fråga – det ligger kvar tills administratören granskat det
  if (text || b.status !== r.status) th.push({ from: 'team', text, ts: now(), status: b.status, ...(b.status === 'fixed' && version ? { version } : {}) });
  return save(r, th, { status: b.status, ...(b.status === 'fixed' ? { version: version || null } : {}) });
}
