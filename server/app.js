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
import * as follows from './follows.js';
import * as calendar from './calendar.js';
import { allowedFor, clearRecommendations } from './http/context.js';
import * as colors from './imgcolor.js';
// Routefilerna registrerar sina routes när de laddas. Ordningen är matchningsordningen (första träff vinner).
import './routes/auth.js';
import './routes/admin.js';
import './routes/setup.js';
import './routes/library.js';
import './routes/collections.js';
import './routes/search.js';
import './routes/music.js';
import './routes/playback.js';
import './routes/social.js';
import './routes/books.js';
import './routes/integrations.js';
import './routes/livetv.js';
import './routes/calendar.js';
import './routes/subsonic.js'; // /rest/* (musikappar) och /api/me/subsonic
export { handle } from './http/router.js';

// Skanningen kontrollerar bara att nyckelbildsfilen finns (läser inte in alla listor i minnet)
hooks.keyframes = (it) => st.keyframesCached(it) ? null : st.computeKeyframes(it);
hooks.markers = (lib, status) => detectMarkers(lib, status);
hooks.trickplay = (lib, status) => trick.generateLibrary(lib, status);
hooks.music = (lib, status) => music.scanMusic(lib, status);
hooks.subtitlesOf = (it) => st.subtitlesOf(it);
// Söknycklar för nya och ändrade titlar räknas fram direkt (annars vid första sökningen)
hooks.afterScan = () => { clearRecommendations(); refreshKeys(null, Infinity); return arr.markAvailable(); };
// Metadata och kapitel från nätet hämtas i bakgrunden efter skanningen (väntar inte – skanningskön går vidare)
hooks.audiobooks = async (lib, status) => { await books.scanBooks(lib, status); bookmeta.queue(lib.id); };
hooks.newEpisodes = (ids) => follows.onNewEpisodes(ids, (uid, it) => allowedFor(uid, it));

// Kalendern: avsnitt och sändningsdatum från TMDB, utspritt (pågående och följda serier en gång per dygn)
calendar.start();
// Platshållarfärger för bilder som saknar en (befintliga bibliotek) – i bakgrunden, en bild åt gången
colors.kick(20000);

// Filbevakning: skanna direkt när filer läggs till/tas bort (med periodisk skanning som reserv)
setTimeout(() => act.watchLibraries(scan), 5000);

// Periodisk skanning
let lastAuto = Date.now();
setInterval(() => {
  const min = +getSetting('scan_interval', process.env.SCAN_INTERVAL || '60');
  if (min > 0 && Date.now() - lastAuto > min * 60000 && !scanStatus.running) { lastAuto = Date.now(); scan(); }
}, 30000).unref();
