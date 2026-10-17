// Service worker: gör BraXhn TV installerbar som app och låter den starta även när servern inte svarar.
// Appens egna filer hämtas alltid från servern först (en ny version syns direkt) och tas ur cachen bara
// utan kontakt. API-anrop, strömmar och bilder går aldrig genom cachen.
const CACHE = 'braxhn-app-v2';
const SHELL = ['/app.js', '/style.css', '/icon.svg', '/icon.png', '/manifest.webmanifest', '/brand/logo.svg',
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
