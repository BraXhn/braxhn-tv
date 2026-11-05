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
import * as booktools from './booktools.js';
import * as musicmeta from './musicmeta.js';
import * as follows from './follows.js';
import * as calendar from './calendar.js';
import { allowedFor, clearRecommendations } from './http/context.js';
import { clearHome } from './homeshelves.js';
import * as colors from './imgcolor.js';
import * as sonic from './sonic.js';
import * as gapless from './gapless.js';
import * as webhooks from './webhooks.js';
import * as photos from './photos.js';
import * as ebooks from './ebooks.js';
import { metadataOf, itemMeta } from './activity.js';
import * as libfilter from './libfilter.js';
import * as sublines from './sublines.js';
import * as prestart from './prestart.js';
import * as health from './health.js';
import * as family from './familyfilter.js';
import * as jobs from './jobs.js';
import './loopmon.js'; // händelseslingans fördröjning (Statistik, diagnos vid hack)
import * as envcheck from './envcheck.js'; // minnesgräns (cgroup), kärnor, miljöfel till säkerhetskontrollen
// Routefilerna registrerar sina routes när de laddas. Ordningen är matchningsordningen (första träff vinner).
import './routes/auth.js';
import './routes/sso.js'; // enkel inloggning: OIDC, bekräftad koppling, Mitt konto och administration
import './routes/admin.js';
import './routes/health.js'; // hälsokontroll av biblioteket (admin)
import './routes/shrink.js'; // diskrådgivaren: analys och omkodning till HEVC/AV1 (admin)
import './routes/setup.js';
import './routes/library.js';
import './routes/metadata.js'; // Redigera: fält med lås och bilder
import './routes/collections.js';
import './routes/search.js';
import './routes/music.js';
import './routes/ratings.js';
import './routes/playback.js';
import './routes/vocab.js'; // språkinlärningens ordlista per profil, export till Anki och ljudklipp
import './routes/moments.js'; // Ögonblick: klipp som hushållet delar, reaktioner, kommentarer och externa länkar (/api/share/*)
import './routes/recap.js'; // "Det här har hänt": sammanfattning av förra säsongen ur de egna filerna (/api/items/:id/recap, /api/recaps/*)
import './routes/familyfilter.js'; // familjefilter: profilens läge, scener att hoppa över, ordlistor (admin)
import './routes/social.js';
import './routes/parents.js'; // Föräldraöversikt: barnprofilernas tittande och skärmtid för huvudkontot (/api/parents*)
import './routes/books.js';
import './routes/integrations.js';
import './routes/livetv.js';
import './routes/iptv.js'; // IPTV: kanaler per profil, rutnätsguide, catch-up, VOD, källor (efter livetv.js)
import './routes/calendar.js';
import './routes/subsonic.js'; // /rest/* (musikappar) och /api/me/subsonic
import './routes/remote.js';
import './routes/tonight.js'; // Kvällsvalet: hushållet röstar fram filmen
import './routes/history.js';
import './routes/photos.js';
import './routes/ebooks.js'; // e-böcker och serietidningar, lösenord för läsappar och OPDS (/api/opds/*)
import './routes/privacy.js'; // personuppgifter: sidan Integritet, export av egna uppgifter och radering av eget konto
import './routes/relay.js'; // fjärråtkomst via BraXhn Relay: parning och status (/api/relay, admin)
import { handle } from './http/router.js';
import * as relay from './relay.js';
export { handle };

// BraXhn Relay: hemservern ansluter utgående till reläet när den är parad (server/relay.js). Förfrågningarna genom
// tunneln går till samma handle() men räknas alltid som utanför hemmet.
relay.start(handle);

// Någon tittar: en HLS-ström hämtas (segment de senaste 20 s) eller en uppspelning (även direkt) skickar framsteg och
// är inte pausad. Alla bakgrundsjobb väntar då eller går långsamt (jobs.yieldToPlayback, busy-kontrollerna nedan).
jobs.setWatching(() => st.streamingNow() || act.watchingNow());
const busy = () => st.activeTranscodes().length > 0 || jobs.watching();
// Skanningen kontrollerar bara att nyckelbildsfilen finns (läser inte in alla listor i minnet)
hooks.keyframes = (it) => st.keyframesCached(it) ? null : st.computeKeyframes(it);
hooks.keyframesCached = (it) => st.keyframesCached(it);
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
  // Hälsokontrollen: nya och ändrade filer kontrolleras i bakgrunden, hela biblioteket räknas om ur databasen
  health.kick(30000);
  webhooks.emit('library.scan.done', { scan: { libraries: scanStatus.scanned || [], started: scanStatus.started, seconds: Math.max(0, (scanStatus.last || 0) - (scanStatus.started || 0)), warnings: scanStatus.warnings || [] } });
  return arr.markAvailable();
};
// Metadata och kapitel från nätet hämtas i bakgrunden efter skanningen (väntar inte – skanningskön går vidare)
hooks.audiobooks = async (lib, status) => { await books.scanBooks(lib, status); bookmeta.queue(lib.id); };
// Ljudböckernas verktyg (kapitel in i filen, sammanslagning, ångra) skannar om biblioteket efter bytet
booktools.setRescan((libId) => scan(libId));
// Fotobibliotek: miniatyrerna görs i bakgrunden efter skanningen (och väntar medan video omkodas)
hooks.photos = (lib, status) => photos.scanPhotos(lib, status);
// E-böcker och serietidningar (ebooks.js): metadata och omslag ur filerna
hooks.ebooks = (lib, status) => ebooks.scanEbooks(lib, status);
photos.setBusyCheck(busy);
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

// Containerns minnesgräns: nära gränsen töms cacherna i minnet (de byggs upp igen vid behov)
envcheck.onMemoryPressure(() => { clearRecommendations(); clearHome(); });
envcheck.startMemoryWatch();

// Kalendern: avsnitt och sändningsdatum från TMDB, utspritt (pågående och följda serier en gång per dygn)
calendar.start();
// Platshållarfärger för bilder som saknar en (befintliga bibliotek) – i bakgrunden, en bild åt gången
colors.kick(20000);
// Filtrens fil-egenskaper för titlar som inte räknats än (t.ex. efter uppgradering)
setTimeout(() => libfilter.kickFacets(), 15000).unref();
// Ljudanalysen fortsätter där den slutade (efter omstart) och väntar medan video omkodas eller flera ljudströmmar kodas om
sonic.setBusyCheck(() => busy() || music.audioTranscodes() >= 2);
sonic.kick(60000);
// Glapplöst/övertoning: trim och tystnad i kanterna för spår som inte analyserats (lägsta prioritet, väntar under omkodning)
gapless.setBusyCheck(() => busy() || music.audioTranscodes() >= 2);
gapless.kick(75000);
// Repliksökningen fortsätter där den slutade och väntar medan video omkodas
sublines.setBusyCheck(busy);
sublines.kick(90000);
// Hälsokontrollen: rättad språkmärkning läggs på spåren; jobbet väntar medan något spelas eller kodas om
st.setLangFix(health.langFixFor);
// Familjefiltret: HLS-strömmar med ff=1 tystar svordomarna med ett volymfilter (apparna, Chromecast)
st.setMuteHook((it, uid, audio, off) => {
  const a = audio !== '' ? st.streamsOf(it).find(x => x.type === 'audio' && String(x.index) === String(audio)) : null;
  return family.modeFor(uid) === 'off' ? [] : family.muteFilters(family.muteIntervals(it, a?.lang), off);
});
// Påtvingat familjefilter (barnprofiler): HLS-sessionen tystas även om ff=1 tagits bort ur adressen
st.setFamilyForce((uid, it, audio) => {
  if (!family.enforced(uid)) return false;
  const a = audio !== '' ? st.streamsOf(it).find(x => x.type === 'audio' && String(x.index) === String(audio)) : null;
  return family.muteIntervals(it, a?.lang).length > 0;
});
health.setBusyCheck(() => busy() || act.listActive().length > 0);
health.kick(+(process.env.HEALTH_START_DELAY ?? 120000));

// Filbevakning: skanna direkt när filer läggs till/tas bort (med periodisk skanning som reserv)
setTimeout(() => act.watchLibraries(scan), 5000);

// Periodisk skanning
let lastAuto = Date.now();
setInterval(() => {
  const min = +getSetting('scan_interval', process.env.SCAN_INTERVAL || '60');
  if (min > 0 && Date.now() - lastAuto > min * 60000 && !scanStatus.running) { lastAuto = Date.now(); scan(); }
}, 30000).unref();
