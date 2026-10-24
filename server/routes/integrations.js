// Streamingtjänster ("var kan jag se den?"), Sonarr/Radarr och önskemål, Trakt, scrobbling (ListenBrainz/Last.fm) och notiser.
import { get, setSetting, getSetting, all, run } from '../db.js';
import { fail, send, readJson, clientIp } from '../util.js';
import { audit, auditHooks } from '../auth.js';
import { hasTmdb, scan, tmdbSearch, tvdbOf } from '../scanner.js';
import * as notifier from '../notify.js';
import * as arr from '../arr.js';
import * as trakt from '../trakt.js';
import * as scrobble from '../scrobble.js';
import * as streaming from '../streaming.js';
import { route, user, admin, pub } from '../http/router.js';
import { ctx } from '../http/context.js';

// ---------- Streamingtjänster ("var kan jag se den?") ----------
route('GET', '/api/items/:id/watch', user, async (c) => {
  let it = get('SELECT * FROM items WHERE id=?', +c.p.id); if (!it) return fail(c.res, 404, 'Finns inte');
  if (it.kind === 'episode') it = get('SELECT * FROM items WHERE id=?', it.parent_id);
  if (!it?.tmdb_id || !hasTmdb()) return send(c.res, 200, null);
  try { send(c.res, 200, await streaming.providersFor(it.kind, it.tmdb_id, it.title)); } catch { send(c.res, 200, null); }
});
route('GET', '/api/streaming/providers', user, async (c) => {
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel (Administration → Inställningar)');
  try { send(c.res, 200, { region: streaming.region(), mine: streaming.myProviders(), all: await streaming.allProviders() }); } catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
route('PUT', '/api/streaming/mine', admin, async (c) => {
  const { ids } = await readJson(c.req);
  setSetting('my_providers', (Array.isArray(ids) ? ids : []).map(Number).filter(n => n > 0).slice(0, 30).join(','));
  send(c.res, 200, { ok: true });
});
route('GET', '/api/streaming/discover', user, async (c) => {
  if (c.user.max_age != null) return fail(c.res, 403, 'Inte tillgängligt i barnprofiler');
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel');
  const ids = String(c.q.get('providers') || '').split(',').map(Number).filter(Boolean);
  try { send(c.res, 200, await streaming.discover(c.q.get('kind') === 'show' ? 'show' : 'movie', ids, parseInt(c.q.get('page')) || 1, parseInt(c.q.get('genre')) || null)); }
  catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
route('GET', '/api/streaming/title/:kind/:tid', user, async (c) => {
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel');
  try { send(c.res, 200, await streaming.providersFor(c.p.kind === 'show' ? 'show' : 'movie', +c.p.tid, String(c.q.get('title') || '').slice(0, 200))); }
  catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});

// ---------- Sonarr/Radarr och önskemål ----------
route('POST', '/api/webhook/arr', pub, async (c) => {
  if (!arr.checkKey(c.q.get('key'))) { audit('webhook_denied', { ip: clientIp(c.req) }); return fail(c.res, 403, 'Fel nyckel'); }
  const b = await readJson(c.req, 2 << 20);
  const w = arr.parseWebhook(b);
  if (arr.SCAN_EVENTS.test(w.event)) { for (const id of w.libIds) scan(id); console.log(`[arr] ${w.event}: ${w.title || ''} → skannar`); }
  send(c.res, 200, { ok: true, event: w.event, scanned: arr.SCAN_EVENTS.test(w.event) ? w.libIds.length : 0 });
});
const canRequest = (u) => getSetting('requests_enabled', '1') === '1' && u.max_age == null && (arr.configured('movie') || arr.configured('show') || getSetting('requests_without_arr', '1') === '1');
const reqShape = (r) => ({ id: r.id, kind: r.kind, tmdbId: r.tmdb_id, title: r.title, year: r.year, poster: r.poster, overview: r.overview, status: r.status, note: r.note,
  user: r.user_name, userId: r.user_id, created: r.created });
route('GET', '/api/requests/search', user, async (c) => {
  if (!canRequest(c.user)) return fail(c.res, 403, 'Önskemål är inte tillgängliga');
  if (!hasTmdb()) return fail(c.res, 400, 'Kräver en TMDB-nyckel (Administration → Inställningar)');
  const kind = c.q.get('kind') === 'show' ? 'show' : 'movie';
  try {
    const res = await tmdbSearch(kind, String(c.q.get('q') || '').slice(0, 100), null);
    const mine = streaming.myProviders().length > 0;
    send(c.res, 200, await Promise.all(res.map(async r => {
      const lib = get('SELECT id FROM items WHERE tmdb_id=? AND kind=? AND version_of IS NULL', r.id, kind);
      const rq = get('SELECT status FROM requests WHERE tmdb_id=? AND kind=?', r.id, kind);
      // Finns den redan på en tjänst ni har? Då behöver den inte laddas ner.
      const streams = mine && !lib ? (await streaming.providersFor(kind, r.id, r.title).catch(() => null))?.onMine || [] : [];
      return { ...r, kind, inLibrary: lib?.id || null, request: rq?.status || null, streaming: streams };
    })));
  } catch (e) { fail(c.res, 502, 'TMDB: ' + e.message); }
});
async function sendRequest(row) {
  if (!arr.configured(row.kind)) { arr.setStatus(row.id, 'approved', 'Godkänd – lägg till manuellt (Radarr/Sonarr är inte inställt)'); return; }
  try { const r = await arr.send(row, tvdbOf); arr.setStatus(row.id, 'sent', r.already ? 'Fanns redan i ' + (row.kind === 'movie' ? 'Radarr' : 'Sonarr') : null); }
  catch (e) { arr.setStatus(row.id, 'failed', e.message); throw e; }
}
route('GET', '/api/requests', user, (c) => send(c.res, 200, {
  canRequest: canRequest(c.user), radarr: arr.configured('movie'), sonarr: arr.configured('show'), autoApprove: getSetting('requests_auto', '0') === '1',
  items: c.user.max_age != null ? [] : all('SELECT * FROM requests ORDER BY created DESC LIMIT 300').map(reqShape)
}));
route('POST', '/api/requests', user, async (c) => {
  if (!canRequest(c.user)) return fail(c.res, 403, 'Önskemål är inte tillgängliga');
  const { kind, tmdbId, title, year, poster, overview } = await readJson(c.req);
  if (!['movie', 'show'].includes(kind) || !(+tmdbId > 0) || !title) return fail(c.res, 400, 'Ogiltig önskan');
  if (poster && !/^https:\/\/image\.tmdb\.org\//.test(poster)) return fail(c.res, 400, 'Ogiltig bild');
  const open = get("SELECT COUNT(*) AS n FROM requests WHERE user_id=? AND status='pending'", c.user.id).n;
  if (open >= 20 && !c.user.is_admin) return fail(c.res, 429, 'Du har redan 20 obesvarade önskemål');
  const { row, existing } = arr.create(c.user, { kind, tmdbId: +tmdbId, title, year: +year || null, poster, overview });
  if (existing) return send(c.res, 200, reqShape(row));
  audit('request_created', { ...ctx(c), detail: `${title} (${kind})` });
  if (c.user.is_admin || getSetting('requests_auto', '0') === '1') { try { await sendRequest(row); } catch (e) { return fail(c.res, 502, e.message); } }
  else notifier.notify('request', 'Ny önskan', `${c.user.name} önskar ${kind === 'movie' ? 'filmen' : 'serien'} ${title}${year ? ` (${year})` : ''}.`);
  send(c.res, 200, reqShape(get('SELECT * FROM requests WHERE id=?', row.id)));
});
route('POST', '/api/requests/:rid/approve', admin, async (c) => {
  const row = get('SELECT * FROM requests WHERE id=?', +c.p.rid); if (!row) return fail(c.res, 404, 'Finns inte');
  try { await sendRequest(row); audit('request_approved', { ...ctx(c), detail: row.title }); send(c.res, 200, reqShape(get('SELECT * FROM requests WHERE id=?', row.id))); }
  catch (e) { fail(c.res, 502, e.message); }
});
route('POST', '/api/requests/:rid/decline', admin, async (c) => {
  const { note } = await readJson(c.req);
  arr.setStatus(+c.p.rid, 'declined', String(note || '').slice(0, 200) || null);
  send(c.res, 200, { ok: true });
});
route('DELETE', '/api/requests/:rid', user, (c) => {
  const row = get('SELECT * FROM requests WHERE id=?', +c.p.rid); if (!row) return fail(c.res, 404, 'Finns inte');
  if (!c.user.is_admin && !(row.user_id === c.user.id && row.status === 'pending')) return fail(c.res, 403, 'Kan inte tas bort');
  run('DELETE FROM requests WHERE id=?', row.id);
  send(c.res, 200, { ok: true });
});
route('GET', '/api/integrations', admin, (c) => send(c.res, 200, {
  radarrUrl: getSetting('radarr_url', process.env.RADARR_URL || ''), radarrKeySet: !!getSetting('radarr_key', process.env.RADARR_API_KEY || ''),
  radarrProfile: +getSetting('radarr_profile', '0'), radarrRoot: getSetting('radarr_root', ''),
  sonarrUrl: getSetting('sonarr_url', process.env.SONARR_URL || ''), sonarrKeySet: !!getSetting('sonarr_key', process.env.SONARR_API_KEY || ''),
  sonarrProfile: +getSetting('sonarr_profile', '0'), sonarrRoot: getSetting('sonarr_root', ''),
  pathMap: getSetting('arr_path_map', process.env.ARR_PATH_MAP || ''), webhookPath: `/api/webhook/arr?key=${arr.webhookKey()}`,
  requestsEnabled: getSetting('requests_enabled', '1') === '1', requestsAuto: getSetting('requests_auto', '0') === '1',
  traktClientId: getSetting('trakt_client_id', process.env.TRAKT_CLIENT_ID || ''), traktSecretSet: !!getSetting('trakt_client_secret', process.env.TRAKT_CLIENT_SECRET || ''),
  lastfmApiKey: getSetting('lastfm_api_key', process.env.LASTFM_API_KEY || ''), lastfmSecretSet: !!getSetting('lastfm_secret', process.env.LASTFM_SECRET || '')
}));
route('PUT', '/api/integrations', admin, async (c) => {
  const b = await readJson(c.req);
  for (const k of ['radarr', 'sonarr']) {
    if (typeof b[k + 'Url'] === 'string') {
      const u = b[k + 'Url'].trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return fail(c.res, 400, 'Adressen ska vara t.ex. http://192.168.1.10:7878');
      setSetting(k + '_url', u);
    }
    if (typeof b[k + 'Key'] === 'string' && b[k + 'Key']) setSetting(k + '_key', b[k + 'Key'].trim());
    if (b[k + 'Profile'] != null) setSetting(k + '_profile', parseInt(b[k + 'Profile']) || 0);
    if (typeof b[k + 'Root'] === 'string') setSetting(k + '_root', b[k + 'Root']);
  }
  if (typeof b.pathMap === 'string') setSetting('arr_path_map', b.pathMap.trim().slice(0, 500));
  if (b.requestsEnabled != null) setSetting('requests_enabled', b.requestsEnabled ? '1' : '0');
  if (b.requestsAuto != null) setSetting('requests_auto', b.requestsAuto ? '1' : '0');
  if (typeof b.traktClientId === 'string') setSetting('trakt_client_id', b.traktClientId.trim());
  if (typeof b.traktSecret === 'string' && b.traktSecret) setSetting('trakt_client_secret', b.traktSecret.trim());
  const lfKey = getSetting('lastfm_api_key', ''), lfSecret = getSetting('lastfm_secret', '');
  if (typeof b.lastfmApiKey === 'string') setSetting('lastfm_api_key', b.lastfmApiKey.trim().slice(0, 100));
  if (typeof b.lastfmSecret === 'string' && b.lastfmSecret) setSetting('lastfm_secret', b.lastfmSecret.trim().slice(0, 100));
  if (lfKey !== getSetting('lastfm_api_key', '') || lfSecret !== getSetting('lastfm_secret', '')) scrobble.lastfmAppChanged();
  if (b.newWebhookKey) setSetting('arr_webhook_key', '');
  audit('settings_changed', { ...ctx(c), detail: 'integrationer' });
  send(c.res, 200, { ok: true });
});
route('GET', '/api/integrations/arr-options', admin, async (c) => {
  try { send(c.res, 200, await arr.options(c.q.get('kind') === 'show' ? 'show' : 'movie')); } catch (e) { fail(c.res, 502, e.message); }
});
// Trakt (per användare)
route('GET', '/api/me/trakt', user, (c) => send(c.res, 200, trakt.info(c.user.id)));
route('POST', '/api/me/trakt/connect', user, async (c) => { try { send(c.res, 200, await trakt.startDevice(c.user.id)); } catch (e) { fail(c.res, 400, e.message); } });
route('POST', '/api/me/trakt/poll', user, async (c) => { try { send(c.res, 200, await trakt.pollDevice(c.user.id)); } catch (e) { fail(c.res, 502, e.message); } });
route('POST', '/api/me/trakt/sync', user, async (c) => { try { send(c.res, 200, await trakt.sync(c.user.id)); } catch (e) { fail(c.res, 502, 'Trakt: ' + e.message); } });
route('DELETE', '/api/me/trakt', user, (c) => { trakt.disconnect(c.user.id); send(c.res, 200, { ok: true }); });

// Scrobbling av musik (per person; barnprofiler kan inte koppla och ärver ingen koppling). Token/sessionsnyckel lämnas aldrig ut.
const scrobbleFail = (c, e) => fail(c.res, e.kind === 'temp' ? 502 : 400, e.message);
const adultOnly = (c) => { if (c.user.max_age == null) return true; fail(c.res, 403, 'Inte tillgängligt i barnprofiler'); return false; };
route('GET', '/api/me/scrobble', user, (c) => send(c.res, 200, scrobble.info(c.user)));
route('PUT', '/api/me/scrobble/listenbrainz', user, async (c) => {
  if (!adultOnly(c)) return;
  const { token } = await readJson(c.req);
  try { await scrobble.connectListenBrainz(c.user.id, token); send(c.res, 200, scrobble.info(c.user)); } catch (e) { scrobbleFail(c, e); }
});
route('POST', '/api/me/scrobble/lastfm/connect', user, async (c) => {
  if (!adultOnly(c)) return;
  try { send(c.res, 200, await scrobble.startLastfm(c.user.id)); } catch (e) { scrobbleFail(c, e); }
});
route('POST', '/api/me/scrobble/lastfm/poll', user, async (c) => {
  if (!adultOnly(c)) return;
  try { send(c.res, 200, await scrobble.pollLastfm(c.user.id)); } catch (e) { scrobbleFail(c, e); }
});
route('DELETE', '/api/me/scrobble/:service', user, (c) => {
  if (!scrobble.SERVICES.includes(c.p.service)) return fail(c.res, 404, 'Okänd tjänst');
  scrobble.disconnect(c.user.id, c.p.service); send(c.res, 200, scrobble.info(c.user));
});

// Notiser och uppdateringar
auditHooks.push(notifier.onAudit);
route('GET', '/api/notify', admin, (c) => send(c.res, 200, { kind: getSetting('notify_kind', process.env.NOTIFY_KIND || 'none'), url: getSetting('notify_url', process.env.NOTIFY_URL || ''),
  user: getSetting('notify_user', process.env.NOTIFY_USER || ''), tokenSet: !!getSetting('notify_token', process.env.NOTIFY_TOKEN || ''),
  events: getSetting('notify_events', notifier.DEFAULT_EVENTS).split(',').filter(Boolean), kinds: notifier.KINDS, allEvents: notifier.EVENTS, recent: notifier.sent.slice(-10).reverse() }));
route('PUT', '/api/notify', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.kind != null) { if (!notifier.KINDS.includes(b.kind)) return fail(c.res, 400, 'Okänd typ'); setSetting('notify_kind', b.kind); }
  if (typeof b.url === 'string') {
    const u = b.url.trim();
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return fail(c.res, 400, 'Adressen ska börja med https://');
    setSetting('notify_url', u);
  }
  if (typeof b.user === 'string') setSetting('notify_user', b.user.trim().slice(0, 200));
  if (typeof b.token === 'string' && b.token) setSetting('notify_token', b.token.trim().slice(0, 500));
  if (Array.isArray(b.events)) setSetting('notify_events', b.events.filter(e => notifier.EVENTS[e]).join(','));
  audit('settings_changed', { ...ctx(c), detail: 'notiser' });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/notify/test', admin, async (c) => {
  try { await notifier.notify('test', 'Testnotis', 'Det fungerar! Så här ser larm från BraXhn TV ut.', { force: true }); send(c.res, 200, { ok: true }); }
  catch (e) { fail(c.res, 502, 'Kunde inte skicka: ' + e.message); }
});
