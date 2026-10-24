// Routing och appens skal: inloggning vid start (boot), route() med navigeringsgeneration, bibliotekslänkar,
// användarmenyn, sökfältet, flikmenyn och installation som app
import { $, $$, api, esc, leaveFns, store, libs, main, me, nextRoute, rememberPage, routeGen, setLibs, setLogin, setMe, toast, views } from './core.js';
import { stopAudio } from './audio.js';
import { measureBandwidth } from './player/caps.js';
import { closeLive, closeRec } from './player/live.js';
import { P, closeAllPlayers } from './player/video.js';
import { refreshScreen, screenBadge } from './screentime.js';
import { fillWatch } from './views/item.js';
import { openDialog } from './ui/dialog.js';
import { bindRetry, errorState, loadingState } from './ui/states.js';
import { startActivity, stopActivity } from './ui/activity.js';
import { RAIL_ICON } from './ui/icons.js';
import { openMenu } from './ui/menu.js';

// ---------- routing ----------
const LIB_PATH = { music: 'music', audiobook: 'books' };
const railItem = (href, icon, label) => `<a class="ri" href="${href}" title="${esc(label)}">${RAIL_ICON[icon] || RAIL_ICON.movie}<span class="lbl">${esc(label)}</span></a>`;
const libIcon = (l) => /barn|kids|junior/i.test(l.name) && (l.type === 'movie' || l.type === 'show') ? 'kids' : l.type;
export async function loadLibs() {
  setLibs(await api('/libraries'));
  // Sidomenyn: Hem, ett val per bibliotek och övriga delar (ikoner, namnen syns när menyn är utfälld)
  $('#libnav').innerHTML = railItem('#/', 'home', 'Hem') + libs.map(l => railItem(`#/${LIB_PATH[l.type] || 'lib'}/${+l.id}`, libIcon(l), l.name)).join('')
    + (me?.liveTv ? railItem('#/live', 'live', 'Live-TV') : '') + (me?.streaming ? railItem('#/streaming', 'streaming', 'Strömmande') : '')
    + (!me?.kid ? railItem('#/podcasts', 'podcast', 'Poddar') : '');
  markNav();
}
// Rubriken till vänster i menyraden ("Hem", bibliotekets namn …)
const CRUMB = { '': 'Hem', home: 'Hem', watchlist: 'Min lista', search: 'Sök', podcasts: 'Poddar', podcast: 'Poddar', live: 'Live-TV', streaming: 'Strömmande',
  account: 'Mitt konto', admin: 'Administration', stats: 'Statistik', requests: 'Önskningar', calendar: 'Kommande', wrapped: 'Årssammanfattning', collection: 'Samling', collections: 'Samlingar', ucollection: 'Samling', person: 'Person' };
/** Markerar aktivt val i sidomenyn och flikarna i menyraden och sätter rubriken */
function markNav() {
  const h = location.hash.slice(2) || '';
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
  const lib = ['lib', 'music', 'books'].includes(name) ? libs.find(l => String(l.id) === arg) : null;
  $('#crumb').textContent = lib ? lib.name : CRUMB[name] ?? '';
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k) { try { sessionStorage.setItem(k, '1'); } catch {} }
export async function boot() {
  const st = await api('/status');
  setLogin(st);
  if (!me) return false;
  $('#top').hidden = false;
  $('#userbtn').innerHTML = `<span class="avatar" aria-hidden="true">${me.kid ? '🧸' : esc((me.name || '?').slice(0, 1).toUpperCase())}</span><span class="uname">${esc(me.name)}</span><span class="caret" aria-hidden="true">▾</span>`;
  $$('[data-profiles]').forEach(e => e.hidden = me.profiles < 2);
  $$('[data-admin]').forEach(e => e.hidden = !me.adminHere);
  $$('[data-requests]').forEach(e => e.hidden = me.kid);
  $('#userbtn').classList.toggle('upd', !!(me.adminHere && me.update));
  screenBadge(me.screenTime);
  // Utanför hemmet: mät uppkopplingen i förväg, så att första filmen startar i rätt kvalitet direkt
  if (st.remote) setTimeout(() => measureBandwidth(), 3000);
  if (me.adminHere) startActivity(); else stopActivity();
  if (me.adminHere && me.update && !sessionStorageGet('upd' + me.update)) { sessionStorageSet('upd' + me.update); toast(`Version ${me.update} av BraXhn TV finns – se Administration`); }
  await loadLibs();
  return true;
}
// Skelett medan vyn laddas – i samma form som sidan som kommer (ingen hoppande layout)
const SKELETON = { home: 'shelves', lib: 'grid', watchlist: 'grid', search: 'grid', books: 'grid', podcasts: 'grid', music: 'grid', streaming: 'grid',
  item: 'detail', album: 'detail', artist: 'detail', playlist: 'detail', smart: 'detail', book: 'detail', podcast: 'detail', collection: 'detail', ucollection: 'detail', collections: 'shelves', person: 'detail',
  admin: 'panels', account: 'panels', stats: 'panels', wrapped: 'panels' };
// Sällan använda vyer laddas först när de öppnas: vy -> modul i views/ (märkt @lazy, förladdas inte).
// Relativ dynamisk import → samma bygge (/v/<bygge>/js/views/…). Modulen registrerar sina vyer i views när den laddats.
const LAZY = new Map(Object.entries({ admin: 'admin', stats: 'stats', wrapped: 'wrapped', requests: 'requests', streaming: 'streaming', live: 'live', guide: 'live', dvr: 'live' }));
export async function route() {
  const gen = nextRoute();
  // Stoppa timers/slingor från föregående vy
  for (const f of [...leaveFns]) { try { f(); } catch {} }
  leaveFns.clear();
  const h = location.hash.slice(2) || '';
  const [name, arg, arg2] = h.split('/');
  if (!me && name !== 'login') { rememberPage(); location.hash = '#/login'; return; }
  // En film i litet fönster fortsätter spela medan man bläddrar – men aldrig efter utloggning eller vid profilval
  // (då skulle framsteget sparas på fel profil, och en barnprofil kunna titta vidare)
  if (name === 'login' || name === 'profiles') { closeAllPlayers(); stopAudio(); }
  else if (P?.mini) { closeLive(); closeRec(); } else closeAllPlayers();
  markNav();
  let v = views[name || 'home'];
  const lazy = v ? null : LAZY.get(name);
  if (!v && !lazy) { location.hash = '#/'; return; }
  // Inloggning och profilval döljer menyn – visa den igen när man navigerar därifrån (även med Bakåt)
  $('#top').hidden = !me || name === 'login' || name === 'profiles';
  $('#tabbar').hidden = $('#top').hidden;
  $('#rail').hidden = $('#top').hidden;
  $$('#tabbar [data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === (name || '')));
  main.innerHTML = loadingState({ kind: SKELETON[name || 'home'] || 'list' });
  main.setAttribute('aria-busy', 'true');
  if (me && name !== 'timeup') refreshScreen();
  try {
    if (lazy) {
      await import(`./views/${lazy}.js`);
      if (gen !== routeGen) return;
      v = views[name];
      if (!v) { location.hash = '#/'; return; }
    }
    await v(arg, arg2); if (gen !== routeGen) return; main.removeAttribute('aria-busy'); window.scrollTo(0, 0); fillWatch(); }
  catch (e) {
    if (gen !== routeGen || e?.aborted) return;
    main.removeAttribute('aria-busy');
    if (me) { main.innerHTML = errorState(e, { retry: true }); bindRetry(main, () => route()); }
  }
}
window.addEventListener('hashchange', route);

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
const SHORTCUTS = [['Överallt', [['?', 'Visa den här listan'], ['/', 'Sök'], ['← → ↑ ↓', 'Flytta mellan korten i en hylla eller ett rutnät'], ['Enter', 'Öppna det markerade kortet']]],
  ['Spelaren', [['Mellanslag eller k', 'Spela/pausa'], ['← eller j', '10 sekunder bakåt'], ['→ eller l', '10 sekunder framåt'], ['↑ ↓', 'Volym'],
    ['m', 'Ljud av/på'], ['f', 'Helskärm'], ['0–9', 'Hoppa till 0 %, 10 % … 90 %'], ['s', 'Hoppa över intro/eftertexter (när knappen visas)'], ['Esc', 'Litet fönster']]]];
export function showShortcuts() {
  openDialog({ title: 'Kortkommandon', body: SHORTCUTS.map(([h, list]) => `<h3>${esc(h)}</h3><table class="tbl keys">${list.map(([k, t]) =>
    `<tr><td>${k.split(' ').map(x => ['eller', '…'].includes(x) ? esc(x) : `<kbd>${esc(x)}</kbd>`).join(' ')}</td><td>${esc(t)}</td></tr>`).join('')}</table>`).join('') });
}
$('#keyshelp').onclick = () => showShortcuts();
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input,textarea,select,[contenteditable]')) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  else if (e.key === '/' && me && !P) { e.preventDefault(); const q = $('#q'); if (q?.offsetParent) q.focus(); else location.hash = '#/search'; }
});
// ---------- installera som app ----------
// Service workern kräver HTTPS (eller localhost); utan den går appen ändå att lägga på hemskärmen
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('#install').hidden = true; toast('BraXhn TV är installerad'); });
if (!standalone() && isIos()) $('#install').hidden = false; // Safari har ingen installationsdialog – visa instruktioner
document.documentElement.classList.toggle('standalone', standalone());
$('#install').onclick = async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#install').hidden = true; return; }
  openDialog({ title: 'Installera BraXhn TV', actions: [{ label: 'OK', kind: 'primary' }], body: isIos()
    ? '<ol><li>Tryck på <b>Dela</b> (rutan med pilen uppåt) i Safari.</li><li>Välj <b>Lägg till på hemskärmen</b>.</li><li>Tryck <b>Lägg till</b>.</li></ol><p class="muted small">Appen öppnas sedan i helskärm med egen ikon.</p>'
    : '<p>Öppna webbläsarens meny (⋮) och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.</p><p class="muted small">Fullständig installation kräver att servern nås via HTTPS (se README, "Titta utanför hemmet").</p>' });
};
// Flikmenyn: Sök fokuserar sökfältet i stället för att byta sida
$('#tabbar [data-tab="search"]').onclick = (e) => { e.preventDefault(); window.scrollTo(0, 0); $('#q').focus(); };

$('#logout').onclick = async () => { stopAudio(); stopActivity(); await api('/logout', { method: 'POST' }).catch(() => {}); setMe(null); location.hash = '#/login'; };
// Sökfältet (resultat medan man skriver, piltangenter, senaste sökningar) sköts av views/search.js

// ---------- sidomenyn ----------
// Ikoner som standard; ☰ fäller ut menyn med namnen (sparas i webbläsaren)
function setRail(open) {
  document.documentElement.classList.toggle('rail-open', open);
  $('#railbtn').setAttribute('aria-expanded', String(open));
  $('#railbtn').setAttribute('aria-label', open ? 'Dölj namnen i sidomenyn' : 'Visa namnen i sidomenyn');
}
setRail(!!store.get('rail', false));
$('#railbtn').onclick = () => { const open = !document.documentElement.classList.contains('rail-open'); store.set('rail', open); setRail(open); };
// Mer: det som inte får plats i sidomenyn
$('#railmore').onclick = (e) => {
  e.stopPropagation();
  openMenu(e.currentTarget, [
    { icon: '🔖', label: 'Min lista', href: '#/watchlist' },
    { icon: '📅', label: 'Kommande avsnitt', href: '#/calendar' },
    { icon: '✋', label: 'Önskningar', href: '#/requests', hidden: !!me?.kid },
    { icon: '🎁', label: 'Årssammanfattning', href: '#/wrapped' },
    { icon: '👤', label: 'Mitt konto', href: '#/account' },
    'separator',
    { icon: '📊', label: 'Statistik och aktivitet', href: '#/stats', hidden: !me?.adminHere },
    { icon: '⚙', label: 'Administration', href: '#/admin', hidden: !me?.adminHere },
  ], { title: 'Mer', label: 'Mer' });
};
