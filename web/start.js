// Startar appens första API-anrop direkt när sidan öppnas, parallellt med att modulerna laddas
// (klassiskt skript, async – körs innan modulträdet är klart). api() i js/core.js tar över svaren.
// Bara läsningar som alltid behövs, plus startsidans hyllor när man öppnar startsidan.
(() => {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('login')) return;
  const paths = ['/status', '/libraries', ...(h === '' ? ['/home', '/collections'] : [])];
  const at = Date.now();
  window.__early = Object.fromEntries(paths.map(p => [p, { at, res: fetch('/api' + p, { headers: {} }).catch(() => null) }]));
})();
