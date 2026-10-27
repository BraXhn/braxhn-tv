// BraXhn TV webbklient – ren JavaScript, inga ramverk. Startmodul: laddar startsidans moduler och startar appen.
// Modulerna ligger i /js/ (se CLAUDE.md). Bara det startsidan behöver importeras här (servern förladdar hela
// kedjan, server/http/static.js). Övriga vyer laddas av router.js första gången de öppnas (LAZY) och spelaren
// genom fasaderna i js/lazy.js – i förväg när sidan är ritad och när pekaren eller fokus når ett kort.
// Alla moduler ska även finnas i MODULES i sw.js så att appen kan starta utan kontakt med servern.
import { me, rememberPage } from './js/core.js';
import { boot, prefetchView, route } from './js/router.js';
import { idle, loadPlayer, need, pageDrawn } from './js/lazy.js';
import { initCardMenus } from './js/ui/cardmenu.js';
import { initCardSize, initShelves } from './js/ui/shelves.js';
import './js/screentime.js';
import './js/views/home.js';

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

initCardMenus();
initShelves();
initCardSize();

// Djuplänk (#/item/…, #/music/… …): vyns moduler hämtas redan nu, parallellt med inloggningskontrollen
prefetchView(location.hash.slice(2).split('/')[0] || 'home');

(async () => {
  try { await boot(); } catch {}
  // Djuplänk utan inloggning (t.ex. QR-koden för inloggning med kod): öppnas efter inloggningen
  if (!me && location.hash.startsWith('#/invite/')) route(); // inbjudan: skapa konto utan att logga in först
  else if (!me) { rememberPage(); location.hash = '#/login'; if (location.hash === '#/login') route(); }
  else { if (location.hash === '#/login') location.hash = '#/'; else await route(); }
  // När sidan är ritad: spelaren (med Chromecast), titelsidan och sökningen i förväg – första klicket ska inte vänta
  pageDrawn();
  idle(() => {
    loadPlayer().then(() => need('player/cast.js')).then(m => m.initCast()).catch(() => {});
    if (me) { need('views/item.js').catch(() => {}); need('views/search.js').catch(() => {}); }
  });
})();
