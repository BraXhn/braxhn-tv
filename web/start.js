// Startar appens första API-anrop direkt när sidan öppnas, parallellt med att modulerna laddas
// (klassiskt skript, async – körs innan modulträdet är klart). api() i js/core.js tar över svaren.
// Bara läsningar som alltid behövs, plus startsidans hyllor (med samlingarna, ?web=1) när man öppnar startsidan och
// titeln vid en djuplänk. Skriptet ligger direkt i index.html (server/http/static.js), så anropen startar direkt.
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
  const at = Date.now(), early = {};
  const get = (p) => { early[p] = { at, res: fetch('/api' + p, { headers: {}, priority: 'high' }).catch(() => null) }; };
  if (!h.startsWith('login')) {
    // Djuplänk till en titel: titeln också (om ingen version valts för den i webbläsaren, se views/item.js)
    const item = /^item\/(\d+)(?:\/|$)/.exec(h);
    let ver = null;
    try { ver = item && localStorage.getItem('braxhn-tv.version.' + item[1]); } catch {}
    ['/status', ...(h === '' ? ['/home?web=1'] : item && !ver ? ['/items/' + item[1]] : [])].forEach(get);
  }
  // Startens moduler (self.__preload, server/http/static.js) förladdas först nu – efter API-anropen ovan, som annars
  // fick vänta på en ledig anslutning bakom modulerna. /libraries behövs först efter /status och modulerna och får vänta.
  for (const href of self.__preload || []) { const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = href; document.head.append(l); }
  if (!h.startsWith('login')) get('/libraries');
  window.__early = early;
})();
