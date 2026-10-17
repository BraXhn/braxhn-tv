// Service worker: gör BraXhn TV installerbar som app och låter den starta även när servern inte svarar.
// Appens egna filer hämtas alltid från servern först (en ny version syns direkt) och tas ur cachen bara
// utan kontakt. API-anrop, strömmar och bilder går aldrig genom cachen.
const CACHE = 'braxhn-app-v5';
// Webbklientens moduler i /js/ måste finnas med här (annars startar appen inte utan kontakt med servern)
const MODULES = ['core.js', 'router.js', 'passkeys.js', 'screentime.js', 'audio.js', 'audio-extras.js',
  'ui/cards.js', 'ui/icons.js', 'ui/dialog.js', 'ui/states.js', 'ui/buttons.js', 'ui/tabs.js', 'ui/menu.js', 'ui/cardmenu.js', 'ui/activity.js', 'ui/shelves.js',
  'player/overlay.js', 'player/video.js', 'player/controls.js', 'player/subs.js', 'player/caps.js', 'player/cast.js', 'player/live.js', 'player/party.js',
  'views/login.js', 'views/home.js', 'views/item.js', 'views/person.js', 'views/wrapped.js', 'views/account.js', 'views/books.js', 'views/live.js',
  'views/streaming.js', 'views/requests.js', 'views/stats.js', 'views/admin.js', 'views/admin-ops.js', 'views/music.js'].map(f => '/js/' + f);
const SHELL = ['/app.js', ...MODULES, '/style.css', '/icon.svg', '/icon.png', '/manifest.webmanifest', '/brand/logo.svg',
  '/brand/icon-192.png', '/brand/icon-512.png', '/vendor/hls.min.js', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (!SHELL.includes(u.pathname)) return;
  e.respondWith(fetch(r, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(u.pathname, copy)); }
    return res;
  }).catch(() => caches.match(u.pathname)));
});
