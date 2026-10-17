// BraXhn TV webbklient – ren JavaScript, inga ramverk. Startmodul: laddar alla moduler och startar appen.
// Modulerna ligger i /js/ (se CLAUDE.md). Vyerna registrerar sig i views när de laddas, därför importeras alla här.
// Nya moduler ska även läggas in i SHELL i sw.js så att appen kan starta utan kontakt med servern.
import { me } from './js/core.js';
import { boot, route } from './js/router.js';
import { initCast } from './js/player/cast.js';
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

initCast();

(async () => {
  try { await boot(); } catch {}
  if (!me) { location.hash = '#/login'; if (location.hash === '#/login') route(); }
  else { if (location.hash === '#/login') location.hash = '#/'; else route(); }
})();
