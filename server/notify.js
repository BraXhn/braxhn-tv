// Larm till mobilen: ntfy, Pushover, Gotify, Discord, Telegram eller valfri webhook.
// Händelser grupperas och begränsas så att en attack inte ger hundratals notiser.
import { getSetting } from './db.js';
import { isPrivate } from './util.js';

export const KINDS = ['none', 'ntfy', 'pushover', 'gotify', 'discord', 'telegram', 'webhook'];
export const EVENTS = { security: 'Säkerhet (spärrade konton, attacker, ändrad 2FA)', newlogin: 'Inloggning utifrån', cert: 'HTTPS-certifikat', backup: 'Säkerhetskopior', update: 'Ny version', dvr: 'Inspelningar', request: 'Önskningar av filmer/serier' };
const DEFAULT_EVENTS = 'security,cert,backup,update,dvr,request';

const cfg = () => ({
  kind: getSetting('notify_kind', process.env.NOTIFY_KIND || 'none'),
  url: getSetting('notify_url', process.env.NOTIFY_URL || ''),
  token: getSetting('notify_token', process.env.NOTIFY_TOKEN || ''),
  user: getSetting('notify_user', process.env.NOTIFY_USER || ''),
  events: new Set(getSetting('notify_events', DEFAULT_EVENTS).split(',').filter(Boolean))
});
export const enabled = (event) => { const c = cfg(); return c.kind !== 'none' && c.events.has(event); };

const last = new Map(); // nyckel → tid då nästa notis tidigast får skickas (begränsning)
const LAST_MAX = 1000;
function pruneLast() {
  if (last.size <= LAST_MAX) return;
  const t = Date.now();
  for (const [k, until] of last) if (until <= t) last.delete(k);
  // Fortfarande för många (t.ex. en attack från tusentals adresser): släpp de äldsta
  for (const k of last.keys()) { if (last.size <= LAST_MAX) break; last.delete(k); }
}
export const sent = []; // senaste notiser (för test och visning)

/** Skicka en notis. key + minIntervalSec begränsar upprepningar. */
export async function notify(event, title, message, { priority = 3, key = null, minInterval = 0, force = false } = {}) {
  const c = cfg();
  if (!force && (c.kind === 'none' || !c.events.has(event))) return false;
  if (key && minInterval) {
    if ((last.get(key) || 0) > Date.now()) return false;
    last.delete(key); // nyast sist (Map behåller insättningsordning)
    last.set(key, Date.now() + minInterval * 1000);
    pruneLast();
  }
  const t = `BraXhn TV: ${title}`;
  sent.push({ event, title: t, message, at: Date.now() }); if (sent.length > 50) sent.shift();
  try {
    await deliver(c, t, message, priority);
    return true;
  } catch (e) { console.warn('[notify] kunde inte skicka:', e.message); if (force) throw e; return false; }
}

async function deliver(c, title, message, priority) {
  const post = async (url, body, headers = {}) => {
    const r = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  const json = (o) => JSON.stringify(o);
  const J = { 'Content-Type': 'application/json' };
  switch (c.kind) {
    case 'ntfy': {
      // url = https://ntfy.sh/mitt-hemliga-ämne (eller egen ntfy-server). JSON-publicering klarar å, ä, ö i rubriken.
      const u = new URL(c.url), topic = u.pathname.replace(/^\/+|\/+$/g, '');
      return post(u.origin, json({ topic, title, message, priority, tags: ['tv'] }), { ...J, ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) });
    }
    case 'pushover':
      return post('https://api.pushover.net/1/messages.json', new URLSearchParams({ token: c.token, user: c.user, title, message, priority: String(Math.max(-1, Math.min(1, priority - 3))) }));
    case 'gotify':
      return post(`${c.url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(c.token)}`, json({ title, message, priority: priority * 2 }), J);
    case 'discord':
      return post(c.url, json({ username: 'BraXhn TV', content: `**${title}**\n${message}` }), J);
    case 'telegram':
      return post(`https://api.telegram.org/bot${c.token}/sendMessage`, json({ chat_id: c.user, text: `${title}\n${message}` }), J);
    case 'webhook':
      return post(c.url, json({ title, message, priority, app: 'braxhn-tv' }), { ...J, ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) });
  }
}

// ---------- koppling till säkerhetsloggen ----------
let failWindow = { start: 0, n: 0, ips: new Set() };
export function onAudit(event, { user, ip, detail }) {
  const remote = ip && !isPrivate(ip);
  const who = user?.name ? ` (${user.name})` : '';
  if (event === 'login_fail' && remote) {
    // Samla misslyckade försök utifrån: notis när ≥5 inom 15 min, max en gång per 15 min
    if (Date.now() - failWindow.start > 900e3) failWindow = { start: Date.now(), n: 0, ips: new Set() };
    failWindow.n++; failWindow.ips.add(ip);
    if (failWindow.n >= 5) notify('security', 'Misslyckade inloggningar', `${failWindow.n} misslyckade inloggningar utifrån de senaste 15 minuterna från ${failWindow.ips.size} adress(er), senast ${ip}.`, { priority: 4, key: 'fails', minInterval: 900 });
  }
  else if (event === 'login_locked') notify('security', 'Konto spärrat', `Kontot${who} spärrades tillfälligt efter upprepade felaktiga inloggningar från ${ip}.`, { priority: 4, key: 'locked:' + (user?.name || ''), minInterval: 3600 });
  else if (event === 'admin_denied') notify('security', 'Admin nekad', `Försök att nå administrationen utifrån${who} från ${ip}: ${detail || ''}`, { priority: 4, key: 'admin:' + ip, minInterval: 3600 });
  else if (['2fa_disabled', 'passkey_added', 'password_changed', '2fa_recovery_used'].includes(event)) {
    const what = { '2fa_disabled': 'Tvåstegsverifiering avstängd', passkey_added: 'Ny passkey tillagd', password_changed: 'Lösenord bytt', '2fa_recovery_used': 'Reservkod använd' }[event];
    notify('security', what, `${what}${who} från ${ip || 'okänd adress'}. Var det inte du? Logga in och byt lösenord.`, { priority: 4 });
  }
  else if (event === 'login_ok' && remote) notify('newlogin', 'Inloggning utifrån', `${user?.name || '?'} loggade in från ${ip} (${detail || ''}).`, { key: 'in:' + (user?.id || '') + ip, minInterval: 6 * 3600 });
}
