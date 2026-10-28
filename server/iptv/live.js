// Kopplingen mellan livetv.js och IPTV-modulerna: det livetv.js anropar (listor, guider, rubriker, reservströmmar,
// kontroll av strömadresser). Importerar inte livetv.js (livetv.js importerar den här filen).
import { all, get } from '../db.js';
import { ffHeaders, assertStream, cleanHeaders, redact, ffGuard } from './net.js';
import { sourceCtx } from './sources.js';

export { loadChannels, beforeSync, afterSync } from './sources.js';
export { importGuides, pruneOld } from './guide.js';
export { redact };
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Rubrikerna för en strömadress: källans (User-Agent/Referer som administratören angett) och kanalens egna från listan
 *  (#EXTVLCOPT, |User-Agent=…) ovanpå. Slås upp på adressen, så att även inspelningar (dvr.js → httpOpts) får dem. */
export function headersFor(url) {
  const r = get(`SELECT c.tuner_id, e.headers FROM channels c LEFT JOIN channel_ext e ON e.channel_id=c.id WHERE c.stream_url=? LIMIT 1`, String(url));
  if (!r) return {};
  return cleanHeaders({ ...(sourceCtx(r.tuner_id)?.headers || {}), ...json(r.headers, {}) });
}
export const headerOpts = (url) => { try { return ffHeaders(headersFor(url)); } catch { return []; } };

/** Samma kanal i andra källor (reservström): samma tvg-id, annars samma namn. Även dolda dubbletter räknas – de döljs ofta
 *  just för att de är dubbletter. Källor med högre prioritet först. */
export function alternatives(ch) {
  const k = get('SELECT alt_key FROM channel_ext WHERE channel_id=?', ch.id)?.alt_key;
  if (!k) return [];
  return all(`SELECT c.* FROM channels c JOIN channel_ext e ON e.channel_id=c.id JOIN tuners t ON t.id=c.tuner_id LEFT JOIN iptv_sources s ON s.tuner_id=t.id
    WHERE e.alt_key=? AND c.id != ? AND c.tuner_id != ? AND t.enabled=1 ORDER BY COALESCE(s.priority, 0) DESC, c.hidden, t.id LIMIT 4`, k, ch.id, ch.tuner_id);
}
/** Xtream-konton med bara filmer/serier har inga kanaler – tillåtet så länge källan inte haft några (en tillfälligt tom
 *  lista ska aldrig ta bort kanaler, favoriter och ändringar) */
export const allowEmpty = (t) => sourceCtx(t.id)?.type === 'xtream' && !get('SELECT 1 FROM channels WHERE tuner_id=? LIMIT 1', t.id);
/** Strömadressen kontrolleras mot källans policy innan ffmpeg får den (net.js) */
export async function checkStream(ch) {
  const c = sourceCtx(ch.tuner_id);
  if (c) await assertStream(ch.stream_url, c.pol);
}
/** ffmpeg genom strömvakten (net.js ffGuard) med källans policy. Kanaler som inte kommer från en IPTV-källa (HDHomeRun)
 *  går direkt som förut. Ger { args, env, release }; kastar om adressen är spärrad eller vakten inte lyssnar. */
export function guardFor(ch) {
  const c = sourceCtx(ch.tuner_id);
  if (!c) return { args: [], env: process.env, release: () => {} };
  return ffGuard(ch.stream_url, c.pol);
}
