// Routing och appens skal: inloggning vid start (boot), route() med navigeringsgeneration, bibliotekslänkar,
// användarmenyn, sökfältet, flikmenyn och installation som app
import { $, $$, api, esc, resumeAt, isBackKey, isTyping, lang, leaveFns, store, libs, main, me, nextRoute, rememberLang, rememberPage, routeGen, setLibs, setLogin, setMe, setSpatialOn, spatialOn, toast, tvMode, views, t } from './core.js';
import { closeAllPlayers, closeLiveAndRec, curPlayer, idle, loadPlayer, need, startRemote, stopAudio, stopRemote, warmPlay } from './lazy.js';
import { refreshScreen, screenBadge } from './screentime.js';
import { bindRetry, errorState, loadingState } from './ui/states.js';
import { RAIL_ICON } from './ui/icons.js';
import { cardItem } from './ui/cards.js';
import { openMenu } from './ui/menu.js';
// Laddas när de behövs (lazy.js): dialoger, administratörens aktivitetsruta, bandbreddsmätningen
const openDialog = (o) => need('ui/dialog.js').then(m => m.openDialog(o));
let activityOn = false;
const startActivity = () => { activityOn = true; need('ui/activity.js').then(m => { if (activityOn) m.startActivity(); }).catch(() => {}); };
const stopActivity = () => { if (!activityOn) return; activityOn = false; need('ui/activity.js').then(m => m.stopActivity()).catch(() => {}); };

// Skalet i index.html (menyraden, sidomenyn, flikmenyn) är skrivet på svenska – översätts här en gång på engelska
if (lang !== 'sv') {
  const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
  for (const root of [$('#skiplink'), $('#top'), $('#rail'), $('#tabbar'), $('#player')]) {
    if (!root) continue;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) n.nodeValue = t(n.nodeValue);
    for (const el of [root, ...root.querySelectorAll('*')]) for (const a of ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, t(el.getAttribute(a)));
  }
}

// ---------- routing ----------
const LIB_PATH = { music: 'music', audiobook: 'books', photo: 'photos', ebook: 'ebooks' };
const railItem = (href, icon, label) => `<a class="ri" href="${href}" title="${esc(label)}">${RAIL_ICON[icon] || RAIL_ICON.movie}<span class="lbl">${esc(label)}</span></a>`;
const libIcon = (l) => /barn|kids|junior/i.test(l.name) && (l.type === 'movie' || l.type === 'show') ? 'kids' : l.type;
export async function loadLibs(list) {
  setLibs(list || await api('/libraries'));
  // Sidomenyn: Hem, ett val per bibliotek och övriga delar (ikoner, namnen syns när menyn är utfälld)
  $('#libnav').innerHTML = railItem('#/', 'home', t('Hem')) + libs.map(l => railItem(`#/${LIB_PATH[l.type] || 'lib'}/${+l.id}`, libIcon(l), l.name)).join('')
    + (me?.liveTv ? railItem('#/live', 'live', t('Live-TV')) : '') + (me?.streaming ? railItem('#/streaming', 'streaming', t('Strömmande')) : '')
    + (!me?.kid ? railItem('#/podcasts', 'podcast', t('Poddar')) : '');
  markNav();
}
// Rubriken till vänster i menyraden ("Hem", bibliotekets namn …)
const CRUMB = { '': t('Hem'), home: t('Hem'), watchlist: t('Min lista'), search: t('Sök'), podcasts: t('Poddar'), podcast: t('Poddar'), live: t('Live-TV'), streaming: t('Strömmande'),
  account: t('Mitt konto'), admin: t('Administration'), setup: t('Installation'), stats: t('Statistik'), requests: t('Önskningar'), calendar: t('Kommande'), wrapped: t('Årssammanfattning'), collection: t('Samling'), collections: t('Samlingar'), ucollection: t('Samling'), person: 'Person',
  history: t('Min historik'), playstats: t('Tittarstatistik'), webhooks: 'Webhooks', downloads: t('Nedladdat'), epg: t('TV-guide'), vod: t('Filmer och serier'), iptvadmin: 'IPTV', health: t('Hälsokontroll'), shrink: t('Diskrådgivaren'), tonight: t('Kvällsvalet'), sso: t('Enkel inloggning'), privacy: t('Integritet'),
  quickconnect: t('Godkänn inloggning'), guide: t('TV-guide'), dvr: t('Inspelningar'), photos: t('Foton'), lib: t('Bibliotek'), music: t('Musik'), books: t('Ljudböcker'),
  ebooks: t('E-böcker'), ebook: t('E-bok'), read: t('Läsaren'), vocab: t('Ordlista'), moments: t('Ögonblick'), family: t('Föräldraöversikt') };
// Sidor som inte syns i menyraden (rubriken för skärmläsare och flikens titel)
const PAGE = { login: t('Logga in'), profiles: t('Välj profil'), invite: t('Skapa konto'), timeup: t('Skärmtiden är slut') };
/** Markerar aktivt val i sidomenyn och flikarna i menyraden och sätter rubriken */
function markNav() {
  const h = (location.hash.slice(2) || '').split('?')[0]; // ?… = vyns parametrar (t.ex. bibliotekets filter)
  const [name, arg] = h.split('/');
  for (const a of $$('#libnav a')) {
    const hr = a.getAttribute('href');
    const on = hr === '#/' ? h === '' : ('#/' + h + '/').startsWith(hr + '/');
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const a of $$('#toptabs a')) {
    const on = a.dataset.top === (name || '');
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const lib = ['lib', 'music', 'books', 'photos', 'ebooks'].includes(name) ? libs.find(l => String(l.id) === arg) : null;
  $('#crumb').textContent = lib ? lib.name : CRUMB[name] ?? '';
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k) { try { sessionStorage.setItem(k, '1'); } catch {} }
// Språket: servern ger sidan på profilens språk (server/http/router.js, pageLang). Har profilen inget språk än och
// någon just loggat in på sidan (första inloggningen) blir sidans språk – webbläsarens – profilens. Byts profil
// till en med annat språk laddas sidan om (efter att anroparen hunnit byta adress).
let bootedAnon = false;
function syncLang() {
  let want = me.lang;
  if (!want && bootedAnon) { want = lang; api('/me/lang', { method: 'PUT', body: { lang }, bg: true }).catch(() => {}); }
  want = want === 'en' ? 'en' : 'sv';
  rememberLang(want);
  if (want === lang) return;
  try { const at = +sessionStorage.getItem('bx_langreload') || 0; if (Date.now() - at < 10000) return; sessionStorage.setItem('bx_langreload', String(Date.now())); } catch {}
  setTimeout(() => location.reload(), 0);
}
// Varm start: inloggningsläget och biblioteken från förra besöket (localStorage, rensas vid utloggning som de sparade
// startsidorna), så att startsidan ritas utan att vänta på /status. Servern kontrolleras ändå direkt: en annan
// profil eller utloggad laddar om sidan, annars uppdateras menyn tyst. Bara vid sidans start (app.js), aldrig efter
// inloggning eller profilbyte.
const BOOT_KEY = 'bxhomeboot1';
function bootCache() { try { return JSON.parse(localStorage.getItem(BOOT_KEY) || 'null'); } catch { return null; } }
function saveBoot(st) { try { localStorage.setItem(BOOT_KEY, JSON.stringify({ st, libs })); } catch {} }
const dropBoot = () => { try { localStorage.removeItem(BOOT_KEY); } catch {} };
/** Menyraden och sidomenyn för den inloggade */
function showLogin() {
  $('#top').hidden = false;
  $('#userbtn').innerHTML = `<span class="avatar" aria-hidden="true">${me.kid ? '🧸' : esc((me.name || '?').slice(0, 1).toUpperCase())}</span><span class="uname">${esc(me.name)}</span><span class="caret" aria-hidden="true">▾</span>`;
  $$('[data-profiles]').forEach(e => e.hidden = me.profiles < 2);
  $$('[data-admin]').forEach(e => e.hidden = !me.adminHere);
  $$('[data-requests]').forEach(e => e.hidden = me.kid);
  $$('[data-family]').forEach(e => e.hidden = !me.kidProfiles);
  $$('[data-dlnav]').forEach(e => e.hidden = me.canDownload === false && !store.get('dl.' + me.id, []).length);
  $('#userbtn').setAttribute('aria-label', t('{name} – konto och meny', { name: me.name }));
  $('#userbtn').classList.toggle('upd', !!(me.adminHere && me.update));
  screenBadge(me.screenTime);
}
/** Det som bara görs med serverns svar: mätning, aktivitetsrutan, Spela på… och uppdateringsnotisen */
function afterLogin(st) {
  // Utanför hemmet: mät uppkopplingen i förväg, så att första filmen startar i rätt kvalitet direkt
  if (st.remote) setTimeout(() => need('player/caps.js').then(m => m.measureBandwidth()).catch(() => {}), 3000);
  if (me.adminHere) idle(startActivity); else stopActivity();
  // "Spela på…": den här webbläsaren blir en enhet som kan styras och styra. Laddar spelaren – när sidan är ritad.
  idle(startRemote);
  if (me.adminHere && me.update && !sessionStorageGet('upd' + me.update)) { sessionStorageSet('upd' + me.update); toast(t('Version {update} av BraXhn TV finns – se Administration', { update: me.update })); }
}
export async function boot({ fast = false } = {}) {
  const old = fast && !/^#\/(login|invite|profiles)/.test(location.hash) ? bootCache() : null;
  if (old?.st?.user && Array.isArray(old.libs)) {
    const fresh = api('/status', { bg: true });
    setLogin(old.st);
    // Språket kontrolleras först med serverns svar (det sparade kan vara inaktuellt efter ett byte i Mitt konto)
    showLogin();
    await loadLibs(old.libs);
    fresh.then(async (st) => {
      if (st.user?.id !== old.st.user.id) { dropBoot(); location.reload(); return; }
      setLogin(st);
      syncLang();
      showLogin();
      afterLogin(st);
      const list = await api('/libraries', { bg: true });
      if (JSON.stringify(list) !== JSON.stringify(old.libs)) await loadLibs(list); else setLibs(list);
      saveBoot(st);
    }).catch((e) => {
      // Servern svarar inte: som vid en vanlig start utan server (Nedladdat eller sidan om att servern inte nås)
      if (!e?.offline) return;
      dropBoot();
      if (!store.get('dl.last', null)) return location.replace('/offline.html');
      setMe(null);
      need('views/downloads.js').then(m => m.offlineStart()).catch(() => location.replace('/offline.html'));
    });
    return true;
  }
  const st = await api('/status');
  setLogin(st);
  if (!me) { bootedAnon = true; dropBoot(); stopRemote(); return false; }
  syncLang();
  showLogin();
  afterLogin(st);
  await loadLibs();
  saveBoot(st);
  return true;
}
// Skelett medan vyn laddas – i samma form som sidan som kommer (ingen hoppande layout)
const SKELETON = { home: 'shelves', lib: 'grid', photos: 'grid', ebooks: 'grid', ebook: 'detail', watchlist: 'grid', search: 'grid', books: 'grid', podcasts: 'grid', music: 'grid', streaming: 'grid',
  item: 'detail', album: 'detail', artist: 'detail', playlist: 'detail', smart: 'detail', book: 'detail', podcast: 'detail', collection: 'detail', ucollection: 'detail', collections: 'shelves', person: 'detail',
  admin: 'panels', iptvadmin: 'panels', vod: 'shelves', setup: 'panels', account: 'panels', stats: 'panels', wrapped: 'panels', playstats: 'panels', webhooks: 'panels', health: 'panels', shrink: 'panels', tonight: 'panels', sso: 'panels' };
// Vyerna utom startsidan laddas först när de öppnas (eller när pekaren/fokus når en länk dit): vy -> modul i js/
// (märkt @lazy). need() i lazy.js hämtar modulen och hela dess kedja av beroenden på en gång (samma bygge,
// /v/<bygge>/js/…). Modulen registrerar sina vyer i views när den laddats.
const LAZY = new Map(Object.entries({ item: 'views/item', person: 'views/person', account: 'views/account', search: 'views/search',
  books: 'views/books', book: 'views/books', podcasts: 'views/books', podcast: 'views/books', calendar: 'views/calendar',
  collections: 'views/collections', ucollection: 'views/collections', setup: 'views/setup', quickconnect: 'views/quickconnect',
  music: 'views/music', album: 'views/music', artist: 'views/music', playlist: 'views/music', smart: 'views/music', smartedit: 'views/music',
  login: 'views/login', invite: 'views/login', profiles: 'views/login', party: 'player/party',
  admin: 'views/admin', stats: 'views/stats', wrapped: 'views/wrapped', requests: 'views/requests', streaming: 'views/streaming', live: 'views/live', guide: 'views/live', dvr: 'views/dvr', epg: 'views/epg', vod: 'views/vod', iptvadmin: 'views/iptvadmin',
  history: 'views/history', playstats: 'views/history', webhooks: 'views/webhooks', photos: 'views/photos', downloads: 'views/downloads', health: 'views/health', shrink: 'views/shrink', tonight: 'views/tonight', sso: 'views/sso',
  ebooks: 'views/ebooks', ebook: 'views/ebooks', read: 'views/reader', vocab: 'views/vocab', moments: 'views/moments', family: 'views/family', privacy: 'views/privacy' }));
/** Hämtar vyns modul i förväg (pekaren över eller fokus på en länk dit) */
export function prefetchView(name) { const m = !views[name] && LAZY.get(name); if (m) need(m + '.js').catch(() => {}); }
// Pekaren över (även ett tryck börjar så) eller fokus på en länk eller ett kort: hämta vyn – och spelaren för
// kort och Spela-knappar – innan klicket, så att det inte märks att de laddas först nu
function prefetch(e) {
  const t = e.target; if (!me || !t?.closest) return;
  const a = t.closest('a[href^="#/"]');
  if (a) prefetchView(a.getAttribute('href').slice(2).split('/')[0]);
  if (t.closest('.card, .feat, [data-play], #playfirst')) loadPlayer().catch(() => {});
  if (t.closest('.card')) need('ui/cardmenu.js').catch(() => {}); // ▶ ✎ ⋮ (kopplas i app.js)
  // Snabbstart: pekaren på ett korts Spela-knapp väcker titelns disk i förväg (servern läser lite av filen)
  const w = t.closest('[data-cplay]');
  if (w) { wakeDisk(+w.dataset.cplay); warmCard(w); }
  // Spela-knappar med titel och position (titelsidan, avsnittslistan): strömmen förvärms
  const wp = t.closest('[data-warm]');
  if (wp) { const [id, pos, kind] = wp.dataset.warm.split(':'); warmPlay(+id, +pos || 0, { movie: kind === 'm' }); }
}
/** ▶ på ett kort: samma titel och position som klicket spelar (serier väljer avsnitt först vid klicket) */
function warmCard(b) {
  if (b.dataset.pos != null) return warmPlay(+b.dataset.cplay, +b.dataset.pos || 0); // nästa avsnitt i en serie
  const it = cardItem(b.dataset.cplay);
  if (it && it.kind !== 'show') warmPlay(it.id, resumeAt(it.position, it.duration), { movie: it.kind === 'movie' });
}
const woken = new Map();
function wakeDisk(id) {
  if (!id || Date.now() - (woken.get(id) || 0) < 60e3) return;
  woken.set(id, Date.now());
  // Vanlig fetch (inte api()): en skrivning via api() gör startens förhämtade svar ogiltiga
  fetch(`/api/items/${id}/wake`, { method: 'POST', keepalive: true }).catch(() => {});
}
document.addEventListener('pointerover', prefetch, { passive: true });
document.addEventListener('focusin', prefetch);
// Sökrutan i menyraden sköts av views/search.js – den laddas när rutan får fokus
$('#q').addEventListener('focus', () => need('views/search.js').catch(() => {}));
export async function route() {
  const gen = nextRoute();
  // Stoppa timers/slingor från föregående vy
  for (const f of [...leaveFns]) { try { f(); } catch {} }
  leaveFns.clear();
  // Allt efter ? hör till vyn (bibliotekets filter, #/lib/1?genre=…) och läses av den
  const h = (location.hash.slice(2) || '').split('?')[0];
  const [name, arg, arg2] = h.split('/');
  // Inbjudningslänken (#/invite/<token>) öppnas utan inloggning – där skapar mottagaren sitt konto
  // Nedladdat (views/downloads.js) visas även när servern inte svarade vid start – vyn kontrollerar det själv
  if (!me && name !== 'login' && name !== 'invite' && name !== 'downloads') { rememberPage(); location.hash = '#/login'; return; }
  // En film i litet fönster fortsätter spela medan man bläddrar – men aldrig efter utloggning eller vid profilval
  // (då skulle framsteget sparas på fel profil, och en barnprofil kunna titta vidare)
  if (name === 'login' || name === 'profiles') { closeAllPlayers(); stopAudio(); }
  else if (curPlayer()?.mini) closeLiveAndRec(); else closeAllPlayers();
  markNav();
  let v = views[name || 'home'];
  const lazy = v ? null : LAZY.get(name);
  if (!v && !lazy) { location.hash = '#/'; return; }
  // Inloggning och profilval döljer menyn – visa den igen när man navigerar därifrån (även med Bakåt)
  $('#top').hidden = !me || name === 'login' || name === 'profiles' || name === 'invite';
  $('#tabbar').hidden = $('#top').hidden;
  $('#rail').hidden = $('#top').hidden;
  $$('#tabbar [data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === (name || '')));
  main.innerHTML = loadingState({ kind: SKELETON[name || 'home'] || 'list' });
  main.setAttribute('aria-busy', 'true');
  if (me && name !== 'timeup') refreshScreen();
  try {
    if (lazy) {
      await need(lazy + '.js');
      if (gen !== routeGen) return;
      v = views[name];
      if (!v) { location.hash = '#/'; return; }
    }
    await v(arg, arg2); if (gen !== routeGen) return; main.removeAttribute('aria-busy'); window.scrollTo(0, 0);
    announcePage(name);
    // "Finns även på" på titelsidan (views/item.js är laddad när rutan finns)
    if ($('[data-wid]')) need('views/item.js').then(m => m.fillWatch()).catch(() => {}); }
  catch (e) {
    if (gen !== routeGen || e?.aborted) return;
    main.removeAttribute('aria-busy');
    if (me) { main.innerHTML = errorState(e, { retry: true }); bindRetry(main, () => route()); announcePage(name); }
  }
}
window.addEventListener('hashchange', () => { navigated = true; saveFocus(); entry(); route(); });

// Tillgänglighet efter varje sidbyte: en h1 (dold om vyn inte har en egen – menyradens rubrik visar namnet),
// flikens titel efter sidan (2.4.2) och fokus till rubriken när fokus annars tappats eller låg i menyerna,
// så att skärmläsaren läser den nya sidan och Tab fortsätter i innehållet (inte vid första laddningen).
let navigated = false;
function announcePage(name) {
  let h = main.querySelector('h1');
  if (!h) {
    h = document.createElement('h1'); h.className = 'sr-only pageh';
    h.textContent = PAGE[name] || $('#crumb').textContent || CRUMB[name || ''] || 'BraXhn TV';
    main.prepend(h);
  }
  const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
  document.title = t && t !== 'BraXhn TV' ? `${t} – BraXhn TV` : 'BraXhn TV';
  if (!navigated) return;
  navigated = false;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !a.closest('#rail, #toptabs, #tabbar, #usermenu, .pop')) return;
  // Fjärrkontroll: fokus på kortet man kom ifrån (Bakåt) eller på första vettiga elementet – inte på rubriken
  if (spatialOn) return tvFocus();
  if (!h.hasAttribute('tabindex')) h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

// ---------- fjärrkontroll: rumslig navigering, Bakåt och fokus per sida ----------
// Pilarna går till ui/spatial.js (laddas i förväg i TV-läge, annars vid första piltrycket utan fokus). Komponenter med
// egna piltangenter (menyer, flikar, reglage, TV-guiden, spelaren) anropar preventDefault() – då gör navigeringen
// inget. Lyssnaren sitter på window så att den kommer efter alla lyssnare på dokumentet.
let spatial = null;
const loadSpatial = () => need('ui/spatial.js').then(m => (spatial = m));
if (tvMode) idle(() => loadSpatial().catch(() => {}));
const ARROW = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const withSpatial = (fn) => { if (spatial) fn(spatial); else loadSpatial().then(fn).catch(() => {}); };
/** Inget egentligt fokus: body, huvudytan eller sidans rubrik (fokus efter sidbyte) */
const noFocus = (a) => !a || a === document.body || a === document.documentElement || a === main || a.matches('.pageh, h1[tabindex="-1"]');
/** Lämnar pilen textfältet? Upp/ner alltid (i flerradiga fält vid första/sista raden), vänster/höger vid kanten */
function leavesField(el, dir) {
  let s = null, e = null, n = (el.value || '').length;
  try { s = el.selectionStart; e = el.selectionEnd; } catch {}
  if (el.isContentEditable) return dir === 'up' || dir === 'down';
  if (el.tagName === 'TEXTAREA') return s === e && ((dir === 'up' && !el.value.slice(0, s).includes('\n')) || (dir === 'down' && !el.value.slice(s).includes('\n')));
  if (dir === 'up' || dir === 'down') return true;
  return s != null && s === e && (dir === 'left' ? s === 0 : s === n);
}
window.addEventListener('keydown', (e) => {
  const dir = ARROW[e.key];
  if (!dir || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const P = curPlayer();
  if (P && !P.mini) return; // helskärmsspelaren sköter pilarna själv (player/controls.js)
  const a = document.activeElement;
  // Utan påslagen navigering: bara när inget har fokus, och mellan korten (som förut)
  if (!spatialOn && !noFocus(a) && !a.matches('.card > .clink')) return;
  if (isTyping(a) && !leavesField(a, dir)) return;
  // Reglage och video: ←/→ ändrar värdet (vid änden av ett reglage går pilen vidare), ↑/↓ navigerar
  if ((dir === 'left' || dir === 'right') && a?.matches('input[type=range], [role=slider], video')
    && !(a.type === 'range' && +a.value === +(dir === 'left' ? a.min || 0 : a.max || 100))) return;
  if (!spatialOn) setSpatialOn();
  e.preventDefault();
  withSpatial(m => m.move(dir));
});
// Fokus per historikpost: kortet man öppnade får fokus igen när man går Bakåt till listan. Varje post får ett
// löpnummer i history.state (bxi, och föregående post i bxprev – finns den kan Bakåt gå dit i appen).
const focusMem = new Map();
let curEntry = 0, wentBack = false;
function entry() {
  if (!globalThis.history) return; // (testerna laddar modulen utan webbläsare)
  let s = history.state;
  if (s?.bxi) wentBack = s.bxi < curEntry;
  else {
    s = { ...(s || {}), bxi: Math.max(Date.now(), curEntry + 1), bxprev: curEntry };
    try { history.replaceState(s, ''); } catch {}
    wentBack = false;
  }
  curEntry = s.bxi;
}
entry();
function saveFocus() {
  const a = document.activeElement;
  if (!curEntry || !a || !main.contains(a)) return;
  const c = a.closest('.card');
  const id = c?.dataset.id ? `.card[data-id="${CSS.escape(c.dataset.id)}"]` : c?.dataset.season ? `.card[data-season="${CSS.escape(c.dataset.season)}"]`
    : a.id ? '#' + CSS.escape(a.id) : a.getAttribute('href') ? `a[href="${CSS.escape(a.getAttribute('href'))}"]` : null;
  if (id) focusMem.set(curEntry, { id, n: [...main.querySelectorAll(id)].indexOf(c || a), y: scrollY });
  if (focusMem.size > 50) focusMem.delete(focusMem.keys().next().value);
}
/** Fokus efter sidbyte med fjärrkontroll: det sparade elementet (Bakåt), annars första vettiga på sidan */
function tvFocus() {
  const gen = routeGen, m = wentBack ? focusMem.get(curEntry) : null;
  withSpatial((sp) => {
    let tries = 0;
    const attempt = () => {
      if (gen !== routeGen || (!noFocus(document.activeElement) && main.contains(document.activeElement))) return;
      if (m) {
        // Startsidan ritar hyllorna efter hand – vänta en stund på kortet
        const all = main.querySelectorAll(m.id), el = all[m.n] || all[0];
        const target = el?.matches('.card') ? el.querySelector('.clink') || el : el;
        if (target) { window.scrollTo(0, m.y); sp.focusEl(target); return; }
        if (++tries < 20) return setTimeout(attempt, 100);
      }
      sp.focusFirst();
    };
    attempt();
  });
}
// Bakåt: Escape (och Backspace utanför fält) när navigeringen är på, och fjärrkontrollens Bakåt-knapp alltid.
// Ordningen: det som är öppet stängs av sin egen Escape-hantering (dialog, meny, spelare → litet fönster, panel);
// är inget öppet och ingen komponent tog tangenten (preventDefault) går appen till förra sidan.
let openAtKey = false;
const somethingOpen = () => !!(document.querySelector('dialog[open], .pop') || document.fullscreenElement || !$('#usermenu').hidden
  || ($('#player') && !$('#player').hidden && !$('#player').classList.contains('mini')));
/** Skickar en Escape dit fokus är (TV-plattformarnas Bakåt-knapp och Backspace) */
function sendBack(target) {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
  ev.bxBack = true;
  (target?.isConnected ? target : document.activeElement || document.body).dispatchEvent(ev);
}
window.addEventListener('keydown', (e) => {
  if (isBackKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); sendBack(e.target); return; }
  if (e.key !== 'Escape') return;
  openAtKey = somethingOpen();
  if (e.isTrusted) return;
  // Vår egen Escape: det webbläsaren annars gör själv (modal dialog, helskärm) görs här
  if (document.querySelector('.pop') && e.target.closest?.('.pop')) return; // menyn stänger sig själv
  const d = [...document.querySelectorAll('dialog[open]')].pop();
  if (d) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (d.dispatchEvent(new Event('cancel', { cancelable: true }))) d.close();
  } else if (document.fullscreenElement) { e.preventDefault(); e.stopImmediatePropagation(); document.exitFullscreen().catch(() => {}); }
}, true);
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Backspace' && spatialOn && !isTyping(e.target)) { e.preventDefault(); sendBack(e.target); return; }
  if (e.key !== 'Escape' || openAtKey || !(spatialOn || e.bxBack)) return;
  // I ett textfält: Escape stänger förslag/tömmer sökfältet – bara fjärrkontrollens Bakåt i ett tomt fält byter sida
  if (isTyping(e.target) && (!e.bxBack || e.target.value || e.target.isContentEditable)) return;
  e.preventDefault();
  goBack();
});
/** Förra sidan i appen; på startsidan händer inget, och från en djuplänk går Bakåt till startsidan */
export function goBack() {
  const h = location.hash;
  if (!h || h === '#/' || h === '#') return;
  if (history.state?.bxprev) history.back(); else location.hash = '#/';
}
// Hoppa till innehållet: länken först på sidan (hash-adresserna styr routern, därför flyttas fokus här)
$('#skiplink').onclick = (e) => { e.preventDefault(); const h = main.querySelector('h1'); (h || main).tabIndex = -1; (h || main).focus(); };

// Sparade startsidor (views/home.js) tas bort vid utloggning – nästa person på datorn ska inte se dem
function clearHomeCache() { try { for (const k of Object.keys(localStorage)) if (k.startsWith('bxhome')) localStorage.removeItem(k); } catch {} } // även bxhomeboot1 (boot)
// Användarmenyn: aria-expanded följer menyn, Escape stänger och lämnar fokus på knappen
const userMenu = (open) => { $('#usermenu').hidden = !open; $('#userbtn').setAttribute('aria-expanded', String(open)); };
// iPhone (Safari och hemskärmsappen): efter att tangentbordet stängts eller verktygsfältet krympt kan den synliga
// ytan och sidans layout hamna ur fas, och fasta element i nederkant (flikmenyn, ljudspelaren) blir hängande
// mitt på skärmen. Knuffa ner dem till den synliga ytans nederkant, och göm flikmenyn medan tangentbordet är uppe.
const vv = window.visualViewport;
if (vv) {
  const root = document.documentElement;
  const fitBottom = () => {
    const below = vv.offsetTop + vv.height - window.innerHeight; // > 0: layoutens nederkant ligger ovanför den synliga
    root.style.setProperty('--vv-shift', below > 1 ? Math.round(below) + 'px' : '0px');
    root.classList.toggle('kbd-open', vv.height < window.innerHeight * 0.8 && !!document.activeElement?.matches('input,textarea,select'));
  };
  vv.addEventListener('resize', fitBottom); vv.addEventListener('scroll', fitBottom);
  window.addEventListener('scroll', fitBottom, { passive: true });
  document.addEventListener('focusout', () => setTimeout(fitBottom, 300));
  fitBottom();
}
$('#userbtn').onclick = (e) => { e.stopPropagation(); userMenu($('#usermenu').hidden); if (!$('#usermenu').hidden) $('#usermenu a:not([hidden]), #usermenu button:not([hidden])')?.focus(); };
document.addEventListener('click', () => userMenu(false));
$('#usermenu').addEventListener('keydown', (e) => { if (e.key === 'Escape') { userMenu(false); $('#userbtn').focus(); } });
// ---------- tangentbordsgenvägar ----------
// ? visar alla genvägar, / går till sökrutan. Inte när man skriver i ett fält eller en dialog är öppen.
const SHORTCUTS = [[t('Överallt'), [['?', t('Visa den här listan')], ['/', t('Sök')], ['Tab', t('Första tabbstoppet: Hoppa till innehållet')], ['← → ↑ ↓', t('Flytta fokus till det närmaste i pilens riktning (kort, knappar, menyer)')],
    ['Enter', t('Öppna det markerade kortet')], [t('Shift+F10 eller Menu'), t('Kortets meny (spela, Min lista, sedd …)')], ['Esc', t('Stäng dialog, meny eller panel')], [t('Bakåt eller Esc'), t('Med fjärrkontroll: förra sidan när inget är öppet')]]],
  [t('Spelaren'), [[t('Mellanslag eller k'), t('Spela/pausa')], [t('← eller j'), t('10 sekunder bakåt')], [t('→ eller l'), t('10 sekunder framåt')], ['↑ ↓', t('Volym')],
    ['m', t('Ljud av/på')], ['c', t('Undertexter av/på')], ['< >', t('Långsammare/snabbare')], ['f', t('Helskärm')], ['0–9', t('Hoppa till 0 %, 10 % … 90 %')],
    ['Home End', t('Början/slutet (på tidslinjen)')], ['PageUp PageDown', t('En minut framåt/bakåt (på tidslinjen)')],
    ['s', t('Hoppa över intro/eftertexter (när knappen visas)')], ['Esc', t('Litet fönster')], [t('Mediaknapparna'), t('Spela/pausa, spola, nästa/föregående')]]],
  [t('Språkinlärning (⚙ i spelaren)'), [['a d', t('Föregående/nästa replik')], ['r', t('Upprepa repliken')], ['x', t('Upprepa repliken långsamt')],
    ['p', t('Pausa efter varje replik av/på')], ['w', t('Välj ord i repliken (← → mellan orden, Enter sparar)')]]],
  [t('TV-guiden och foton'), [['← → ↑ ↓', t('Flytta mellan program/kanaler och foton')], ['PageUp PageDown', t('En skärm i taget')], ['Enter', t('Öppna programmet eller fotot')], ['Esc', t('Stäng fotovisaren')]]],
  [t('Läsaren'), [[t('→ eller Mellanslag'), t('Nästa sida (manga: ←)')], ['← PageUp', t('Föregående sida')], ['Home End', t('Första/sista sidan')], ['t', t('Innehåll')],
    ['b', t('Bokmärk sidan')], ['+ −', t('Zooma serietidningen')], ['f', t('Helskärm')], ['Esc', t('Tillbaka till boken')]]]];
export function showShortcuts() {
  openDialog({ title: t('Kortkommandon'), body: SHORTCUTS.map(([h, list]) => `<h3>${esc(h)}</h3><table class="tbl keys">${list.map(([k, tm]) =>
    `<tr><td>${k.split(' ').map(x => [t('eller'), '…'].includes(x) ? esc(x) : `<kbd>${esc(x)}</kbd>`).join(' ')}</td><td>${esc(tm)}</td></tr>`).join('')}</table>`).join('') });
}
$('#keyshelp').onclick = () => showShortcuts();
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input,textarea,select,[contenteditable]')) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  else if (e.key === '/' && me && !curPlayer()) { e.preventDefault(); const q = $('#q'); if (q?.offsetParent) q.focus(); else location.hash = '#/search'; }
});
// ---------- installera som app ----------
// Service workern kräver HTTPS (eller localhost); utan den går appen ändå att lägga på hemskärmen
// Registreras först när sidan är ritad: installationen hämtar hela appen (~100 filer) och skulle annars ta anslutningarna
// från startsidans moduler, anrop och bilder vid första besöket
// Ny version utan att användaren gör något: sw.js hämtas alltid från servern (updateViaCache none), och hemskärmsappen
// i iOS – som kan ligga i bakgrunden i dagar utan en ny navigering – frågar efter en ny service worker när den kommer
// fram igen (högst en gång i timmen). Den nya tar över direkt (skipWaiting) och ger nästa start från servern.
if ('serviceWorker' in navigator && window.isSecureContext) idle(() => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
  let asked = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - asked < 3600e3) return;
    asked = Date.now();
    reg.update().catch(() => {});
  });
}).catch(() => {}));
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('#install').hidden = true; toast(t('BraXhn TV är installerad')); });
if (!standalone() && isIos()) $('#install').hidden = false; // Safari har ingen installationsdialog – visa instruktioner
document.documentElement.classList.toggle('standalone', standalone());
$('#install').onclick = async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#install').hidden = true; return; }
  openDialog({ title: t('Installera BraXhn TV'), actions: [{ label: 'OK', kind: 'primary' }], body: isIos()
    ? t('<ol><li>Tryck på <b>Dela</b> (rutan med pilen uppåt) i Safari.</li><li>Välj <b>Lägg till på hemskärmen</b>.</li><li>Tryck <b>Lägg till</b>.</li></ol><p class="muted small">Appen öppnas sedan i helskärm med egen ikon.</p>')
    : t('<p>Öppna webbläsarens meny (⋮) och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.</p><p class="muted small">Fullständig installation kräver att servern nås via HTTPS (se README, "Titta utanför hemmet").</p>') });
};
// Flikmenyn: Sök fokuserar sökfältet i stället för att byta sida
$('#tabbar [data-tab="search"]').onclick = (e) => { e.preventDefault(); window.scrollTo(0, 0); $('#q').focus(); };

// Utloggning: Nedladdat visas inte längre när servern inte svarar (filerna finns kvar till nästa inloggning)
$('#logout').onclick = async () => { stopAudio(); stopActivity(); stopRemote(); clearHomeCache(); store.set('dl.last', null); await api('/logout', { method: 'POST' }).catch(() => {}); setMe(null); location.hash = '#/login'; };
// Sökfältet (resultat medan man skriver, piltangenter, senaste sökningar) sköts av views/search.js

// ---------- sidomenyn ----------
// Ikoner som standard; ☰ fäller ut menyn med namnen (sparas i webbläsaren)
function setRail(open) {
  document.documentElement.classList.toggle('rail-open', open);
  $('#railbtn').setAttribute('aria-expanded', String(open));
  $('#railbtn').setAttribute('aria-label', open ? t('Dölj namnen i sidomenyn') : t('Visa namnen i sidomenyn'));
}
setRail(!!store.get('rail', false));
let railAnim = 0;
$('#railbtn').onclick = () => {
  const r = document.documentElement, open = !r.classList.contains('rail-open');
  // Animeringen bara vid klicket (se html.rail-anim i style.css)
  r.classList.add('rail-anim'); clearTimeout(railAnim); railAnim = setTimeout(() => r.classList.remove('rail-anim'), 400);
  store.set('rail', open); setRail(open);
};
// Mer: det som inte får plats i sidomenyn
$('#railmore').onclick = (e) => {
  e.stopPropagation();
  openMenu(e.currentTarget, [
    { icon: '🔖', label: t('Min lista'), href: '#/watchlist' },
    { icon: '📅', label: t('Kommande avsnitt'), href: '#/calendar' },
    { icon: '✋', label: t('Önskningar'), href: '#/requests', hidden: !!me?.kid },
    { icon: '🎁', label: t('Årssammanfattning'), href: '#/wrapped' },
    { icon: '🕘', label: t('Min historik'), href: '#/history' },
    { icon: '📒', label: t('Ordlista'), href: '#/vocab' },
    { icon: '✂', label: t('Ögonblick'), href: '#/moments' },
    { icon: '⤓', label: t('Nedladdat'), href: '#/downloads', hidden: me?.canDownload === false && !store.get('dl.' + me?.id, []).length },
    { icon: '👤', label: t('Mitt konto'), href: '#/account' },
    { icon: '👪', label: t('Föräldraöversikt'), href: '#/family', hidden: !me?.kidProfiles },
    'separator',
    { icon: '📊', label: t('Statistik och aktivitet'), href: '#/stats', hidden: !me?.adminHere },
    { icon: '📈', label: t('Tittarstatistik'), href: '#/playstats', hidden: !me?.adminHere },
    { icon: '⚙', label: t('Administration'), href: '#/admin', hidden: !me?.adminHere },
  ], { title: t('Mer'), label: t('Mer') });
};
