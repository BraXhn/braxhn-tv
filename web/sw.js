// Service worker: gör BraXhn TV installerbar som app och låter den starta även när servern inte svarar.
// Appens filer har en innehållshash i adressen (/m/<fil>?h=<hash>, server/http/static.js) och ändras aldrig på
// samma adress – de tas ur cachen direkt. Ett nytt bygge ger en ny sw.js (bygget och hasharna står nedan); vid
// installationen hämtas bara filer vars hash är ny, resten kopieras från den gamla cachen. Sidan själv hämtas
// alltid från servern. API-anrop, strömmar och bilder går aldrig genom cachen.
const BUILD = '{{b}}';
const V = `/v/${BUILD}`;
const CACHE = 'braxhn-app-' + BUILD;
// Webbklientens moduler i /js/ måste finnas med här (annars startar appen inte utan kontakt med servern)
const MODULES = ['core.js', 'router.js', 'lazy.js', 'passkeys.js', 'screentime.js', 'audio.js', 'audio-extras.js', 'sonic.js', 'musicinfo.js', 'ui/cards.js', 'ui/icons.js', 'ui/dialog.js', 'ui/states.js', 'ui/buttons.js', 'ui/tabs.js', 'ui/menu.js', 'ui/cardmenu.js', 'ui/activity.js', 'ui/shelves.js', 'ui/collections.js', 'player/overlay.js', 'player/video.js', 'player/controls.js', 'player/subs.js', 'player/caps.js', 'player/cast.js', 'player/live.js', 'player/party.js', 'views/login.js', 'views/home.js', 'views/collections.js', 'views/item.js', 'views/person.js', 'views/wrapped.js', 'views/account.js', 'views/books.js', 'views/live.js', 'views/streaming.js', 'views/requests.js', 'views/calendar.js', 'views/stats.js', 'views/admin.js', 'views/admin-ops.js', 'views/admin-users.js', 'views/music.js', 'views/quickconnect.js', 'views/search.js', 'player/comfort.js', 'views/setup.js', 'player/cinema.js', 'player/remote.js', 'ui/featured.js', 'views/homecustom.js', 'views/history.js', 'views/webhooks.js', 'player/autoskip.js', 'player/playprefs.js', 'views/photos.js', 'ui/libfilter.js', 'views/itemedit.js'].map(f => '/js/' + f);
const HASH = JSON.parse('{{hashes}}');
const hashed = (f) => HASH[f.slice(1)] ? `/m${f}?h=${HASH[f.slice(1)]}` : V + f;
const SHELL = [...['/app.js', '/start.js', ...MODULES, '/style.css', '/vendor/hls.min.js'].map(hashed),
  '/icon.svg', '/icon.png', '/manifest.webmanifest', '/brand/logo.svg', '/brand/icon-192.png', '/brand/icon-512.png', '/offline.html'];
const versioned = (p) => p.startsWith('/m/') || p.startsWith(V + '/');

self.addEventListener('install', (e) => {
  // Oförändrade filer (samma hash) kopieras från förra versionens cache i stället för att hämtas igen
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(async (url) => {
    const old = versioned(url) && await caches.match(url);
    if (old) return c.put(url, old);
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) await c.put(url, res);
  }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  // Sidan själv: från servern, annars en enkel sida om att servern inte nås
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).catch(() => caches.match('/offline.html')));
    return;
  }
  const key = u.pathname + u.search;
  if (!SHELL.includes(key) && !SHELL.includes(u.pathname)) return;
  // Versionerade filer: cachen först (samma adress = samma innehåll)
  if (versioned(u.pathname) && SHELL.includes(key)) {
    e.respondWith(caches.match(key).then(hit => hit || fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(r, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(u.pathname, copy)); }
    return res;
  }).catch(() => caches.match(u.pathname)));
});
