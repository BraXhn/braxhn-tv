// Webhooks för händelser (som Plex Pass-webhooks, men gratis): uppspelning (play/pause/resume/stop/scrobble), nya titlar,
// skanning klar, önskningar, inspelningar och ny version. Administratören lägger in serverns webhooks (alla händelser,
// alla profiler); varje vuxen profil kan lägga in egna för sina egna uppspelningar och nya titlar inom sin åldersgräns.
//
// Leverans: emit() lägger en rad per webhook i webhook_queue (kroppen byggs direkt, i valt format: JSON i Plex-stil,
// Discord eller ntfy). processQueue() skickar med safePost (podcasts.js – spärrar lokala adresser, följer inga
// omdirigeringar), signerar kroppen med HMAC-SHA256 (X-BraXhn-Signature: sha256=<hex>) och försöker igen med ökande
// väntetid vid fel. Webhooks i hemnätet (Home Assistant) kräver att administratören uttryckligen tillåtit lokala adresser
// för just den webhooken – loopback och länklokala adresser spärras ändå (se blockedFor i podcasts.js).
// Adressen kan innehålla en hemlighet (Discord-token, Home Assistants webhook-id): den maskeras i API-svar och skrivs
// aldrig till loggen. Hemligheten för signaturen visas bara när webhooken skapas eller nyckeln byts.
import crypto from 'node:crypto';
import { get, all, run, now, tx, getSetting, setSetting } from './db.js';
import { safePost } from './podcasts.js';

export const EVENTS = {
  'media.play': 'Uppspelning startar', 'media.pause': 'Pausad', 'media.resume': 'Fortsätter efter paus', 'media.stop': 'Uppspelning slutar',
  'media.scrobble': 'Sedd (90 %)', 'library.new': 'Ny film eller nytt avsnitt', 'library.scan.done': 'Skanningen är klar',
  'request.new': 'Ny önskan', 'recording.done': 'Inspelning klar', 'server.update': 'Ny version av BraXhn TV'
};
/** Händelser som en vanlig profil kan få till sin egen webhook (bara sina egna uppspelningar, nya titlar inom åldersgränsen) */
export const USER_EVENTS = ['media.play', 'media.pause', 'media.resume', 'media.stop', 'media.scrobble', 'library.new'];
export const FORMATS = { json: 'JSON (Home Assistant, n8n, egna skript)', discord: 'Discord', ntfy: 'ntfy' };
export const MAX_ATTEMPTS = 8;
const MAX_QUEUE = 500, KEEP_LOG = 100, MAX_PER_USER = 10;
/** Väntetid före nästa försök: 30 s, 1, 2, 4 … minuter, högst en timme */
export const backoff = (attempts) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
export const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

// ---------- webhooks (lagring) ----------
/** Adressen utan det som brukar vara hemligt (sökvägens slut, frågedelen) – för visning */
export function maskUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 16 ? x.pathname.slice(0, 12) + '…' : x.pathname;
    return `${x.protocol}//${x.host}${p}${x.search ? '?…' : ''}`;
  } catch { return ''; }
}
const parseEvents = (s) => String(s || '').split(',').filter(e => EVENTS[e]);
const shape = (h) => ({
  id: h.id, name: h.name, url: maskUrl(h.url), events: parseEvents(h.events), format: h.format, allowLocal: !!h.allow_local,
  enabled: !!h.enabled, created: h.created, lastOk: h.last_ok || null, lastError: h.last_error || null, server: h.user_id == null,
  queued: get('SELECT COUNT(*) AS n FROM webhook_queue WHERE hook_id=?', h.id).n
});
/** owner: null = serverns webhooks (administratören), annars användarens id */
const ownerSql = (owner) => owner == null ? ['user_id IS NULL', []] : ['user_id=?', [owner]];
export function list(owner) {
  const [w, p] = ownerSql(owner);
  return all(`SELECT * FROM webhooks WHERE ${w} ORDER BY id`, ...p).map(shape);
}
export function find(owner, id) {
  const [w, p] = ownerSql(owner);
  return get(`SELECT * FROM webhooks WHERE id=? AND ${w}`, +id, ...p) || null;
}
class HookError extends Error { constructor(m) { super(m); this.status = 400; } }
function clean(b, owner, prev) {
  const name = String(b.name ?? prev?.name ?? '').trim().slice(0, 80) || 'Webhook';
  let url = b.url === undefined || b.url === '' ? prev?.url : String(b.url).trim();
  if (!url) throw new HookError('Ange adressen till webhooken');
  let u;
  try { u = new URL(url); } catch { throw new HookError('Adressen är inte giltig'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HookError('Adressen måste börja med http:// eller https://');
  if (u.username || u.password) throw new HookError('Adresser med inloggning stöds inte – använd en token i adressen eller signaturen');
  if (url.length > 2000) throw new HookError('Adressen är för lång');
  const allowed = owner == null ? Object.keys(EVENTS) : USER_EVENTS;
  const events = b.events === undefined ? parseEvents(prev?.events) : (Array.isArray(b.events) ? b.events : []).filter(e => allowed.includes(e));
  if (!events.length) throw new HookError('Välj minst en händelse');
  const format = b.format === undefined ? prev?.format || 'json' : typeof b.format === 'string' && Object.hasOwn(FORMATS, b.format) ? b.format : 'json';
  // Lokala adresser bara för serverns webhooks (administratören på betrott nät) – aldrig för en profils egna
  const allowLocal = owner == null ? (b.allowLocal === undefined ? !!prev?.allow_local : !!b.allowLocal) : false;
  const enabled = b.enabled === undefined ? (prev ? !!prev.enabled : true) : !!b.enabled;
  return { name, url, events: [...new Set(events)].join(','), format, allowLocal: allowLocal ? 1 : 0, enabled: enabled ? 1 : 0 };
}
const newSecret = () => crypto.randomBytes(24).toString('base64url');
/** Skapar en webhook. Svaret innehåller hemligheten – den enda gången den lämnas ut. */
export function create(owner, b) {
  const v = clean(b, owner, null);
  if (owner != null && get('SELECT COUNT(*) AS n FROM webhooks WHERE user_id=?', owner).n >= MAX_PER_USER) throw new HookError(`Högst ${MAX_PER_USER} webhooks per profil`);
  const secret = newSecret();
  const id = Number(run('INSERT INTO webhooks(user_id,name,url,events,format,secret,allow_local,enabled,created) VALUES(?,?,?,?,?,?,?,?,?)',
    owner, v.name, v.url, v.events, v.format, secret, v.allowLocal, v.enabled, now()).lastInsertRowid);
  return { ...shape(get('SELECT * FROM webhooks WHERE id=?', id)), secret };
}
export function update(owner, id, b) {
  const h = find(owner, id); if (!h) return null;
  const v = clean(b, owner, h);
  run('UPDATE webhooks SET name=?, url=?, events=?, format=?, allow_local=?, enabled=? WHERE id=?', v.name, v.url, v.events, v.format, v.allowLocal, v.enabled, h.id);
  // Avstängd: väntande leveranser skickas inte
  if (!v.enabled) run('DELETE FROM webhook_queue WHERE hook_id=?', h.id);
  return shape(get('SELECT * FROM webhooks WHERE id=?', h.id));
}
export function remove(owner, id) {
  const h = find(owner, id); if (!h) return false;
  run('DELETE FROM webhooks WHERE id=?', h.id);
  return true;
}
export function rotateSecret(owner, id) {
  const h = find(owner, id); if (!h) return null;
  const secret = newSecret();
  run('UPDATE webhooks SET secret=? WHERE id=?', secret, h.id);
  return { secret };
}
export function log(owner, id = null, limit = 50) {
  const [w, p] = ownerSql(owner);
  return all(`SELECT l.id, l.hook_id AS hookId, h.name AS hook, l.event, l.ts, l.status, l.ok, l.error, l.attempt, l.ms FROM webhook_log l
    JOIN webhooks h ON h.id=l.hook_id WHERE h.${w}${id ? ' AND h.id=?' : ''} ORDER BY l.id DESC LIMIT ?`, ...p, ...(id ? [+id] : []), Math.min(200, limit))
    .map(r => ({ ...r, ok: !!r.ok }));
}

// ---------- innehåll ----------
const VERSION = () => globalThis.__braxhnAppVersion || '0';
const pad = (n) => String(n ?? 0).padStart(2, '0');
/** "Serie – S01E02 Titel" eller filmens titel (år) */
export function fullTitle(m) {
  if (!m) return '?';
  if (m.type === 'episode') return `${m.show || '?'} – S${pad(m.season)}E${pad(m.episode)}${m.title ? ' ' + m.title : ''}`;
  return `${m.title || '?'}${m.year ? ` (${m.year})` : ''}`;
}
const MODE = { direct: 'direkt', remux: 'remux', transcode: 'omkodning' };
const clock = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
/** Kort text på svenska (Discord, ntfy och fältet "text" i JSON) */
export function summary(event, p) {
  const who = p.user?.name || 'Någon', what = fullTitle(p.metadata);
  const where = p.player ? ` på ${p.player.device || 'okänd enhet'}${p.player.local === false ? ' (utifrån)' : ''}` : '';
  const how = p.playback ? ` · ${MODE[p.playback.mode] || p.playback.mode}${p.playback.quality && p.playback.quality !== 'orig' ? ' ' + p.playback.quality + 'p' : ''}` : '';
  switch (event) {
    case 'media.play': return { title: 'Spelas nu', message: `${who} började titta på ${what}${where}${how}` };
    case 'media.pause': return { title: 'Pausad', message: `${who} pausade ${what} vid ${clock(p.metadata?.position)}` };
    case 'media.resume': return { title: 'Fortsätter', message: `${who} fortsätter titta på ${what}` };
    case 'media.stop': return { title: 'Slutade titta', message: `${who} slutade titta på ${what} vid ${clock(p.metadata?.position)}${p.metadata?.progress != null ? ` (${p.metadata.progress} %)` : ''}` };
    case 'media.scrobble': return { title: 'Sedd', message: `${who} har sett ${what}` };
    case 'library.new': return { title: 'Nytt i biblioteket', message: p.metadata?.newEpisodes > 1 ? `${p.metadata.newEpisodes} nya avsnitt av ${p.metadata.show}` : `${what} finns nu att titta på` };
    case 'library.scan.done': return { title: 'Skanningen är klar', message: `${(p.scan?.libraries || []).join(', ') || 'Biblioteken'} skannades på ${clock(p.scan?.seconds)}${p.scan?.warnings?.length ? ` – ${p.scan.warnings.length} varningar` : ''}` };
    case 'request.new': return { title: 'Ny önskan', message: `${who} önskar ${p.request?.kind === 'show' ? 'serien' : 'filmen'} ${p.request?.title || '?'}${p.request?.year ? ` (${p.request.year})` : ''}` };
    case 'recording.done': return { title: 'Inspelning klar', message: `${p.recording?.title || '?'}${p.recording?.subtitle ? ' – ' + p.recording.subtitle : ''}${p.recording?.channel ? ` (${p.recording.channel})` : ''} finns att titta på` };
    case 'server.update': return { title: 'Ny version', message: `BraXhn TV ${p.update?.latest || ''} finns (du kör ${p.update?.current || VERSION()})` };
    case 'test': return { title: 'Test', message: 'Det fungerar! Så här ser webhooks från BraXhn TV ut.' };
  }
  return { title: event, message: '' };
}
const COLOR = { 'media.play': 0x2e9e5b, 'media.resume': 0x2e9e5b, 'media.pause': 0xe0a030, 'media.stop': 0x777777, 'media.scrobble': 0x3b82f6, 'library.new': 0xf97316 };
/** Kroppen i valt format. JSON: händelsen med allt (Plex-liknande); Discord: inbäddning; ntfy: JSON-publicering till ämnet. */
export function build(format, event, payload, url) {
  const full = { event, ts: new Date().toISOString(), server: { name: 'BraXhn TV', version: VERSION() }, ...payload };
  const s = summary(event, full);
  if (format === 'discord') {
    const m = full.metadata;
    const fields = [];
    if (full.user?.name) fields.push({ name: 'Profil', value: full.user.name, inline: true });
    if (full.player?.device) fields.push({ name: 'Enhet', value: full.player.device + (full.player.local === false ? ' (utifrån)' : ''), inline: true });
    if (full.playback?.mode) fields.push({ name: 'Uppspelning', value: (MODE[full.playback.mode] || full.playback.mode) + (full.playback.quality && full.playback.quality !== 'orig' ? ' ' + full.playback.quality + 'p' : ''), inline: true });
    if (m?.duration && m.position != null) fields.push({ name: 'Position', value: `${clock(m.position)} / ${clock(m.duration)}`, inline: true });
    return JSON.stringify({ username: 'BraXhn TV', embeds: [{ title: `${s.title}: ${fullTitle(m) === '?' ? '' : fullTitle(m)}`.replace(/: $/, ''), description: s.message,
      color: COLOR[event] || 0xf97316, fields, timestamp: full.ts, footer: { text: event } }] });
  }
  if (format === 'ntfy') {
    let topic = '';
    try { topic = new URL(url).pathname.replace(/^\/+|\/+$/g, ''); } catch {}
    return JSON.stringify({ topic, title: `BraXhn TV: ${s.title}`, message: s.message, tags: ['tv'], priority: event === 'server.update' ? 4 : 3 });
  }
  return JSON.stringify({ ...full, text: s.message });
}
/** ntfy publicerar JSON till serverns rot (ämnet står i kroppen) */
const targetUrl = (h) => { if (h.format !== 'ntfy') return h.url; try { return new URL(h.url).origin; } catch { return h.url; } };

// ---------- händelser ----------
/**
 * En händelse har inträffat. userId = profilen den gäller (uppspelningar, önskningar) – profilens egna webhooks får
 * bara sina egna händelser. visibleTo(uid) = får profilen se titeln (library.new, åldersgränsen). Serverns webhooks
 * får allt. Returnerar antalet köade leveranser.
 */
export function emit(event, payload, { userId = null, visibleTo = null } = {}) {
  if (!EVENTS[event]) return 0;
  let hooks;
  try { hooks = all("SELECT * FROM webhooks WHERE enabled=1 AND (',' || events || ',') LIKE ?", `%,${event},%`); }
  catch { return 0; } // databasen stängd (avslutning)
  const at = now();
  let n = 0;
  tx(() => {
    for (const h of hooks) {
      if (h.user_id != null) {
        if (!USER_EVENTS.includes(event)) continue;
        if (event.startsWith('media.') && h.user_id !== userId) continue;
        if (event === 'library.new' && !(visibleTo && visibleTo(h.user_id))) continue;
        // Barnprofiler har inga egna webhooks (och en profil som blivit barnprofil får inget)
        if (get('SELECT max_age FROM users WHERE id=?', h.user_id)?.max_age != null) continue;
      }
      run('INSERT INTO webhook_queue(hook_id,event,body,created,next_try) VALUES(?,?,?,?,?)', h.id, event, build(h.format, event, payload, h.url), at, at);
      // En webhook som inte svarar på länge ska inte fylla databasen: släpp de äldsta
      run('DELETE FROM webhook_queue WHERE hook_id=? AND id <= (SELECT id FROM webhook_queue WHERE hook_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)', h.id, h.id, MAX_QUEUE);
      n++;
    }
  });
  if (n) kick();
  return n;
}

// ---------- leverans ----------
async function deliver(h, row) {
  const ts = now();
  const headers = { 'Content-Type': 'application/json', 'User-Agent': `BraXhnTV/${VERSION()} (webhook)`, 'X-BraXhn-Event': row.event,
    'X-BraXhn-Delivery': String(row.id), 'X-BraXhn-Timestamp': String(ts), 'X-BraXhn-Signature': sign(h.secret, row.body) };
  const t0 = Date.now();
  try {
    const r = await safePost(targetUrl(h), row.body, { headers, timeout: 10000, allowLocal: !!h.allow_local });
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, error: r.ok ? null : `Svarade ${r.status}${r.text ? ': ' + r.text.replace(/\s+/g, ' ').slice(0, 160) : ''}` };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200), net: true };
  }
}
// Fel som inte blir bättre av att försöka igen (fel adress, nekad): 4xx utom 408/425/429
const permanent = (r) => r.status >= 400 && r.status < 500 && ![408, 425, 429].includes(r.status);
function writeLog(h, row, r, attempt) {
  run('INSERT INTO webhook_log(hook_id,event,ts,status,ok,error,attempt,ms) VALUES(?,?,?,?,?,?,?,?)', h.id, row.event, now(), r.status, r.ok ? 1 : 0, r.error, attempt, r.ms);
  run('DELETE FROM webhook_log WHERE hook_id=? AND id <= (SELECT id FROM webhook_log WHERE hook_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)', h.id, h.id, KEEP_LOG);
}
let busy = null, again = false;
/** Skickar leveranser vars tid är inne, i ordning per webhook. Ett fel stoppar webhooken till nästa försök. */
export function processQueue(at = now()) {
  if (busy) { again = true; return busy; }
  busy = drain(at).finally(() => { busy = null; if (again) { again = false; kick(); } });
  return busy;
}
async function drain(at) {
  run('DELETE FROM webhook_queue WHERE created < ?', at - 86400); // äldre än ett dygn: inte längre intressant
  const hooks = all(`SELECT DISTINCT h.* FROM webhook_queue q JOIN webhooks h ON h.id=q.hook_id WHERE h.enabled=1 AND q.next_try<=?`, at);
  let sent = 0, failed = 0;
  // Webhooks parallellt (en långsam ska inte hålla upp de andra), leveranserna till samma webhook i tur och ordning
  await Promise.all(hooks.map(async (h) => {
    for (let i = 0; i < 100; i++) {
      const row = get('SELECT * FROM webhook_queue WHERE hook_id=? ORDER BY id LIMIT 1', h.id);
      if (!row || row.next_try > at) break;
      const r = await deliver(h, row);
      const attempt = row.attempts + 1;
      writeLog(h, row, r, attempt);
      if (r.ok) {
        tx(() => { run('DELETE FROM webhook_queue WHERE id=?', row.id); run('UPDATE webhooks SET last_ok=?, last_error=NULL WHERE id=?', now(), h.id); });
        sent++; continue;
      }
      failed++;
      run('UPDATE webhooks SET last_error=? WHERE id=?', r.error, h.id);
      if (permanent(r) || attempt >= MAX_ATTEMPTS) run('DELETE FROM webhook_queue WHERE id=?', row.id);
      else run('UPDATE webhook_queue SET attempts=?, next_try=?, error=? WHERE id=?', attempt, at + backoff(attempt), r.error, row.id);
      if (!permanent(r)) break; // fel nu: resten av webhookens kö väntar (ordningen behålls)
    }
  }));
  return { sent, failed };
}
/** Testleverans direkt (utan kön) – svaret visas för användaren */
export async function test(owner, id) {
  const h = find(owner, id); if (!h) return null;
  const row = { id: 0, event: 'test', body: build(h.format, 'test', { user: null }, h.url) };
  const r = await deliver(h, row);
  writeLog(h, row, r, 1);
  if (r.ok) run('UPDATE webhooks SET last_ok=?, last_error=NULL WHERE id=?', now(), h.id); else run('UPDATE webhooks SET last_error=? WHERE id=?', r.error, h.id);
  return { ok: r.ok, status: r.status, error: r.error, ms: r.ms };
}

const interval = () => +(process.env.WEBHOOK_INTERVAL ?? 10);
let kicked = false;
function kick() {
  if (interval() <= 0 || kicked) return;
  kicked = true;
  setTimeout(() => { kicked = false; processQueue().catch(e => console.warn('[webhook]', e.message)); }, 200).unref();
}
if (interval() > 0) setInterval(() => processQueue().catch(e => console.warn('[webhook]', e.message)), interval() * 1000).unref();

// ---------- ny version (en gång per version) ----------
export function updateAvailable(info) {
  if (!info?.latest || getSetting('webhook_update_sent', '') === info.latest) return;
  setSetting('webhook_update_sent', info.latest);
  emit('server.update', { update: { current: info.current, latest: info.latest, notes: String(info.notes || '').slice(0, 2000) } });
}
