// BraXhn TV webbklient – ren JavaScript, inga ramverk. Startmodul: laddar alla moduler och startar appen.
// Modulerna ligger i /js/ (se CLAUDE.md). Vyerna registrerar sig i views när de laddas, därför importeras alla här.
// Nya moduler ska även läggas in i SHELL i sw.js så att appen kan starta utan kontakt med servern.
import { me } from './js/core.js';
import { boot, route } from './js/router.js';
import { initCast } from './js/player/cast.js';
import { initCardMenus } from './js/ui/cardmenu.js';
import { initCardSize, initShelves } from './js/ui/shelves.js';
import './js/player/overlay.js';
import './js/player/live.js';
import './js/player/video.js';
import './js/player/party.js';
import './js/audio.js';
import './js/screentime.js';
import './js/views/login.js';
import './js/views/home.js';
import './js/views/item.js';
import './js/views/person.js';
import './js/views/wrapped.js';
import './js/views/account.js';
import './js/views/books.js';
import './js/views/live.js';
import './js/views/streaming.js';
import './js/views/requests.js';
import './js/views/stats.js';
import './js/views/admin.js';
import './js/views/music.js';

// Fel i appen rapporteras till serverloggen (Administration → Logg) – bara egna skript och högst fem per sidvisning
let reported = 0;
const report = (msg, stack, where) => {
  if (!me || ++reported > 5) return;
  fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ msg: String(msg).slice(0, 300), stack: String(stack || '').slice(0, 1500), where: `${location.hash} ${where || ''}`.slice(0, 200), ua: navigator.userAgent }) }).catch(() => {});
};
addEventListener('error', (e) => { if (e.filename?.startsWith(location.origin)) report(e.message, e.error?.stack, `${e.filename.replace(location.origin, '')}:${e.lineno}`); });
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  // Avbrutna anrop (navigering) och nätverksfel är inga programfel
  if (!r || r.name === 'AbortError' || r.aborted || r.offline || r.code || (typeof r === 'object' && 'data' in r) || /^Fel \d|Inte inloggad/.test(r.message || '')) return;
  if (r instanceof Error && !(r.stack || '').includes(location.origin)) return;
  report(r.message || r, r.stack);
});

initCast();
initCardMenus();
initShelves();
initCardSize();

(async () => {
  try { await boot(); } catch {}
  if (!me) { location.hash = '#/login'; if (location.hash === '#/login') route(); }
  else { if (location.hash === '#/login') location.hash = '#/'; else route(); }
})();
