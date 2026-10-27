// Hälsokontroll av biblioteket (server/health.js) – bara administratör på betrott nät.
//   GET  /api/admin/health                     – fynd, rättade språk, läge och inställningar
//   POST /api/admin/health/run                 – starta en genomgång nu ({ full: true } = kontrollera alla filer igen)
//   PUT  /api/admin/health/settings            – { enabled, samples, maxMbps }
//   POST /api/admin/health/issues/:id/ignore   – { ignored: true|false }
//   POST /api/admin/health/issues/:id/replace  – be Radarr/Sonarr om en ny version ({ blocklist: true } spärrar den nuvarande)
//   PUT  /api/admin/health/lang                – { item, track, lang } rätta språkmärkningen (lang '' = ta bort rättelsen)
import path from 'node:path';
import { route, admin } from '../http/router.js';
import { ctx } from '../http/context.js';
import { send, fail, readJson } from '../util.js';
import { all, get, run, now, setSetting } from '../db.js';
import { audit } from '../auth.js';
import { tvdbOf } from '../scanner.js';
import * as arr from '../arr.js';
import * as health from '../health.js';
import * as libfilter from '../libfilter.js';
import { streamsOf, subtitlesOf } from '../stream.js';

const REPLACE = new Set(['broken', 'truncated', 'length', 'decode', 'sync', 'bitrate', 'quality', 'duplicate']);
const LANG = new Set(['audiolang', 'sublang']);
const actionsOf = (r) => [...(REPLACE.has(r.kind) || r.kind === 'missing' ? ['replace'] : []), ...(LANG.has(r.kind) ? ['lang'] : []), 'ignore'];

route('GET', '/api/admin/health', admin, (c) => {
  const rows = all(`SELECT h.*, i.title, i.kind AS ikind, i.season, i.episode, i.year, i.path, i.library_id, i.parent_id, i.version_of,
      s.title AS show_title, l.name AS library
    FROM health_issues h JOIN items i ON i.id=h.item_id LEFT JOIN items s ON s.id=i.parent_id JOIN libraries l ON l.id=i.library_id
    ORDER BY CASE h.severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, h.found DESC, h.id LIMIT 5000`);
  const issues = rows.map(r => {
    let detail = {}; try { detail = JSON.parse(r.detail || '{}'); } catch {}
    return { id: r.id, item: r.item_id, kind: r.kind, key: r.key, severity: r.severity, found: r.found, ignored: !!r.ignored, action: r.action, actionAt: r.action_at,
      detail, actions: actionsOf(r), title: r.title, itemKind: r.ikind, season: r.season, episode: r.episode, year: r.year, show: r.show_title,
      library: r.library, libraryId: r.library_id, link: r.ikind === 'episode' ? r.parent_id : (r.version_of || r.item_id), file: r.path ? path.basename(r.path) : null };
  });
  const files = get('SELECT COUNT(*) AS n, MAX(checked) AS last FROM health_files');
  send(c.res, 200, { issues, overrides: health.overrides(), kinds: health.KINDS,
    status: { enabled: health.enabled(), running: health.running(), progress: health.progress(), last: health.lastPass(), files: files.n, checked: files.last },
    settings: { enabled: health.enabled(), samples: health.samples(), maxMbps: health.maxMbps() },
    arr: { movie: arr.configured('movie'), show: arr.configured('show') } });
});

route('POST', '/api/admin/health/run', admin, async (c) => {
  const b = await readJson(c.req).catch(() => ({}));
  if (!health.enabled()) return fail(c.res, 409, 'Hälsokontrollen är avstängd');
  if (b?.full) health.recheckAll(); else health.kick(200);
  audit('health_run', { ...ctx(c), detail: b?.full ? 'alla filer' : 'nya och ändrade' });
  send(c.res, 200, { ok: true });
});

route('PUT', '/api/admin/health/settings', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.enabled !== undefined) setSetting('health_enabled', b.enabled ? '1' : '0');
  if (b.samples !== undefined) { const n = Math.round(+b.samples); if (!(n >= 0 && n <= 20)) return fail(c.res, 400, 'Stickprov: 0–20'); setSetting('health_samples', String(n)); }
  if (b.maxMbps !== undefined) { const n = +b.maxMbps; if (!(n >= 1 && n <= 1000)) return fail(c.res, 400, 'Bithastighet: 1–1000 Mbit/s'); setSetting('health_max_mbps', String(n)); }
  if (health.enabled()) health.kick(1000);
  send(c.res, 200, { settings: { enabled: health.enabled(), samples: health.samples(), maxMbps: health.maxMbps() } });
});

const issueOf = (id) => get('SELECT h.*, i.kind AS ikind, i.tmdb_id, i.path, i.season, i.episode, i.parent_id, i.version_of, i.title FROM health_issues h JOIN items i ON i.id=h.item_id WHERE h.id=?', +id);

route('POST', '/api/admin/health/issues/:id/ignore', admin, async (c) => {
  const b = await readJson(c.req).catch(() => ({}));
  const r = issueOf(c.p.id); if (!r) return fail(c.res, 404, 'Finns inte');
  run('UPDATE health_issues SET ignored=? WHERE id=?', b?.ignored === false ? 0 : 1, r.id);
  send(c.res, 200, { ok: true });
});

const asked = new Map(); // fynd → senaste begäran (Radarr/Sonarr får inte samma sökning många gånger i rad)
route('POST', '/api/admin/health/issues/:id/replace', admin, async (c) => {
  const b = await readJson(c.req).catch(() => ({}));
  const r = issueOf(c.p.id); if (!r) return fail(c.res, 404, 'Finns inte');
  if (!REPLACE.has(r.kind) && r.kind !== 'missing') return fail(c.res, 400, 'Fyndet går inte att åtgärda med Radarr/Sonarr');
  const kind = r.ikind === 'movie' ? 'movie' : 'show', name = kind === 'movie' ? 'Radarr' : 'Sonarr';
  if (!arr.configured(kind)) return fail(c.res, 409, `${name} är inte kopplat – ställ in det under Administration → Sonarr, Radarr och Trakt`);
  if (Date.now() - (asked.get(r.id) || 0) < 5 * 60e3) return fail(c.res, 429, `${name} söker redan – vänta några minuter`);
  asked.set(r.id, Date.now());
  try {
    let out, what;
    if (r.kind === 'missing') {
      const show = get('SELECT * FROM items WHERE id=?', r.item_id);
      let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch {}
      const eps = (d.episodes || []).map(e => ({ season: d.season, episode: e }));
      const ep = get("SELECT path FROM items WHERE parent_id=? AND kind='episode' AND path IS NOT NULL LIMIT 1", show.id);
      out = await arr.searchEpisodes({ tmdbId: show.tmdb_id, tvdbId: show.tmdb_id ? await tvdbOf(show.tmdb_id) : null, path: ep?.path }, eps);
      if (out.notInSonarr) out.notInArr = true;
      what = `${show.title}: ${d.label || ''}`;
    } else {
      const main = r.ikind === 'movie' ? (r.version_of ? get('SELECT * FROM items WHERE id=?', r.version_of) : r) : get('SELECT * FROM items WHERE id=?', r.parent_id);
      const tmdbId = main?.tmdb_id || null;
      out = await arr.replaceFile({ kind: r.ikind, tmdbId, tvdbId: kind === 'show' && tmdbId ? await tvdbOf(tmdbId) : null, path: r.path, season: r.season, episode: r.episode },
        { blocklist: !!b?.blocklist });
      what = r.ikind === 'episode' ? `${main?.title || ''} S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}` : r.title;
    }
    if (out.notInArr) { asked.delete(r.id); return fail(c.res, 404, kind === 'movie' ? 'Filmen finns inte i Radarr' : 'Serien eller avsnittet finns inte i Sonarr'); }
    run('UPDATE health_issues SET action=?, action_at=? WHERE id=?', out.blocked ? 'blocklist' : 'search', now(), r.id);
    audit('health_replace', { ...ctx(c), detail: `${name}: ${what}${out.blocked ? ' (spärrad)' : ''}` });
    send(c.res, 200, { searched: out.searched || 0, blocked: out.blocked || 0 });
  } catch (e) { asked.delete(r.id); fail(c.res, 502, e.message); }
});

route('PUT', '/api/admin/health/lang', admin, async (c) => {
  const b = await readJson(c.req);
  const it = get("SELECT * FROM items WHERE id=? AND kind IN ('movie','episode') AND path IS NOT NULL", +b.item);
  if (!it) return fail(c.res, 404, 'Finns inte');
  const track = String(b.track || ''), lang = b.lang ? String(b.lang).toLowerCase() : null;
  if (!health.TRACK.test(track)) return fail(c.res, 400, 'Okänt spår');
  if (lang && !/^[a-z]{3}$/.test(lang)) return fail(c.res, 400, 'Språket anges med tre bokstäver (ISO 639-2), t.ex. swe');
  // Spåret måste finnas i filen (ljud/inbäddad undertext) eller bredvid den (undertextfil)
  const ok = /^a\d/.test(track) ? streamsOf(it).some(s => s.type === 'audio' && 'a' + s.index === track)
    : /^e\d/.test(track) ? streamsOf(it).some(s => s.type === 'subtitle' && 'e' + s.index === track)
    : subtitlesOf(it).some(s => s.file && `${s.source}:${path.basename(s.file)}` === track);
  if (!ok) return fail(c.res, 400, 'Spåret finns inte i filen');
  const orig = /^[ae]\d/.test(track) ? (JSON.parse(it.streams || '[]').find(s => (s.type === 'audio' ? 'a' : 'e') + s.index === track)?.lang ?? null) : null;
  health.setLang(it, track, lang, orig);
  libfilter.forget(it.id); // bibliotekets filter (ljud-/undertextspråk) räknas om
  audit('health_lang', { ...ctx(c), detail: `${it.title}: ${track} → ${lang || '(filens)'}` });
  send(c.res, 200, { ok: true });
});
