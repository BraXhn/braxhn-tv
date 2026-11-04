// Service worker: gör BraXhn TV installerbar som app och låter den starta även när servern inte svarar.
// Appens filer har en innehållshash i adressen (/m/<fil>?h=<hash>, server/http/static.js) och ändras aldrig på
// samma adress – de tas ur cachen direkt. Ett nytt bygge ger en ny sw.js (bygget och hasharna står nedan); vid
// installationen hämtas bara filer vars hash är ny, resten kopieras från den gamla cachen.
// Ett bygge i taget: cachen innehåller bara filer och sidor från det här bygget (BUILD). En fil med hash sparas bara
// när servern bekräftar hashen (immutable – annars har servern hunnit uppdateras och installationen görs om senare),
// och en sida bara när dess <meta name="bx-build"> är BUILD. Gamla och nya moduler blandas därför aldrig.
// Sidan själv (navigering) hämtas från servern först; svarar den inte inom NAV_TIMEOUT, eller inte alls, används
// sidan från samma bygge ur cachen, så att appen startar och visar Nedladdat (web/js/offline.js, egen cache
// 'braxhn-dl-v1' som aldrig rensas här). En gammal eller trasig sida i cachen visas alltså aldrig när servern svarar,
// och en ny version tas i bruk vid nästa start utan att något behöver rensas (skipWaiting + clients.claim).
// Startskriptets vakthund (web/start.js) och /reset (server/http/static.js) är nödvägarna om något ändå fastnar.
// API-anrop, strömmar och bilder går aldrig genom cachen.
const BUILD = '{{b}}';
const V = `/v/${BUILD}`;
const CACHE = 'braxhn-app-' + BUILD;
// Webbklientens moduler i /js/ måste finnas med här (annars startar appen inte utan kontakt med servern)
const MODULES = ['core.js', 'router.js', 'lazy.js', 'passkeys.js', 'screentime.js', 'audio.js', 'audio-extras.js', 'sonic.js', 'musicinfo.js', 'ui/cards.js', 'ui/icons.js', 'ui/dialog.js', 'ui/states.js', 'ui/buttons.js', 'ui/tabs.js', 'ui/menu.js', 'ui/cardmenu.js', 'ui/activity.js', 'ui/shelves.js', 'ui/collections.js', 'player/overlay.js', 'player/video.js', 'player/controls.js', 'player/subs.js', 'player/caps.js', 'player/cast.js', 'player/live.js', 'player/party.js', 'views/login.js', 'views/home.js', 'views/collections.js', 'views/item.js', 'views/person.js', 'views/wrapped.js', 'views/account.js', 'views/books.js', 'views/booktools.js', 'views/live.js', 'views/streaming.js', 'views/requests.js', 'views/calendar.js', 'views/stats.js', 'views/admin.js', 'views/admin-ops.js', 'views/historyimport.js', 'views/admin-users.js', 'views/music.js', 'views/quickconnect.js', 'views/search.js', 'player/comfort.js', 'views/setup.js', 'player/cinema.js', 'player/remote.js', 'ui/featured.js', 'views/homecustom.js', 'views/history.js', 'views/webhooks.js', 'player/autoskip.js', 'player/playprefs.js', 'player/stall.js', 'views/photos.js', 'ui/libfilter.js', 'views/itemedit.js', 'ui/rating.js', 'ui/thememusic.js', 'player/subsync.js', 'views/dvr.js', 'offline.js', 'views/downloads.js', 'views/searchlines.js', 'player/iptv.js', 'views/epg.js', 'views/vod.js', 'views/iptvadmin.js', 'views/health.js', 'views/shrink.js', 'audioengine.js', 'audiomix.js', 'player/familyfilter.js', 'familyprefs.js', 'views/tonight.js', 'views/sso.js', 'views/ebooks.js', 'views/reader.js', 'reader/epub.js', 'reader/comic.js', 'player/learn.js', 'views/vocab.js', 'player/musicvideo.js', 'player/moments.js', 'views/moments.js', 'player/recap.js', 'player/hlsconfig.js', 'player/stats.js', 'ui/spatial.js', 'views/family.js', 'views/admin-relay.js'].map(f => '/js/' + f);
const HASH = JSON.parse('{{hashes}}');
const hashed = (f) => HASH[f.slice(1)] ? `/m${f}?h=${HASH[f.slice(1)]}` : V + f;
const SHELL = [...['/app.js', '/i18n/en.js', ...MODULES, '/style.css', '/vendor/hls.min.js'].map(hashed),
  '/icon.svg', '/icon.png', '/manifest.webmanifest', '/brand/logo.svg', '/brand/icon-192.png', '/brand/icon-512.png', '/offline.html', '/'];
const versioned = (p) => p.startsWith('/m/') || p.startsWith(V + '/');
// Servern svarar immutable bara när hashen/bygget i adressen stämmer med filen (server/http/static.js)
const confirmed = (res) => res.ok && /immutable/.test(res.headers.get('cache-control') || '');

self.addEventListener('install', (e) => {
  // Oförändrade filer (samma hash) kopieras från förra versionens cache i stället för att hämtas igen. En fil eller
  // sida från ett annat bygge stoppar installationen (den görs om vid nästa besök) i stället för att blandas in.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(async (url) => {
    const old = versioned(url) && await caches.match(url);
    if (old) return c.put(url, old);
    const res = await fetch(url, { cache: 'no-cache' });
    if (versioned(url) && !confirmed(res)) throw new Error('annat bygge: ' + url);
    if (url === '/') {
      if (!(await savePage(res.clone()))) throw new Error('annat bygge: /');
    }
    if (res.ok) await c.put(url, res);
  }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // Bara appens gamla cacher – nedladdningarna (braxhn-dl-*) ligger kvar. Förra byggets cache får finnas kvar ett dygn:
  // en sida som startade ur cachen före uppdateringen hämtar sina moduler (även de som laddas vid behov) därifrån i
  // stället för att blanda dem med det nya byggets.
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && !k.startsWith('braxhn-dl-')).map(async (k) => {
    const c = await caches.open(k), mark = await c.match('/__retired');
    if (!mark) return k.startsWith('braxhn-app-') ? c.put('/__retired', new Response(String(Date.now()))) : caches.delete(k);
    if (Date.now() - (+(await mark.text()) || 0) > RETIRE_MS) return caches.delete(k);
  }))).then(() => self.clients.claim()));
});
const RETIRE_MS = 24 * 3600e3;
// Startsidan: från servern först. Svarar den inte inom NAV_TIMEOUT (eller inte alls) används sidan ur cachen – samma
// bygge som service workern, per språk (server/http/static.js ger sidan i två språk) när språket går att läsa ur kakan
// bxlang (Cookie Store API), annars sidan från installationen. Varje svar från servern sparas till nästa gång (bara
// om det hör till det här bygget). Förr kom sidan ur cachen först: en trasig sida i cachen visades då om och om igen.
const NAV_TIMEOUT = 3000;
const pageKey = (l) => '/__page/' + (l === 'en' ? 'en' : 'sv');
async function wantedLang() {
  try { const c = await self.cookieStore?.get('bxlang'); return c?.value === 'en' || c?.value === 'sv' ? c.value : null; } catch { return null; }
}
/** Sparar sidan om den hör till det här bygget – true när den sparats */
async function savePage(res) {
  if (res.status !== 200 || res.type !== 'basic' || !/text\/html/.test(res.headers.get('content-type') || '')) return false;
  const html = await res.clone().text();
  const l = /<html lang="(sv|en)"/.exec(html)?.[1];
  if (!l || !html.includes(`<meta name="bx-build" content="${BUILD}">`)) return false;
  await (await caches.open(CACHE)).put(pageKey(l), res);
  return true;
}
async function cachedPage() {
  const l = await wantedLang();
  return (l && await caches.match(pageKey(l), { cacheName: CACHE })) || caches.match('/', { cacheName: CACHE });
}
function startPage(e) {
  const net = fetch(e.request);
  e.waitUntil(net.then(res => savePage(res.clone())).catch(() => {}));
  return new Promise((resolve) => {
    let done = false;
    const give = (res) => { if (!done && res) { done = true; clearTimeout(timer); resolve(res); } };
    const fromCache = () => cachedPage().catch(() => null);
    // Servern är långsam: sidan ur cachen om den finns, annars vänta vidare på servern
    const timer = setTimeout(() => fromCache().then(give), NAV_TIMEOUT);
    net.then((res) => {
      // Serverfel (502 från en omvänd proxy medan containern startar om …): hellre sidan ur cachen
      if (res.status >= 500) return fromCache().then(hit => give(hit || res));
      give(res);
    }, async () => give((await fromCache()) || (await caches.match('/offline.html')) || Response.error()));
  });
}
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (r.mode === 'navigate') {
    // Startsidan (även hemskärmsappens /?app=1 och vakthundens /?bxheal=…): servern först, cachen som reserv
    if (u.pathname === '/') { e.respondWith(startPage(e)); return; }
    // /reset (nödvägen) och andra sidor: alltid från servern, annars en enkel sida om att servern inte nås
    e.respondWith(fetch(r).catch(async () => (u.pathname !== '/offline.html' && u.pathname !== '/reset' && await caches.match('/', { cacheName: CACHE })) || caches.match('/offline.html')));
    return;
  }
  const key = u.pathname + u.search;
  // En fil med hash som inte hör till det här bygget: ur förra byggets cache om sidan är därifrån, annars från servern
  if (u.pathname.startsWith('/m/') && !SHELL.includes(key)) { e.respondWith(caches.match(key).then(hit => hit || fetch(r))); return; }
  if (!SHELL.includes(key) && !SHELL.includes(u.pathname)) return;
  // Versionerade filer: cachen först (samma adress = samma innehåll)
  if (versioned(u.pathname) && SHELL.includes(key)) {
    e.respondWith(caches.match(key).then(hit => hit || fetch(r).then(res => {
      if (confirmed(res)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    })));
    return;
  }
  if (u.pathname === '/') return; // sidan sparas bara via savePage (byggkontrollen)
  e.respondWith(fetch(r, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(u.pathname, copy)); }
    return res;
  }).catch(() => caches.match(u.pathname)));
});
