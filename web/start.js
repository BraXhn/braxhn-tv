// Startar appens första API-anrop direkt när sidan öppnas, parallellt med att modulerna laddas
// (klassiskt skript, async – körs innan modulträdet är klart). api() i js/core.js tar över svaren.
// Bara läsningar som alltid behövs, plus startsidans hyllor när man öppnar startsidan och titeln vid en djuplänk.
// Visningsval för tillgänglighet (Mitt konto → Tillgänglighet, per enhet): textstorlek, minska rörelse och hög
// kontrast sätts innan sidan ritas – annars hoppar layouten när stilarna läses in.
(() => {
  try {
    const a = JSON.parse(localStorage.getItem('braxhn-tv.a11y') || 'null') || {};
    const r = document.documentElement, t = Math.max(100, Math.min(200, +a.text || 100));
    if (t !== 100) r.style.fontSize = t + '%';
    r.classList.toggle('reduce-motion', a.motion === 'reduce');
    r.classList.toggle('more-contrast', a.contrast === 'more');
    r.classList.toggle('bigtext', t >= 130); // menyraden: sidflikarna får inte plats (finns i Mer/användarmenyn)
  } catch {}
})();
(() => {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('login')) return;
  // Djuplänk till en titel: titeln också (om ingen version valts för den i webbläsaren, se views/item.js)
  const item = /^item\/(\d+)(?:\/|$)/.exec(h);
  let ver = null;
  try { ver = item && localStorage.getItem('braxhn-tv.version.' + item[1]); } catch {}
  const paths = ['/status', '/libraries', ...(h === '' ? ['/home', '/collections', '/custom-collections'] : item && !ver ? ['/items/' + item[1]] : [])];
  const at = Date.now();
  window.__early = Object.fromEntries(paths.map(p => [p, { at, res: fetch('/api' + p, { headers: {} }).catch(() => null) }]));
})();
