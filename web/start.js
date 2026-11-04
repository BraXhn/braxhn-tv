// Startar appens första API-anrop direkt när sidan öppnas, parallellt med att modulerna laddas
// (klassiskt skript, async – körs innan modulträdet är klart). api() i js/core.js tar över svaren.
// Bara läsningar som alltid behövs, plus startsidans hyllor (med samlingarna, ?web=1) när man öppnar startsidan och
// titeln vid en djuplänk. Skriptet ligger direkt i index.html (server/http/static.js), så anropen startar direkt.
//
// Vakthund för starten: appen får aldrig fastna på laddningen så att användaren inte kommer ur det själv (incident
// 2026-11-03: en sida med startskriptet före import map hängde för evigt i Safari vid varm start ur service workerns
// cache, även efter omstart av servern). web/app.js anropar self.__bxBooted() när första sidan är ritad. Har det inte
// skett inom 10 s (20 s på långsamt nät), eller har ett skript/en modul från servern fallerat före det:
//  - servern svarar inte (/api/health) → cachen rörs inte (den behövs för att starta utan nät); vänta, efter 60 s en
//    sida om att servern inte svarar
//  - servern svarar men något går fortfarande framåt (anrop pågår, filer kommer in, långsamt svar) → vänta, högst 60 s
//  - annars (modulerna laddade men starten kraschade, eller inget händer) → läk EN gång: avregistrera service workern,
//    töm appens cacher (braxhn-app-*, aldrig Nedladdat braxhn-dl-*) och startsidans sparade läge och gå via
//    /reset?soft=1 (servern rensar webbläsarens HTTP-cache) tillbaka till /?bxheal=…. Går det fel igen (bxheal i
//    adressen, eller läkt för mindre än 5 min sedan enligt sessionStorage): en statisk felsida med "Rensa och ladda
//    om" (/reset). Ingen omladdningsslinga.
// Felsidans texter står här och inte i den engelska katalogen: den får inte bero på något som laddas efter sidan.
(() => {
  const t0 = Date.now(), KEY = 'bx.heal', CAP = 60000;
  const conn = navigator.connection;
  const slowNet = () => !!conn && (conn.saveData || /2g|3g/.test(conn.effectiveType || ''));
  const healedParam = /[?&]bxheal=/.test(location.search);
  const healedRecently = () => { if (healedParam) return true; try { return Date.now() - (+sessionStorage.getItem(KEY) || 0) < 300000; } catch { return false; } };
  // Pågående anrop: startskriptets och modulernas fetch räknas tills appen startat (sedan återställs fetch)
  const ofetch = window.fetch;
  let inflight = 0, booted = false, err = false, timer = 0, checking = false, seen = -1, box = null;
  const wfetch = function (...a) { inflight++; return ofetch.apply(this, a).finally(() => { inflight--; }); };
  if (ofetch) window.fetch = wfetch;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(check, ms); };
  const progressed = () => { let n = 0; try { n = performance.getEntriesByType('resource').length; } catch {} const p = n !== seen; seen = n; return p; };
  progressed();
  later(slowNet() ? 20000 : 10000);
  self.__bxBooted = () => {
    if (booted) return;
    booted = true; clearTimeout(timer);
    self.__bxBootedAt = Date.now(); // test/web-selfheal.test.js
    if (window.fetch === wfetch) window.fetch = ofetch;
    box?.remove();
    try { sessionStorage.removeItem(KEY); } catch {}
    if (healedParam) {
      const u = new URL(location.href); u.searchParams.delete('bxheal');
      try { history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch {}
    }
  };
  // Fel före starten: en modul som inte gick att hämta (felet kommer på <script>), fel i appens egna skript eller en
  // avvisad start (app.js). Kontrolleras efter 3 s – ett ofarligt fel följt av en lyckad start gör ingenting.
  const onErr = () => { if (booted || err) return; err = true; later(3000); };
  addEventListener('error', (e) => {
    if (booted) return;
    const el = e.target;
    if (el && el.tagName === 'SCRIPT') { if (!el.src || el.src.startsWith(location.origin)) onErr(); return; }
    if (e instanceof ErrorEvent && (!e.filename || e.filename.startsWith(location.origin))) onErr();
  }, true);
  addEventListener('unhandledrejection', (e) => { const r = e.reason; if (!booted && r instanceof Error && String(r.stack || '').includes(location.origin)) onErr(); });
  async function probe() {
    const at = Date.now(), ac = new AbortController(), to = setTimeout(() => ac.abort(), 5000);
    try { const r = await ofetch.call(window, '/api/health', { cache: 'no-store', signal: ac.signal }); return r.status < 500 ? Date.now() - at : -1; } catch { return -1; } finally { clearTimeout(to); }
  }
  async function check() {
    if (booted || checking || box) return;
    if (document.visibilityState === 'hidden') return later(5000); // i bakgrunden (iOS pausar sidan): vänta
    checking = true;
    try {
      const age = Date.now() - t0, ms = await probe();
      if (booted) return;
      if (ms < 0) return age > CAP ? show(false) : later(5000);
      if (age < CAP && (inflight > 0 || (!err && (progressed() || ms > 1500 || slowNet())))) return later(4000);
      if (healedRecently()) return show(true);
      await heal();
    } finally { checking = false; }
  }
  async function heal() {
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch {}
    const wait = (p) => Promise.race([p, new Promise(r => setTimeout(r, 3000))]).catch(() => {});
    await wait(navigator.serviceWorker?.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
    await wait(self.caches?.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('braxhn-app-')).map(k => caches.delete(k)))));
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('bxhome')) localStorage.removeItem(k); } catch {}
    if (!booted) location.replace('/reset?soft=1' + location.hash);
  }
  // Felsidan: ren DOM med egna stilar, oberoende av stilmallen och modulerna. broken = appen startar inte (Rensa och
  // ladda om först); annars svarar servern inte (Försök igen först – att rensa tar bort det som behövs utan nät).
  function show(broken) {
    if (box || booted) return;
    const en = document.documentElement.lang === 'en';
    const T = en ? {
      h: broken ? 'BraXhn TV could not start' : 'The server is not responding',
      p: broken ? 'Usually old app files from an earlier version are left on this device. “Clear and reload” removes the app’s saved files here (Downloads too) – you stay signed in.'
        : 'Check that you are connected to your home network or VPN and that BraXhn TV is running.',
      reset: 'Clear and reload', retry: 'Try again', hint: 'Still stuck? Open this address:'
    } : {
      h: broken ? 'BraXhn TV kunde inte starta' : 'Servern svarar inte',
      p: broken ? 'Oftast ligger gamla filer från en tidigare version kvar på enheten. ”Rensa och ladda om” tar bort appens sparade filer här (även Nedladdat) – du förblir inloggad.'
        : 'Kontrollera att du är ansluten till hemnätet eller VPN:et och att BraXhn TV är igång.',
      reset: 'Rensa och ladda om', retry: 'Försök igen', hint: 'Fastnar det ändå? Öppna adressen:'
    };
    const el = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text) n.textContent = text; return n; };
    const btn = 'font:inherit;font-weight:700;padding:12px 22px;border-radius:10px;margin:6px;cursor:pointer;';
    box = el('div', 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0b1020;color:#e7eaf3;font:16px system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box;overflow:auto');
    box.id = 'bxstartfail'; box.setAttribute('role', 'alert'); box.dataset.kind = broken ? 'broken' : 'offline';
    const inner = el('div', 'max-width:420px');
    inner.append(el('h1', 'font-size:22px;margin:0 0 10px', T.h), el('p', 'color:#9aa3bd;margin:0 0 20px', T.p));
    const reset = el('button', btn + 'background:#ff6b4a;color:#14090a;border:0', T.reset);
    reset.type = 'button'; reset.id = 'bxreset';
    reset.onclick = () => { location.href = '/reset' + location.hash; };
    const retry = el('button', btn + 'background:transparent;color:#e7eaf3;border:1px solid #3a4260', T.retry);
    retry.type = 'button'; retry.id = 'bxretry';
    retry.onclick = () => location.reload();
    inner.append(...(broken ? [reset, retry] : [retry, reset]));
    const a = el('a', 'color:#9aa3bd', location.origin + '/reset'); a.href = '/reset';
    const hint = el('p', 'color:#9aa3bd;font-size:14px;margin:22px 0 0', T.hint + ' ');
    hint.append(a);
    inner.append(hint);
    box.append(inner);
    (document.body || document.documentElement).append(box);
    (broken ? reset : retry).focus();
  }
})();
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
  // Bara om import map redan står före skriptet: annars löses modulerna innan reglerna finns (Safari hängde, Chrome
  // hämtade allt två gånger) – utan förladdning hinner import map läsas före modulskriptet sist i sidan.
  if (document.querySelector('script[type=importmap]')) for (const href of self.__preload || []) { const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = href; document.head.append(l); }
  if (!h.startsWith('login')) get('/libraries');
  window.__early = early;
})();
