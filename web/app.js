// BraXhn TV webbklient – ren JavaScript, inga ramverk. Startmodul: laddar alla moduler och startar appen.
// Modulerna ligger i /js/ (se CLAUDE.md). Vyerna registrerar sig i views när de laddas, därför importeras de här –
// utom sällan använda vyer (administration, statistik, live-TV …), som router.js laddar första gången de öppnas (LAZY).
// Nya moduler ska även läggas in i SHELL i sw.js så att appen kan starta utan kontakt med servern.
import { me, rememberPage } from './js/core.js';
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
import './js/views/quickconnect.js';
import './js/views/home.js';
import './js/views/collections.js';
import './js/views/search.js';
import './js/views/item.js';
import './js/views/person.js';
import './js/views/account.js';
import './js/views/books.js';
import './js/views/calendar.js';
import './js/views/setup.js';
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

// Googles Cast-bibliotek (från gstatic.com) först när sidan visats – behövs bara för att casta
const idle = (fn, ms) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: ms }) : setTimeout(fn, ms));
idle(() => initCast(), 2500);
initCardMenus();
initShelves();
initCardSize();

(async () => {
  try { await boot(); } catch {}
  // Djuplänk utan inloggning (t.ex. QR-koden för inloggning med kod): öppnas efter inloggningen
  if (!me && location.hash.startsWith('#/invite/')) route(); // inbjudan: skapa konto utan att logga in först
  else if (!me) { rememberPage(); location.hash = '#/login'; if (location.hash === '#/login') route(); }
  else { if (location.hash === '#/login') location.hash = '#/'; else route(); }
})();
