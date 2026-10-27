// HTTP-delen av servern: kopplar ihop skannerns krokar, laddar alla routes och startar bakgrundsjobben.
//   http/router.js   – route-registret och säkerhetsmodellen (handle)
//   http/static.js   – webbappens statiska filer och CSP
//   http/context.js  – hjälpfunktioner som flera routefiler delar
//   routes/*.js      – alla /api-routes, grupperade per område
// server/index.js startar http/https-servrarna med handle().
import { getSetting, refreshKeys } from './db.js';
import { hooks, scan, status as scanStatus } from './scanner.js';
import * as st from './stream.js';
import { detectMarkers } from './intro.js';
import * as act from './activity.js';
import * as trick from './trickplay.js';
import * as music from './music.js';
import * as arr from './arr.js';
import * as books from './audiobooks.js';
import * as bookmeta from './bookmeta.js';
import * as musicmeta from './musicmeta.js';
import * as follows from './follows.js';
import * as calendar from './calendar.js';
import { allowedFor, clearRecommendations } from './http/context.js';
import { clearHome } from './homeshelves.js';
import * as colors from './imgcolor.js';
import * as sonic from './sonic.js';
import * as webhooks from './webhooks.js';
import * as photos from './photos.js';
import { metadataOf, itemMeta } from './activity.js';
import * as libfilter from './libfilter.js';
import * as sublines from './sublines.js';
import * as prestart from './prestart.js';
// Routefilerna registrerar sina routes när de laddas. Ordningen är matchningsordningen (första träff vinner).
import './routes/auth.js';
import './routes/admin.js';
import './routes/setup.js';
import './routes/library.js';
import './routes/metadata.js'; // Redigera: fält med lås och bilder
import './routes/collections.js';
import './routes/search.js';
import './routes/music.js';
import './routes/ratings.js';
import './routes/playback.js';
import './routes/social.js';
import './routes/books.js';
import './routes/integrations.js';
import './routes/livetv.js';
import './routes/iptv.js'; // IPTV: kanaler per profil, rutnätsguide, catch-up, VOD, källor (efter livetv.js)
import './routes/calendar.js';
import './routes/subsonic.js'; // /rest/* (musikappar) och /api/me/subsonic
import './routes/remote.js';
import './routes/history.js';
import './routes/photos.js';
export { handle } from './http/router.js';

// Skanningen kontrollerar bara att nyckelbildsfilen finns (läser inte in alla listor i minnet)
hooks.keyframes = (it) => st.keyframesCached(it) ? null : st.computeKeyframes(it);
hooks.markers = (lib, status) => detectMarkers(lib, status);
hooks.trickplay = (lib, status) => trick.generateLibrary(lib, status);
// Artistbilder, biografier och albumtyper från nätet hämtas i bakgrunden efter musikskanningen (skanningen väntar inte)
hooks.music = async (lib, status) => { await music.scanMusic(lib, status); musicmeta.queue(lib.id); };
hooks.subtitlesOf = (it) => st.subtitlesOf(it);
// Söknycklar för nya och ändrade titlar räknas fram direkt (annars vid första sökningen)
hooks.afterScan = () => {
  clearRecommendations(); clearHome(); refreshKeys(null, Infinity);
  // Bibliotekens filter: ljud-/undertextspråk räknas om i bakgrunden (undertextfiler kan ha tillkommit)
  libfilter.clearFacets(); libfilter.afterScan();
  // Repliksökningen: nya och ändrade undertexter indexeras i bakgrunden, borttagna tas bort
  sublines.kick(5000);
  webhooks.emit('library.scan.done', { scan: { libraries: scanStatus.scanned || [], started: scanStatus.started, seconds: Math.max(0, (scanStatus.last || 0) - (scanStatus.started || 0)), warnings: scanStatus.warnings || [] } });
  return arr.markAvailable();
};
// Metadata och kapitel från nätet hämtas i bakgrunden efter skanningen (väntar inte – skanningskön går vidare)
hooks.audiobooks = async (lib, status) => { await books.scanBooks(lib, status); bookmeta.queue(lib.id); };
// Fotobibliotek: miniatyrerna görs i bakgrunden efter skanningen (och väntar medan video omkodas)
hooks.photos = (lib, status) => photos.scanPhotos(lib, status);
photos.setBusyCheck(() => st.activeTranscodes().length > 0);
photos.kickThumbs(30000);
// Snabbstart: startcachen kopplas in i strömningen; nya titlar har just lästs av skanningen (disken är vaken)
st.fastStart.direct = prestart.serveDirect;
st.fastStart.input = prestart.inputFor;
prestart.hooks.keyframes = (it) => st.keyframesCached(it) ? null : st.computeKeyframes(it);
prestart.start();
hooks.newEpisodes = (ids) => follows.onNewEpisodes(ids, (uid, it) => allowedFor(uid, it));
// Webhooks för nya titlar: en händelse per film/avsnitt – många nya avsnitt av samma serie (säsongspaket) blir en händelse
hooks.newItems = (ids) => {
  const rows = ids.map(itemMeta).filter(Boolean);
  prestart.touchIds(ids);
  const byShow = new Map();
  for (const r of rows) {
    if (r.kind !== 'episode') { webhooks.emit('library.new', { metadata: metadataOf(r) }, { visibleTo: (uid) => allowedFor(uid, r) }); continue; }
    if (!byShow.has(r.show_id)) byShow.set(r.show_id, []);
    byShow.get(r.show_id).push(r);
  }
  for (const list of byShow.values()) {
    const first = list.sort((a, b) => a.season - b.season || a.episode - b.episode)[0];
    const meta = { ...metadataOf(first), ...(list.length > 1 ? { newEpisodes: list.length, episodes: list.slice(0, 50).map(e => ({ id: e.id, season: e.season, episode: e.episode, title: e.title })) } : {}) };
    webhooks.emit('library.new', { metadata: meta }, { visibleTo: (uid) => list.some(e => allowedFor(uid, e)) });
  }
};

// Kalendern: avsnitt och sändningsdatum från TMDB, utspritt (pågående och följda serier en gång per dygn)
calendar.start();
// Platshållarfärger för bilder som saknar en (befintliga bibliotek) – i bakgrunden, en bild åt gången
colors.kick(20000);
// Filtrens fil-egenskaper för titlar som inte räknats än (t.ex. efter uppgradering)
setTimeout(() => libfilter.kickFacets(), 15000).unref();
// Ljudanalysen fortsätter där den slutade (efter omstart) och väntar medan video omkodas eller flera ljudströmmar kodas om
sonic.setBusyCheck(() => st.activeTranscodes().length > 0 || music.audioTranscodes() >= 2);
sonic.kick(60000);
// Repliksökningen fortsätter där den slutade och väntar medan video omkodas
sublines.setBusyCheck(() => st.activeTranscodes().length > 0);
sublines.kick(90000);

// Filbevakning: skanna direkt när filer läggs till/tas bort (med periodisk skanning som reserv)
setTimeout(() => act.watchLibraries(scan), 5000);

// Periodisk skanning
let lastAuto = Date.now();
setInterval(() => {
  const min = +getSetting('scan_interval', process.env.SCAN_INTERVAL || '60');
  if (min > 0 && Date.now() - lastAuto > min * 60000 && !scanStatus.running) { lastAuto = Date.now(); scan(); }
}, 30000).unref();
